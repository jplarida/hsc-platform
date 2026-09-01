// Audit completeness, masking, immutability and actor attribution.
//
// An audit gap is a compliance defect under RULE-HSC-02, not a missing feature, so audit
// behaviour is asserted rather than assumed.
//
// The first test here is the one infrastructure/02 says "would have caught the broken
// trigger from database/04" — create_audit_log() read NEW.record_id while attached to
// files and tenant_users, whose primary keys are file_id and user_id, so every write to
// those two tables failed at runtime and they were simply unwritable.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPool, withTenantContext, asOwner, seedTenant, createRecord, cleanup,
} from './helpers/db.mjs';

let pool;
let t;
const created = [];

before(async () => {
  pool = createPool();
  t = await seedTenant(pool);
  created.push(t.id);
});

after(async () => {
  await cleanup(pool, created);
  await pool.end();
});

const auditCount = (table, tenantId) =>
  asOwner(pool, async (c) => {
    const { rows: [{ count }] } = await c.query(
      'SELECT COUNT(*)::int AS count FROM data_audit_log WHERE table_name = $1 AND tenant_id = $2',
      [table, tenantId]);
    return count;
  });

/**
 * The most recent audit row for a table, optionally narrowed to one operation.
 *
 * The `operation` filter is not a convenience. OBSERVED on first execution: ordering by
 * timestamp alone returned the INSERT row rather than the UPDATE that followed it in the
 * same transaction, because NOW() is transaction-scoped and both rows carried an
 * identical timestamp. Migration 0005 now writes clock_timestamp(), which fixes the
 * ordering — but a test that depends on tie-breaking is fragile either way, so it asks
 * for the row it actually means.
 */
const latestAudit = (table, tenantId, operation = null) =>
  asOwner(pool, async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM data_audit_log
        WHERE table_name = $1 AND tenant_id = $2
          AND ($3::text IS NULL OR operation = $3)
        ORDER BY timestamp DESC LIMIT 1`, [table, tenantId, operation]);
    return rows[0];
  });

describe('audit completeness', () => {
  test('writing a record produces a data_audit_log row', async () => {
    const before = await auditCount('records', t.id);
    await createRecord(pool, t, 'audited');
    assert.equal(await auditCount('records', t.id), before + 1);
  });

  test('writing tenant_users produces an audit row — fault 1 regression', async () => {
    // The primary key here is user_id, not record_id. Before the TG_ARGV[0] fix this
    // insert failed outright with 'record "new" has no field "record_id"'.
    const before = await auditCount('tenant_users', t.id);

    await withTenantContext(pool, { tenantId: t.id }, (c) => c.query(
      `INSERT INTO tenant_users (tenant_id, email, password_hash, status)
       VALUES ($1, $2, 'hash', 'active')`, [t.id, `audit-${Date.now()}@example.test`]));

    assert.equal(await auditCount('tenant_users', t.id), before + 1,
      'tenant_users must be writable AND audited');
  });

  test('writing files produces an audit row — fault 1 regression', async () => {
    // Primary key file_id. Same defect, second table.
    const before = await auditCount('files', t.id);

    await withTenantContext(pool, { tenantId: t.id }, (c) => c.query(
      `INSERT INTO files (tenant_id, original_name, mime_type, status, scan_status)
       VALUES ($1, 'test.pdf', 'application/pdf', 'uploading', 'pending')`, [t.id]));

    assert.equal(await auditCount('files', t.id), before + 1,
      'files must be writable AND audited');
  });

  test('a no-op update writes no audit row', async () => {
    const recId = await createRecord(pool, t, 'noop');
    const before = await auditCount('records', t.id);

    await withTenantContext(pool, { tenantId: t.id }, (c) => c.query(
      `UPDATE records SET title = title WHERE record_id = $1`, [recId]));

    assert.equal(await auditCount('records', t.id), before,
      'an update that changes nothing should not write an empty audit row');
  });

  test('an update records only the fields that changed', async () => {
    const recId = await createRecord(pool, t, 'before');

    await withTenantContext(pool, { tenantId: t.id }, (c) => c.query(
      `UPDATE records SET title = 'after' WHERE record_id = $1`, [recId]));

    const row = await latestAudit('records', t.id, 'UPDATE');
    assert.equal(row.operation, 'UPDATE');
    assert.ok(row.changed_fields.includes('title'));
    // version and updated_at also change, via the bump_record_version trigger.
    assert.ok(!row.changed_fields.includes('description'),
      'unchanged fields must not appear in changed_fields');
  });
});

describe('audit masking', () => {
  test('audit rows never contain credentials', async () => {
    const email = `mask-${Date.now()}@example.test`;
    let userId;

    await withTenantContext(pool, { tenantId: t.id }, async (c) => {
      const { rows: [u] } = await c.query(
        `INSERT INTO tenant_users (tenant_id, email, password_hash, status)
         VALUES ($1, $2, 'original-hash', 'active') RETURNING user_id`, [t.id, email]);
      userId = u.user_id;
      await c.query(`UPDATE tenant_users SET password_hash = 'rotated-hash' WHERE user_id = $1`,
        [userId]);
    });

    const row = await latestAudit('tenant_users', t.id, 'UPDATE');

    // Without mask_sensitive() the audit log becomes a credential store that outlives
    // password rotation — every historical hash, retained for six years.
    assert.ok(!('password_hash' in row.new_values), 'password_hash must be masked from new_values');
    assert.ok(!('mfa_secret' in row.new_values), 'mfa_secret must be masked from new_values');
    assert.ok(!('password_hash' in (row.old_values ?? {})), 'password_hash must be masked from old_values');

    // The row is still useful: it records that the field changed, without its value.
    assert.ok(row.changed_fields.includes('password_hash'),
      'the fact of the change must survive masking');
  });
});

describe('audit immutability', () => {
  test('app_user cannot UPDATE an audit row', async () => {
    await createRecord(pool, t, 'immutable');

    await assert.rejects(
      withTenantContext(pool, { tenantId: t.id }, (c) => c.query(
        `UPDATE data_audit_log SET operation = 'TAMPERED' WHERE tenant_id = $1`, [t.id])),
      'audit rows must not be updatable by the application',
    );
  });

  test('app_user cannot DELETE an audit row', async () => {
    await assert.rejects(
      withTenantContext(pool, { tenantId: t.id }, (c) => c.query(
        `DELETE FROM data_audit_log WHERE tenant_id = $1`, [t.id])),
      'audit rows must not be deletable by the application',
    );
  });

  test('even the owner cannot UPDATE an audit row', async () => {
    // The trigger is belt-and-braces alongside the REVOKE: privileges can be re-granted
    // by a later migration without anyone noticing, whereas a dropped trigger is
    // conspicuous. This asserts the trigger, not the grant.
    await assert.rejects(
      asOwner(pool, (c) => c.query(`UPDATE data_audit_log SET operation = 'TAMPERED'`)),
      /append-only/i,
      'the immutability trigger must fire regardless of role',
    );
  });
});

describe('actor attribution', () => {
  test('a user-authenticated write records changed_by', async () => {
    await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) => c.query(
      `INSERT INTO records (tenant_id, record_type, title, created_by)
       VALUES ($1, 'note', 'attributed', $2)`, [t.id, t.userId]));

    const row = await latestAudit('records', t.id);
    assert.equal(row.changed_by, t.userId);
    assert.equal(row.app_id, null);
  });

  test('a write with no request context does not abort — fault 2 regression', async () => {
    // current_setting without missing_ok raises undefined_object whenever the GUC is
    // unset, which is every background job, migration and psql session. Any such write
    // to an audited table failed.
    const before = await auditCount('records', t.id);

    await asOwner(pool, (c) => c.query(
      `INSERT INTO records (tenant_id, record_type, title) VALUES ($1, 'note', 'no-context')`,
      [t.id]));

    assert.equal(await auditCount('records', t.id), before + 1,
      'a write outside any request context must still audit, with a null actor');

    const row = await latestAudit('records', t.id);
    assert.equal(row.changed_by, null);
  });

  test('an app-authenticated write records app_id — partners/02 amendment', async () => {
    // Without this, an app write has a null actor and no way to identify which of a
    // tenant's installed apps acted — an incomplete HIPAA accounting of disclosures.
    const fakeAppId = '00000000-0000-0000-0000-0000000000aa';

    // app_id is a plain UUID column on the audit table (no FK), so this exercises
    // attribution without needing the full marketplace fixture chain.
    await withTenantContext(pool,
      { tenantId: t.id, userId: null, appId: fakeAppId }, (c) => c.query(
        `INSERT INTO records (tenant_id, record_type, title) VALUES ($1, 'note', 'by-app')`,
        [t.id]));

    const row = await latestAudit('records', t.id);
    assert.equal(row.app_id, fakeAppId, 'the acting app must be recorded');
  });
});
