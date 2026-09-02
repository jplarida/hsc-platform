-- 0005 — Audit and compliance
--
-- Source: DATABASE_SCHEMA.md (base audit tables and the faulty trigger),
--         database/04_AUDIT_COMPLIANCE_ERD.md, partners/02 (app attribution).
--
-- This migration carries the three faults database/04 found in the original audit
-- trigger, plus one more that only appears when the DDL is actually executed. See the
-- note above create_audit_log().

CREATE TYPE retention_scope  AS ENUM ('record_type', 'file', 'audit_log');
CREATE TYPE retention_action AS ENUM ('purge', 'anonymize', 'archive');
CREATE TYPE dsr_type         AS ENUM ('access', 'erasure', 'portability', 'rectification');
CREATE TYPE dsr_status       AS ENUM ('received', 'verifying', 'in_progress', 'completed', 'rejected');

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit tables (partitioned)
-- ─────────────────────────────────────────────────────────────────────────────
-- Audit volume is the fastest-growing thing in the database and retention deletes by
-- age, so monthly range partitions turn a multi-hour DELETE into an instant DROP.
--
-- The primary key must be composite — (audit_id, timestamp) — because PostgreSQL
-- requires the partition key to participate in every unique constraint.

CREATE TABLE user_audit_log (
    audit_id        UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),

    user_id         UUID REFERENCES tenant_users(user_id),
    user_email      VARCHAR(255),           -- denormalised: survives user deletion

    action          VARCHAR(100) NOT NULL,  -- 'login','logout','view','create','update','delete'
    resource_type   VARCHAR(100),
    resource_id     UUID,

    -- Fault 3 (database/04): a database trigger cannot observe a SELECT, but HIPAA
    -- 164.312(b) requires recording *access* to PHI. Read logging is therefore an
    -- application responsibility written here, and this flag is what makes it auditable.
    is_phi_access   BOOLEAN NOT NULL DEFAULT FALSE,

    ip_address      INET,
    user_agent      TEXT,
    session_id      UUID,                   -- correlate to sessions (0003)

    -- AMENDMENT (partners/02): without these, an app-authenticated action has a null
    -- actor and no way to identify which of a tenant's installed apps performed it.
    --
    -- DIVERGENCE from partners/02, which writes these as
    --   app_id UUID REFERENCES partner_apps(app_id)
    -- Deliberately no foreign key here. Audit rows are retained for six years under
    -- HIPAA 164.316(b)(2) and must outlive the partner they refer to; an FK would either
    -- block a partner's removal forever or, with a cascade, delete the evidence that the
    -- app ever touched the data. The id is recorded as an opaque value, exactly as
    -- user_email is denormalised onto user_audit_log so it survives user deletion.
    app_id          UUID,
    installation_id UUID,

    details         JSONB NOT NULL DEFAULT '{}',
    timestamp       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    PRIMARY KEY (audit_id, timestamp)
) PARTITION BY RANGE (timestamp);

CREATE TABLE data_audit_log (
    audit_id        UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),

    table_name      VARCHAR(100) NOT NULL,
    record_id       UUID NOT NULL,
    operation       VARCHAR(10) NOT NULL,   -- 'INSERT' | 'UPDATE' | 'DELETE'
    old_values      JSONB,
    new_values      JSONB,
    changed_fields  TEXT[],

    changed_by      UUID REFERENCES tenant_users(user_id),
    app_id          UUID,
    installation_id UUID,

    timestamp       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    PRIMARY KEY (audit_id, timestamp)
) PARTITION BY RANGE (timestamp);

CREATE TABLE system_audit_log (
    audit_id       UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id      UUID REFERENCES tenants(tenant_id),   -- NULL for platform-wide events

    event_type     VARCHAR(100) NOT NULL,
    event_category VARCHAR(50)  NOT NULL,   -- 'security'|'performance'|'data'|'system'
    severity       VARCHAR(20)  NOT NULL DEFAULT 'info',

    message        TEXT NOT NULL,
    details        JSONB NOT NULL DEFAULT '{}',
    source         VARCHAR(100),
    correlation_id UUID,

    timestamp      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    PRIMARY KEY (audit_id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Partition management. database/04 names pg_partman as the production tool; this is the
-- same behaviour without the extension dependency, so a developer machine can migrate.
CREATE OR REPLACE FUNCTION create_audit_partition(p_table TEXT, p_month DATE)
RETURNS VOID AS $$
DECLARE
    v_start DATE := date_trunc('month', p_month)::DATE;
    v_end   DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::DATE;
    v_name  TEXT := format('%s_%s', p_table, to_char(v_start, 'YYYY_MM'));
BEGIN
    IF to_regclass(v_name) IS NOT NULL THEN
        RETURN;
    END IF;
    EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        v_name, p_table, v_start, v_end);
END;
$$ LANGUAGE plpgsql;

-- A DEFAULT partition is not in database/04 but is required for safety: without one, an
-- insert whose timestamp falls outside every declared range fails outright, which would
-- take the whole application down the first month the partition job is missed. Rows
-- landing here are a monitoring signal, not a normal path.
CREATE TABLE user_audit_log_default   PARTITION OF user_audit_log   DEFAULT;
CREATE TABLE data_audit_log_default   PARTITION OF data_audit_log   DEFAULT;
CREATE TABLE system_audit_log_default PARTITION OF system_audit_log DEFAULT;

DO $$
DECLARE
    m DATE;
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['user_audit_log', 'data_audit_log', 'system_audit_log'] LOOP
        m := date_trunc('month', NOW() - INTERVAL '3 months')::DATE;
        WHILE m < (date_trunc('month', NOW()) + INTERVAL '13 months')::DATE LOOP
            PERFORM create_audit_partition(t, m);
            m := (m + INTERVAL '1 month')::DATE;
        END LOOP;
    END LOOP;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Masking
-- ─────────────────────────────────────────────────────────────────────────────
-- to_jsonb(NEW) on tenant_users copies password_hash and mfa_secret into the audit log
-- in plaintext, turning it into a credential store that outlives password rotation.
CREATE OR REPLACE FUNCTION mask_sensitive(p_table TEXT, p_row JSONB) RETURNS JSONB AS $$
BEGIN
    IF p_row IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_table = 'tenant_users' THEN
        RETURN p_row - 'password_hash' - 'mfa_secret';
    ELSIF p_table = 'sso_connections' THEN
        RETURN p_row - 'oidc_client_secret_encrypted';
    ELSIF p_table = 'mfa_methods' THEN
        RETURN p_row - 'secret_encrypted';
    ELSIF p_table = 'integration_connections' THEN
        -- Added by 0007: OAuth tokens for third-party services.
        RETURN p_row - 'access_token_encrypted' - 'refresh_token_encrypted';
    END IF;
    RETURN p_row;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ─────────────────────────────────────────────────────────────────────────────
-- The audit trigger
-- ─────────────────────────────────────────────────────────────────────────────
-- Fault 1 (database/04): the original function referenced NEW.record_id and was attached
--   to records, files and tenant_users, whose PKs are record_id, file_id and user_id.
--   Every write to files and tenant_users failed at runtime with
--   'record "new" has no field "record_id"' — those two tables were simply unwritable.
--   Fixed by passing the PK column name as TG_ARGV[0] and reading it out of a jsonb copy.
--
-- Fault 2 (database/04): current_setting('app.current_user_id') without missing_ok raises
--   undefined_object whenever the GUC is unset — which is every background job, every
--   migration and every psql session. Fixed with the two-argument form.
--
-- Fault 4 (found on execution, not in the documents): database/04 specifies both
--   SECURITY DEFINER on this function and FORCE ROW LEVEL SECURITY on data_audit_log,
--   with tenant_isolation declared only FOR app_user. FORCE subjects the table owner to
--   RLS too, and a policy naming a role does not apply to any other role — so the
--   function, running as its owner, matches no policy and every audited write fails with
--   'new row violates row-level security policy'. The two directives deadlock as written.
--   Resolved with an explicit append-only policy for the function owner below: it can
--   insert any tenant's row, which the trigger must do, but it is granted no SELECT
--   policy, so it still cannot read across tenants.
CREATE OR REPLACE FUNCTION create_audit_log() RETURNS TRIGGER AS $$
DECLARE
    v_pk_column TEXT := TG_ARGV[0];
    v_new       JSONB;
    v_old       JSONB;
    v_row       JSONB;
    v_record_id UUID;
    v_tenant_id UUID;
    v_changed   TEXT[];
BEGIN
    v_new := to_jsonb(NEW);
    v_old := to_jsonb(OLD);
    v_row := COALESCE(v_new, v_old);
    v_record_id := (v_row ->> v_pk_column)::UUID;

    -- Fault 5 (found by seeding, not by the tests): this originally read
    -- COALESCE(NEW.tenant_id, OLD.tenant_id) directly. That is fault 1 again in a
    -- different column — database/04 fixed the primary key by passing it as TG_ARGV[0]
    -- and then went on referencing NEW.tenant_id, which does not exist on every audited
    -- table. user_roles is keyed (user_id, role_id) and carries no tenant_id at all, so
    -- every grant of a role to a user failed with
    -- 'record "new" has no field "tenant_id"'. RBAC was unusable.
    --
    -- Reading it out of the jsonb copy tolerates its absence; the GUC supplies it for
    -- tables scoped through a parent. Failing loudly beats writing an unattributable
    -- audit row, so a null tenant raises rather than defaulting.
    v_tenant_id := COALESCE(
        NULLIF(v_row ->> 'tenant_id', '')::UUID,
        current_tenant_id());

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'Audit trigger on % cannot resolve a tenant: the row has no tenant_id and '
            'no tenant context is set. Wrap the write in set_tenant_context().',
            TG_TABLE_NAME
            USING ERRCODE = 'raise_exception';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT array_agg(key) INTO v_changed
          FROM jsonb_each(v_new)
         WHERE v_new -> key IS DISTINCT FROM v_old -> key;

        -- A no-op save should not write an empty audit row.
        --
        -- OBSERVED (first execution): the guard above never fired for `records`. Two
        -- triggers documented independently — bump_record_version() in database/03 and
        -- this one in database/04 — interact. The BEFORE trigger sets updated_at = NOW()
        -- and increments version on every UPDATE, so by the time this AFTER trigger runs
        -- those two columns have always changed and v_changed is never NULL.
        --
        -- Neither document is wrong on its own; the combination defeats the stated intent
        -- and turns every touch of a record into an audit row. Mechanical columns are
        -- therefore excluded when deciding whether anything actually happened. They are
        -- still reported in changed_fields when a real change accompanies them.
        IF v_changed IS NOT NULL
           AND v_changed <@ ARRAY['updated_at', 'version', 'search_vector'] THEN
            RETURN NEW;
        END IF;

        IF v_changed IS NULL THEN
            RETURN NEW;
        END IF;
    END IF;

    INSERT INTO data_audit_log (
        tenant_id, table_name, record_id, operation,
        old_values, new_values, changed_fields,
        changed_by, app_id, installation_id, timestamp
    ) VALUES (
        v_tenant_id,
        TG_TABLE_NAME,
        v_record_id,
        TG_OP,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE')
             THEN mask_sensitive(TG_TABLE_NAME, v_old) END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE')
             THEN mask_sensitive(TG_TABLE_NAME, v_new) END,
        v_changed,
        current_actor_id(),
        current_app_id(),
        current_installation_id(),
        -- clock_timestamp(), not NOW(). OBSERVED on first execution: NOW() is the
        -- transaction start time, so every audit row written inside one transaction
        -- carried an identical timestamp. With no sequence column either, the order of
        -- two changes made in the same transaction was unrecoverable — "what happened
        -- first?" is a question an audit trail has to be able to answer, and this one
        -- could not. clock_timestamp() advances per statement.
        clock_timestamp()
    );

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER records_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON records
    FOR EACH ROW EXECUTE FUNCTION create_audit_log('record_id');
CREATE TRIGGER tenant_users_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON tenant_users
    FOR EACH ROW EXECUTE FUNCTION create_audit_log('user_id');
CREATE TRIGGER record_links_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON record_links
    FOR EACH ROW EXECUTE FUNCTION create_audit_log('link_id');
CREATE TRIGGER user_roles_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON user_roles
    FOR EACH ROW EXECUTE FUNCTION create_audit_log('user_id');
CREATE TRIGGER sso_connections_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON sso_connections
    FOR EACH ROW EXECUTE FUNCTION create_audit_log('connection_id');
-- The files trigger is attached in migration 0006, where files is created.

-- ─────────────────────────────────────────────────────────────────────────────
-- Immutability
-- ─────────────────────────────────────────────────────────────────────────────
-- An audit log the application can rewrite is not evidence.
CREATE OR REPLACE FUNCTION deny_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit records are append-only (attempted % on %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_audit_immutable   BEFORE UPDATE OR DELETE ON user_audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION deny_audit_mutation();
CREATE TRIGGER data_audit_immutable   BEFORE UPDATE OR DELETE ON data_audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION deny_audit_mutation();
CREATE TRIGGER system_audit_immutable BEFORE UPDATE OR DELETE ON system_audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION deny_audit_mutation();

-- NOTE on the purge path. database/04 states that "retention purges must therefore run as
-- the table owner, not app_user — the one legitimate path that bypasses these triggers".
-- That is not how triggers work: they fire regardless of the role executing the
-- statement, owner included. The claim would leave retention unimplementable.
--
-- It does not matter, because the designed purge path is DROP PARTITION rather than
-- DELETE, and detaching or dropping a partition fires no row or statement DELETE
-- trigger. Retention by partition drop works; retention by DELETE would require an
-- explicit ALTER TABLE ... DISABLE TRIGGER, which should never be scripted.

-- ─────────────────────────────────────────────────────────────────────────────
-- Retention, holds and purge
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE retention_policies (
    policy_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    scope           retention_scope NOT NULL,
    target_code     VARCHAR(100),           -- record_type code, or NULL for whole scope
    retain_for_days INTEGER NOT NULL CHECK (retain_for_days > 0),
    action          retention_action NOT NULL DEFAULT 'archive',
    legal_basis     VARCHAR(255) NOT NULL,  -- 'HIPAA 45 CFR 164.316(b)(2) - 6 years'
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, scope, target_code)
);

ALTER TABLE record_type_definitions ADD CONSTRAINT fk_rtd_retention
    FOREIGN KEY (retention_policy_id) REFERENCES retention_policies(policy_id) ON DELETE SET NULL;

CREATE TABLE retention_holds (
    hold_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    scope       retention_scope NOT NULL,
    target_id   UUID,                       -- specific record/file, or NULL for whole scope
    reason      TEXT NOT NULL,
    placed_by   UUID REFERENCES tenant_users(user_id),
    placed_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    released_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_holds_active ON retention_holds(tenant_id, scope, target_id)
    WHERE released_at IS NULL;

CREATE TABLE purge_jobs (
    job_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    policy_id            UUID REFERENCES retention_policies(policy_id) ON DELETE SET NULL,
    scheduled_for        TIMESTAMP WITH TIME ZONE NOT NULL,
    status               job_status NOT NULL DEFAULT 'pending',
    rows_affected        INTEGER NOT NULL DEFAULT 0,
    -- The number an auditor asks for. Purging data under legal hold is spoliation, so
    -- this is the one place where failing closed matters more than completing the job.
    rows_skipped_on_hold INTEGER NOT NULL DEFAULT 0,
    error                TEXT,
    started_at           TIMESTAMP WITH TIME ZONE,
    completed_at         TIMESTAMP WITH TIME ZONE
);

-- A legal hold always outranks a retention policy.
CREATE OR REPLACE FUNCTION is_on_hold(p_tenant UUID, p_scope retention_scope, p_target UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM retention_holds
         WHERE tenant_id = p_tenant
           AND scope     = p_scope
           AND released_at IS NULL
           AND (target_id IS NULL OR target_id = p_target));
$$ LANGUAGE sql STABLE;

CREATE TABLE audit_log_archives (
    archive_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID REFERENCES tenants(tenant_id) ON DELETE SET NULL,
    log_table    VARCHAR(50) NOT NULL,
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end   TIMESTAMP WITH TIME ZONE NOT NULL,
    object_key   TEXT NOT NULL,          -- S3 Glacier object, Object Lock enabled
    -- What makes a restored archive provably the one that was sealed. Without it a
    -- cold-storage export is not evidence either.
    checksum     VARCHAR(64) NOT NULL,
    row_count    BIGINT NOT NULL,
    sealed_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Subject rights (GDPR / CCPA)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE data_subject_requests (
    request_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    subject_email     VARCHAR(255),
    subject_record_id UUID REFERENCES records(record_id) ON DELETE SET NULL,
    request_type      dsr_type NOT NULL,
    status            dsr_status NOT NULL DEFAULT 'received',
    received_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    due_at            TIMESTAMP WITH TIME ZONE NOT NULL,   -- GDPR: received_at + 30 days
    completed_at      TIMESTAMP WITH TIME ZONE,
    handled_by        UUID REFERENCES tenant_users(user_id),
    export_file_id    UUID,                                -- FK to files, added in 0006
    rejection_reason  TEXT,

    CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

CREATE INDEX idx_dsr_due ON data_subject_requests(due_at)
    WHERE status NOT IN ('completed', 'rejected');

-- PATIENT consent to data processing. Distinct from marketplace installation consent in
-- partners/02: different subject, different legal basis, different retention. The two
-- must not be merged.
CREATE TABLE consent_records (
    consent_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    subject_record_id UUID NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
    purpose           VARCHAR(100) NOT NULL,   -- 'treatment' | 'marketing' | 'research'
    granted           BOOLEAN NOT NULL,
    policy_version    VARCHAR(20) NOT NULL,
    source            VARCHAR(50) NOT NULL,    -- 'web_form' | 'paper' | 'verbal'
    granted_at        TIMESTAMP WITH TIME ZONE,
    withdrawn_at      TIMESTAMP WITH TIME ZONE,
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_consent_subject ON consent_records(subject_record_id, purpose);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE user_audit_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_audit_log        FORCE  ROW LEVEL SECURITY;
ALTER TABLE data_audit_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_audit_log        FORCE  ROW LEVEL SECURITY;
-- CORRECTION (database/04): DATABASE_SCHEMA.md enables RLS on seven tables and omits
-- system_audit_log, which carries a nullable tenant_id — so every tenant could read
-- every other tenant's system events.
ALTER TABLE system_audit_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_audit_log      FORCE  ROW LEVEL SECURITY;
ALTER TABLE retention_policies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies    FORCE  ROW LEVEL SECURITY;
ALTER TABLE retention_holds       ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_holds       FORCE  ROW LEVEL SECURITY;
ALTER TABLE purge_jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE purge_jobs            FORCE  ROW LEVEL SECURITY;
ALTER TABLE data_subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_subject_requests FORCE  ROW LEVEL SECURITY;
ALTER TABLE consent_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records       FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_log_archives    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log_archives    FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON user_audit_log        FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON data_audit_log        FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
-- Platform rows (tenant_id IS NULL) are visible to no tenant: NULL = x yields NULL.
CREATE POLICY tenant_isolation ON system_audit_log      FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON retention_policies    FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON retention_holds       FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON purge_jobs            FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON data_subject_requests FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON consent_records       FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON audit_log_archives    FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());

-- Resolves fault 4. The trigger runs SECURITY DEFINER as its owner — whichever role
-- applied this migration — and must be able to append a row for whichever tenant it
-- fired in. Append only: no SELECT, UPDATE or DELETE policy exists for that role, so it
-- cannot read across tenants, and the immutability triggers still apply to it.
--
-- The role name is resolved dynamically rather than hardcoded, so the migration works
-- whatever the DATABASE_URL user is called.
DO $$
BEGIN
    EXECUTE format(
        'CREATE POLICY audit_append ON data_audit_log FOR INSERT TO %I WITH CHECK (true)',
        current_user);
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants — audit immutability
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON user_audit_log, data_audit_log, system_audit_log FROM app_user;
GRANT  SELECT ON user_audit_log, data_audit_log, system_audit_log TO app_user;
-- The application writes its own read-access and system events; data_audit_log is
-- trigger-only, so app_user gets no INSERT on it.
GRANT  INSERT ON user_audit_log, system_audit_log TO app_user;

-- The PHI access-log writer batches events across tenants and runs as app_platform.
--
-- BYPASSRLS is a row-level exemption, NOT a table privilege — a role can be exempt from
-- every policy on a table it has no right to touch. Without this grant the background
-- writer fails with 'permission denied for table user_audit_log', and because it writes
-- asynchronously the failure surfaces as a queue that never drains rather than as a
-- failed request. The audit trail would appear to be working.
GRANT SELECT, INSERT ON user_audit_log, system_audit_log TO app_platform;
GRANT SELECT ON data_audit_log TO app_platform;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    retention_policies, retention_holds, purge_jobs, data_subject_requests,
    consent_records, audit_log_archives
    TO app_user;

GRANT EXECUTE ON FUNCTION is_on_hold(UUID, retention_scope, UUID) TO app_user, app_platform;
GRANT EXECUTE ON FUNCTION create_audit_partition(TEXT, DATE)      TO app_platform;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_user_audit_tenant_time ON user_audit_log(tenant_id, timestamp DESC);
CREATE INDEX idx_user_audit_phi         ON user_audit_log(tenant_id, timestamp DESC)
    WHERE is_phi_access;
CREATE INDEX idx_user_audit_actor       ON user_audit_log(tenant_id, user_id, timestamp DESC);
CREATE INDEX idx_user_audit_resource    ON user_audit_log(tenant_id, resource_type, resource_id, timestamp DESC);
CREATE INDEX idx_user_audit_app         ON user_audit_log(tenant_id, app_id, timestamp DESC)
    WHERE app_id IS NOT NULL;

CREATE INDEX idx_data_audit_tenant_table_time ON data_audit_log(tenant_id, table_name, timestamp DESC);
-- Answers the most common audit question — the full history of one record — which the
-- (tenant_id, table_name, timestamp) index cannot do without scanning a table's worth.
CREATE INDEX idx_data_audit_record      ON data_audit_log(tenant_id, table_name, record_id, timestamp DESC);
CREATE INDEX idx_data_audit_actor       ON data_audit_log(tenant_id, changed_by, timestamp DESC);

CREATE INDEX idx_system_audit_time      ON system_audit_log(timestamp DESC);
CREATE INDEX idx_system_audit_severity  ON system_audit_log(severity, timestamp DESC);
CREATE INDEX idx_system_audit_corr      ON system_audit_log(correlation_id) WHERE correlation_id IS NOT NULL;
