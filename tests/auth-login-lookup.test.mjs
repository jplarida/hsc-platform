// The login chicken-and-egg, and the reason it did not work.
//
// `app.current_tenant_id` comes from the JWT and the login endpoint has no JWT yet, so the
// lookup has to cross tenants before any context exists. `auth_resolve_login()` is the one
// sanctioned way to do that: SECURITY DEFINER, a fixed query, seven columns, one tenant.
//
// Before migration 0011 its behaviour depended on how the database had been provisioned,
// which is worse than a flat bug. The three tables it reads are FORCE RLS with an
// `app_user`-only policy, and the function ran as the role that applied 0002 — so whether it
// returned anything came down to whether that role happened to be a superuser:
//
//   docker-compose.yml sets POSTGRES_USER=hsc_owner, and the postgres image makes that role
//   a SUPERUSER. Superusers bypass RLS entirely, FORCE included, so the lookup worked — and
//   this is the environment the whole test suite runs against.
//
//   scripts/db-create.mjs (db:create:native) grants the owner CREATEROLE and nothing more.
//   A non-superuser owner IS subject to FORCE, matches no policy, and sees zero rows — so
//   login fails as "user not found" for every input, silently.
//
// `db/README.md` documents the intended shape as the second one: the Roles table says the
// migration owner is "Subject to FORCE". 0011 removes the dependency altogether by giving the
// function an owner that is a plain role with explicit grants and policies, so it behaves the
// same either way. The last test here is what holds that line.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, asOwner, seedTenant, cleanup } from './helpers/db.mjs';

let pool;
const tenants = [];

/**
 * Call the function the way the login path will: as `auth_service`, which is the only role
 * holding EXECUTE on it. SET LOCAL ROLE inside a transaction, so the connection is never
 * returned to the pool still wearing it — the same discipline as src/db/context.ts.
 */
async function resolveLogin(subdomain, email) {
  return asOwner(pool, async (c) => {
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE auth_service');
      const { rows } = await c.query(
        'SELECT * FROM auth_resolve_login($1, $2)', [subdomain, email]);
      return rows;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });
}

before(async () => { pool = createPool(); });
after(async () => { await cleanup(pool, tenants); await pool.end(); });

describe('auth_resolve_login', () => {
  test('resolves a real user', async () => {
    const t = await seedTenant(pool);
    tenants.push(t.id);

    const rows = await resolveLogin(t.slug, `user-${t.slug}@example.test`);

    assert.equal(rows.length, 1, 'expected exactly one row; zero means the definer role ' +
      'matches no policy on tenant_users or tenants — see migration 0011');
    assert.equal(rows[0].user_id, t.userId);
    assert.equal(rows[0].tenant_id, t.id);
    assert.equal(rows[0].mfa_enrolled, false, 'no confirmed MFA method was seeded');
    assert.ok(rows[0].password_hash, 'the hash is what the caller verifies against');
  });

  test('an unknown email in a real tenant resolves to nothing', async () => {
    const t = await seedTenant(pool);
    tenants.push(t.id);

    const rows = await resolveLogin(t.slug, 'nobody@example.test');
    assert.equal(rows.length, 0);
  });

  test('a real user is not resolvable under another tenant subdomain', async () => {
    const a = await seedTenant(pool);
    const b = await seedTenant(pool);
    tenants.push(a.id, b.id);

    // The email exists, the subdomain exists, they do not belong together. This is the
    // predicate that stops the function being a cross-tenant email oracle, so it is worth
    // asserting directly rather than trusting the WHERE clause to stay as written.
    const rows = await resolveLogin(b.slug, `user-${a.slug}@example.test`);
    assert.equal(rows.length, 0);
  });

  test('the lookup is case-insensitive on both arguments', async () => {
    const t = await seedTenant(pool);
    tenants.push(t.id);

    const rows = await resolveLogin(t.slug.toUpperCase(), `USER-${t.slug}@EXAMPLE.TEST`);
    assert.equal(rows.length, 1, 'uq_tenant_users_email_ci indexes lower(email), and the ' +
      'function lowers both sides; a mismatch here is a login that fails on capitalisation');
  });

  test('the lookup does not depend on its owner being a superuser', async () => {
    // The assertion that makes this portable, and the one whose absence hid the problem.
    //
    // A SECURITY DEFINER function owned by a superuser bypasses RLS wholesale, so it works
    // for a reason that has nothing to do with the policies written for it — and then fails
    // the moment it is deployed somewhere the owner was provisioned properly. Asserting the
    // owner is an ordinary role is what stops that difference existing.
    //
    // Note what this deliberately does NOT assert: that the CONNECTING user is a
    // non-superuser. Under docker-compose it is one (POSTGRES_USER=hsc_owner), and changing
    // that is a separate decision about the dev stack. This pins the function only.
    await asOwner(pool, async (c) => {
      const { rows } = await c.query(`
        SELECT r.rolsuper, r.rolbypassrls, r.rolname, p.proconfig
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname = 'auth_resolve_login'`);

      assert.equal(rows.length, 1, 'auth_resolve_login should exist exactly once');
      assert.equal(rows[0].rolsuper, false,
        `auth_resolve_login is owned by ${rows[0].rolname}, a SUPERUSER — it would then read ` +
        'through RLS by bypass rather than by policy, and behave differently wherever the ' +
        'owner is provisioned without superuser. See migration 0011.');
      assert.equal(rows[0].rolbypassrls, false,
        `auth_resolve_login is owned by ${rows[0].rolname}, which holds BYPASSRLS`);
      assert.ok(
        (rows[0].proconfig ?? []).some((c2) => c2.startsWith('search_path=') && c2.includes('pg_temp')),
        'search_path must list pg_temp explicitly, or the temporary schema is searched ' +
        'first for relations and tenant_users can be shadowed');
    });
  });

  test('auth_definer cannot write through its own policies', async () => {
    const t = await seedTenant(pool);
    tenants.push(t.id);

    // The policies added in 0011 are FOR SELECT. If one is ever widened to FOR ALL, the
    // login role becomes a write path that is not subject to tenant isolation, which
    // RULE-HSC-02 classes as a compliance defect rather than a shortcut.
    await asOwner(pool, async (c) => {
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE auth_definer');
        await assert.rejects(
          () => c.query('UPDATE tenant_users SET failed_login_count = 99 WHERE tenant_id = $1',
            [t.id]),
          (err) => err.code === '42501' || err.code === '44000',
          'auth_definer must hold no write path to tenant_users');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  });
});
