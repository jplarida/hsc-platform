-- 0009 — Tenant data import
--
-- Source: database/07_DATA_MIGRATION_WORKFLOWS.md Part B.
--
-- Part B was specified in full — flow, legacy field mapping, validation, throughput,
-- reversal by import_job_id — and its tables were never carried into the migrations.
-- Nothing detected that: schema-invariants asserts properties OF the tables that exist,
-- and a table never created has no properties to assert. Found by comparing the corpus
-- against the migrations by hand (documents/healthcare/IMPLEMENTATION_GAPS.md Part F).
--
-- Import is the one path that writes bulk PHI into a tenant on the tenant's behalf, so
-- three things below are deliberate rather than incidental: staging and errors hold raw
-- customer rows and are therefore tenant-isolated like any record table, the errors table
-- is retention-managed because it is a second copy of regulated data, and only import_jobs
-- is audited — see the note above the trigger.

CREATE TYPE import_source AS ENUM ('csv', 'api', 'manual');

-- ADDITION (database/07 open question 1): the source document names 'import_data' nowhere
-- because retention_scope predates it. import_row_errors.source_row holds the raw failed
-- row — including PHI when the import is a patient list — and Part B is explicit that a
-- retention policy "should purge it once the job is accepted; keeping failed rows
-- indefinitely creates a second, unmanaged copy of regulated data". That instruction was
-- unimplementable: retention_scope is ('record_type', 'file', 'audit_log') and none of the
-- three covers import data.
--
-- ALTER TYPE ... ADD VALUE is legal inside Prisma's transaction wrapper on PostgreSQL 12+,
-- but the new value cannot be USED in the same transaction. Nothing here uses it — no
-- retention rows are seeded anywhere yet — so this is safe. A migration that also inserted
-- a policy row would fail, which is the trap worth naming for whoever adds the purge worker.
ALTER TYPE retention_scope ADD VALUE 'import_data';

-- ─────────────────────────────────────────────────────────────────────────────
-- Import jobs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE import_jobs (
    import_job_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,

    source_type        import_source NOT NULL,
    source_file_id     UUID REFERENCES files(file_id) ON DELETE SET NULL,
    target_record_type VARCHAR(100) NOT NULL,

    -- Defaults TRUE because the dry run is the loop, not a formality: the customer
    -- iterates on the mapping against real validation output without writing a record.
    -- TENANT_ONBOARDING_FLOW.md names import confusion as a top support driver, so the
    -- safe mode is the one you get by forgetting to choose.
    is_dry_run         BOOLEAN NOT NULL DEFAULT TRUE,

    status             job_status NOT NULL DEFAULT 'pending',
    total_rows         INTEGER NOT NULL DEFAULT 0,
    valid_rows         INTEGER NOT NULL DEFAULT 0,
    error_rows         INTEGER NOT NULL DEFAULT 0,
    imported_rows      INTEGER NOT NULL DEFAULT 0,

    created_by         UUID REFERENCES tenant_users(user_id),
    started_at         TIMESTAMP WITH TIME ZONE,
    completed_at       TIMESTAMP WITH TIME ZONE,
    reversed_at        TIMESTAMP WITH TIME ZONE,
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Composite rather than a plain FK to type_id: the pair must agree, so a job cannot
    -- target another tenant's record type even if someone supplies its code. Relies on
    -- record_type_definitions UNIQUE (tenant_id, code) from 0004.
    FOREIGN KEY (tenant_id, target_record_type)
        REFERENCES record_type_definitions(tenant_id, code) ON UPDATE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Field mappings
-- ─────────────────────────────────────────────────────────────────────────────
-- Either bound to one job, or saved as a reusable template — never neither, which is what
-- the CHECK enforces. A row with both NULL would be unreachable by every query that reads
-- this table and would accumulate silently.
CREATE TABLE import_field_mappings (
    mapping_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    import_job_id  UUID REFERENCES import_jobs(import_job_id) ON DELETE CASCADE,
    template_name  VARCHAR(150),          -- set instead of job id to save a reusable mapping

    source_column  VARCHAR(255) NOT NULL,
    target_path    VARCHAR(255) NOT NULL, -- 'title' | 'data.mrn' | 'data.date_of_birth'
    transform      VARCHAR(50),           -- 'trim' | 'iso_date' | 'e164' | 'upper'
    is_required    BOOLEAN NOT NULL DEFAULT FALSE,
    default_value  TEXT,

    CHECK (import_job_id IS NOT NULL OR template_name IS NOT NULL)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Staging
-- ─────────────────────────────────────────────────────────────────────────────
-- ADDITION (database/07 open question 1). Part B's flow loads into import_staging and its
-- second-pass link query joins against it — s.import_job_id, s.external_id, s.source_row —
-- but no DDL was ever given for it. The open question asks whether it should be one wide
-- JSONB table or per-job temporary tables, and states the assumption taken here: one table,
-- because per-job temporaries are faster but are gone by the time a customer asks why row
-- 4,812 failed, and that question is the whole reason the dry-run loop exists.
--
-- Shape is derived from the document's own usage rather than invented.
CREATE TABLE import_staging (
    staging_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    import_job_id UUID NOT NULL REFERENCES import_jobs(import_job_id) ON DELETE CASCADE,

    row_number    INTEGER NOT NULL,
    -- The legacy primary key, promoted to records.external_id on load. This is what makes
    -- re-running an import idempotent against uq_records_external_id, and what the second
    -- pass matches on when resolving links.
    external_id   VARCHAR(255),
    source_row    JSONB NOT NULL,        -- raw and untyped, exactly as read from the source
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (import_job_id, row_number)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row errors
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE import_row_errors (
    error_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    import_job_id UUID NOT NULL REFERENCES import_jobs(import_job_id) ON DELETE CASCADE,

    row_number    INTEGER NOT NULL,
    source_row    JSONB NOT NULL,        -- the raw row, so the user can see what failed
    error_code    VARCHAR(50) NOT NULL,  -- 'required_missing' | 'bad_date' | 'duplicate_key'
    error_message TEXT NOT NULL,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Provenance on records
-- ─────────────────────────────────────────────────────────────────────────────
-- No ON DELETE clause, deliberately. SET NULL would erase a batch's provenance the moment
-- its job row went away, and CASCADE would let deleting a job delete the tenant's records.
-- NO ACTION matches how records already behaves — records.tenant_id is a plain reference
-- too, so records must be deleted explicitly before their parents rather than vanishing
-- through a cascade nobody reviewed.
ALTER TABLE records ADD COLUMN import_job_id UUID REFERENCES import_jobs(import_job_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit
-- ─────────────────────────────────────────────────────────────────────────────
-- import_jobs only, and that is a decision rather than an omission.
--
-- A bulk load of PHI into a tenant is exactly the administrative act an auditor asks
-- about, it is one row per job, and create_audit_log captures changed_by — so who imported
-- what, when, and whether it was reversed is on the record.
--
-- Not on import_staging or import_row_errors. Both are per-source-row, so a 100k-row import
-- would write 100k audit rows describing data that is not yet a record and may never become
-- one. Part B already flags the per-row audit cost of large imports as the thing that needs
-- compliance sign-off; auditing staging would multiply it for no evidentiary gain. The
-- imported records themselves are audited by the records trigger from 0005, which is where
-- the tenant's actual data arrives. file_processing_jobs — the closest existing analogue —
-- carries no trigger either.
CREATE TRIGGER import_jobs_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON import_jobs
    FOR EACH ROW EXECUTE FUNCTION create_audit_log('import_job_id');

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
-- RULE-HSC-02. import_staging and import_row_errors hold raw customer rows before anything
-- has classified them, so they are PHI-bearing by default and isolated like any record
-- table — not treated as scratch space because the data has not landed yet.
ALTER TABLE import_jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs            FORCE  ROW LEVEL SECURITY;
ALTER TABLE import_field_mappings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_field_mappings  FORCE  ROW LEVEL SECURITY;
ALTER TABLE import_staging         ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_staging         FORCE  ROW LEVEL SECURITY;
ALTER TABLE import_row_errors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_row_errors      FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON import_jobs           FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON import_field_mappings FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON import_staging        FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON import_row_errors     FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    import_jobs, import_field_mappings, import_staging, import_row_errors
    TO app_user;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_import_jobs_tenant   ON import_jobs(tenant_id, created_at DESC);
CREATE INDEX idx_import_jobs_active   ON import_jobs(status, created_at)
    WHERE status IN ('pending', 'running');
CREATE INDEX idx_import_mappings_job  ON import_field_mappings(import_job_id)
    WHERE import_job_id IS NOT NULL;
-- Reusable templates are looked up by name within a tenant, never by job.
CREATE INDEX idx_import_mappings_tmpl ON import_field_mappings(tenant_id, template_name)
    WHERE template_name IS NOT NULL;
CREATE INDEX idx_import_staging_job   ON import_staging(import_job_id, row_number);
-- The second pass resolves links by matching external_id within the batch.
CREATE INDEX idx_import_staging_ext   ON import_staging(import_job_id, external_id)
    WHERE external_id IS NOT NULL;
CREATE INDEX idx_import_errors_job    ON import_row_errors(import_job_id, row_number);
CREATE INDEX idx_records_import_job   ON records(import_job_id) WHERE import_job_id IS NOT NULL;
