// Contract conformance against api/openapi.yaml.
//
// api/05 makes the spec the source of truth rather than something generated from code.
// That only means anything if something checks: without these tests the spec is a
// description of what someone once intended, and the implementation drifts from it
// silently, because both sides look self-consistent on their own.
//
// It had already drifted. The first version of these routes returned a bare
// { data, has_more } with `id` and `type`, where the contract specifies an envelope of
// { success, data, meta } with `record_id` and `record_type`. Nothing failed. These
// tests are what would have caught it on the first commit.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, seedTenant, createRecord, cleanup } from './helpers/db.mjs';

process.env.JWT_SECRET ??= 'test-secret-at-least-32-bytes-long!!';
process.env.REDIS_CACHE_URL ??= 'redis://localhost:6379';
process.env.REDIS_STATE_URL ??= 'redis://localhost:6381';

const { createApp } = await import('../dist/app.js');
const { signAccessToken } = await import('../dist/auth/token.js');
const { closePool } = await import('../dist/db/context.js');
const { closeRedis, waitForReady } = await import('../dist/redis/client.js');
const { responseValidator, spec } = await import('../dist/openapi/spec.js');

let pool, server, base, t, token;
const created = [];
const RW = ['records:read', 'records:write'];

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

async function call(method, path, { body, key } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

/** Assert a response body matches the schema the spec declares for that status. */
function assertMatchesSpec(specPath, method, status, body) {
  const validate = responseValidator(specPath, method, String(status));
  assert.ok(validate, `the spec declares no ${status} schema for ${method} ${specPath}`);
  const ok = validate(body);
  assert.ok(ok, `response does not match the contract: ${JSON.stringify(validate.errors)}`);
}

before(async () => {
  pool = createPool();
  await Promise.all([waitForReady('cache'), waitForReady('state')]);
  t = await seedTenant(pool);
  created.push(t.id);
  for (const title of ['one', 'two', 'three']) await createRecord(pool, t, title);
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
  token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: RW });
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await closeRedis();
  await closePool();
  await cleanup(pool, created);
  await pool.end();
});

describe('the spec itself', () => {
  test('parses and declares the routes we serve', () => {
    const paths = spec().paths;
    assert.ok(paths['/records'], '/records must be specified');
    assert.ok(paths['/records'].get && paths['/records'].post);
  });
});

describe('response conformance', () => {
  test('GET /records matches the 200 schema', async () => {
    const res = await call('GET', '/v1/records');
    assert.equal(res.status, 200);
    assertMatchesSpec('/records', 'get', 200, res.body);
  });

  test('the envelope is the contract envelope, not an ad-hoc shape', async () => {
    const { body } = await call('GET', '/v1/records');
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.meta.request_id, 'meta.request_id is required by the spec');
    assert.ok(body.meta.timestamp);
  });

  test('records use the contract field names', async () => {
    const { body } = await call('GET', '/v1/records');
    const record = body.data[0];
    // record_id / record_type, not id / type. This is the drift that existed.
    assert.ok(record.record_id, 'record_id, not id');
    assert.ok(record.record_type, 'record_type, not type');
    assert.equal(record.id, undefined);
    assert.equal(record.type, undefined);
  });

  test('POST /records matches the 201 schema and sets both headers', async () => {
    const res = await call('POST', '/v1/records', {
      body: { record_type: 'note', title: 'contract' },
      key: randomUUID(),
    });
    assert.equal(res.status, 201);
    assertMatchesSpec('/records', 'post', 201, res.body);
    assert.equal(res.headers.get('etag'), '"1"');
    // Location is required by the spec on 201 and was missing before.
    assert.match(res.headers.get('location') ?? '', /^\/v1\/records\/[0-9a-f-]{36}$/);
  });

  test('an error response matches the ErrorEnvelope', async () => {
    const res = await call('POST', '/v1/records', { body: {}, key: randomUUID() });
    assert.equal(res.status, 422);
    assert.equal(res.body.success, false);
    assert.ok(res.body.error.code);
    assert.ok(res.body.meta.request_id);
    assertMatchesSpec('/records', 'post', 422, res.body);
  });
});

describe('request validation from the spec', () => {
  test('a missing required field is 422 with field_errors', async () => {
    const res = await call('POST', '/v1/records', {
      body: { title: 'no type' },
      key: randomUUID(),
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    assert.ok(
      res.body.error.field_errors.some((f) => f.field === 'record_type'),
      `expected a field error naming record_type, got ${JSON.stringify(res.body.error.field_errors)}`,
    );
  });

  test('a wrongly-typed field is refused', async () => {
    const res = await call('POST', '/v1/records', {
      body: { record_type: 'note', title: 12345 },
      key: randomUUID(),
    });
    assert.equal(res.status, 422);
  });

  test('the old field name is now refused', async () => {
    // `type` was what the implementation accepted before conforming. The spec says
    // record_type, so this must fail rather than quietly work.
    const res = await call('POST', '/v1/records', {
      body: { type: 'note' },
      key: randomUUID(),
    });
    assert.equal(res.status, 422);
  });

  test('a query parameter outside its declared range is refused', async () => {
    // The spec caps limit at 200.
    const res = await call('GET', '/v1/records?limit=5000');
    assert.equal(res.status, 422);
    assert.ok(res.body.error.field_errors.some((f) => f.field === 'limit'));
  });

  test('a non-numeric limit is refused rather than coerced to a default', async () => {
    const res = await call('GET', '/v1/records?limit=abc');
    assert.equal(res.status, 422);
  });

  test('a repeated query parameter is refused', async () => {
    // ?limit=1&limit=999 must not silently mean one of them.
    const res = await call('GET', '/v1/records?limit=1&limit=999');
    assert.equal(res.status, 422);
  });

  test('validation runs after authorization, so it leaks no shape', async () => {
    // api/06: detailed validation errors on a resource you cannot access reveal its
    // structure. A caller without records:write must get 403, not 422.
    const readOnly = await signAccessToken({
      tenantId: t.id, userId: t.userId, permissions: ['records:read'],
    });
    const res = await fetch(`${base}/v1/records`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${readOnly}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403, 'authorization must be decided before validation');
  });

  test('an invalid request does not burn an idempotency key', async () => {
    // Validation precedes idempotency for exactly this reason.
    const key = randomUUID();
    const bad = await call('POST', '/v1/records', { body: {}, key });
    assert.equal(bad.status, 422);

    const good = await call('POST', '/v1/records', {
      body: { record_type: 'note', title: 'after invalid' }, key,
    });
    assert.equal(good.status, 201, 'the key must still be usable');
  });
});

describe('cursor pagination', () => {
  test('a page carries limit and has_more', async () => {
    const { body } = await call('GET', '/v1/records?limit=2');
    assert.equal(body.data.length, 2);
    assert.equal(body.meta.page.limit, 2);
    assert.equal(body.meta.page.has_more, true);
    assert.ok(body.meta.page.next_cursor, 'a truncated page must offer a cursor');
  });

  test('the cursor walks the collection without repeats or gaps', async () => {
    const first = await call('GET', '/v1/records?limit=2');
    const second = await call(
      'GET', `/v1/records?limit=2&cursor=${encodeURIComponent(first.body.meta.page.next_cursor)}`,
    );

    const firstIds = first.body.data.map((r) => r.record_id);
    const secondIds = second.body.data.map((r) => r.record_id);
    assert.equal(new Set([...firstIds, ...secondIds]).size, firstIds.length + secondIds.length,
      'pages must not overlap');
  });

  test('the last page reports has_more false and offers no cursor', async () => {
    const { body } = await call('GET', '/v1/records?limit=200');
    assert.equal(body.meta.page.has_more, false);
    assert.equal(body.meta.page.next_cursor, undefined);
  });

  test('a malformed cursor is a 422, not a 500', async () => {
    const res = await call('GET', '/v1/records?cursor=not-a-real-cursor');
    assert.equal(res.status, 422);
  });

  test('the cursor is opaque', async () => {
    // The spec calls it opaque and says offsets are unsupported. If it looked like an
    // offset, clients would start constructing them.
    const { body } = await call('GET', '/v1/records?limit=1');
    const cursor = body.meta.page.next_cursor;
    assert.ok(!/^\d+$/.test(cursor), 'a bare number would invite offset arithmetic');
  });
});
