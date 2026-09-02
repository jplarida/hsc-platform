// Session revocation (stage 7) and rate limiting (stage 9).
//
// The limiter tests are written against the two defects api/03 found in the
// implementation API_ARCHITECTURE.md gives: an off-by-one that let every tier serve
// limit + 1, and denied requests consuming the window so a throttled client pushed its
// own reset forward indefinitely. Both are asserted directly, because both look correct
// in a casual read and neither shows up under light load.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, asOwner, seedTenant, cleanup } from './helpers/db.mjs';

process.env.JWT_SECRET ??= 'test-secret-at-least-32-bytes-long!!';
process.env.REDIS_CACHE_URL ??= 'redis://localhost:6379';
process.env.REDIS_STATE_URL ??= 'redis://localhost:6381';

const { createApp } = await import('../dist/app.js');
const { signAccessToken } = await import('../dist/auth/token.js');
const { closePool } = await import('../dist/db/context.js');
const { closeRedis, redis, waitForReady } = await import('../dist/redis/client.js');
const { keys, checkLimit } = await import('../dist/ratelimit/limiter.js');
const { invalidatePlanLimits } = await import('../dist/services/planLimits.js');

let pool, server, base, t;
const created = [];
const READ = ['records:read'];

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

async function get(path, token, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

/** Give the tenant a tiny plan so limits are reachable in a test. */
async function setPlanLimits(tenantId, limits) {
  await asOwner(pool, (c) => c.query(
    `UPDATE plans SET limits = $2::jsonb
      WHERE plan_id = (SELECT plan_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1)`,
    [tenantId, JSON.stringify(limits)]));
  await invalidatePlanLimits(tenantId);
}

before(async () => {
  pool = createPool();
  // Connections are lazy; without this the first checkLimit calls return
  // indeterminate and the algorithm assertions measure nothing.
  await Promise.all([waitForReady('cache'), waitForReady('state')]);
  t = await seedTenant(pool);
  created.push(t.id);
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // fetch keeps connections alive, and server.close() waits for them — without this
  // the suite hangs on teardown once a second file has made requests.
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await closeRedis();
  await closePool();
  await cleanup(pool, created);
  await pool.end();
});

describe('rate limiter algorithm', () => {
  test('the limit is exact, not off by one — api/03 bug 1', async () => {
    // The documented implementation read the count BEFORE adding and compared
    // count <= limit, so a limit of N served N + 1. Three requests against a limit of
    // three must all pass; the fourth must not.
    const key = `rl:test:${Date.now()}:exact`;
    const rule = { key, limit: 3, windowMs: 60_000, scope: 'tenant' };

    for (let i = 1; i <= 3; i += 1) {
      const d = await checkLimit(rule, `req-${i}`);
      assert.equal(d.allowed, true, `request ${i} of 3 should be allowed`);
    }
    const fourth = await checkLimit(rule, 'req-4');
    assert.equal(fourth.allowed, false, 'a limit of 3 must not serve a 4th request');
    assert.equal(fourth.remaining, 0);
  });

  test('a denied request does not consume the window — api/03 bug 2', async () => {
    // The documented implementation ran ZADD unconditionally, so a client already over
    // its limit kept adding entries and kept pushing its own reset forward. Here the
    // reset must not move when a denied request is repeated.
    const key = `rl:test:${Date.now()}:drain`;
    const rule = { key, limit: 2, windowMs: 60_000, scope: 'tenant' };

    await checkLimit(rule, 'a');
    await checkLimit(rule, 'b');

    const first = await checkLimit(rule, 'c');
    assert.equal(first.allowed, false);

    await new Promise((r) => setTimeout(r, 1100));
    const second = await checkLimit(rule, 'd');
    assert.equal(second.allowed, false);

    // If denials were recorded, the window would keep sliding forward and reset would
    // stay flat or grow. Draining correctly means it shrinks as the oldest entry ages.
    assert.ok(second.resetSeconds <= first.resetSeconds,
      `reset must drain, not advance (${first.resetSeconds} -> ${second.resetSeconds})`);
  });

  test('reset is derived from the oldest entry, not now + window', async () => {
    // A sliding window frees its next slot when the oldest request ages out, which is
    // sooner than a full window away. Returning now + window overstates the wait and
    // makes well-behaved clients back off far longer than necessary.
    const key = `rl:test:${Date.now()}:reset`;
    const rule = { key, limit: 1, windowMs: 10_000, scope: 'tenant' };

    await checkLimit(rule, 'first');
    await new Promise((r) => setTimeout(r, 2100));

    const denied = await checkLimit(rule, 'second');
    assert.equal(denied.allowed, false);
    assert.ok(denied.resetSeconds < 10,
      `reset ${denied.resetSeconds}s should be less than the full 10s window`);
  });

  test('the token bucket is used above the log threshold and allows a burst', async () => {
    // Above 1,000 the log's memory cost is the problem api/03 quantifies, so the
    // algorithm switches. A bucket starts full, so a burst is permitted.
    const key = `rl:test:${Date.now()}:bucket`;
    const rule = { key, limit: 5_000, windowMs: 3_600_000, scope: 'tenant' };

    for (let i = 0; i < 20; i += 1) {
      const d = await checkLimit(rule, `burst-${i}`);
      assert.equal(d.allowed, true, 'a full bucket must permit a burst');
    }
    const d = await checkLimit(rule, 'after');
    assert.ok(d.remaining < 5_000, 'tokens must be consumed');
  });
});

describe('rate limiting over HTTP', () => {
  test('a tenant over its hourly limit gets 429 with Retry-After', async () => {
    await setPlanLimits(t.id, { requests_per_hour: 2, user_requests_per_minute: 100 });
    await redis('state').del(keys.tenantHour(t.id));

    const token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: READ });

    assert.equal((await get('/v1/records', token)).status, 200);
    assert.equal((await get('/v1/records', token)).status, 200);

    const third = await get('/v1/records', token);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(third.headers.get('retry-after'), 'Retry-After is mandatory on 429');
    // scope tells the client whether backing off helps, or whether the whole tenant is
    // blocked and waiting alone will not.
    assert.equal(third.body.error.details.scope, 'tenant');
  });

  test('the two Reset headers carry genuinely different units', async () => {
    // api/03 calls emitting the same number in both a common and confusing bug.
    // RateLimit-Reset is seconds remaining; X-RateLimit-Reset is a Unix timestamp.
    await setPlanLimits(t.id, { requests_per_hour: 100, user_requests_per_minute: 100 });
    await redis('state').del(keys.tenantHour(t.id));

    const token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: READ });
    const res = await get('/v1/records', token);

    const seconds = Number(res.headers.get('ratelimit-reset'));
    const stamp = Number(res.headers.get('x-ratelimit-reset'));

    assert.ok(seconds < 100_000, 'RateLimit-Reset should be a duration in seconds');
    assert.ok(stamp > 1_700_000_000, 'X-RateLimit-Reset should be a Unix timestamp');
    assert.notEqual(seconds, stamp);
  });

  test('limits come from the plan, so a change takes effect without a deploy', async () => {
    await setPlanLimits(t.id, { requests_per_hour: 1, user_requests_per_minute: 100 });
    await redis('state').del(keys.tenantHour(t.id));

    const token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: READ });
    assert.equal((await get('/v1/records', token)).status, 200);
    assert.equal((await get('/v1/records', token)).status, 429);

    // Raise the plan; the limiter must pick it up from the row, not from code.
    await setPlanLimits(t.id, { requests_per_hour: 500, user_requests_per_minute: 100 });
    await redis('state').del(keys.tenantHour(t.id));
    assert.equal((await get('/v1/records', token)).status, 200);
  });
});

describe('session revocation — stage 7', () => {
  test('a token for a revoked session is refused', async () => {
    const sessionId = await asOwner(pool, async (c) => {
      const { rows: [s] } = await c.query(
        `INSERT INTO sessions (tenant_id, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour') RETURNING session_id`,
        [t.id, t.userId]);
      return s.session_id;
    });

    await setPlanLimits(t.id, { requests_per_hour: 1000, user_requests_per_minute: 1000 });
    await redis('state').del(keys.tenantHour(t.id));

    const token = await signAccessToken({
      tenantId: t.id, userId: t.userId, sessionId, permissions: READ,
    });

    assert.equal((await get('/v1/records', token)).status, 200, 'live session works');

    // Revoke it — a logout, password change or admin action does exactly this.
    await asOwner(pool, (c) => c.query(
      `UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'logout'
        WHERE session_id = $1`, [sessionId]));
    const { invalidateSession } = await import('../dist/services/sessions.js');
    await invalidateSession(t.id, sessionId);

    const after = await get('/v1/records', token);
    assert.equal(after.status, 401, 'a revoked session must stop working immediately');
    // TOKEN_REVOKED, not INVALID_TOKEN: the client should log in again, not refresh.
    assert.equal(after.body.error.code, 'TOKEN_REVOKED');
  });

  test('an expired session is treated as revoked', async () => {
    const sessionId = await asOwner(pool, async (c) => {
      const { rows: [s] } = await c.query(
        `INSERT INTO sessions (tenant_id, user_id, expires_at)
         VALUES ($1, $2, NOW() - INTERVAL '1 minute') RETURNING session_id`,
        [t.id, t.userId]);
      return s.session_id;
    });

    const token = await signAccessToken({
      tenantId: t.id, userId: t.userId, sessionId, permissions: READ,
    });
    const res = await get('/v1/records', token);
    assert.equal(res.status, 401);
  });

  test('a token naming a session that does not exist is refused', async () => {
    const token = await signAccessToken({
      tenantId: t.id, userId: t.userId,
      sessionId: '00000000-0000-0000-0000-0000000000ff', permissions: READ,
    });
    assert.equal((await get('/v1/records', token)).status, 401);
  });

  test('a token with no session id still works — API keys have no session', async () => {
    // Rejecting these would break every machine-to-machine route. Their revocation lives
    // in api_keys.revoked_at and app_tokens.revoked_at instead.
    await setPlanLimits(t.id, { requests_per_hour: 1000, user_requests_per_minute: 1000 });
    await redis('state').del(keys.tenantHour(t.id));

    const token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: READ });
    assert.equal((await get('/v1/records', token)).status, 200);
  });
});
