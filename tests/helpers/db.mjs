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

/** Remove everything a test run created. Financial FKs are RESTRICT by design, so order
 *  matters and tenants cannot simply be deleted — which is itself the behaviour
 *  database/01 intended. */
export async function cleanup(pool, tenantIds) {
  if (tenantIds.length === 0) return;
  await asOwner(pool, async (c) => {
    await c.query('DELETE FROM invoice_line_items WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM invoices WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM subscriptions WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM records WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM record_type_definitions WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM tenant_users WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM tenants WHERE tenant_id = ANY($1)', [tenantIds]);
  });
}
