-- 0007 — API layer: keys, webhooks and outbound integrations
--
-- Source: api/01_AUTH_AUTHORIZATION_FLOWS.md (api_keys),
--         api/04_INTEGRATION_WEBHOOK_FLOWS.md (webhooks, deliveries, connections).
--
-- API_ARCHITECTURE.md defines /webhooks CRUD endpoints and an Integration Service, but
-- no data model for either existed anywhere in Phase 1.

CREATE TYPE webhook_status  AS ENUM ('active', 'paused', 'disabled_on_failure', 'revoked');
CREATE TYPE delivery_status AS ENUM ('pending', 'delivering', 'succeeded', 'failed', 'dead');

-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant API keys
-- ─────────────────────────────────────────────────────────────────────────────
-- Distinct from the marketplace app credentials in 0008: an API key belongs to exactly
-- one tenant and carries permissions directly. See partners/01 on why the two cannot be
-- the same table.
CREATE TABLE api_keys (
    api_key_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name              VARCHAR(150) NOT NULL,        -- 'Zapier production'
    environment       VARCHAR(10) NOT NULL DEFAULT 'live',   -- 'live' | 'test'

    key_prefix        VARCHAR(16) NOT NULL,         -- shown in the UI, used for lookup
    -- SHA-256 of the full key. An API key is high-entropy and machine-generated, so a
    -- plain digest is appropriate — argon2 on every request would be a self-inflicted
    -- denial of service.
    key_hash          VARCHAR(64) NOT NULL UNIQUE,

    created_by        UUID REFERENCES tenant_users(user_id),
    last_used_at      TIMESTAMP WITH TIME ZONE,
    last_used_ip      INET,
    expires_at        TIMESTAMP WITH TIME ZONE,
    revoked_at        TIMESTAMP WITH TIME ZONE,
    revoked_reason    VARCHAR(50),
    rotated_to_key_id UUID REFERENCES api_keys(api_key_id),

    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, name)
);

-- A key's scopes must be a subset of what its creator could grant, validated at creation
-- rather than at use. Audit rows written by a key-authenticated request carry a null
-- user_id, which compliance reporting must handle rather than assume a human actor.
CREATE TABLE api_key_scopes (
    api_key_id    UUID NOT NULL REFERENCES api_keys(api_key_id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (api_key_id, permission_id)
);

CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix) WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Webhooks
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE webhooks (
    webhook_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name                 VARCHAR(150) NOT NULL,
    url                  TEXT NOT NULL,
    event_types          TEXT[] NOT NULL,          -- ['record.created','file.uploaded']

    signing_secret_hash  VARCHAR(64) NOT NULL,     -- shown once at creation
    secret_rotated_at    TIMESTAMP WITH TIME ZONE,
    previous_secret_hash VARCHAR(64),              -- valid during the rotation overlap

    status               webhook_status NOT NULL DEFAULT 'active',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_success_at      TIMESTAMP WITH TIME ZONE,
    last_failure_at      TIMESTAMP WITH TIME ZONE,
    last_failure_reason  TEXT,

    -- Ignored for PHI record types: the serializer emits ids only and there is no tenant
    -- setting to override it. A webhook is an unauthenticated POST to a URL a tenant
    -- typed into a form, and it terminates outside the audit trail and the BAA.
    include_payload      BOOLEAN NOT NULL DEFAULT FALSE,

    -- Set when the endpoint belongs to a marketplace app rather than the tenant itself.
    -- FK added in 0008. webhooks.manage is scoped to an app's own subscriptions.
    installation_id      UUID,

    created_by           UUID REFERENCES tenant_users(user_id),
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Re-validated at request time after redirects, not only here.
    CHECK (url LIKE 'https://%'),
    CHECK (array_length(event_types, 1) > 0)
);

CREATE TABLE webhook_deliveries (
    delivery_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    webhook_id       UUID NOT NULL REFERENCES webhooks(webhook_id) ON DELETE CASCADE,

    event_id         VARCHAR(40) NOT NULL,          -- stable across retries
    event_type       VARCHAR(100) NOT NULL,
    payload          JSONB NOT NULL,                -- ids and metadata only

    status           delivery_status NOT NULL DEFAULT 'pending',
    attempt          INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMP WITH TIME ZONE,

    response_status  INTEGER,
    response_headers JSONB,
    response_body    TEXT,                          -- truncated to 2 KB
    duration_ms      INTEGER,
    error            TEXT,

    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMP WITH TIME ZONE,

    -- What makes delivery idempotent from the platform's side: a retry updates the
    -- existing row rather than creating a second delivery of the same event.
    UNIQUE (webhook_id, event_id)
);

-- Deliberately cross-tenant: the delivery worker runs as app_platform (BYPASSRLS) and
-- sweeps every tenant's due deliveries in one pass.
CREATE INDEX idx_deliveries_due ON webhook_deliveries(next_attempt_at)
    WHERE status IN ('pending', 'failed');
CREATE INDEX idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Transactional outbox
-- ─────────────────────────────────────────────────────────────────────────────
-- Not a table in api/04, but the outbox pattern it mandates has to live somewhere.
-- The event row is written in the SAME transaction as the change that produced it:
-- emitting from application code after commit loses the event on a crash, and emitting
-- before commit fires a webhook for something that never happened. Both are unacceptable
-- when the receiver is a billing or clinical system.
CREATE TABLE event_outbox (
    outbox_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    event_id     VARCHAR(40) NOT NULL UNIQUE,
    event_type   VARCHAR(100) NOT NULL,
    payload      JSONB NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    relayed_at   TIMESTAMP WITH TIME ZONE
);

-- The relay claims rows with FOR UPDATE SKIP LOCKED, so several workers drain the queue
-- without coordination — the same pattern database/07 uses for backfills.
CREATE INDEX idx_outbox_unrelayed ON event_outbox(outbox_id) WHERE relayed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Outbound integrations
-- ─────────────────────────────────────────────────────────────────────────────
-- Platform-built integrations only: the tenant authorizes the platform to call out to a
-- service it already uses. Marketplace apps calling *in* are 0008, a different model.
CREATE TABLE integration_connections (
    connection_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    provider                VARCHAR(50) NOT NULL,       -- 'google_calendar', 'docusign'
    external_account_id     VARCHAR(255),
    -- Envelope-encrypted with the same KMS key as files.encryption_key_id, and masked by
    -- mask_sensitive() in 0005 so they never reach the audit log in plaintext.
    access_token_encrypted  TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    token_expires_at        TIMESTAMP WITH TIME ZONE,
    scopes                  TEXT[] NOT NULL,
    connected_by            UUID REFERENCES tenant_users(user_id),
    status                  VARCHAR(20) NOT NULL DEFAULT 'active',
    last_error              TEXT,
    last_used_at            TIMESTAMP WITH TIME ZONE,
    created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, provider, external_account_id)
);

CREATE TRIGGER integration_connections_audit_trigger
    AFTER INSERT OR UPDATE OR DELETE ON integration_connections
    FOR EACH ROW EXECUTE FUNCTION create_audit_log('connection_id');

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE api_keys                ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys                FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_key_scopes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_scopes          FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhooks                ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks                FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries      FORCE  ROW LEVEL SECURITY;
ALTER TABLE event_outbox            ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox            FORCE  ROW LEVEL SECURITY;
ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON api_keys                FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON webhooks                FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON webhook_deliveries      FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON event_outbox            FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON integration_connections FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());

-- api_key_scopes has no tenant_id; scoped through the key.
CREATE POLICY tenant_isolation ON api_key_scopes FOR ALL TO app_user
    USING (EXISTS (SELECT 1 FROM api_keys k
                    WHERE k.api_key_id = api_key_scopes.api_key_id
                      AND k.tenant_id = current_tenant_id()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    api_keys, api_key_scopes, webhooks, webhook_deliveries, event_outbox,
    integration_connections
    TO app_user;
