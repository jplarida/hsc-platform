// Caching, cross-task invalidation, CORS and the pre-auth IP limit.
//
// performance/01 applies three invalidation strategies deliberately rather than uniformly,
// and the tests below are organised around why each one was chosen: version stamping where
// a version column exists, TTL where a bounded stale window is acceptable, and pub/sub only
// where staleness is a security problem.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, asOwner, seedTenant, cleanup } from './helpers/db.mjs';

process.env.JWT_SECRET ??= 'test-secret-at-least-32-bytes-long!!';
process.env.REDIS_CACHE_URL ??= 'redis://localhost:6379';
process.env.REDIS_STATE_URL ??= 'redis://localhost:6381';
process.env.CORS_ALLOWED_ORIGINS ??= 'https://app.example.test,*.tenants.example.test';

const { createApp } = await import('../dist/app.js');
const { signAccessToken } = await import('../dist/auth/token.js');
const { closePool, deriveContext } = await import('../dist/db/context.js');
const { closeRedis, waitForReady, redis } = await import('../dist/redis/client.js');
const { tenantConfig, bumpConfigVersion } = await import('../dist/services/tenantConfig.js');
const { isSessionLive, invalidateSession, subscribeToSessionInvalidation } =
  await import('../dist/services/sessions.js');
const { startInvalidationListener, stopInvalidationListener, publishInvalidation } =
  await import('../dist/redis/invalidation.js');

let pool, server, base, t, ctx;
const created = [];

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

before(async () => {
  pool = createPool();
  await Promise.all([waitForReady('cache'), waitForReady('state')]);
  t = await seedTenant(pool);
  created.push(t.id);
  ctx = deriveContext({ tenantId: t.id, userId: t.userId });

  await asOwner(pool, (c) => c.query(
    `INSERT INTO tenant_configurations (tenant_id, app_name, company_name, industry_type)
     VALUES ($1, 'Before', 'Before Ltd', 'healthcare')
     ON CONFLICT (tenant_id) DO UPDATE SET app_name = 'Before'`, [t.id]));

  startInvalidationListener();
  subscribeToSessionInvalidation();
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await stopInvalidationListener();
  await closeRedis();
  await closePool();
  await cleanup(pool, created);
  await pool.end();
});

describe('tenant config: version-stamped caching', () => {
  test('a config is readable and cached under its version', async () => {
    const config = await tenantConfig(ctx);
    assert.equal(config.appName, 'Before');

    const key = `cfg:${t.id}:v:${config.configVersion}`;
    const raw = await redis('cache').get(key);
    assert.ok(raw, 'the payload must be cached under a version-stamped key');
  });

  test('bumping the version makes a change visible without deleting anything', async () => {
    // The property that makes version stamping better than invalidation: there is no
    // message to lose and no ordering race. A reader either has the new version and
    // misses, or has the old one and correctly reads old data.
    const before = await tenantConfig(ctx);

    await asOwner(pool, (c) => c.query(
      `UPDATE tenant_configurations SET app_name = 'After' WHERE tenant_id = $1`, [t.id]));
    const newVersion = await bumpConfigVersion(ctx);

    assert.equal(newVersion, before.configVersion + 1);

    const after = await tenantConfig(ctx);
    assert.equal(after.appName, 'After');
    assert.equal(after.configVersion, newVersion);

    // The OLD key is still present and still correct for anyone holding that version.
    const oldRaw = await redis('cache').get(`cfg:${t.id}:v:${before.configVersion}`);
    assert.ok(oldRaw, 'the previous version must remain readable, not be deleted');
    assert.equal(JSON.parse(oldRaw).appName, 'Before');
  });

  test('a cache outage makes config reads slower, not wrong', async () => {
    // Redis is a cache, not a dependency. Deleting every key must change nothing a caller
    // can observe except latency.
    const keys = await redis('cache').keys(`cfg:${t.id}:*`);
    if (keys.length > 0) await redis('cache').del(...keys);

    const config = await tenantConfig(ctx);
    assert.equal(config.appName, 'After', 'the source of truth still answers');
  });
});

describe('session invalidation: pub/sub', () => {
  test('a published invalidation drops the key on a listening task', async () => {
    // The case where TTL alone is not good enough. With 2-20 API tasks, one task deleting
    // its own copy leaves the rest admitting a revoked token until their copies expire.
    const sessionId = await asOwner(pool, async (c) => {
      const { rows: [s] } = await c.query(
        `INSERT INTO sessions (tenant_id, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour') RETURNING session_id`,
        [t.id, t.userId]);
      return s.session_id;
    });

    assert.equal(await isSessionLive(ctx, sessionId), 'live');
    const key = `sess:${t.id}:s:${sessionId}`;
    assert.ok(await redis('cache').get(key), 'the check should have cached its answer');

    await publishInvalidation({ ns: 'sess', tenant: t.id, key: sessionId });

    // Pub/sub is asynchronous; give the subscriber a moment to receive it.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await redis('cache').get(key), null,
      'the subscriber must have dropped the cached entry');
  });

  test('revoking publishes as well as deleting locally', async () => {
    const sessionId = await asOwner(pool, async (c) => {
      const { rows: [s] } = await c.query(
        `INSERT INTO sessions (tenant_id, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour') RETURNING session_id`,
        [t.id, t.userId]);
      return s.session_id;
    });

    await isSessionLive(ctx, sessionId);
    await invalidateSession(t.id, sessionId);
    await new Promise((r) => setTimeout(r, 250));

    assert.equal(await redis('cache').get(`sess:${t.id}:s:${sessionId}`), null);
  });

  test('the TTL remains as a backstop', async () => {
    // Pub/sub is best effort: a task disconnected at the moment of publication never
    // receives the message. The TTL is what covers that, so it must still be set.
    const sessionId = await asOwner(pool, async (c) => {
      const { rows: [s] } = await c.query(
        `INSERT INTO sessions (tenant_id, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour') RETURNING session_id`,
        [t.id, t.userId]);
      return s.session_id;
    });

    await isSessionLive(ctx, sessionId);
    const ttl = await redis('cache').ttl(`sess:${t.id}:s:${sessionId}`);
    assert.ok(ttl > 0 && ttl <= 60, `expected a bounded TTL, got ${ttl}`);
  });
});

describe('CORS', () => {
  test('an allowed origin is reflected with credentials and Vary', async () => {
    const res = await fetch(`${base}/healthz`, {
      headers: { origin: 'https://app.example.test' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.test');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    // Without Vary a shared cache can serve one origin's response, complete with its
    // Allow-Origin header, to a different origin.
    assert.match(res.headers.get('vary') ?? '', /Origin/);
  });

  test('a wildcard subdomain matches on the dot boundary', async () => {
    const ok = await fetch(`${base}/healthz`, {
      headers: { origin: 'https://acme.tenants.example.test' },
    });
    assert.equal(ok.headers.get('access-control-allow-origin'),
      'https://acme.tenants.example.test');
  });

  test('a lookalike domain is not allowed', async () => {
    // "evil-tenants.example.test" must not satisfy "*.tenants.example.test".
    const res = await fetch(`${base}/healthz`, {
      headers: { origin: 'https://evil-tenants.example.test' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('an unknown origin gets no CORS headers at all', async () => {
    const res = await fetch(`${base}/healthz`, {
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });

  test('the response is never a wildcard origin', async () => {
    // `*` cannot be combined with credentials, and reflecting any origin alongside
    // Allow-Credentials is a standing CSRF invitation.
    const res = await fetch(`${base}/healthz`, {
      headers: { origin: 'https://app.example.test' },
    });
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  });

  test('a preflight is answered without reaching authentication', async () => {
    const res = await fetch(`${base}/v1/records`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.test',
        'access-control-request-method': 'POST',
      },
    });
    // 204, not 401: a preflight carries no credentials, so running it through auth would
    // reject it and break every browser client.
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
  });

  test('a preflight from an unknown origin is refused', async () => {
    const res = await fetch(`${base}/v1/records`, {
      method: 'OPTIONS',
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(res.status, 403);
  });
});

describe('pre-auth IP rate limit', () => {
  test('it runs before authentication', async () => {
    // The ordering that matters: auth does password hashing and database work, so an
    // unauthenticated flood must be refused before paying for any of it. An unauthenticated
    // request should still reach 401 under normal conditions.
    const res = await fetch(`${base}/v1/records`);
    assert.equal(res.status, 401, 'the IP limit must not block ordinary traffic');
  });

  test('a flood from one address is throttled', async () => {
    const key = `rl:anon:ip:127.0.0.1:login`;
    await redis('state').del(key);

    const limit = Number(process.env.IP_RATE_LIMIT_PER_MINUTE ?? 300);
    let sawThrottle = false;

    // Deliberately unauthenticated: this limit applies before any token is examined.
    for (let i = 0; i < limit + 5; i += 1) {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 429) { sawThrottle = true; break; }
    }

    assert.ok(sawThrottle, 'a sustained flood from one address must eventually be refused');
    await redis('state').del(key);
  });
});
