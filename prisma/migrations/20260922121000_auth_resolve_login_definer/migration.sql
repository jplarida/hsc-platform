-- 0011 — Give the login lookup an owner that is not the schema owner
--
-- Resolves `database/02` OQ4, reviewed 2026-09-22. The review confirmed the deviation
-- recorded in 0002: a SECURITY DEFINER function is the right answer over BYPASSRLS, because
-- BYPASSRLS is a cluster-wide role attribute and cannot be scoped to `tenant_users` the way
-- database/02 asks for — granting it would have exempted the login role from RLS on every
-- table in the database, `records` and the audit logs included.
--
-- The review also found that the function as written could never return a row.
--
-- `tenant_users`, `tenants` and `mfa_methods` are all ENABLE + FORCE ROW LEVEL SECURITY, and
-- the only policy on each is `tenant_isolation ... FOR ALL TO app_user`. A SECURITY DEFINER
-- function executes as its owner, the owner here was the role that applied 0002, and FORCE is
-- precisely what subjects that role to its own policies. A policy naming `app_user` does not
-- apply to it, and RLS with no applicable policy denies by default — so the SELECT inside
-- `auth_resolve_login()` matched nothing, for every subdomain and every email. Login would
-- have failed as "user not found" in all cases.
--
-- This is fault 4 again (db/README defect 3), which was found and fixed for the audit trigger
-- by giving its owner a narrow policy of its own, and never applied here. It survived because
-- nothing calls this function and no test covered it: a function that is specified, granted
-- and wrong looks exactly like a function that works.
--
-- The cheap fix is to add owner policies to the three tables, mirroring `audit_append`. That
-- was rejected: the owner currently reads nothing in those tables, and re-opening it would
-- undo what FORCE was added to achieve, for every future query as well as this one. Instead
-- the function gets an owner that owns nothing else and cannot log in, so the bypass is
-- confined to one role, three tables and SELECT.

-- ─────────────────────────────────────────────────────────────────────────────
-- A role that exists only to own this function
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_definer') THEN
        CREATE ROLE auth_definer NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO auth_definer;

-- Handing ownership over requires membership of the receiving role, and a later migration
-- that needs to CREATE OR REPLACE this function will need it too. Resolved dynamically, as
-- in 0001 and 0002, so the migration works whatever the DATABASE_URL user is called.
--
-- Membership is not free: it means the migration owner can SET ROLE auth_definer and read
-- these three tables. That is a deliberate, visible step rather than an ambient privilege —
-- which is the difference between this and granting the owner a policy outright.
DO $$
BEGIN
    EXECUTE format('GRANT auth_definer TO %I', current_user);
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly the three tables the function reads, SELECT only
-- ─────────────────────────────────────────────────────────────────────────────
-- A grant is not enough on its own: these tables are under RLS, and a role with SELECT and
-- no applicable policy still sees zero rows. That is the same mistake `app_platform` has now
-- made three times in the other direction — exempt from the policies, no privilege on the
-- table. Both halves are needed, so both are here.
GRANT SELECT ON tenants, tenant_users, mfa_methods TO auth_definer;

-- SELECT only, and no `FOR ALL`. `auth_definer` must never be able to write: the login path
-- has to increment `failed_login_count` and create a session, and those writes deliberately
-- do not happen here — they belong to an authenticated role once the tenant is known.
CREATE POLICY auth_login_lookup ON tenants
    FOR SELECT TO auth_definer USING (deleted_at IS NULL);

CREATE POLICY auth_login_lookup ON tenant_users
    FOR SELECT TO auth_definer USING (deleted_at IS NULL);

-- Narrower than the other two on purpose: the function only asks whether a confirmed method
-- exists, so an unconfirmed enrollment is not readable through this path at all. If a later
-- flow needs to see pending enrollments it must widen this deliberately — the failure mode
-- is a missing row rather than a leak, which is the right direction for it to fail in.
CREATE POLICY auth_login_lookup ON mfa_methods
    FOR SELECT TO auth_definer USING (confirmed_at IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- Replace the function to pin pg_temp, then hand it over
-- ─────────────────────────────────────────────────────────────────────────────
-- Unchanged except for `search_path`. `SET search_path = public` left `pg_temp` implicit, and
-- PostgreSQL searches the temporary schema FIRST for relations when it is not listed — so a
-- session able to create temp objects could shadow `tenant_users` and feed this function its
-- own rows. Listing pg_temp last is the documented form for SECURITY DEFINER.
--
-- Not reachable from the API today: every query in src/ is parameterised and role names go
-- through a closed set, so there is no way in. It is defence in depth, and it costs one line.
CREATE OR REPLACE FUNCTION auth_resolve_login(p_subdomain TEXT, p_email TEXT)
RETURNS TABLE (
    user_id       UUID,
    tenant_id     UUID,
    password_hash VARCHAR(255),
    status        user_status,
    locked_until  TIMESTAMP WITH TIME ZONE,
    failed_login_count INTEGER,
    mfa_enrolled  BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT u.user_id,
           u.tenant_id,
           u.password_hash,
           u.status,
           u.locked_until,
           u.failed_login_count,
           EXISTS (SELECT 1 FROM mfa_methods m
                    WHERE m.user_id = u.user_id AND m.confirmed_at IS NOT NULL)
      FROM tenant_users u
      JOIN tenants t ON t.tenant_id = u.tenant_id
     WHERE t.subdomain = lower(p_subdomain)
       AND t.deleted_at IS NULL
       AND lower(u.email) = lower(p_email)
       AND u.deleted_at IS NULL;
$$;

-- This is the line that makes the function work. Everything above it is the scaffolding that
-- lets this be narrow instead of broad.
ALTER FUNCTION auth_resolve_login(TEXT, TEXT) OWNER TO auth_definer;

-- CREATE OR REPLACE preserves the existing ACL and ALTER ... OWNER does not reset it, so the
-- grant surface from 0002 still stands: revoked from PUBLIC, executable by `auth_service` and
-- nothing else. Restated rather than assumed, because it is the whole containment argument —
-- EXECUTE on this function is equivalent to reading any user's password hash in any tenant,
-- given a subdomain and an email.
REVOKE EXECUTE ON FUNCTION auth_resolve_login(TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION auth_resolve_login(TEXT, TEXT) TO auth_service;
