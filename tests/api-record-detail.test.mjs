// GET / PATCH / DELETE /v1/records/{id}
//
// These are the endpoints that make the ETag mean something. api/02 exposes records.version
// as an ETag and requires If-Match on every write, because the generic record model plus
// offline clients makes lost updates likely: two clients PATCH the same record and, without
// a precondition, the second silently overwrites the first.
//
// api/02 is explicit that If-Match is REQUIRED rather than optional. An optional
// precondition is one every client eventually forgets, at which point the lost update is
// back for exactly the clients that were not careful.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, asOwner, seedTenant, cleanup } from './helpers/db.mjs';

process.env.JWT_SECRET ??= 'test-secret-at-least-32-bytes-long!!';
process.env.REDIS_CACHE_URL ??= 'redis://localhost:6379';
process.env.REDIS_STATE_URL ??= 'redis://localhost:6381';

const { createApp } = await import('../dist/app.js');
const { signAccessToken } = await import('../dist/auth/token.js');
const { closePool } = await import('../dist/db/context.js');
const { closeRedis, waitForReady } = await import('../dist/redis/client.js');
const { responseValidator } = await import('../dist/openapi/spec.js');
const { flushAuditForTest } = await import('../dist/audit/phiLog.js');

let pool, server, base, t, other, token, otherToken;
const created = [];
const ALL = ['records:read', 'records:write', 'records:delete'];

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

async function call(method, path, { body, ifMatch, tok, contentType } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tok ?? token}`,
      ...(body !== undefined
        ? { 'content-type': contentType ?? 'application/merge-patch+json' } : {}),
      ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? JSON.parse(text) : null,
  };
}

async function makeRecord(tenant, title, data = {}) {
  const res = await fetch(`${base}/v1/records`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tenant === t ? token : otherToken}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ record_type: 'note', title, data }),
  });
  return (await res.json()).data;
}

before(async () => {
  pool = createPool();
  await Promise.all([waitForReady('cache'), waitForReady('state')]);
  t = await seedTenant(pool);
  other = await seedTenant(pool);
  created.push(t.id, other.id);
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
  token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: ALL });
  otherToken = await signAccessToken({
    tenantId: other.id, userId: other.userId, permissions: ALL,
  });
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await closeRedis();
  await closePool();
  await cleanup(pool, created);
  await pool.end();
});

describe('GET /records/{id}', () => {
  test('returns the record with an ETag matching its version', async () => {
    const rec = await makeRecord(t, 'gettable');
    const res = await call('GET', `/v1/records/${rec.record_id}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.record_id, rec.record_id);
    assert.equal(res.headers.get('etag'), `"${rec.version}"`);

    const validate = responseValidator('/records/{record_id}', 'get', '200');
    assert.ok(validate(res.body), JSON.stringify(validate.errors));
  });

  test("another tenant's record is 404, not 403", async () => {
    // RLS makes it invisible, and that is the correct externally-visible answer: a 403
    // would confirm the record exists. api/01, correction on tenant-mismatched resources.
    const mine = await makeRecord(t, 'private');
    const res = await call('GET', `/v1/records/${mine.record_id}`, { tok: otherToken });

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'RESOURCE_NOT_FOUND');
  });

  test('a malformed id is 404, not a database error', async () => {
    const res = await call('GET', '/v1/records/not-a-uuid');
    assert.equal(res.status, 404);
  });

  test('an unknown id is 404', async () => {
    const res = await call('GET', `/v1/records/${randomUUID()}`);
    assert.equal(res.status, 404);
  });

  test('a PHI read is recorded', async () => {
    const phi = await seedTenant(pool, { isPhi: true });
    created.push(phi.id);
    const phiToken = await signAccessToken({
      tenantId: phi.id, userId: phi.userId, permissions: ALL,
    });

    const res = await fetch(`${base}/v1/records`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${phiToken}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ record_type: 'note', title: 'phi-detail' }),
    });
    const rec = (await res.json()).data;

    await call('GET', `/v1/records/${rec.record_id}`, { tok: phiToken });
    await flushAuditForTest();

    const n = await asOwner(pool, async (c) => {
      const { rows } = await c.query(
        `SELECT COUNT(*)::int AS n FROM user_audit_log
          WHERE tenant_id = $1 AND action = 'view' AND is_phi_access = TRUE`, [phi.id]);
      return rows[0].n;
    });
    assert.ok(n >= 1, 'reading a PHI record must be logged');
  });
});

describe('If-Match preconditions', () => {
  test('PATCH without If-Match is 428, not a silent overwrite', async () => {
    const rec = await makeRecord(t, 'unguarded');
    const res = await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { title: 'changed' },
    });

    assert.equal(res.status, 428);
    assert.equal(res.body.error.code, 'PRECONDITION_REQUIRED');

    const after = await call('GET', `/v1/records/${rec.record_id}`);
    assert.equal(after.body.data.title, 'unguarded', 'nothing may have been written');
  });

  test('DELETE without If-Match is 428', async () => {
    const rec = await makeRecord(t, 'undeleted');
    const res = await call('DELETE', `/v1/records/${rec.record_id}`);
    assert.equal(res.status, 428);

    const after = await call('GET', `/v1/records/${rec.record_id}`);
    assert.equal(after.status, 200, 'the record must still be there');
  });

  test('a stale If-Match is 412 and reports both versions', async () => {
    const rec = await makeRecord(t, 'racy');

    const first = await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { title: 'first writer' }, ifMatch: `"${rec.version}"`,
    });
    assert.equal(first.status, 200);

    // The second client still believes it holds version 1 — the lost update, caught.
    const second = await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { title: 'second writer' }, ifMatch: `"${rec.version}"`,
    });

    assert.equal(second.status, 412);
    assert.equal(second.body.error.details.expected_version, rec.version);
    assert.equal(second.body.error.details.current_version, rec.version + 1);

    const after = await call('GET', `/v1/records/${rec.record_id}`);
    assert.equal(after.body.data.title, 'first writer', 'the first write must survive');
  });

  test('If-Match: * is refused', async () => {
    // Valid in the grammar and useless here: it matches whatever the record happens to be,
    // which defeats the entire point of the precondition.
    const rec = await makeRecord(t, 'star');
    const res = await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { title: 'x' }, ifMatch: '*',
    });
    assert.equal(res.status, 428);
  });

  test('a weak validator is refused', async () => {
    const rec = await makeRecord(t, 'weak');
    const res = await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { title: 'x' }, ifMatch: `W/"${rec.version}"`,
    });
    assert.equal(res.status, 428);
  });

  test('an unquoted version is accepted', async () => {
    // Clients strip the quotes often enough that being right about the grammar is less
    // useful than being usable.
    const rec = await makeRecord(t, 'unquoted');
    const res = await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { title: 'ok' }, ifMatch: String(rec.version),
    });
    assert.equal(res.status, 200);
  });
});

describe('PATCH semantics', () => {
  test('an absent field is left alone', async () => {
    const rec = await makeRecord(t, 'keeper');
    await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { description: 'added' }, ifMatch: `"${rec.version}"`,
    });

    const after = await call('GET', `/v1/records/${rec.record_id}`);
    assert.equal(after.body.data.title, 'keeper', 'an unmentioned field must survive');
    assert.equal(after.body.data.description, 'added');
  });

  test('an explicit null clears a field — RFC 7396', async () => {
    // The rule that is easy to get backwards. null means delete, not "set to null";
    // without it a client has no way to clear a field at all.
    const rec = await makeRecord(t, 'clearable');
    await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { description: 'present' }, ifMatch: `"${rec.version}"`,
    });

    const mid = await call('GET', `/v1/records/${rec.record_id}`);
    assert.equal(mid.body.data.description, 'present');

    await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { description: null }, ifMatch: `"${mid.body.data.version}"`,
    });

    const after = await call('GET', `/v1/records/${rec.record_id}`);
    assert.equal(after.body.data.description, undefined, 'null must clear the field');
  });

  test('data merges recursively rather than replacing', async () => {
    const rec = await makeRecord(t, 'merging', { a: 1, nested: { x: 1, y: 2 } });
    await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { data: { nested: { y: 99 } } }, ifMatch: `"${rec.version}"`,
    });

    const data = await asOwner(pool, async (c) => {
      const { rows } = await c.query('SELECT data FROM records WHERE record_id = $1',
        [rec.record_id]);
      return rows[0].data;
    });

    assert.equal(data.a, 1, 'untouched top-level keys survive');
    assert.equal(data.nested.x, 1, 'untouched nested keys survive');
    assert.equal(data.nested.y, 99, 'the patched key is updated');
  });

  test('a null inside data deletes that key', async () => {
    const rec = await makeRecord(t, 'deleting', { keep: 1, drop: 2 });
    await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { data: { drop: null } }, ifMatch: `"${rec.version}"`,
    });

    const data = await asOwner(pool, async (c) => {
      const { rows } = await c.query('SELECT data FROM records WHERE record_id = $1',
        [rec.record_id]);
      return rows[0].data;
    });
    assert.equal(data.keep, 1);
    assert.equal('drop' in data, false);
  });

  test('the version increments on every update', async () => {
    const rec = await makeRecord(t, 'versioned');
    const res = await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { title: 'bumped' }, ifMatch: `"${rec.version}"`,
    });

    assert.equal(res.body.data.version, rec.version + 1);
    assert.equal(res.headers.get('etag'), `"${rec.version + 1}"`);
  });

  test('immutable fields are refused', async () => {
    // record_type is part of the FK to record_type_definitions and decides whether the row
    // is PHI. Changing it by patch would move a record between types, and with it whether
    // its reads are audited.
    const rec = await makeRecord(t, 'immutable');
    const res = await call('PATCH', `/v1/records/${rec.record_id}`, {
      body: { record_type: 'other' }, ifMatch: `"${rec.version}"`,
    });

    assert.equal(res.status, 422);
    assert.ok(res.body.error.field_errors.some((f) => f.field === 'record_type'));
  });

  test('patching another tenant record is 404', async () => {
    const mine = await makeRecord(t, 'not-yours');
    const res = await call('PATCH', `/v1/records/${mine.record_id}`, {
      body: { title: 'hijacked' }, ifMatch: `"${mine.version}"`, tok: otherToken,
    });
    assert.equal(res.status, 404);
  });
});

describe('DELETE', () => {
  test('a delete is soft and returns 204 with no body', async () => {
    const rec = await makeRecord(t, 'soft');
    const res = await call('DELETE', `/v1/records/${rec.record_id}`, {
      ifMatch: `"${rec.version}"`,
    });

    assert.equal(res.status, 204);
    assert.equal(res.body, null);

    // The row survives — a hard delete would take it out from under its audit history and
    // database/04's retention model expects it to persist until a purge job removes it.
    const row = await asOwner(pool, async (c) => {
      const { rows } = await c.query(
        'SELECT deleted_at FROM records WHERE record_id = $1', [rec.record_id]);
      return rows[0];
    });
    assert.ok(row, 'the row must still exist');
    assert.ok(row.deleted_at, 'deleted_at must be set');
  });

  test('a deleted record is 404 afterwards', async () => {
    const rec = await makeRecord(t, 'gone');
    await call('DELETE', `/v1/records/${rec.record_id}`, { ifMatch: `"${rec.version}"` });

    const res = await call('GET', `/v1/records/${rec.record_id}`);
    assert.equal(res.status, 404);
  });

  test('a deleted record no longer appears in the list', async () => {
    const rec = await makeRecord(t, 'listed-then-gone');
    await call('DELETE', `/v1/records/${rec.record_id}`, { ifMatch: `"${rec.version}"` });

    const list = await call('GET', '/v1/records?limit=200');
    assert.ok(!list.body.data.some((r) => r.record_id === rec.record_id));
  });

  test('deleting twice is 404, not a second delete', async () => {
    const rec = await makeRecord(t, 'twice');
    await call('DELETE', `/v1/records/${rec.record_id}`, { ifMatch: `"${rec.version}"` });

    const res = await call('DELETE', `/v1/records/${rec.record_id}`, {
      ifMatch: `"${rec.version}"`,
    });
    assert.equal(res.status, 404);
  });

  test('deleting needs records:delete, not records:write', async () => {
    const rec = await makeRecord(t, 'perm');
    const writeOnly = await signAccessToken({
      tenantId: t.id, userId: t.userId, permissions: ['records:read', 'records:write'],
    });
    const res = await call('DELETE', `/v1/records/${rec.record_id}`, {
      ifMatch: `"${rec.version}"`, tok: writeOnly,
    });
    assert.equal(res.status, 403);
  });
});
