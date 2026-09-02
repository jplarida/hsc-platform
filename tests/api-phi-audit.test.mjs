// PHI access logging — stage 14.
//
// This is the one audit path with no database trigger behind it: a trigger cannot observe
// a SELECT (database/04), so reads are logged by the application or not at all. Every
// other audit assertion in this suite has a backstop; these do not.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, asOwner, seedTenant, cleanup } from './helpers/db.mjs';

process.env.JWT_SECRET ??= 'test-secret-at-least-32-bytes-long!!';
process.env.REDIS_CACHE_URL ??= 'redis://localhost:6379';
process.env.REDIS_STATE_URL ??= 'redis://localhost:6381';

const { createApp } = await import('../dist/app.js');
const { signAccessToken } = await import('../dist/auth/token.js');
const { closePool } = await import('../dist/db/context.js');
const { closeRedis, waitForReady } = await import('../dist/redis/client.js');
const { flushAuditForTest, resetAuditForTest } = await import('../dist/audit/phiLog.js');
const { invalidateRecordTypes } = await import('../dist/services/recordTypes.js');

let pool, server, base, t;
const created = [];
const READ = ['records:read'];

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

async function get(path, token) {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Read the PHI access log directly — as the owner, since app_user cannot cross tenants. */
async function auditRows(tenantId) {
  return asOwner(pool, async (c) => {
    const { rows } = await c.query(
      `SELECT action, resource_type, is_phi_access, details
         FROM user_audit_log WHERE tenant_id = $1 ORDER BY timestamp DESC`, [tenantId]);
    return rows;
  });
}

/** Add a record of a given type, creating the type definition if needed. */
async function addRecord(tenantId, typeCode, isPhi, title) {
  await asOwner(pool, async (c) => {
    await c.query(
      `INSERT INTO record_type_definitions (tenant_id, code, display_name, plural_name, is_phi)
       VALUES ($1, $2, $2, $2, $3) ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenantId, typeCode, isPhi]);
    await c.query('BEGIN');
    await c.query('SELECT set_tenant_context($1)', [tenantId]);
    await c.query(
      `INSERT INTO records (tenant_id, record_type, title) VALUES ($1, $2, $3)`,
      [tenantId, typeCode, title]);
    await c.query('COMMIT');
  });
  await invalidateRecordTypes(tenantId);
}

before(async () => {
  pool = createPool();
  await Promise.all([waitForReady('cache'), waitForReady('state')]);
  t = await seedTenant(pool);
  created.push(t.id);
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await closeRedis();
  await closePool();
  await cleanup(pool, created);
  await pool.end();
});

describe('PHI access logging', () => {
  test('reading PHI records writes a user_audit_log row', async () => {
    resetAuditForTest();
    await addRecord(t.id, 'patient', true, 'A patient');

    const token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: READ });
    const res = await get('/v1/records?type=patient', token);
    assert.equal(res.status, 200);

    await flushAuditForTest();
    const rows = await auditRows(t.id);
    const phi = rows.filter((r) => r.is_phi_access);

    assert.ok(phi.length >= 1, 'a PHI read must be recorded');
    assert.equal(phi[0].action, 'view');
    assert.equal(phi[0].resource_type, 'record');
  });

  test('reading non-PHI records writes nothing', async () => {
    // The whole point of record_type_definitions.is_phi: an incident report is not a
    // clinical record, and logging every read of everything makes the PHI report useless.
    const other = await seedTenant(pool);
    created.push(other.id);
    await addRecord(other.id, 'incident', false, 'An incident');

    const token = await signAccessToken({
      tenantId: other.id, userId: other.userId, permissions: READ,
    });
    assert.equal((await get('/v1/records?type=incident', token)).status, 200);

    await flushAuditForTest();
    const rows = await auditRows(other.id);
    assert.equal(rows.filter((r) => r.is_phi_access).length, 0);
  });

  test('a list read records the result count and the query', async () => {
    // api/06: GET /records?type=patient returning 50 patients is 50 PHI accesses.
    // One event carrying the count and the filter is the practical compromise — but
    // without the count the event cannot answer how much was exposed.
    const listTenant = await seedTenant(pool);
    created.push(listTenant.id);
    for (const n of ['p1', 'p2', 'p3']) {
      await addRecord(listTenant.id, 'patient', true, n);
    }

    const token = await signAccessToken({
      tenantId: listTenant.id, userId: listTenant.userId, permissions: READ,
    });
    await get('/v1/records?type=patient', token);
    await flushAuditForTest();

    const phi = (await auditRows(listTenant.id)).filter((r) => r.is_phi_access);
    assert.ok(phi.length >= 1);
    assert.equal(phi[0].details.result_count, 3, 'the count is what makes the event useful');
    assert.equal(phi[0].details.query.type, 'patient');
  });

  test('an unfiltered read still detects PHI in the results', async () => {
    // The case a URL-based guess would miss entirely: no type filter, but patients come
    // back anyway. This is why the handler reports what it read.
    const mixed = await seedTenant(pool);
    created.push(mixed.id);
    await addRecord(mixed.id, 'patient', true, 'mixed-patient');
    await addRecord(mixed.id, 'incident', false, 'mixed-incident');

    const token = await signAccessToken({
      tenantId: mixed.id, userId: mixed.userId, permissions: READ,
    });
    await get('/v1/records', token);
    await flushAuditForTest();

    const phi = (await auditRows(mixed.id)).filter((r) => r.is_phi_access);
    assert.ok(phi.length >= 1, 'an unfiltered list containing PHI is still a PHI access');
  });

  test('a denied request is not recorded as an access', async () => {
    // api/06: a 403 is not an access. Counting refused attempts as PHI views overstates
    // exposure, and overstating is still wrong at an audit.
    const denied = await seedTenant(pool);
    created.push(denied.id);
    await addRecord(denied.id, 'patient', true, 'never-seen');

    const token = await signAccessToken({
      tenantId: denied.id, userId: denied.userId, permissions: [],
    });
    assert.equal((await get('/v1/records?type=patient', token)).status, 403);

    await flushAuditForTest();
    const rows = await auditRows(denied.id);
    assert.equal(rows.filter((r) => r.is_phi_access).length, 0,
      'a refused request must not appear as a PHI access');
  });

  test('an unknown record type is treated as PHI', async () => {
    // The safe direction. A type missing from the registry — a race with a pack install,
    // a cache filled before the type existed — must not produce an unlogged clinical
    // read. Over-logging costs storage; under-logging is invisible until an audit.
    const unknown = await seedTenant(pool);
    created.push(unknown.id);

    const { anyIsPhi } = await import('../dist/services/recordTypes.js');
    const { deriveContext } = await import('../dist/db/context.js');
    const ctx = deriveContext({ tenantId: unknown.id, userId: unknown.userId });

    assert.equal(await anyIsPhi(ctx, ['a-type-that-does-not-exist']), true);
    assert.equal(await anyIsPhi(ctx, ['note']), false, 'a known non-PHI type stays false');
  });
});

describe('audit backpressure', () => {
  test('the writer reports healthy under normal load', async () => {
    const { auditHealth } = await import('../dist/audit/phiLog.js');
    const health = auditHealth();
    assert.equal(health.healthy, true);
    assert.equal(health.reason, null);
  });

  test('a saturated queue makes the API refuse traffic', async () => {
    // The design decision that matters most here. An audit trail that silently degrades
    // under load is worse than none, because it looks complete — so when the writer
    // cannot keep up, the API stops serving rather than serving unrecorded PHI.
    const { recordAccess, auditHealth } = await import('../dist/audit/phiLog.js');
    resetAuditForTest();

    const max = Number(process.env.AUDIT_QUEUE_MAX ?? 5000);
    for (let i = 0; i < max; i += 1) {
      recordAccess({
        tenantId: t.id, userId: null, sessionId: null, appId: null, installationId: null,
        action: 'view', resourceType: 'record', resourceId: null, isPhiAccess: true,
        ipAddress: null, userAgent: null, details: {}, at: new Date(),
      });
    }

    const health = auditHealth();
    assert.equal(health.healthy, false, 'a full queue must be unhealthy');
    assert.match(health.reason, /saturated/);

    const token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: READ });
    const res = await get('/v1/records', token);
    assert.equal(res.status, 500, 'traffic is refused while the audit writer is behind');

    // Drain so the rest of the suite is not left behind a closed gate.
    await flushAuditForTest();
    resetAuditForTest();
    assert.equal(auditHealth().healthy, true);
  });
});
