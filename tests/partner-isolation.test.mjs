// The partner axis.
//
// partners/02 isolates the partner portal on partner_id rather than tenant_id — two
// orthogonal filters over the same app_installations rows, which no single policy on
// app_user can express. The wrong fix is an application-level WHERE clause, which is the
// same class of defect as api/01's tenant-resolution bug: one missing predicate and a
// partner enumerates every install on the platform.
//
// The last test here covers the leak the migration lint caught rather than review:
// app_usage_daily carried tenant_id with no RLS while partner_portal_user held SELECT
// on it, exposing every partner's install counts and PHI read volumes to every other.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createPool, withPartnerContext, withTenantContext, asOwner, seedTenant, cleanup,
} from './helpers/db.mjs';

let pool;
let tenant, partnerA, partnerB;
const createdTenants = [];
const createdPartners = [];

/** Seed a partner with one published app and, optionally, an install in a tenant. */
async function seedPartner(pool, { installIn = null } = {}) {
  const slug = randomUUID().slice(0, 8);

  return asOwner(pool, async (c) => {
    const { rows: [p] } = await c.query(
      `INSERT INTO partners (legal_name, display_name, slug, support_email,
                             security_contact, status)
       VALUES ($1, $1, $2, $3, $3, 'active') RETURNING partner_id`,
      [`Partner ${slug}`, `p-${slug}`, `sec-${slug}@example.test`]);

    const { rows: [app] } = await c.query(
      `INSERT INTO partner_apps (partner_id, name, slug, status, phi_tier, client_id,
                                 redirect_uris)
       VALUES ($1, $2, $3, 'certified', 'none', $4, ARRAY['https://example.test/cb'])
       RETURNING app_id`,
      [p.partner_id, `App ${slug}`, `app-${slug}`, `hscapp_${slug}`]);

    const { rows: [ver] } = await c.query(
      `INSERT INTO app_versions (app_id, version, scope_codes, phi_tier, published_at,
                                 certified_at)
       VALUES ($1, 1, ARRAY['profile.read'], 'none', NOW(), NOW())
       RETURNING app_version_id`, [app.app_id]);

    let installationId = null;
    if (installIn) {
      const { rows: [inst] } = await c.query(
        `INSERT INTO app_installations
           (tenant_id, app_id, app_version_id, status, consented_by, consented_at,
            consent_snapshot)
         VALUES ($1, $2, $3, 'active', $4, NOW(), '{"scopes":["profile.read"]}'::jsonb)
         RETURNING installation_id`,
        [installIn.id, app.app_id, ver.app_version_id, installIn.userId]);
      installationId = inst.installation_id;

      await c.query(
        `INSERT INTO app_scope_grants (installation_id, scope_code)
         VALUES ($1, 'profile.read')`, [installationId]);

      await c.query(
        `INSERT INTO app_usage_daily (app_id, tenant_id, day, request_count, phi_read_count)
         VALUES ($1, $2, CURRENT_DATE, 100, 5)`, [app.app_id, installIn.id]);
    }

    return { id: p.partner_id, appId: app.app_id, versionId: ver.app_version_id, installationId };
  });
}

before(async () => {
  pool = createPool();
  tenant = await seedTenant(pool);
  createdTenants.push(tenant.id);
  partnerA = await seedPartner(pool, { installIn: tenant });
  partnerB = await seedPartner(pool, { installIn: tenant });
  createdPartners.push(partnerA.id, partnerB.id);
});

after(async () => {
  await asOwner(pool, async (c) => {
    await c.query('DELETE FROM app_usage_daily WHERE tenant_id = ANY($1)', [createdTenants]);
    await c.query('DELETE FROM app_scope_grants WHERE installation_id IN (SELECT installation_id FROM app_installations WHERE tenant_id = ANY($1))', [createdTenants]);
    await c.query('DELETE FROM app_installations WHERE tenant_id = ANY($1)', [createdTenants]);
    await c.query('DELETE FROM app_versions WHERE app_id IN (SELECT app_id FROM partner_apps WHERE partner_id = ANY($1))', [createdPartners]);
    await c.query('DELETE FROM partner_apps WHERE partner_id = ANY($1)', [createdPartners]);
    await c.query('DELETE FROM partners WHERE partner_id = ANY($1)', [createdPartners]);
  });
  await cleanup(pool, createdTenants);
  await pool.end();
});

describe('partner axis isolation', () => {
  test('a partner sees only its own apps', async () => {
    await withPartnerContext(pool, partnerA.id, async (c) => {
      const { rows } = await c.query('SELECT app_id FROM partner_apps');
      assert.equal(rows.length, 1, 'partner A should see exactly its own app');
      assert.equal(rows[0].app_id, partnerA.appId);
    });
  });

  test("a partner cannot see another partner's app by id", async () => {
    await withPartnerContext(pool, partnerA.id, async (c) => {
      const { rows } = await c.query('SELECT 1 FROM partner_apps WHERE app_id = $1',
        [partnerB.appId]);
      assert.equal(rows.length, 0,
        "partner_apps holds every competitor's client_id and webhook_url");
    });
  });

  test('a partner sees only installs of its own app', async () => {
    // Both partners have an install in the same tenant, so this fails loudly if the
    // policy filters on tenant instead of app.
    await withPartnerContext(pool, partnerA.id, async (c) => {
      const { rows } = await c.query('SELECT installation_id FROM app_installations');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].installation_id, partnerA.installationId);
    });
  });

  test("a partner sees only its own app's usage — lint-caught leak regression", async () => {
    await withPartnerContext(pool, partnerA.id, async (c) => {
      const { rows } = await c.query('SELECT app_id, phi_read_count FROM app_usage_daily');
      assert.equal(rows.length, 1,
        "partner A must not see partner B's install counts or PHI read volumes");
      assert.equal(rows[0].app_id, partnerA.appId);
    });
  });

  test('a partner cannot reach tenant data at all', async () => {
    // Not "returns no rows" — no privilege, so the query itself is refused. That is the
    // property partners/02 claims: a SQL injection in the portal still cannot reach
    // tenant data, because the role has no grant to reach it.
    for (const table of ['records', 'tenant_users', 'files', 'data_audit_log']) {
      await assert.rejects(
        withPartnerContext(pool, partnerA.id, (c) => c.query(`SELECT * FROM ${table} LIMIT 1`)),
        (err) => err.code === '42501',
        `partner_portal_user must have no privilege on ${table}`,
      );
    }
  });

  test('a partner cannot modify an installation', async () => {
    // A partner never changes an install; the tenant does. Only SELECT is granted.
    await assert.rejects(
      withPartnerContext(pool, partnerA.id, (c) => c.query(
        `UPDATE app_installations SET status = 'active' WHERE installation_id = $1`,
        [partnerA.installationId])),
      (err) => err.code === '42501',
      'partner_portal_user must hold SELECT only on app_installations',
    );
  });

  test('with no partner context a partner session sees nothing', async () => {
    // Same fail-closed default as the tenant axis.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE partner_portal_user');
      const { rows } = await client.query('SELECT * FROM partner_apps');
      assert.equal(rows.length, 0, 'without partner context the portal must see no apps');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});

describe('tenant side of an installation', () => {
  test('a tenant sees its own installs', async () => {
    await withTenantContext(pool, { tenantId: tenant.id }, async (c) => {
      const { rows } = await c.query('SELECT installation_id FROM app_installations');
      assert.equal(rows.length, 2, 'the tenant installed two apps and should see both');
    });
  });

  test('a tenant sees per-app usage for its own installs', async () => {
    await withTenantContext(pool, { tenantId: tenant.id }, async (c) => {
      const { rows } = await c.query('SELECT app_id FROM app_usage_daily');
      assert.equal(rows.length, 2, 'the tenant activity view covers every installed app');
    });
  });

  test('another tenant sees neither install', async () => {
    const other = await seedTenant(pool);
    createdTenants.push(other.id);

    await withTenantContext(pool, { tenantId: other.id }, async (c) => {
      const { rows: installs } = await c.query('SELECT 1 FROM app_installations');
      assert.equal(installs.length, 0);
      const { rows: usage } = await c.query('SELECT 1 FROM app_usage_daily');
      assert.equal(usage.length, 0);
    });
  });
});
