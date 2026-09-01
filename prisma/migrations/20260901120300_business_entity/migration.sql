-- 0004 — Core business entities
--
-- Source: DATABASE_SCHEMA.md (base records/forms/workflows),
--         database/03_BUSINESS_ENTITY_ERD.md, analytics/01 and interoperability/01
--         (JSONB annotation conventions).
--
-- This is the industry-agnostic core: there is no `patients` table. A generic records
-- table with a JSONB payload, plus a per-tenant type registry that declares what a
-- record type means. That is what lets one schema serve a clinic and a construction firm,
-- and it is why the vertical question does not block this migration.

CREATE TYPE link_cardinality AS ENUM ('one_to_one', 'one_to_many', 'many_to_many');
CREATE TYPE link_on_delete   AS ENUM ('restrict', 'cascade', 'set_null');

-- ─────────────────────────────────────────────────────────────────────────────
-- Records
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE records (
    record_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(tenant_id),

    record_type    VARCHAR(100) NOT NULL,   -- 'patient', 'incident', 'appointment'
    title          VARCHAR(500),
    description    TEXT,
    data           JSONB NOT NULL DEFAULT '{}',

    status         VARCHAR(100) DEFAULT 'active',
    workflow_state VARCHAR(100),

    -- ADDITION (database/03): offline sync compares local against server version to
    -- detect conflicts. Without it the conflict-resolution flow in OFFLINE_SYNC_PROCESS
    -- has nothing to compare.
    version        INTEGER NOT NULL DEFAULT 1,

    -- Which form schema validated this record. Schemas change; a record captured under
    -- v1 must not be re-validated against v4 on read. FK added below, once form_versions
    -- exists — the two tables reference each other.
    form_version_id UUID,

    -- Provenance for migrated rows, so re-running an import is idempotent.
    external_id    VARCHAR(255),

    created_by     UUID REFERENCES tenant_users(user_id),
    updated_by     UUID REFERENCES tenant_users(user_id),
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at     TIMESTAMP WITH TIME ZONE,

    -- CORRECTION (executable defect): DATABASE_SCHEMA.md writes this as
    --   to_tsvector('english', ...)
    -- which resolves to to_tsvector(text, text) — a STABLE function, because the text
    -- form looks the configuration up at run time. PostgreSQL requires a generation
    -- expression to be IMMUTABLE and rejects the column outright with
    -- "generation expression is not immutable". The explicit ::regconfig cast selects
    -- the two-argument immutable form. The original DDL cannot be created as written.
    search_vector  tsvector GENERATED ALWAYS AS (
        to_tsvector('english'::regconfig,
                    coalesce(title, '') || ' ' || coalesce(description, ''))
    ) STORED
);

CREATE UNIQUE INDEX uq_records_external_id
    ON records(tenant_id, record_type, external_id) WHERE external_id IS NOT NULL;

-- version must increment in the database, not the application: an offline client that
-- syncs directly, or a bulk SQL fix, would otherwise leave the counter stale and
-- silently break conflict detection.
CREATE OR REPLACE FUNCTION bump_record_version() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.version = OLD.version THEN        -- caller did not set it explicitly
        NEW.version := OLD.version + 1;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER records_version_trigger
    BEFORE UPDATE ON records
    FOR EACH ROW EXECUTE FUNCTION bump_record_version();

-- ─────────────────────────────────────────────────────────────────────────────
-- Forms and versioning
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE forms (
    form_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(tenant_id),
    name             VARCHAR(255) NOT NULL,
    description      TEXT,

    -- DEPRECATED (database/03): editing in place destroys the schema that
    -- already-submitted records were validated against. Migrate to form_versions.schema.
    schema           JSONB,
    validation_rules JSONB DEFAULT '{}',
    version          INTEGER DEFAULT 1,

    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       UUID REFERENCES tenant_users(user_id),
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN forms.schema IS
    'DEPRECATED - migrate to form_versions.schema. Editing in place destroys the schema '
    'that already-submitted records were validated against.';

CREATE TABLE form_versions (
    form_version_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    form_id          UUID NOT NULL REFERENCES forms(form_id) ON DELETE CASCADE,
    version          INTEGER NOT NULL,

    -- AMENDMENT (analytics/01 + interoperability/01). Two annotation conventions live
    -- inside this JSONB rather than as columns, because the field set is tenant-defined:
    --
    --   phi_class          — 'direct_identifier' | 'date' | 'geo' | 'clinical' | 'none'
    --                        Drives HIPAA Safe Harbor de-identification. Nothing
    --                        cross-tenant in analytics/01 can ship until fields carry it,
    --                        because de-identification here is schema-driven.
    --   {system,code,display} — coded-field triple for external terminology mapping.
    --                        interoperability/01 notes the cost of adding this rises with
    --                        every record captured, so the convention is fixed now even
    --                        though the FHIR work is deferred.
    --
    -- Enforced at form publish time, not by a CHECK: a partially-annotated draft must
    -- still be storable, and a constraint here would block authoring.
    schema           JSONB NOT NULL,
    validation_rules JSONB NOT NULL DEFAULT '{}',
    published_by     UUID REFERENCES tenant_users(user_id),
    published_at     TIMESTAMP WITH TIME ZONE,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (form_id, version)
);

-- forms and form_versions reference each other, so both FKs are added after the fact.
ALTER TABLE forms   ADD COLUMN current_version_id UUID REFERENCES form_versions(form_version_id);
ALTER TABLE records ADD CONSTRAINT fk_records_form_version
    FOREIGN KEY (form_version_id) REFERENCES form_versions(form_version_id);

CREATE TABLE workflows (
    workflow_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(tenant_id),
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    states      JSONB NOT NULL,      -- array of possible states
    transitions JSONB NOT NULL,      -- valid state transitions
    rules       JSONB NOT NULL DEFAULT '{}',
    record_type VARCHAR(100),
    created_by  UUID REFERENCES tenant_users(user_id),
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Type registry
-- ─────────────────────────────────────────────────────────────────────────────
-- The registry is what makes the platform industry-agnostic, and is_phi is the single
-- switch that drives PHI read-logging (0005), webhook payload restriction (api/04),
-- marketplace scope tiers (partners/02) and de-identification (analytics/01).
CREATE TABLE record_type_definitions (
    type_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    code                VARCHAR(100) NOT NULL,   -- 'patient', 'appointment', 'case'
    display_name        VARCHAR(150) NOT NULL,
    plural_name         VARCHAR(150) NOT NULL,
    icon                VARCHAR(50),

    industry_pack_code  VARCHAR(50),             -- NULL for tenant-authored types
    default_form_id     UUID REFERENCES forms(form_id) ON DELETE SET NULL,
    default_workflow_id UUID REFERENCES workflows(workflow_id) ON DELETE SET NULL,

    indexed_fields      JSONB NOT NULL DEFAULT '[]',   -- ["mrn","date_of_birth"]

    retention_policy_id UUID,                    -- FK added in migration 0005
    is_phi              BOOLEAN NOT NULL DEFAULT FALSE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, code)
);

-- Ties every record to a declared type, per tenant. A typo in record_type now fails
-- loudly instead of creating an invisible orphan class of records.
ALTER TABLE records ADD CONSTRAINT fk_records_type
    FOREIGN KEY (tenant_id, record_type)
    REFERENCES record_type_definitions(tenant_id, code)
    ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Relationships
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE record_links (
    link_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    from_record_id UUID NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
    to_record_id   UUID NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
    link_type      VARCHAR(100) NOT NULL,      -- 'attends', 'treats', 'bills_to'
    metadata       JSONB NOT NULL DEFAULT '{}',
    created_by     UUID REFERENCES tenant_users(user_id),
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (from_record_id, to_record_id, link_type),
    CHECK  (from_record_id <> to_record_id)
);

CREATE TABLE record_link_rules (
    rule_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    from_type_code      VARCHAR(100) NOT NULL,
    to_type_code        VARCHAR(100) NOT NULL,
    link_type           VARCHAR(100) NOT NULL,
    cardinality         link_cardinality NOT NULL DEFAULT 'many_to_many',
    is_required         BOOLEAN NOT NULL DEFAULT FALSE,
    on_delete_behaviour link_on_delete NOT NULL DEFAULT 'restrict',
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, from_type_code, to_type_code, link_type),
    FOREIGN KEY (tenant_id, from_type_code)
        REFERENCES record_type_definitions(tenant_id, code) ON UPDATE CASCADE,
    FOREIGN KEY (tenant_id, to_type_code)
        REFERENCES record_type_definitions(tenant_id, code) ON UPDATE CASCADE
);

-- A plain FK cannot express "an appointment links to exactly one patient" when both
-- live in the same table, so a trigger enforces the declared rule.
--
-- CORRECTION (executable defect): database/03 writes the first lookup as
--   SELECT record_type, tenant_id INTO v_from_type, NEW.tenant_id FROM records ...
-- Assigning into NEW.tenant_id through an INTO clause is not valid plpgsql — INTO
-- targets must be plain variables, not record fields. Rewritten with a local variable
-- and an explicit assignment.
CREATE OR REPLACE FUNCTION enforce_record_link_rule() RETURNS TRIGGER AS $$
DECLARE
    v_from_type TEXT;
    v_to_type   TEXT;
    v_tenant_id UUID;
    v_rule      record_link_rules%ROWTYPE;
    v_existing  INTEGER;
BEGIN
    SELECT record_type, tenant_id INTO v_from_type, v_tenant_id
      FROM records WHERE record_id = NEW.from_record_id;
    SELECT record_type INTO v_to_type
      FROM records WHERE record_id = NEW.to_record_id;

    -- Both endpoints are resolved from records, which is itself under RLS, so a link can
    -- never span two tenants: the lookup of a foreign record returns no row.
    IF v_from_type IS NULL OR v_to_type IS NULL THEN
        RAISE EXCEPTION 'Both link endpoints must exist within the current tenant'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.tenant_id := v_tenant_id;

    SELECT * INTO v_rule FROM record_link_rules
     WHERE tenant_id      = NEW.tenant_id
       AND from_type_code = v_from_type
       AND to_type_code   = v_to_type
       AND link_type      = NEW.link_type;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No link rule permits % -> % via %', v_from_type, v_to_type, NEW.link_type
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_rule.cardinality IN ('one_to_one', 'one_to_many') THEN
        SELECT COUNT(*) INTO v_existing FROM record_links
         WHERE from_record_id = NEW.from_record_id
           AND link_type      = NEW.link_type
           AND link_id       <> COALESCE(NEW.link_id, '00000000-0000-0000-0000-000000000000'::UUID);
        IF v_existing > 0 THEN
            RAISE EXCEPTION 'Cardinality % violated for link_type %', v_rule.cardinality, NEW.link_type
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER record_links_rule_trigger
    BEFORE INSERT OR UPDATE ON record_links
    FOR EACH ROW EXECUTE FUNCTION enforce_record_link_rule();

-- ─────────────────────────────────────────────────────────────────────────────
-- Workflow history
-- ─────────────────────────────────────────────────────────────────────────────
-- records.workflow_state holds only the current state. Compliance questions are almost
-- always historical — "who approved this incident report, and when?"
CREATE TABLE record_state_transitions (
    transition_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    record_id     UUID NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
    workflow_id   UUID REFERENCES workflows(workflow_id) ON DELETE SET NULL,
    from_state    VARCHAR(100),
    to_state      VARCHAR(100) NOT NULL,
    actor_id      UUID REFERENCES tenant_users(user_id),
    reason        TEXT,
    occurred_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Industry packs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE industry_packs (
    pack_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code         VARCHAR(50) NOT NULL,
    name         VARCHAR(150) NOT NULL,
    version      VARCHAR(20) NOT NULL,
    definition   JSONB NOT NULL,   -- record types, forms, workflows, link rules, seed roles
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (code, version)
);

CREATE TABLE tenant_installed_packs (
    tenant_id         UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    pack_id           UUID NOT NULL REFERENCES industry_packs(pack_id) ON DELETE RESTRICT,
    installed_version VARCHAR(20) NOT NULL,
    is_customized     BOOLEAN NOT NULL DEFAULT FALSE,  -- blocks silent pack upgrades
    installed_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    PRIMARY KEY (tenant_id, pack_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Promoted (generated) columns — deliberately NOT created here
-- ─────────────────────────────────────────────────────────────────────────────
-- database/03 shows gc_mrn and gc_dob as an example of promoting hot JSONB fields into
-- generated columns. They are omitted from this migration for two reasons.
--
-- First, they are vertical-specific. database/03 states these are "per-tenant-vertical
-- DDL, generated by the pack installer rather than hand-written", and the clinical vs
-- workplace-safety question is still open. Putting a medical record number in the core
-- schema would prejudge it.
--
-- Second, the example as written cannot be created. PostgreSQL requires a generation
-- expression to be IMMUTABLE, and
--     (data ->> 'date_of_birth')::DATE
-- is STABLE, not immutable: text-to-date casting depends on the DateStyle setting.
-- database/03 hedges that it "is only immutable for a fixed input format", but the
-- planner does not accept the hedge — it rejects the column. The working form supplies
-- the format explicitly, which is genuinely immutable:
--
--     ALTER TABLE records ADD COLUMN gc_dob DATE
--         GENERATED ALWAYS AS (to_date(data ->> 'date_of_birth', 'YYYY-MM-DD')) STORED;
--
-- The pack installer must emit that form. Recorded here so the defect is not
-- rediscovered when the first pack is written.

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE records                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE records                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE forms                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms                    FORCE  ROW LEVEL SECURITY;
ALTER TABLE form_versions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_versions            FORCE  ROW LEVEL SECURITY;
ALTER TABLE workflows                ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows                FORCE  ROW LEVEL SECURITY;
ALTER TABLE record_type_definitions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_type_definitions  FORCE  ROW LEVEL SECURITY;
ALTER TABLE record_links             ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_links             FORCE  ROW LEVEL SECURITY;
ALTER TABLE record_link_rules        ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_link_rules        FORCE  ROW LEVEL SECURITY;
ALTER TABLE record_state_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_state_transitions FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_installed_packs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_installed_packs   FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON records                  FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON forms                    FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON form_versions            FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON workflows                FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON record_type_definitions  FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON record_links             FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON record_link_rules        FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON record_state_transitions FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON tenant_installed_packs   FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    records, forms, form_versions, workflows, record_type_definitions, record_links,
    record_link_rules, record_state_transitions, tenant_installed_packs
    TO app_user;

-- industry_packs is a global catalogue, like plans.
GRANT SELECT ON industry_packs TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON industry_packs TO app_platform;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_records_tenant_id     ON records(tenant_id);
CREATE INDEX idx_records_type_status   ON records(tenant_id, record_type, status);
CREATE INDEX idx_records_search        ON records USING GIN(search_vector);
CREATE INDEX idx_records_data_gin      ON records USING GIN (data jsonb_path_ops);
CREATE INDEX idx_records_created_at    ON records(tenant_id, created_at DESC);
CREATE INDEX idx_records_type_updated  ON records(tenant_id, record_type, updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_forms_tenant_id       ON forms(tenant_id);
CREATE INDEX idx_workflows_tenant_id   ON workflows(tenant_id);
CREATE INDEX idx_record_types_tenant   ON record_type_definitions(tenant_id) WHERE is_active;
CREATE INDEX idx_links_from            ON record_links(from_record_id, link_type);
CREATE INDEX idx_links_to              ON record_links(to_record_id, link_type);
CREATE INDEX idx_links_tenant_type     ON record_links(tenant_id, link_type);
CREATE INDEX idx_form_versions_form    ON form_versions(form_id, version DESC);
CREATE INDEX idx_transitions_record    ON record_state_transitions(record_id, occurred_at DESC);
