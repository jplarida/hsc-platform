#!/usr/bin/env node
// Development seed data.
//
// The migrations seed only what route metadata depends on — `permissions` and
// `app_scopes` — because an absent row there is a route that can never authorize.
// Everything here is operational data that a running system needs but that no migration
// should own: plans, the system role templates, and a tenant to poke at.
//
// Idempotent: safe to re-run. Uses ON CONFLICT throughout rather than TRUNCATE, so it
// will not destroy anything a developer has been working on.

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// Limits are read at runtime by the rate limiter (api/03) and the upload quota check
// (database/05). The tier values are the ones api/03 documents; they live here as seed
// data rather than in code, which is what makes "custom limits for enterprise" a row
// edit rather than a deploy.
const PLANS = [
  { code: 'free_trial', name: 'Free Trial', price: 0, trial: 14, seats: 3,
    limits: { requests_per_hour: 1000, user_requests_per_minute: 100,
              concurrent_connections: 10, max_upload_bytes: 50 * MB,
              webhook_endpoints: 1, storage_bytes: 1 * GB, seats: 3 } },
  { code: 'basic', name: 'Basic', price: 9900, trial: 0, seats: 10,
    limits: { requests_per_hour: 10000, user_requests_per_minute: 500,
              concurrent_connections: 50, max_upload_bytes: 200 * MB,
              webhook_endpoints: 5, storage_bytes: 50 * GB, seats: 10 } },
  { code: 'professional', name: 'Professional', price: 49900, trial: 0, seats: 50,
    limits: { requests_per_hour: 100000, user_requests_per_minute: 2000,
              concurrent_connections: 200, max_upload_bytes: 1 * GB,
              webhook_endpoints: 20, storage_bytes: 500 * GB, seats: 50 } },
  { code: 'enterprise', name: 'Enterprise', price: 0, trial: 0, seats: 500,
    limits: { requests_per_hour: 1000000, user_requests_per_minute: 10000,
              concurrent_connections: 1000, max_upload_bytes: 5 * GB,
              webhook_endpoints: null, storage_bytes: 5 * 1024 * GB, seats: 500 } },
  // Required by partners/01. Not public: a partner's sandbox is provisioned onto it, and
  // it deliberately carries real limits so partners meet 429s before production does.
  { code: 'partner_sandbox', name: 'Partner Sandbox', price: 0, trial: 0, seats: 5,
    isPublic: false,
    limits: { requests_per_hour: 5000, user_requests_per_minute: 200,
              concurrent_connections: 20, max_upload_bytes: 100 * MB,
              webhook_endpoints: 3, storage_bytes: 5 * GB, seats: 5 } },
];

for (const [i, p] of PLANS.entries()) {
  await client.query(
    `INSERT INTO plans (code, name, price_cents, trial_days, limits, is_public, sort_order)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (code) DO UPDATE
        SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents,
            trial_days = EXCLUDED.trial_days, limits = EXCLUDED.limits,
            is_public = EXCLUDED.is_public, sort_order = EXCLUDED.sort_order`,
    [p.code, p.name, p.price, p.trial, JSON.stringify(p.limits), p.isPublic !== false, i]);
}
console.log(`plans: ${PLANS.length}`);

// System role templates carry tenant_id NULL and are readable by every tenant. Only the
// platform can author them — migration 0003's policy has an explicit WITH CHECK that
// stops any app_user creating one, which was a real escalation before it was added.
const ROLES = [
  { code: 'owner',  name: 'Owner',
    perms: ['records:read', 'records:write', 'records:delete', 'records:export',
            'records:import', 'files:read', 'files:write', 'files:share',
            'users:read', 'users:write', 'billing:read', 'billing:write',
            'webhooks:manage', 'api_keys:manage', 'audit:read', 'apps:install'] },
  { code: 'admin',  name: 'Administrator',
    perms: ['records:read', 'records:write', 'records:delete', 'records:export',
            'records:import', 'files:read', 'files:write', 'files:share',
            'users:read', 'users:write', 'billing:read',
            'webhooks:manage', 'api_keys:manage', 'audit:read', 'apps:install'] },
  { code: 'member', name: 'Member',
    perms: ['records:read', 'records:write', 'files:read', 'files:write', 'users:read'] },
  { code: 'viewer', name: 'Viewer',
    perms: ['records:read', 'files:read', 'users:read'] },
];

for (const r of ROLES) {
  const { rows: [role] } = await client.query(
    `INSERT INTO roles (tenant_id, code, name, is_system)
     VALUES (NULL, $1, $2, TRUE)
     ON CONFLICT (code) WHERE tenant_id IS NULL
     DO UPDATE SET name = EXCLUDED.name
     RETURNING role_id`, [r.code, r.name]);

  await client.query('DELETE FROM role_permissions WHERE role_id = $1', [role.role_id]);
  await client.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, permission_id FROM permissions WHERE code = ANY($2)`,
    [role.role_id, r.perms]);
}
console.log(`system roles: ${ROLES.length}`);

// A tenant to explore. Not created if one already exists under this subdomain.
const { rows: [tenant] } = await client.query(
  `INSERT INTO tenants (name, subdomain, status, country_code)
   VALUES ('Acme Health', 'acme', 'active', 'US')
   ON CONFLICT (subdomain) DO UPDATE SET name = EXCLUDED.name
   RETURNING tenant_id`);

await client.query(
  `INSERT INTO tenant_configurations (tenant_id, app_name, company_name, industry_type)
   VALUES ($1, 'Acme Health', 'Acme Health Ltd', 'healthcare')
   ON CONFLICT (tenant_id) DO NOTHING`, [tenant.tenant_id]);

await client.query(
  `INSERT INTO subscriptions (tenant_id, plan_id, status, seats,
                              current_period_start, current_period_end)
   SELECT $1, plan_id, 'active', 10, NOW(), NOW() + INTERVAL '30 days'
     FROM plans WHERE code = 'professional'
   ON CONFLICT DO NOTHING`, [tenant.tenant_id]);

// Two record types, one PHI and one not. is_phi is the single switch that drives PHI
// read-logging, webhook payload restriction, marketplace scope tiers and
// de-identification — so a dev tenant needs both sides of it to be useful.
await client.query(
  `INSERT INTO record_type_definitions (tenant_id, code, display_name, plural_name, is_phi)
   VALUES ($1, 'patient',  'Patient',  'Patients',  TRUE),
          ($1, 'incident', 'Incident', 'Incidents', FALSE)
   ON CONFLICT (tenant_id, code) DO NOTHING`, [tenant.tenant_id]);

// Password hash is a placeholder, not a usable credential: there is no auth service yet
// to verify it against, and seeding a real one would be a login nobody intended to open.
const { rows: [user] } = await client.query(
  `INSERT INTO tenant_users (tenant_id, email, password_hash, first_name, last_name, status)
   VALUES ($1, 'owner@acme.test', 'PLACEHOLDER-NOT-A-VALID-HASH', 'Ada', 'Owner', 'active')
   ON CONFLICT (tenant_id, lower(email)) DO UPDATE SET status = 'active'
   RETURNING user_id`, [tenant.tenant_id]);

// user_roles carries no tenant_id of its own, so the audit trigger resolves the tenant
// from the GUC. Without this the insert fails with a legible error telling you exactly
// that — which is the behaviour intended, and worth keeping rather than defaulting the
// tenant to null and writing an unattributable audit row.
await client.query('BEGIN');
await client.query('SELECT set_tenant_context($1)', [tenant.tenant_id]);
await client.query(
  `INSERT INTO user_roles (user_id, role_id)
   SELECT $1, role_id FROM roles WHERE tenant_id IS NULL AND code = 'owner'
   ON CONFLICT DO NOTHING`, [user.user_id]);
await client.query('COMMIT');

console.log(`tenant: acme (${tenant.tenant_id})`);
console.log(`user:   owner@acme.test (${user.user_id})`);

await client.end();
console.log('\nSeed complete.');
