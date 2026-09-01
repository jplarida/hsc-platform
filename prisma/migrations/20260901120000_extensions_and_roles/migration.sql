-- 0001 — Extensions and roles
--
-- Source: database/01_TENANT_MANAGEMENT_ERD.md (FORCE RLS rationale),
--         database/04_AUDIT_COMPLIANCE_ERD.md (audit immutability grants),
--         database/08_SCALING_ARCHITECTURE.md (pooled connections),
--         partners/02_APP_AUTHORIZATION_AND_ISOLATION.md (partner portal role).
--
-- Four roles, because tenant isolation is enforced by the database rather than by
-- application code (RULE-HSC-02). Every table that holds tenant data is created with
-- ENABLE + FORCE ROW LEVEL SECURITY, and FORCE is what subjects the table owner to the
-- policy as well — without it any connection that happens to own the table silently
-- bypasses tenant isolation.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────────────
-- gen_random_uuid() is core from PostgreSQL 13, so pgcrypto is not required.
-- The only index types the schema uses are core: GIN over tsvector and over
-- jsonb_path_ops (database/06). No extension is needed for either.
--
-- pg_partman is deliberately NOT required here. database/04 names it as the tool that
-- creates monthly audit partitions in production, but it is a third-party extension and
-- making the schema undeployable without it would block every developer machine.
-- Migration 0005 creates the near-term partitions explicitly and defines
-- create_audit_partition(), which is what pg_partman would otherwise automate.

-- ─────────────────────────────────────────────────────────────────────────────
-- Roles
-- ─────────────────────────────────────────────────────────────────────────────
-- Created with DO blocks because CREATE ROLE has no IF NOT EXISTS, and roles are
-- cluster-wide: a second database in the same cluster would otherwise fail to migrate.

DO $$
BEGIN
    -- Owns every object. Migrations run as this role. Subject to FORCE RLS like anyone else.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hsc_owner') THEN
        CREATE ROLE hsc_owner NOLOGIN;
    END IF;

    -- The application. Every request-path connection authenticates as this role and is
    -- subject to every tenant_isolation policy.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN;
    END IF;

    -- Background workers that must legitimately cross tenant boundaries: the webhook
    -- delivery sweep (api/04 idx_deliveries_due), the app_usage_daily rollup
    -- (partners/01), retention purge jobs (database/04) and migration backfills
    -- (database/07). BYPASSRLS overrides FORCE, so this role must never be used on the
    -- request path.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN
        CREATE ROLE app_platform NOLOGIN BYPASSRLS;
    END IF;

    -- The partner portal (partners/02). Isolated along the partner axis rather than the
    -- tenant axis, and granted nothing at all on records, files, tenant_users or any
    -- audit table — so a SQL injection in the portal still cannot reach tenant data.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_portal_user') THEN
        CREATE ROLE partner_portal_user NOLOGIN;
    END IF;
END
$$;

-- Schema usage. Object-level grants are issued per table by the migrations that create
-- them, never wholesale: a blanket GRANT ON ALL TABLES would hand partner_portal_user
-- the tenant tables the moment a later migration adds one.
GRANT USAGE ON SCHEMA public TO app_user, app_platform, partner_portal_user;

-- Nothing is granted by default to PUBLIC on new objects.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant context
-- ─────────────────────────────────────────────────────────────────────────────
-- Every tenant_isolation policy reads app.current_tenant_id. The GUC must be set with
-- set_config(..., true) — the is_local form — inside an explicit transaction.
--
-- database/08 records why: a session-scoped SET persists on a pooled connection after
-- the request that set it returns the connection to the pool, so the next request
-- inherits the previous request's tenant. That is a cross-tenant read with no error
-- raised anywhere. SET LOCAL / set_config(..., true) is reverted at COMMIT, which is
-- the property that makes pooling safe.
--
-- These helpers exist so the application has one entry point rather than scattering
-- set_config calls, and so the reset path is impossible to forget.

CREATE OR REPLACE FUNCTION set_tenant_context(
    p_tenant_id       UUID,
    p_user_id         UUID DEFAULT NULL,
    p_app_id          UUID DEFAULT NULL,
    p_installation_id UUID DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'set_tenant_context requires a tenant id';
    END IF;

    -- The `true` third argument is is_local: reverted at COMMIT.
    PERFORM set_config('app.current_tenant_id', p_tenant_id::TEXT, true);
    PERFORM set_config('app.current_user_id',   COALESCE(p_user_id::TEXT, ''), true);

    -- App identity, for requests authenticated by a marketplace app token rather than a
    -- user session (partners/02). Both are read by the audit trigger in migration 0005:
    -- without them an app-authenticated write has a null actor and no way to tell which
    -- of a tenant's installed apps performed it.
    PERFORM set_config('app.current_app_id',          COALESCE(p_app_id::TEXT, ''), true);
    PERFORM set_config('app.current_installation_id', COALESCE(p_installation_id::TEXT, ''), true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_partner_context(p_partner_id UUID)
RETURNS VOID AS $$
BEGIN
    IF p_partner_id IS NULL THEN
        RAISE EXCEPTION 'set_partner_context requires a partner id';
    END IF;
    PERFORM set_config('app.current_partner_id', p_partner_id::TEXT, true);
END;
$$ LANGUAGE plpgsql;

-- Readers used by policies and triggers. current_setting(..., true) is the missing_ok
-- form and returns NULL rather than aborting when the GUC was never set — database/04
-- fault 2 records what happens without it: any write occurring outside a request
-- context, such as a migration backfill or a psql session, aborts.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_actor_id() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_app_id() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.current_app_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_installation_id() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.current_installation_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION set_tenant_context(UUID, UUID, UUID, UUID) TO app_user, app_platform;
GRANT EXECUTE ON FUNCTION set_partner_context(UUID)                  TO partner_portal_user;
GRANT EXECUTE ON FUNCTION current_tenant_id()                        TO app_user, app_platform;
GRANT EXECUTE ON FUNCTION current_actor_id()                         TO app_user, app_platform;
GRANT EXECUTE ON FUNCTION current_app_id()                           TO app_user, app_platform;
GRANT EXECUTE ON FUNCTION current_installation_id()                  TO app_user, app_platform;
