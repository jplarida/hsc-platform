// The API layer's tenant boundary.
//
// tests/tenant-isolation.test.mjs proves RLS holds at the database. This proves the HTTP
// layer cannot get around it — which is a different claim, and the one api/01's
// correction 1 is about: a valid token plus a forged X-Tenant-ID must not read another
// tenant's data.
//
// Tokens here are genuinely signed and genuinely verified. Stubbing authentication would
// leave the stage 6 -> stage 8 ordering — the thing actually under test — unexercised.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, seedTenant, createRecord, cleanup } from './helpers/db.mjs';

process.env.JWT_SECRET ??= 'test-secret-at-least-32-bytes-long!!';

const { createApp } = await import('../dist/app.js');
const { signAccessToken, CLOCK_TOLERANCE_SECONDS } = await import('../dist/auth/token.js');
const { closePool } = await import('../dist/db/context.js');

let pool;
let server;
let base;
let a, b;
const created = [];

const READ = ['records:read'];

/** Start the app on an ephemeral port so the suite never collides with a dev server. */
function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function get(path, { token, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

before(async () => {
  pool = createPool();
  a = await seedTenant(pool);
  b = await seedTenant(pool);
  created.push(a.id, b.id);

  await createRecord(pool, a, 'A-one');
  await createRecord(pool, a, 'A-two');
  await createRecord(pool, b, 'B-one');

  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closePool();
  await cleanup(pool, created);
  await pool.end();
});

describe('api authentication', () => {
  test('no Authorization header is 401', async () => {
    const { status, body } = await get('/v1/records');
    assert.equal(status, 401);
    assert.equal(body.error.code, 'MISSING_AUTHORIZATION');
  });

  test('a garbage token is 401 INVALID_TOKEN', async () => {
    const { status, body } = await get('/v1/records', { token: 'not-a-jwt' });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'INVALID_TOKEN');
  });

  test('an expired token is distinguishable from an invalid one', async () => {
    // api/01: clients need to tell "refresh and retry" from "log in again". Collapsing
    // both into INVALID_TOKEN forces every client to guess.
    const token = await signAccessToken({
      tenantId: a.id, userId: a.userId, permissions: READ, expiresIn: '-60s',
    });
    const { status, body } = await get('/v1/records', { token });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'TOKEN_EXPIRED');
  });

  test('clock tolerance is bounded and deliberate', async () => {
    // This pair exists because the first version of the expiry test failed for the wrong
    // reason: a token that had expired one second earlier was still accepted, because
    // verification allows CLOCK_TOLERANCE_SECONDS of skew past exp. That is a defensible
    // trade — issuer and verifier clocks do drift — but it is a grace period on an
    // expired credential, so it is asserted in both directions rather than left implicit.
    const within = await signAccessToken({
      tenantId: a.id, userId: a.userId, permissions: READ, expiresIn: '-1s',
    });
    assert.equal((await get('/v1/records', { token: within })).status, 200,
      `a token expired by less than ${CLOCK_TOLERANCE_SECONDS}s is still accepted`);

    const beyond = await signAccessToken({
      tenantId: a.id, userId: a.userId, permissions: READ,
      expiresIn: `-${CLOCK_TOLERANCE_SECONDS + 5}s`,
    });
    assert.equal((await get('/v1/records', { token: beyond })).status, 401,
      'beyond the tolerance a token must be refused');
  });

  test('a token with no tenant claim is refused, not treated as empty', async () => {
    // A token that verifies but carries no tenant must not fall through to a null
    // context, which RLS would render as an empty result — a confusing 200 where 401
    // is correct.
    const { SignJWT } = await import('jose');
    const noTenant = await new SignJWT({ permissions: READ })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(a.userId)
      .setIssuer('hsc-platform')
      .setAudience('hsc-api')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    const { status, body } = await get('/v1/records', { token: noTenant });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'INVALID_TOKEN');
  });

  test('a token signed with the wrong secret is rejected', async () => {
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({ tenant_id: a.id, permissions: READ })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(a.userId)
      .setIssuer('hsc-platform')
      .setAudience('hsc-api')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-different-secret-32-bytes-long!!!!'));

    const { status } = await get('/v1/records', { token: forged });
    assert.equal(status, 401);
  });

  test('every response carries a request id', async () => {
    const res = await fetch(`${base}/v1/records`);
    assert.ok(res.headers.get('x-request-id'), 'X-Request-Id must be set on errors too');
  });
});

describe('api authorization', () => {
  test('a token without records:read is 403', async () => {
    const token = await signAccessToken({ tenantId: a.id, userId: a.userId, permissions: [] });
    const { status, body } = await get('/v1/records', { token });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'INSUFFICIENT_PERMISSIONS');
  });
});

describe('api tenant isolation', () => {
  test('a tenant sees only its own records', async () => {
    const token = await signAccessToken({ tenantId: a.id, userId: a.userId, permissions: READ });
    const { status, body } = await get('/v1/records', { token });
    assert.equal(status, 200);
    assert.equal(body.data.length, 2);
    assert.ok(body.data.every((r) => r.title.startsWith('A-')));
  });

  test('the other tenant sees only its own', async () => {
    const token = await signAccessToken({ tenantId: b.id, userId: b.userId, permissions: READ });
    const { body } = await get('/v1/records', { token });
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].title, 'B-one');
  });

  test('a forged X-Tenant-ID cannot reach another tenant — api/01 correction 1', async () => {
    // THE test for this slice. A valid token for tenant B, plus a header naming tenant A.
    // If tenancy were resolved from the header before the token were verified — the order
    // API_ARCHITECTURE.md specifies — this would return tenant A's records and RLS would
    // enforce the attacker's choice without raising anything.
    const token = await signAccessToken({ tenantId: b.id, userId: b.userId, permissions: READ });
    const { status, body } = await get('/v1/records', {
      token,
      headers: { 'x-tenant-id': a.id },
    });

    assert.equal(status, 403);
    assert.equal(body.error.code, 'TENANT_MISMATCH');
  });

  test('an agreeing X-Tenant-ID is a harmless no-op', async () => {
    // Browsers and proxies genuinely send stale headers; a matching one must not break
    // an otherwise valid request.
    const token = await signAccessToken({ tenantId: a.id, userId: a.userId, permissions: READ });
    const { status, body } = await get('/v1/records', {
      token,
      headers: { 'x-tenant-id': a.id },
    });
    assert.equal(status, 200);
    assert.equal(body.data.length, 2);
  });

  test('the type filter cannot escape the tenant', async () => {
    const token = await signAccessToken({ tenantId: b.id, userId: b.userId, permissions: READ });
    const { body } = await get('/v1/records?type=note', { token });
    assert.equal(body.data.length, 1, 'filtering must narrow within the tenant, never widen');
  });
});

describe('api hygiene', () => {
  test('healthz needs no authentication and leaks nothing', async () => {
    const { status, body } = await get('/healthz');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok' });
  });

  test('authenticated responses are not cacheable', async () => {
    const token = await signAccessToken({ tenantId: a.id, userId: a.userId, permissions: READ });
    const res = await fetch(`${base}/v1/records`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  });

  test('the server does not advertise itself', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});
