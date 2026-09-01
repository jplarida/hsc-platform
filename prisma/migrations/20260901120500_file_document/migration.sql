-- 0006 — Files and documents
--
-- Source: DATABASE_SCHEMA.md (base files), FILE_UPLOAD_STORAGE.md,
--         database/05_FILE_DOCUMENT_ERD.md.

CREATE TYPE file_status   AS ENUM ('uploading', 'scanning', 'available', 'quarantined', 'failed', 'deleted');
CREATE TYPE scan_status   AS ENUM ('pending', 'clean', 'infected', 'unscannable', 'skipped');
CREATE TYPE upload_status AS ENUM ('initiated', 'in_progress', 'assembling', 'completed', 'aborted', 'expired');
CREATE TYPE storage_class AS ENUM ('standard', 'infrequent_access', 'glacier', 'deep_archive');
CREATE TYPE grantee_type  AS ENUM ('user', 'role');
CREATE TYPE file_access   AS ENUM ('read', 'write', 'delete', 'share');

-- ─────────────────────────────────────────────────────────────────────────────
-- Files
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE files (
    file_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),

    original_name      VARCHAR(500) NOT NULL,
    file_type          VARCHAR(100),          -- DEPRECATED: redundant with mime_type
    file_size          BIGINT,
    mime_type          VARCHAR(100),

    -- DEPRECATED: per-version storage moves to file_versions.
    storage_path       TEXT,
    storage_provider   VARCHAR(50) DEFAULT 's3',

    is_encrypted       BOOLEAN NOT NULL DEFAULT TRUE,
    encryption_key_id  VARCHAR(255),

    -- DEPRECATED: an unenforceable polymorphic reference with no FK, so every record
    -- deletion silently orphaned its files. Superseded by file_associations.
    associated_record_id   UUID,
    associated_record_type VARCHAR(100),

    current_version_id UUID,                  -- FK added after file_versions exists

    -- ADDITION (database/05): FILE_UPLOAD_STORAGE.md puts virus scanning between upload
    -- and availability, but nothing in the schema recorded the outcome — so a download
    -- handler had nothing to check before serving bytes.
    status             file_status NOT NULL DEFAULT 'uploading',
    scan_status        scan_status NOT NULL DEFAULT 'pending',
    scan_signature     VARCHAR(255),          -- threat name when infected
    scanned_at         TIMESTAMP WITH TIME ZONE,

    metadata           JSONB NOT NULL DEFAULT '{}',
    storage_class      storage_class NOT NULL DEFAULT 'standard',
    transitioned_at    TIMESTAMP WITH TIME ZONE,

    uploaded_by        UUID REFERENCES tenant_users(user_id),
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at         TIMESTAMP WITH TIME ZONE,

    -- Makes the invalid combination unrepresentable rather than merely discouraged.
    CONSTRAINT files_available_implies_clean
        CHECK (status <> 'available' OR scan_status IN ('clean', 'skipped'))
);

COMMENT ON COLUMN files.storage_path IS
    'DEPRECATED - read file_versions.storage_path for the current_version_id.';
COMMENT ON COLUMN files.file_type IS
    'DEPRECATED - redundant with mime_type.';
COMMENT ON COLUMN files.associated_record_id IS
    'DEPRECATED - superseded by file_associations. No FK, so deleting a record orphaned its files.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Versioning
-- ─────────────────────────────────────────────────────────────────────────────
-- Versions are immutable once written: a new upload against an existing file_id inserts
-- a row and repoints current_version_id, never rewriting a storage path.
CREATE TABLE file_versions (
    file_version_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    file_id           UUID NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    version_number    INTEGER NOT NULL,
    storage_path      TEXT NOT NULL,
    storage_provider  VARCHAR(50) NOT NULL DEFAULT 's3',
    file_size         BIGINT NOT NULL,
    -- Verifies a chunked assembly, detects silent storage corruption, and de-duplicates
    -- identical uploads. Mandatory: a version without one cannot be verified after the fact.
    checksum          VARCHAR(64) NOT NULL,
    mime_type         VARCHAR(100),
    encryption_key_id VARCHAR(255),
    uploaded_by       UUID REFERENCES tenant_users(user_id),
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (file_id, version_number)
);

ALTER TABLE files ADD CONSTRAINT fk_files_current_version
    FOREIGN KEY (current_version_id) REFERENCES file_versions(file_version_id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Variants and processing
-- ─────────────────────────────────────────────────────────────────────────────
-- A table rather than FILE_UPLOAD_STORAGE.md's processed_variants JSONB blob: variants
-- belong to a *version* (a re-upload invalidates every thumbnail), each needs its own
-- storage path for lifecycle and deletion, and "find every file whose OCR failed" is a
-- query rather than a JSON scan.
CREATE TABLE file_variants (
    variant_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    file_version_id UUID NOT NULL REFERENCES file_versions(file_version_id) ON DELETE CASCADE,
    variant_type    VARCHAR(50) NOT NULL,   -- 'thumbnail_sm'|'preview_pdf'|'ocr_text'|'compressed'
    storage_path    TEXT NOT NULL,
    file_size       BIGINT,
    width           INTEGER,
    height          INTEGER,
    generated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (file_version_id, variant_type)
);

CREATE TABLE file_processing_jobs (
    job_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    file_version_id UUID NOT NULL REFERENCES file_versions(file_version_id) ON DELETE CASCADE,
    job_type        VARCHAR(50) NOT NULL,   -- 'virus_scan'|'thumbnail'|'ocr'|'backup'
    status          job_status NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    started_at      TIMESTAMP WITH TIME ZONE,
    completed_at    TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (file_version_id, job_type)
);

CREATE INDEX idx_processing_pending ON file_processing_jobs(status, created_at)
    WHERE status IN ('pending', 'running');

-- ─────────────────────────────────────────────────────────────────────────────
-- Chunked upload state
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE file_uploads (
    upload_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,
    file_id         UUID REFERENCES files(file_id) ON DELETE SET NULL,  -- set on finalize
    original_name   VARCHAR(500) NOT NULL,
    total_size      BIGINT NOT NULL,
    chunk_size      INTEGER NOT NULL,
    total_chunks    INTEGER NOT NULL,
    received_chunks INTEGER NOT NULL DEFAULT 0,
    status          upload_status NOT NULL DEFAULT 'initiated',
    storage_prefix  TEXT NOT NULL,          -- where partial chunks land
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    CHECK (received_chunks <= total_chunks)
);

-- The composite PK makes chunk re-uploads idempotent: a retried chunk conflicts on
-- (upload_id, chunk_index) and resolves with ON CONFLICT DO UPDATE rather than
-- accumulating duplicates.
CREATE TABLE file_upload_chunks (
    upload_id   UUID NOT NULL REFERENCES file_uploads(upload_id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_hash  VARCHAR(64) NOT NULL,       -- the X-Chunk-Hash header
    size        INTEGER NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    PRIMARY KEY (upload_id, chunk_index)
);

-- What the sweeper uses to reclaim orphaned chunks: without it, a client that
-- disconnects at chunk 58 of 102 leaves paid-for storage behind forever.
CREATE INDEX idx_uploads_expired ON file_uploads(expires_at)
    WHERE status IN ('initiated', 'in_progress');

-- ─────────────────────────────────────────────────────────────────────────────
-- Associations
-- ─────────────────────────────────────────────────────────────────────────────
-- Also makes many-to-many attachment possible — one consent PDF referenced by several
-- appointments — which the deprecated single-column pair could not express.
CREATE TABLE file_associations (
    association_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    file_id          UUID NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    record_id        UUID NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
    association_type VARCHAR(50) NOT NULL DEFAULT 'attachment',  -- 'signature'|'evidence'
    created_by       UUID REFERENCES tenant_users(user_id),
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (file_id, record_id, association_type)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Permissions and external sharing
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE file_permissions (
    permission_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    file_id       UUID NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    grantee_type  grantee_type NOT NULL,
    grantee_id    UUID NOT NULL,          -- tenant_users.user_id or roles.role_id
    access_level  file_access NOT NULL,
    granted_by    UUID REFERENCES tenant_users(user_id),
    expires_at    TIMESTAMP WITH TIME ZONE,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (file_id, grantee_type, grantee_id, access_level)
);

CREATE TABLE file_shares (
    share_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    file_id        UUID NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    token_hash     VARCHAR(64) NOT NULL UNIQUE,   -- SHA-256, never the raw token
    password_hash  VARCHAR(255),                  -- optional second factor on the link
    max_downloads  INTEGER,
    download_count INTEGER NOT NULL DEFAULT 0,
    created_by     UUID REFERENCES tenant_users(user_id),
    -- NOT NULL deliberately. A share link is a credential that bypasses authentication
    -- entirely; a non-expiring one is a permanent unauthenticated route to regulated
    -- data. Callers must choose a lifetime.
    expires_at     TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at     TIMESTAMP WITH TIME ZONE,
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    CHECK (max_downloads IS NULL OR download_count <= max_downloads)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Tagging
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE file_tags (
    tag_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    parent_tag_id UUID REFERENCES file_tags(tag_id) ON DELETE CASCADE,
    name          VARCHAR(100) NOT NULL,
    color         VARCHAR(7),
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, parent_tag_id, name)
);

CREATE TABLE file_tag_assignments (
    file_id     UUID NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    tag_id      UUID NOT NULL REFERENCES file_tags(tag_id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES tenant_users(user_id),
    assigned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    PRIMARY KEY (file_id, tag_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Deferred foreign key from 0005
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE data_subject_requests ADD CONSTRAINT fk_dsr_export_file
    FOREIGN KEY (export_file_id) REFERENCES files(file_id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit trigger for files
-- ─────────────────────────────────────────────────────────────────────────────
-- Deferred from 0005 because files did not exist yet. This is the attachment that
-- fault 1 in database/04 made impossible: the original function read NEW.record_id while
-- attached to a table whose primary key is file_id, so every write to files failed.
CREATE TRIGGER files_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON files
    FOR EACH ROW EXECUTE FUNCTION create_audit_log('file_id');

-- ─────────────────────────────────────────────────────────────────────────────
-- Storage quota
-- ─────────────────────────────────────────────────────────────────────────────
-- The counter must include every file_versions.file_size, not just current versions:
-- retaining old versions consumes real storage, and billing them as free is a margin leak.
CREATE OR REPLACE FUNCTION tenant_storage_available(p_tenant UUID)
RETURNS BIGINT AS $$
    SELECT COALESCE((p.limits ->> 'storage_bytes')::BIGINT, 0)
         - COALESCE((SELECT uc.value FROM usage_counters uc
                      WHERE uc.tenant_id = p_tenant
                        AND uc.metric = 'storage_bytes'
                   ORDER BY uc.period_start DESC LIMIT 1), 0)
      FROM subscriptions s
      JOIN plans p ON p.plan_id = s.plan_id
     WHERE s.tenant_id = p_tenant
       AND s.status IN ('trialing', 'active', 'past_due')
     LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE files                ENABLE ROW LEVEL SECURITY;
ALTER TABLE files                FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_versions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_versions        FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_variants        ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_variants        FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_processing_jobs FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_uploads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_uploads         FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_upload_chunks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_upload_chunks   FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_associations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_associations    FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_permissions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_permissions     FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_shares          ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_shares          FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_tags            ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_tags            FORCE  ROW LEVEL SECURITY;
ALTER TABLE file_tag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_tag_assignments FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON files                FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON file_versions        FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON file_variants        FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON file_processing_jobs FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON file_uploads         FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON file_associations    FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON file_permissions     FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON file_shares          FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON file_tags            FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());

-- Neither of these carries tenant_id; both are scoped through their parent.
CREATE POLICY tenant_isolation ON file_upload_chunks FOR ALL TO app_user
    USING (EXISTS (SELECT 1 FROM file_uploads u
                    WHERE u.upload_id = file_upload_chunks.upload_id
                      AND u.tenant_id = current_tenant_id()));
CREATE POLICY tenant_isolation ON file_tag_assignments FOR ALL TO app_user
    USING (EXISTS (SELECT 1 FROM files f
                    WHERE f.file_id = file_tag_assignments.file_id
                      AND f.tenant_id = current_tenant_id()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    files, file_versions, file_variants, file_processing_jobs, file_uploads,
    file_upload_chunks, file_associations, file_permissions, file_shares,
    file_tags, file_tag_assignments
    TO app_user;

GRANT EXECUTE ON FUNCTION tenant_storage_available(UUID) TO app_user, app_platform;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_files_tenant_id        ON files(tenant_id);
CREATE INDEX idx_files_tenant_status    ON files(tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_scan_pending     ON files(scan_status, created_at) WHERE scan_status = 'pending';
CREATE INDEX idx_files_created_at       ON files(tenant_id, created_at DESC);
CREATE INDEX idx_file_versions_file     ON file_versions(file_id, version_number DESC);
CREATE INDEX idx_file_versions_checksum ON file_versions(tenant_id, checksum);   -- dedup lookups
CREATE INDEX idx_variants_version       ON file_variants(file_version_id);
CREATE INDEX idx_associations_record    ON file_associations(record_id);
CREATE INDEX idx_associations_file      ON file_associations(file_id);
CREATE INDEX idx_file_perms_grantee     ON file_permissions(grantee_type, grantee_id);
