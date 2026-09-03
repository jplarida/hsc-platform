// Test helpers for the schema suite.
//
// These tests exercise the DATABASE, not the application: there is no application yet.
// infrastructure/02 writes them against a Prisma `withTenantContext` helper; the same
// boundaries are asserted here directly through `pg`, which is what that helper would
// wrap anyway.
//
// Everything runs through withTenantContext() rather than raw queries, for the same
// reason the application must: the tenant GUC has to be transaction-local, and a single
// entry point is what makes that impossible to forget (database/08).

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env — see db/README.md.');
}

/** A pool. `max` is meaningful: the pooling test needs exactly one connection. */
export function createPool(max = 5) {
  return new pg.Pool({ connectionString: DATABASE_URL, max });
}

/**
 * Run `fn` inside a transaction with the tenant context set and a role assumed.
 *
 * The three things that make this correct, and that the application must copy:
 *   1. An explicit transaction. set_config(..., true) is reverted at COMMIT; outside a
 *      transaction "local" means the rest of the session, which is the leak.
 *   2. SET LOCAL ROLE, not SET ROLE — also reverted at COMMIT, so a pooled connection is
 *      never handed back still wearing app_user.
 *   3. Context set INSIDE the transaction, after the role is assumed.
 */
export async function withTenantContext(pool, { tenantId, userId = null, appId = null,
                                                installationId = null, role = 'app_user' }, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query('SELECT set_tenant_context($1, $2, $3, $4)',
      [tenantId, userId, appId, installationId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** As above, for the partner portal's axis. */
export async function withPartnerContext(pool, partnerId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE partner_portal_user');
    await client.query('SELECT set_partner_context($1)', [partnerId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Privileged access, as the migration owner. Used for seeding and for reading across
 *  tenants when a test needs to verify what isolation is hiding. Never a substitute for
 *  the helpers above when the point of the test is the boundary itself. */
export async function asOwner(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

const uniq = () => randomUUID().slice(0, 8);

/**
 * Seed a tenant with the minimum chain needed to hold a record:
 * tenant -> plan+subscription -> record_type_definitions -> user.
 *
 * Seeds as the owner rather than app_user, because there is no tenant context to set
 * until the tenant exists — the same chicken-and-egg the login path has (database/02).
 */
export async function seedTenant(pool, { isPhi = false } = {}) {
  return asOwner(pool, async (c) => {
    const slug = `t${uniq()}`;

    const { rows: [plan] } = await c.query(
      `INSERT INTO plans (code, name, price_cents, limits)
       VALUES ($1, 'Test plan', 0, '{"storage_bytes": 1073741824, "seats": 10}'::jsonb)
       RETURNING plan_id`, [`test_${uniq()}`]);

    const { rows: [tenant] } = await c.query(
      `INSERT INTO tenants (name, subdomain, status)
       VALUES ($1, $2, 'active') RETURNING tenant_id`, [`Tenant ${slug}`, slug]);

    await c.query(
      `INSERT INTO subscriptions (tenant_id, plan_id, status,
                                  current_period_start, current_period_end)
       VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '30 days')`,
      [tenant.tenant_id, plan.plan_id]);

    await c.query(
      `INSERT INTO record_type_definitions
         (tenant_id, code, display_name, plural_name, is_phi)
       VALUES ($1, 'note', 'Note', 'Notes', $2)`, [tenant.tenant_id, isPhi]);

    const { rows: [user] } = await c.query(
      `INSERT INTO tenant_users (tenant_id, email, password_hash, status)
       VALUES ($1, $2, 'argon2-placeholder', 'active') RETURNING user_id`,
      [tenant.tenant_id, `user-${slug}@example.test`]);

    return { id: tenant.tenant_id, userId: user.user_id, planId: plan.plan_id, slug };
  });
}

/** Create a record inside a tenant, through the tenant context like the app would. */
export async function createRecord(pool, tenant, title = 'Untitled') {
  return withTenantContext(pool, { tenantId: tenant.id, userId: tenant.userId }, async (c) => {
    const { rows: [r] } = await c.query(
      `INSERT INTO records (tenant_id, record_type, title, created_by)
       VALUES ($1, 'note', $2, $3) RETURNING record_id`,
      [tenant.id, title, tenant.userId]);
    return r.record_id;
  });
}

/**
 * Remove everything a test run created.
 *
 * OBSERVED on first execution: this originally failed with
 *   update or delete on table "tenants" violates foreign key constraint
 *   "data_audit_log_tenant_id_fkey"
 * and the equivalent for tenant_users via data_audit_log.changed_by.
 *
 * That is the schema working as designed, not a bug. database/01 states that tenant
 * offboarding soft-deletes via tenants.deleted_at rather than issuing a DELETE, precisely
 * so audit and financial history survives. A hard delete is something production never
 * does — the test fixture was asking for something the design forbids.
 *
 * Test teardown legitimately needs it, so audit rows are removed first, as the owner,
 * with the immutability trigger disabled for the statement. That is the one place this
 * is acceptable: a disposable dev database. It must never appear in application code,
 * which is why it lives here and not behind a general-purpose helper.
 */
export async function cleanup(pool, tenantIds) {
  if (tenantIds.length === 0) return;
  const AUDITED = ['records', 'tenant_users', 'files', 'record_links', 'user_roles',
                   'sso_connections', 'integration_connections'];
  const AUDIT_TRIGGER = {
    records: 'records_audit_trigger',
    tenant_users: 'tenant_users_audit_trigger',
    files: 'files_audit_trigger',
    record_links: 'record_links_audit_trigger',
    user_roles: 'user_roles_audit_trigger',
    sso_connections: 'sso_connections_audit_trigger',
    integration_connections: 'integration_connections_audit_trigger',
  };

  await asOwner(pool, async (c) => {
    // Auditing is suppressed for the duration of teardown.
    //
    // OBSERVED across three iterations of this helper: deleting from an audited table
    // fires create_audit_log() and writes *fresh* audit rows, so purging audit first
    // leaves tenants blocked, and purging it last leaves tenant_users blocked by
    // data_audit_log.changed_by. There is no ordering that works while the triggers are
    // live — the audit trail is designed to make this data undeletable, and it succeeds.
    //
    // Suppressing the triggers is legitimate here and nowhere else: a disposable dev
    // fixture. Production never hard-deletes a tenant; database/01 soft-deletes via
    // tenants.deleted_at precisely so this history survives.
    for (const t of AUDITED) {
      await c.query(`ALTER TABLE ${t} DISABLE TRIGGER ${AUDIT_TRIGGER[t]}`);
    }

    await c.query('DELETE FROM invoice_line_items WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM invoices WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM subscriptions WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM file_associations WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM files WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM record_links WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM records WHERE tenant_id = ANY($1)', [tenantIds]);
    // record_link_rules has composite foreign keys to record_type_definitions on
    // (tenant_id, from_type_code) and (tenant_id, to_type_code), so the rules go first or
    // the type definitions cannot be removed.
    await c.query('DELETE FROM record_link_rules WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM record_state_transitions WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM record_type_definitions WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM user_roles WHERE user_id IN (SELECT user_id FROM tenant_users WHERE tenant_id = ANY($1))', [tenantIds]);

    // Audit rows must go before tenant_users, because data_audit_log.changed_by is a
    // foreign key to it — a user who has ever written anything cannot be deleted while
    // their audit history exists. See the note in db/README.md: that FK contradicts
    // user_audit_log.user_email being denormalised "so it survives user deletion", and
    // is a genuine design question rather than a fixture problem.
    await c.query('ALTER TABLE data_audit_log DISABLE TRIGGER data_audit_immutable');
    await c.query('ALTER TABLE user_audit_log DISABLE TRIGGER user_audit_immutable');
    await c.query('ALTER TABLE system_audit_log DISABLE TRIGGER system_audit_immutable');
    try {
      await c.query('DELETE FROM data_audit_log WHERE tenant_id = ANY($1)', [tenantIds]);
      await c.query('DELETE FROM user_audit_log WHERE tenant_id = ANY($1)', [tenantIds]);
      await c.query('DELETE FROM system_audit_log WHERE tenant_id = ANY($1)', [tenantIds]);
    } finally {
      await c.query('ALTER TABLE data_audit_log ENABLE TRIGGER data_audit_immutable');
      await c.query('ALTER TABLE user_audit_log ENABLE TRIGGER user_audit_immutable');
      await c.query('ALTER TABLE system_audit_log ENABLE TRIGGER system_audit_immutable');
    }

    await c.query('DELETE FROM tenant_users WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM roles WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM tenants WHERE tenant_id = ANY($1)', [tenantIds]);

    for (const t of AUDITED) {
      await c.query(`ALTER TABLE ${t} ENABLE TRIGGER ${AUDIT_TRIGGER[t]}`);
    }
  });
}
