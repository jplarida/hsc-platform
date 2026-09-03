// Idempotency — stage 12 — and the first mutation endpoint.
//
// api/02: mobile clients retry over unreliable networks, and a retried POST otherwise
// creates a duplicate. The tests below cover the three outcomes that matter — replay,
// key reuse with a different body, and a concurrent duplicate — plus the write path
// itself reaching the database and the audit trigger.

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
const { flushAuditForTest } = await import('../dist/audit/phiLog.js');

let pool, server, base, t, token;
const created = [];
const WRITE = ['records:read', 'records:write'];

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

async function post(path, body, { key, tok } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(tok ?? token ? { authorization: `Bearer ${tok ?? token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: await res.json().catch(() => null),
  };
}

async function countRecords(tenantId, title) {
  return asOwner(pool, async (c) => {
    const { rows } = await c.query(
      'SELECT COUNT(*)::int AS n FROM records WHERE tenant_id = $1 AND title = $2',
      [tenantId, title]);
    return rows[0].n;
  });
}

before(async () => {
  pool = createPool();
  await Promise.all([waitForReady('cache'), waitForReady('state')]);
  t = await seedTenant(pool);
  created.push(t.id);
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
  token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: WRITE });
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await closeRedis();
  await closePool();
  await cleanup(pool, created);
  await pool.end();
});

describe('creating a record', () => {
  test('a valid create returns 201 with an ETag', async () => {
    const res = await post('/v1/records', { record_type: 'note', title: 'first' }, { key: randomUUID() });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.record_type, 'note');
    assert.equal(res.body.data.version, 1);
    // The version is the ETag api/02 uses for optimistic concurrency on later writes.
    assert.equal(res.headers.get('etag'), '"1"');
  });

  test('the row actually reaches the database', async () => {
    await post('/v1/records', { record_type: 'note', title: 'persisted' }, { key: randomUUID() });
    assert.equal(await countRecords(t.id, 'persisted'), 1);
  });

  test('a create writes a data_audit_log row', async () => {
    // The trigger fires on INSERT; this confirms the write path runs inside a tenant
    // context, since without one the trigger cannot resolve a tenant and raises.
    await post('/v1/records', { record_type: 'note', title: 'audited-create' }, { key: randomUUID() });
    const n = await asOwner(pool, async (c) => {
      const { rows } = await c.query(
        `SELECT COUNT(*)::int AS n FROM data_audit_log
          WHERE tenant_id = $1 AND table_name = 'records' AND operation = 'INSERT'`, [t.id]);
      return rows[0].n;
    });
    assert.ok(n >= 1, 'an insert must be audited');
  });

  test('a missing type is 422, not a 500', async () => {
    const res = await post('/v1/records', { title: 'no type' }, { key: randomUUID() });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  test('an unknown record type is refused by the foreign key', async () => {
    // fk_records_type ties every record to a declared type per tenant, so a typo fails
    // loudly instead of creating an invisible orphan class of records.
    const res = await post('/v1/records', { record_type: 'not-a-real-type' }, { key: randomUUID() });
    assert.ok(res.status >= 400, 'an undeclared type must not be insertable');
  });

  test('writing needs records:write, not just records:read', async () => {
    const readOnly = await signAccessToken({
      tenantId: t.id, userId: t.userId, permissions: ['records:read'],
    });
    const res = await post('/v1/records', { record_type: 'note' }, { key: randomUUID(), tok: readOnly });
    assert.equal(res.status, 403);
  });
});

describe('idempotency', () => {
  test('the key is required on this endpoint', async () => {
    // api/02 lists POST /records explicitly. Optional would mean every client that
    // forgets silently reintroduces duplicates.
    const res = await post('/v1/records', { record_type: 'note', title: 'no key' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(await countRecords(t.id, 'no key'), 0, 'nothing should have been created');
  });

  test('a replay returns the original response and creates nothing new', async () => {
    const key = randomUUID();
    const body = { record_type: 'note', title: 'replayed' };

    const first = await post('/v1/records', body, { key });
    assert.equal(first.status, 201);

    const second = await post('/v1/records', body, { key });
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('idempotency-replayed'), 'true');
    assert.equal(second.body.data.record_id, first.body.data.record_id, 'the same record, not a new one');

    assert.equal(await countRecords(t.id, 'replayed'), 1, 'exactly one row');
  });

  test('the same key with a different body is 422 IDEMPOTENCY_KEY_REUSE', async () => {
    // The client bug this catches: reusing one key across several distinct requests.
    const key = randomUUID();
    await post('/v1/records', { record_type: 'note', title: 'original' }, { key });

    const res = await post('/v1/records', { record_type: 'note', title: 'different' }, { key });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REUSE');
    assert.equal(await countRecords(t.id, 'different'), 0, 'the second body must not be written');
  });

  test('key matching ignores JSON key order', async () => {
    // Two structurally identical bodies must hash the same regardless of the order a
    // client's serialiser emitted them, or a legitimate retry looks like key reuse.
    const key = randomUUID();
    const a = await post('/v1/records', { record_type: 'note', title: 'ordered' }, { key });
    assert.equal(a.status, 201);

    const res = await fetch(`${base}/v1/records`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'idempotency-key': key,
      },
      body: '{"title":"ordered","record_type":"note"}',
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('idempotency-replayed'), 'true');
  });

  test('concurrent duplicates produce one record, never two', async () => {
    // The case a read-then-write misses entirely: both requests see no key and both
    // execute. SET NX makes the claim atomic, so one wins and the other is told to retry.
    const key = randomUUID();
    const body = { record_type: 'note', title: 'concurrent' };

    const [a, b] = await Promise.all([
      post('/v1/records', body, { key }),
      post('/v1/records', body, { key }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.ok(
      statuses[0] === 201 && (statuses[1] === 201 || statuses[1] === 409),
      `expected one 201 and one 201-replay or 409, got ${statuses.join(' and ')}`,
    );
    assert.equal(await countRecords(t.id, 'concurrent'), 1, 'exactly one row must exist');
  });

  test('a failed request does not burn its key', async () => {
    // Nothing succeeded, so there is nothing to be idempotent about — and holding the
    // reservation would make a legitimate retry wait out the TTL for no reason.
    const key = randomUUID();

    const failed = await post('/v1/records', { record_type: 'not-a-real-type' }, { key });
    assert.ok(failed.status >= 400);

    const retried = await post('/v1/records', { record_type: 'note', title: 'after failure' }, { key });
    assert.equal(retried.status, 201, 'the key must be reusable after a failure');
  });

  test('a malformed key is refused', async () => {
    const res = await post('/v1/records', { record_type: 'note' }, { key: 'short' });
    assert.equal(res.status, 400);
  });

  test('a replay does not double-log the PHI access', async () => {
    // A replay is not a second access — it never reaches the handler, so stage 14 has
    // nothing to record. Counting it would overstate exposure in the access report.
    const phiTenant = await seedTenant(pool, { isPhi: true });
    created.push(phiTenant.id);
    const phiToken = await signAccessToken({
      tenantId: phiTenant.id, userId: phiTenant.userId, permissions: WRITE,
    });

    const key = randomUUID();
    const body = { record_type: 'note', title: 'phi-create' };
    await post('/v1/records', body, { key, tok: phiToken });
    await post('/v1/records', body, { key, tok: phiToken });
    await flushAuditForTest();

    const n = await asOwner(pool, async (c) => {
      const { rows } = await c.query(
        `SELECT COUNT(*)::int AS n FROM user_audit_log
          WHERE tenant_id = $1 AND action = 'create' AND is_phi_access = TRUE`,
        [phiTenant.id]);
      return rows[0].n;
    });
    assert.equal(n, 1, 'the replay must not appear as a second PHI access');
  });
});
