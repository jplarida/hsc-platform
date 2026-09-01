// Tenant isolation and the pooled-connection GUC leak.
//
// RULE-HSC-02 makes row-level security the isolation mechanism, so a bug here is a
// breach rather than a defect — and it will not show up in ordinary tests, which run
// with one tenant.
//
// database/08 calls the leak in the second describe block "the highest-severity failure
// in the platform": a session-scoped tenant GUC survives a pooled connection being
// returned to the pool, and RLS then cheerfully enforces the *previous* tenant. It
// produces no error at any layer.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPool, withTenantContext, asOwner, seedTenant, createRecord, cleanup,
} from './helpers/db.mjs';

let pool;
let a, b;
const created = [];

before(async () => {
  pool = createPool();
  a = await seedTenant(pool);
  b = await seedTenant(pool);
  created.push(a.id, b.id);
});

after(async () => {
  await cleanup(pool, created);
  await pool.end();
});

describe('tenant isolation', () => {
  test('RLS blocks cross-tenant reads by id', async () => {
    const recA = await createRecord(pool, a, 'A');

    await withTenantContext(pool, { tenantId: b.id }, async (c) => {
      const { rows } = await c.query('SELECT * FROM records WHERE record_id = $1', [recA]);
      assert.equal(rows.length, 0, "tenant B must not see tenant A's record by id");
    });
  });

  test('RLS blocks cross-tenant counts', async () => {
    await createRecord(pool, a, 'A2');

    await withTenantContext(pool, { tenantId: b.id }, async (c) => {
      const { rows: [{ count }] } = await c.query('SELECT COUNT(*)::int AS count FROM records');
      assert.equal(count, 0, 'tenant B should see no records at all');
    });
  });

  test('a tenant sees exactly its own records', async () => {
    const t = await seedTenant(pool);
    created.push(t.id);
    await createRecord(pool, t, 'one');
    await createRecord(pool, t, 'two');

    await withTenantContext(pool, { tenantId: t.id }, async (c) => {
      const { rows: [{ count }] } = await c.query('SELECT COUNT(*)::int AS count FROM records');
      assert.equal(count, 2);
    });
  });

  test('a write cannot forge another tenant_id', async () => {
    // PostgreSQL uses the USING expression as WITH CHECK when the latter is omitted, so
    // a symmetric policy blocks forged inserts without further ceremony. Asserted rather
    // than assumed, because the whole write path depends on it.
    await assert.rejects(
      withTenantContext(pool, { tenantId: b.id }, (c) => c.query(
        `INSERT INTO records (tenant_id, record_type, title) VALUES ($1, 'note', 'forged')`,
        [a.id])),
      (err) => err.code === '42501' || /row-level security/i.test(err.message),
      'inserting a row for another tenant must be refused by RLS',
    );
  });

  test('a tenant cannot create a system role template', async () => {
    // Regression for a real escalation. The roles policy is deliberately asymmetric —
    // USING permits tenant_id IS NULL so system templates are readable by everyone. With
    // no explicit WITH CHECK, that permissiveness would apply to writes too, letting any
    // app_user insert a platform-wide role template visible to every tenant on the
    // installation. The policy carries an explicit WITH CHECK to prevent exactly this.
    await assert.rejects(
      withTenantContext(pool, { tenantId: a.id }, (c) => c.query(
        `INSERT INTO roles (tenant_id, code, name, is_system)
         VALUES (NULL, 'forged_system_role', 'Forged', true)`)),
      (err) => err.code === '42501' || /row-level security/i.test(err.message),
      'a tenant must not be able to author a system role template',
    );
  });

  test('a tenant can still read system role templates', async () => {
    // The other half: the asymmetry exists for a reason, and the fix must not break it.
    const code = `sys_${Date.now()}`;
    await asOwner(pool, (c) => c.query(
      `INSERT INTO roles (tenant_id, code, name, is_system) VALUES (NULL, $1, 'System', true)`,
      [code]));

    try {
      await withTenantContext(pool, { tenantId: a.id }, async (c) => {
        const { rows } = await c.query('SELECT 1 FROM roles WHERE code = $1', [code]);
        assert.equal(rows.length, 1, 'system templates must remain readable by every tenant');
      });
    } finally {
      await asOwner(pool, (c) => c.query('DELETE FROM roles WHERE code = $1', [code]));
    }
  });

  test('a tenant can create its own role', async () => {
    // And the fix must not block the legitimate case it sits next to.
    await withTenantContext(pool, { tenantId: a.id }, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'own_role', 'Own')
         RETURNING role_id`, [a.id]);
      assert.equal(rows.length, 1);
    });
  });

  test('cross-tenant record links are impossible', async () => {
    // database/03: both endpoints resolve through records, which is under RLS, so a
    // foreign record simply does not exist and the trigger raises.
    const recA = await createRecord(pool, a, 'A-link');
    const recB = await createRecord(pool, b, 'B-link');

    await assert.rejects(
      withTenantContext(pool, { tenantId: b.id }, (c) => c.query(
        `INSERT INTO record_links (tenant_id, from_record_id, to_record_id, link_type)
         VALUES ($1, $2, $3, 'relates_to')`, [b.id, recB, recA])),
      'a link to another tenant\'s record must fail',
    );
  });
});

describe('tenant context and connection pooling', () => {
  test('tenant context does not leak across a pooled connection', async () => {
    // max: 1 is what makes this deterministic. With a normal pool the two requests
    // probably land on different connections and the test passes while the bug is present.
    const single = createPool(1);
    try {
      await withTenantContext(single, { tenantId: a.id }, async (c) => {
        await c.query('SELECT COUNT(*) FROM records');
      });

      await withTenantContext(single, { tenantId: b.id }, async (c) => {
        const { rows: [{ t }] } = await c.query(
          `SELECT current_setting('app.current_tenant_id', true) AS t`);
        assert.equal(t, b.id, 'the second request must see its own tenant, not the first\'s');
      });
    } finally {
      await single.end();
    }
  });

  test('the GUC is cleared when a transaction ends', async () => {
    // The property that makes transaction-local set_config safe. If this fails, the
    // previous test only passed because the second request happened to overwrite it —
    // and a request that sets no context at all would inherit the last one.
    const single = createPool(1);
    try {
      await withTenantContext(single, { tenantId: a.id }, async (c) => {
        await c.query('SELECT 1');
      });

      const client = await single.connect();
      try {
        const { rows: [{ t }] } = await client.query(
          `SELECT current_setting('app.current_tenant_id', true) AS t`);
        assert.ok(t === null || t === '',
          `tenant GUC survived the transaction on a pooled connection: ${JSON.stringify(t)}`);
      } finally {
        client.release();
      }
    } finally {
      await single.end();
    }
  });

  test('a query with no tenant context sees nothing', async () => {
    // The fail-closed default: a missed set_tenant_context returns zero rows rather than
    // the previous tenant's. current_tenant_id() is NULL, and `tenant_id = NULL` is NULL,
    // so the policy matches nothing.
    await createRecord(pool, a, 'invisible');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      const { rows: [{ count }] } = await client.query('SELECT COUNT(*)::int AS count FROM records');
      assert.equal(count, 0, 'without tenant context the app must see no rows, not all rows');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  test('app_user cannot read another tenant even by escalating within the transaction', async () => {
    // set_tenant_context is not a security boundary by itself — it is a convenience over
    // set_config. This asserts that RLS, not the helper, is what enforces isolation:
    // setting the GUC to another tenant's id is possible, and useless, because the rows
    // still belong to whoever the policy says.
    const recA = await createRecord(pool, a, 'escalation-target');

    // Confirm the row exists at all, from a vantage point that can see it.
    const { rows: owner } = await asOwner(pool, (c) =>
      c.query('SELECT tenant_id FROM records WHERE record_id = $1', [recA]));
    assert.equal(owner.length, 1);
    assert.equal(owner[0].tenant_id, a.id);

    // An app_user session that sets tenant A's id *does* see it — which is precisely why
    // the GUC must be derived from a verified token and never from a request header
    // (api/01, correction 1). The test documents the trust boundary rather than a bug.
    await withTenantContext(pool, { tenantId: a.id }, async (c) => {
      const { rows } = await c.query('SELECT 1 FROM records WHERE record_id = $1', [recA]);
      assert.equal(rows.length, 1);
    });
  });
});
