// Catalogue-level invariants. These need no fixtures — they interrogate pg_catalog —
// and they are the tests that catch a *future* migration that forgets something.
//
// infrastructure/02 singles this class out: "the second test is the important one: it
// catches a migration that adds a tenant table and forgets its policy (database/07),
// which is otherwise found only in production, by the wrong person."

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, asOwner } from './helpers/db.mjs';

let pool;
before(() => { pool = createPool(); });
after(async () => { await pool.end(); });

describe('schema invariants', () => {
  test('every table with tenant_id has RLS enabled AND forced', async () => {
    const { rows } = await asOwner(pool, (c) => c.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public'
                        AND table_name = c.relname
                        AND column_name = 'tenant_id')
       ORDER BY c.relname`));

    assert.ok(rows.length > 0, 'expected tenant-scoped tables to exist');

    const notEnabled = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    const notForced  = rows.filter((r) => r.relrowsecurity && !r.relforcerowsecurity)
                           .map((r) => r.relname);

    assert.deepEqual(notEnabled, [], `tables with tenant_id but RLS not enabled: ${notEnabled}`);
    // FORCE is what subjects the table owner to the policy. Without it, any connection
    // that happens to own the table silently bypasses tenant isolation (database/04).
    assert.deepEqual(notForced, [], `tables with RLS enabled but not FORCED: ${notForced}`);
  });

  test('every table with RLS enabled has at least one policy', async () => {
    // RLS enabled with no policy is deny-all: a silent outage rather than a leak, but
    // still a defect, and one that only shows up when the table is first used.
    const { rows } = await asOwner(pool, (c) => c.query(`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
       ORDER BY c.relname`));

    assert.deepEqual(rows.map((r) => r.relname), [],
      'tables with RLS enabled but no policy (deny-all)');
  });

  test('partner_portal_user holds no privilege on any tenant-data table', async () => {
    // partners/02: "a SQL injection in the portal still cannot reach tenant data,
    // because the role has no privilege to reach it." That is a claim about grants, so
    // it is asserted against the grant table rather than trusted.
    const forbidden = ['records', 'files', 'file_versions', 'tenant_users', 'sessions',
                       'user_audit_log', 'data_audit_log', 'system_audit_log',
                       'consent_records', 'invoices'];

    const { rows } = await asOwner(pool, (c) => c.query(`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'partner_portal_user'
         AND table_name = ANY($1)`, [forbidden]));

    assert.deepEqual(rows, [],
      `partner_portal_user must hold no grants on tenant data, found: ${JSON.stringify(rows)}`);
  });

  test('app_user cannot UPDATE or DELETE any audit table', async () => {
    const { rows } = await asOwner(pool, (c) => c.query(`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'app_user'
         AND table_name IN ('user_audit_log', 'data_audit_log', 'system_audit_log')
         AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')`));

    assert.deepEqual(rows, [], `audit tables must be append-only for app_user: ${JSON.stringify(rows)}`);
  });

  test('app_user has no INSERT on data_audit_log — it is trigger-only', async () => {
    const { rows } = await asOwner(pool, (c) => c.query(`
      SELECT 1 FROM information_schema.role_table_grants
       WHERE grantee = 'app_user' AND table_name = 'data_audit_log'
         AND privilege_type = 'INSERT'`));

    assert.equal(rows.length, 0,
      'data_audit_log must be written only by create_audit_log(), never by the application');
  });

  test('audit tables are partitioned with the partition key in the primary key', async () => {
    // PostgreSQL requires the partition key in every unique constraint, so the PK is
    // composite (audit_id, timestamp). Easy to regress when adding a table.
    for (const table of ['user_audit_log', 'data_audit_log', 'system_audit_log']) {
      const { rows: [p] } = await asOwner(pool, (c) => c.query(
        `SELECT c.relkind FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`, [table]));
      assert.equal(p?.relkind, 'p', `${table} should be a partitioned table`);

      const { rows: cols } = await asOwner(pool, (c) => c.query(`
        SELECT a.attname
          FROM pg_index i
          JOIN pg_class c   ON c.oid = i.indrelid
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
         WHERE c.relname = $1 AND i.indisprimary`, [table]));

      const names = cols.map((r) => r.attname).sort();
      assert.deepEqual(names, ['audit_id', 'timestamp'],
        `${table} primary key should be (audit_id, timestamp), got ${names}`);
    }
  });

  test('every audit partition parent has a DEFAULT partition', async () => {
    // Without one, an insert whose timestamp falls outside every declared range fails
    // outright — taking the application down the first month the partition job is missed.
    for (const table of ['user_audit_log', 'data_audit_log', 'system_audit_log']) {
      const { rows } = await asOwner(pool, (c) => c.query(`
        SELECT 1
          FROM pg_class parent
          JOIN pg_inherits inh ON inh.inhparent = parent.oid
          JOIN pg_class child ON child.oid = inh.inhrelid
         WHERE parent.relname = $1
           AND pg_get_expr(child.relpartbound, child.oid) = 'DEFAULT'`, [table]));
      assert.equal(rows.length, 1, `${table} should have exactly one DEFAULT partition`);
    }
  });
});
