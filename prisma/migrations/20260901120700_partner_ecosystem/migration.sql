-- 0008 — Partner ecosystem and marketplace
--
-- Source: partners/01_PARTNER_PROGRAM.md, partners/02_APP_AUTHORIZATION_AND_ISOLATION.md,
--         partners/03_MARKETPLACE_AND_REVENUE.md.
--
-- Three identities exist after this migration, not two: a user (one tenant, human), an
-- API key (one tenant, non-human), and an app — which belongs to NO tenant, is installed
-- by many, and holds a separate authorization from each.

CREATE TYPE partner_status  AS ENUM ('pending', 'active', 'suspended', 'terminated');
CREATE TYPE app_status      AS ENUM ('draft', 'in_review', 'certified', 'suspended', 'retired');
CREATE TYPE app_phi_tier    AS ENUM ('none', 'phi');
CREATE TYPE install_status  AS ENUM ('active', 'suspended_by_tenant', 'suspended_by_platform',
                                     'pending_reconsent', 'uninstalled');
CREATE TYPE billing_model   AS ENUM ('free', 'platform_billed', 'vendor_billed');
CREATE TYPE listing_status  AS ENUM ('draft', 'in_review', 'published', 'unlisted', 'removed');
CREATE TYPE payout_status   AS ENUM ('accruing', 'pending', 'paid', 'failed', 'reversed');

-- ─────────────────────────────────────────────────────────────────────────────
-- Partners and apps
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE partners (
    partner_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name       VARCHAR(255) NOT NULL,      -- the entity that signs the BAA
    display_name     VARCHAR(150) NOT NULL,
    slug             VARCHAR(80)  NOT NULL UNIQUE,
    website_url      TEXT,
    support_email    VARCHAR(255) NOT NULL,      -- stored lowercased
    -- NOT NULL for the breach-notification chain: a PHI vendor's breach is the
    -- platform's breach, and the clock runs from the vendor's discovery.
    security_contact VARCHAR(255) NOT NULL,

    status           partner_status NOT NULL DEFAULT 'pending',
    suspended_reason TEXT,

    baa_executed_at  TIMESTAMP WITH TIME ZONE,
    baa_document_id  UUID REFERENCES files(file_id) ON DELETE SET NULL,
    baa_expires_at   TIMESTAMP WITH TIME ZONE,

    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Partner staff are NOT tenant_users: they sit outside every tenant, were invited by no
-- tenant admin, and are covered by no tenant's access review. Sharing the table would
-- require a null tenant_id, which breaks the RLS predicate for every query on it.
CREATE TABLE partner_users (
    partner_user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id      UUID NOT NULL REFERENCES partners(partner_id) ON DELETE CASCADE,
    email           VARCHAR(255) NOT NULL,       -- stored lowercased
    full_name       VARCHAR(200),
    password_hash   VARCHAR(255),                -- argon2id, as tenant_users
    -- 'finance' exists so a developer with an API token cannot change the bank account
    -- that receives payouts.
    role            VARCHAR(30) NOT NULL DEFAULT 'developer',  -- owner|developer|finance
    mfa_enrolled_at TIMESTAMP WITH TIME ZONE,
    last_login_at   TIMESTAMP WITH TIME ZONE,
    deactivated_at  TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (partner_id, email)
);

CREATE TABLE partner_apps (
    app_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- RESTRICT: a partner with a certified app that tenants have installed cannot be
    -- deleted out from under them. Termination is a status change plus a fan-out.
    partner_id    UUID NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
    name          VARCHAR(150) NOT NULL,
    slug          VARCHAR(80)  NOT NULL UNIQUE,

    status        app_status   NOT NULL DEFAULT 'draft',
    phi_tier      app_phi_tier NOT NULL DEFAULT 'none',

    client_id     VARCHAR(40)  NOT NULL UNIQUE,   -- public, hscapp_<random>
    redirect_uris TEXT[]       NOT NULL DEFAULT '{}',

    webhook_url   TEXT,                           -- app lifecycle events
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Exact-match HTTPS redirect URIs. Enforced in a trigger rather than a CHECK because a
-- CHECK constraint cannot contain a subquery over unnest().
CREATE OR REPLACE FUNCTION validate_redirect_uris() RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM unnest(NEW.redirect_uris) AS u
                WHERE u NOT LIKE 'https://%' OR u LIKE '%*%') THEN
        RAISE EXCEPTION 'redirect_uris must be https and must not contain wildcards'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_redirect_uris
    BEFORE INSERT OR UPDATE ON partner_apps
    FOR EACH ROW EXECUTE FUNCTION validate_redirect_uris();

CREATE TABLE partner_app_secrets (
    secret_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id        UUID NOT NULL REFERENCES partner_apps(app_id) ON DELETE CASCADE,
    secret_prefix VARCHAR(16) NOT NULL,
    secret_hash   VARCHAR(64) NOT NULL UNIQUE,
    created_by    UUID REFERENCES partner_users(partner_user_id),
    last_used_at  TIMESTAMP WITH TIME ZONE,
    expires_at    TIMESTAMP WITH TIME ZONE,
    revoked_at    TIMESTAMP WITH TIME ZONE,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- phi_tier is duplicated from partner_apps deliberately: the app row says what the app
-- IS, the version row says what each install consented to. When a non-PHI app becomes
-- PHI-capable at v4, installs still on v3 must remain non-PHI.
CREATE TABLE app_versions (
    app_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id         UUID NOT NULL REFERENCES partner_apps(app_id) ON DELETE CASCADE,
    version        INTEGER NOT NULL,
    scope_codes    TEXT[] NOT NULL,
    phi_tier       app_phi_tier NOT NULL,
    changelog      TEXT,

    submitted_at   TIMESTAMP WITH TIME ZONE,
    certified_at   TIMESTAMP WITH TIME ZONE,
    certified_by   VARCHAR(150),
    published_at   TIMESTAMP WITH TIME ZONE,
    retired_at     TIMESTAMP WITH TIME ZONE,

    UNIQUE (app_id, version)
);

CREATE INDEX idx_app_secrets_prefix ON partner_app_secrets(secret_prefix)
    WHERE revoked_at IS NULL;
CREATE INDEX idx_app_versions_published ON app_versions(app_id, version DESC)
    WHERE published_at IS NOT NULL AND retired_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Scope catalogue
-- ─────────────────────────────────────────────────────────────────────────────
-- App scopes are coarser than permissions and human-readable: "this app is requesting
-- records:read" tells a practice manager nothing about what will leave the building.
CREATE TABLE app_scopes (
    scope_code   VARCHAR(60) PRIMARY KEY,        -- 'records.read.nonphi'
    display_name VARCHAR(120) NOT NULL,
    consent_text TEXT NOT NULL,                  -- shown verbatim on the consent screen
    is_phi       BOOLEAN NOT NULL DEFAULT FALSE,
    requires_baa BOOLEAN NOT NULL DEFAULT FALSE,
    is_grantable BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE app_scope_permissions (
    scope_code    VARCHAR(60) NOT NULL REFERENCES app_scopes(scope_code) ON DELETE CASCADE,
    permission_id UUID        NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (scope_code, permission_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Installations, consent and tokens
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app_installations (
    installation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    app_id           UUID NOT NULL REFERENCES partner_apps(app_id) ON DELETE RESTRICT,
    app_version_id   UUID NOT NULL REFERENCES app_versions(app_version_id),

    status           install_status NOT NULL DEFAULT 'active',
    status_reason    TEXT,

    consented_by     UUID REFERENCES tenant_users(user_id),
    consented_at     TIMESTAMP WITH TIME ZONE NOT NULL,
    -- The exact scope codes AND consent_text shown, not an FK to app_scopes. Consent
    -- text gets reworded; a join would make every historical install appear to have
    -- agreed to today's wording, which for a HIPAA disclosure authorization is not a
    -- cosmetic problem.
    consent_snapshot JSONB NOT NULL,
    consent_ip       INET,

    -- Copied at install time rather than joined from partners: the compliance question
    -- is what agreement was in force *then*, not now.
    baa_reference    VARCHAR(120),
    baa_verified_at  TIMESTAMP WITH TIME ZONE,

    installed_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    uninstalled_at   TIMESTAMP WITH TIME ZONE,

    CHECK (status <> 'uninstalled' OR uninstalled_at IS NOT NULL)
);

CREATE UNIQUE INDEX uq_installation_live ON app_installations(tenant_id, app_id)
    WHERE status <> 'uninstalled';

CREATE TABLE app_scope_grants (
    installation_id UUID NOT NULL REFERENCES app_installations(installation_id) ON DELETE CASCADE,
    scope_code      VARCHAR(60) NOT NULL REFERENCES app_scopes(scope_code),
    granted_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (installation_id, scope_code)
);

-- Opaque reference tokens, not JWTs. Uninstall means "stop having my data now", and a
-- self-contained token stays cryptographically valid until it expires — so a JWT design
-- either accepts a window in which a revoked app still reads PHI, or adds a per-request
-- revocation check and pays the lookup cost anyway.
CREATE TABLE app_tokens (
    token_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID NOT NULL REFERENCES app_installations(installation_id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,

    token_type      VARCHAR(10) NOT NULL,          -- 'access' | 'refresh'
    token_hash      VARCHAR(64) NOT NULL UNIQUE,
    issued_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at         TIMESTAMP WITH TIME ZONE,
    replaced_by     UUID REFERENCES app_tokens(token_id) ON DELETE SET NULL,
    revoked_at      TIMESTAMP WITH TIME ZONE,
    revoked_reason  VARCHAR(50),

    CHECK (token_type IN ('access', 'refresh'))
);

-- Single-use, 60-second authorization codes. A code presented twice means it leaked.
CREATE TABLE app_authorization_codes (
    code_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id          UUID NOT NULL REFERENCES partner_apps(app_id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    installation_id UUID REFERENCES app_installations(installation_id) ON DELETE CASCADE,
    code_hash       VARCHAR(64) NOT NULL UNIQUE,
    code_challenge  VARCHAR(128) NOT NULL,        -- PKCE S256
    redirect_uri    TEXT NOT NULL,                -- compared by exact match at exchange
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_app_tokens_live    ON app_tokens(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_app_tokens_install ON app_tokens(installation_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_auth_codes_expiry  ON app_authorization_codes(expires_at) WHERE consumed_at IS NULL;

-- Deferred FK from 0007: a webhook may belong to an app rather than the tenant.
ALTER TABLE webhooks ADD CONSTRAINT fk_webhooks_installation
    FOREIGN KEY (installation_id) REFERENCES app_installations(installation_id) ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Usage analytics
-- ─────────────────────────────────────────────────────────────────────────────
-- usage_counters (database/01) is per-tenant and RLS-scoped, so it cannot answer "how
-- many calls did app X make across all its installs" — that question crosses tenant
-- boundaries by construction.
CREATE TABLE app_usage_daily (
    app_id          UUID NOT NULL REFERENCES partner_apps(app_id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    day             DATE NOT NULL,

    request_count   BIGINT NOT NULL DEFAULT 0,
    error_4xx_count BIGINT NOT NULL DEFAULT 0,
    error_5xx_count BIGINT NOT NULL DEFAULT 0,
    throttled_count BIGINT NOT NULL DEFAULT 0,
    p95_duration_ms INTEGER,
    -- A count, never content. Exists so a tenant and the platform can both see whether
    -- an app's PHI access matches what it claimed at certification.
    phi_read_count  BIGINT NOT NULL DEFAULT 0,

    -- Offline sync means a request attributed to Tuesday can land on Thursday
    -- (analytics/01's reprocessing window).
    is_provisional  BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (app_id, tenant_id, day)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Marketplace listings
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app_listings (
    listing_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id             UUID NOT NULL UNIQUE REFERENCES partner_apps(app_id) ON DELETE RESTRICT,

    tagline            VARCHAR(200) NOT NULL,
    description_md     TEXT NOT NULL,
    category           VARCHAR(50)  NOT NULL,
    icon_file_id       UUID REFERENCES files(file_id) ON DELETE SET NULL,
    screenshots        UUID[]       NOT NULL DEFAULT '{}',
    support_url        TEXT NOT NULL,
    -- NOT NULL even for free listings: a tenant authorizing a disclosure needs somewhere
    -- to read what the recipient will do with the data.
    privacy_policy_url TEXT NOT NULL,
    terms_url          TEXT NOT NULL,

    billing_model      billing_model  NOT NULL DEFAULT 'free',
    pricing_summary    TEXT,
    revenue_share_bps  INTEGER,                    -- platform_billed only
    referral_fee_bps   INTEGER,                    -- vendor_billed only

    status             listing_status NOT NULL DEFAULT 'draft',
    published_at       TIMESTAMP WITH TIME ZONE,
    removed_at         TIMESTAMP WITH TIME ZONE,
    removed_reason     TEXT,

    -- Displayed rounded (10+, 50+, 100+): an exact count on a three-install listing,
    -- combined with a partner's public customer logos, identifies which practices use
    -- which software.
    install_count      INTEGER NOT NULL DEFAULT 0,

    CHECK ((billing_model = 'platform_billed') = (revenue_share_bps IS NOT NULL)),
    CHECK ((billing_model = 'vendor_billed')   = (referral_fee_bps  IS NOT NULL))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Revenue
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE partner_billing_accounts (
    partner_id          UUID PRIMARY KEY REFERENCES partners(partner_id) ON DELETE RESTRICT,
    external_account_id VARCHAR(255) NOT NULL UNIQUE,   -- Stripe Connect account
    kyc_status          VARCHAR(30)  NOT NULL DEFAULT 'pending',
    payouts_enabled     BOOLEAN      NOT NULL DEFAULT FALSE,
    payout_currency     CHAR(3)      NOT NULL DEFAULT 'USD',
    -- A tenant refund after the vendor is paid leaves the platform chasing money, and a
    -- chargeback arrives later still. The hold is what makes a reversal a ledger entry.
    hold_days           INTEGER      NOT NULL DEFAULT 30,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE app_charges (
    charge_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID NOT NULL REFERENCES app_installations(installation_id) ON DELETE RESTRICT,
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    app_id          UUID NOT NULL REFERENCES partner_apps(app_id) ON DELETE RESTRICT,
    invoice_id      UUID REFERENCES invoices(invoice_id) ON DELETE RESTRICT,

    period_start    TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end      TIMESTAMP WITH TIME ZONE NOT NULL,
    gross_cents     INTEGER NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    -- Snapshotted: reading the current listing at payout time would let a renegotiation
    -- silently restate history.
    platform_bps    INTEGER NOT NULL,
    platform_cents  INTEGER NOT NULL,
    vendor_cents    INTEGER NOT NULL,

    -- A column, not a Redis key. api/02 leaves billing idempotency storage open; for
    -- money leaving the platform a cache flush means a second transfer of real funds.
    idempotency_key VARCHAR(80) NOT NULL UNIQUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    CHECK (gross_cents = platform_cents + vendor_cents)
);

ALTER TABLE invoice_line_items ADD CONSTRAINT fk_line_item_app_charge
    FOREIGN KEY (app_charge_id) REFERENCES app_charges(charge_id) ON DELETE RESTRICT;

CREATE TABLE partner_payouts (
    payout_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id           UUID NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
    status               payout_status NOT NULL DEFAULT 'accruing',
    period_start         TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end           TIMESTAMP WITH TIME ZONE NOT NULL,

    amount_cents         INTEGER NOT NULL,
    currency             CHAR(3) NOT NULL,
    -- Fixed at accrual, never recomputed: recalculating at transfer time makes
    -- reconciliation impossible and makes the platform carry unpriced currency risk.
    fx_rate              NUMERIC(18,8),
    fx_rate_at           TIMESTAMP WITH TIME ZONE,

    external_transfer_id VARCHAR(255) UNIQUE,
    idempotency_key      VARCHAR(80) NOT NULL UNIQUE,
    paid_at              TIMESTAMP WITH TIME ZONE,
    failure_reason       TEXT,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE payout_line_items (
    payout_id    UUID NOT NULL REFERENCES partner_payouts(payout_id) ON DELETE RESTRICT,
    charge_id    UUID NOT NULL REFERENCES app_charges(charge_id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL,
    PRIMARY KEY (payout_id, charge_id)
);

-- vendor_billed: the platform never touches app revenue and takes a referral fee.
-- reported_by = 'partner' is the uncomfortable part — for conversion and renewal fees
-- the platform depends on the vendor's self-report, since it cannot see their invoices.
-- That is an audit-rights clause in the partner agreement, not an engineering control.
CREATE TABLE referral_fee_events (
    event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID NOT NULL REFERENCES app_installations(installation_id) ON DELETE RESTRICT,
    partner_id      UUID NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
    event_type      VARCHAR(30) NOT NULL,     -- 'install' | 'conversion' | 'renewal'
    fee_cents       INTEGER NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    reported_by     VARCHAR(20) NOT NULL,     -- 'platform' | 'partner'
    invoiced_at     TIMESTAMP WITH TIME ZONE,
    idempotency_key VARCHAR(80) NOT NULL UNIQUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
-- Two axes here, not one. Tenant-facing tables isolate on tenant_id for app_user; the
-- catalogue tables isolate on partner_id for partner_portal_user. app_user gets no grant
-- at all on the partner catalogue, and partner_portal_user gets none on tenant data.
ALTER TABLE app_installations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_installations      FORCE  ROW LEVEL SECURITY;
ALTER TABLE app_tokens             ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tokens             FORCE  ROW LEVEL SECURITY;
ALTER TABLE app_scope_grants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_scope_grants       FORCE  ROW LEVEL SECURITY;
ALTER TABLE app_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_authorization_codes FORCE  ROW LEVEL SECURITY;
ALTER TABLE app_charges            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_charges            FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app_installations FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON app_tokens FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON app_authorization_codes FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON app_charges FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());

-- No tenant_id of its own; inherits isolation through its installation. Denormalising
-- tenant_id here would be faster to check but gives the row two sources of truth.
CREATE POLICY tenant_isolation ON app_scope_grants FOR ALL TO app_user
    USING (installation_id IN (SELECT installation_id FROM app_installations));

-- Partner axis. partner_apps holds every competitor's client_id and webhook_url, so it
-- is a global catalogue but not a public one.
ALTER TABLE partner_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_apps FORCE  ROW LEVEL SECURITY;
ALTER TABLE app_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_versions FORCE  ROW LEVEL SECURITY;

CREATE POLICY partner_own_apps ON partner_apps FOR SELECT TO partner_portal_user
    USING (partner_id = NULLIF(current_setting('app.current_partner_id', true), '')::UUID);
CREATE POLICY partner_own_versions ON app_versions FOR SELECT TO partner_portal_user
    USING (app_id IN (SELECT app_id FROM partner_apps));
CREATE POLICY partner_isolation ON app_installations FOR SELECT TO partner_portal_user
    USING (app_id IN (SELECT app_id FROM partner_apps));
CREATE POLICY partner_isolation ON app_scope_grants FOR SELECT TO partner_portal_user
    USING (installation_id IN (SELECT installation_id FROM app_installations));

-- app_usage_daily needs BOTH axes, and is the one table where forgetting either is a
-- disclosure. Without the partner policy, partner_portal_user's SELECT grant returns
-- usage for every app on the platform — including competitors' install counts and PHI
-- read volumes. Without the tenant policy, a tenant reading its own per-app activity
-- view would see other tenants' rows.
ALTER TABLE app_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_usage_daily FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app_usage_daily FOR SELECT TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY partner_isolation ON app_usage_daily FOR SELECT TO partner_portal_user
    USING (app_id IN (SELECT app_id FROM partner_apps));

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────
-- The application manages installs, tokens and consent.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    app_installations, app_scope_grants, app_tokens, app_authorization_codes
    TO app_user;

-- Read-only on the catalogue: a tenant browses the marketplace but never edits it.
GRANT SELECT ON partner_apps, app_versions, app_scopes, app_scope_permissions,
                app_listings, partners
    TO app_user;
GRANT SELECT ON app_charges TO app_user;
-- The tenant's own per-app activity view (partners/02): which app did what, how often,
-- and how much PHI it read.
GRANT SELECT ON app_usage_daily TO app_user;

-- The platform role owns the catalogue, the rollup and all money movement.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    partners, partner_users, partner_apps, partner_app_secrets, app_versions,
    app_scopes, app_scope_permissions, app_listings, app_usage_daily,
    partner_billing_accounts, app_charges, partner_payouts, payout_line_items,
    referral_fee_events
    TO app_platform;

-- The portal reads install metadata and its own analytics, and nothing else. The policy
-- expression is evaluated as the querying role, so the role needs SELECT on every table
-- the subquery touches — omitting a grant makes the policy fail with a permission error
-- rather than returning no rows.
GRANT SELECT ON app_installations, partner_apps, app_versions, app_scope_grants,
                app_scopes, app_usage_daily, app_listings
    TO partner_portal_user;
-- Deliberately absent: records, files, tenant_users, and every audit table. A SQL
-- injection in the partner portal still cannot reach tenant data, because the role has
-- no privilege to reach it.

-- ─────────────────────────────────────────────────────────────────────────────
-- Scope catalogue seed
-- ─────────────────────────────────────────────────────────────────────────────
-- The .nonphi / .phi split is what makes the tiered marketplace enforceable rather than
-- advisory. is_phi here lines up with record_type_definitions.is_phi, the same field
-- api/04 uses for webhook payloads — one definition of PHI, not two that drift.
INSERT INTO app_scopes (scope_code, display_name, consent_text, is_phi, requires_baa, sort_order) VALUES
    ('profile.read',        'Read organisation profile',
     'View your organisation name, plan and timezone. Does not include your user list.', FALSE, FALSE, 10),
    ('users.read',          'Read user list',
     'View the names and email addresses of people in your organisation.', FALSE, FALSE, 20),
    ('records.read.nonphi', 'Read non-clinical records',
     'Read records of types not marked as containing protected health information.', FALSE, FALSE, 30),
    ('records.write.nonphi','Create and update non-clinical records',
     'Create and change records of types not marked as containing protected health information.', FALSE, FALSE, 40),
    ('files.read.nonphi',   'Download non-clinical files',
     'Download files attached to records not marked as containing protected health information.', FALSE, FALSE, 50),
    ('billing.read',        'Read billing information',
     'View your subscription, plan and invoices. Does not include payment card details.', FALSE, FALSE, 60),
    ('webhooks.manage',     'Manage its own event subscriptions',
     'Subscribe to events so the app can react to changes. Limited to the app''s own subscriptions.', FALSE, FALSE, 70),
    ('records.read.phi',    'Read clinical records',
     'Read records containing protected health information, including patient data.', TRUE, TRUE, 80),
    ('records.write.phi',   'Create and update clinical records',
     'Create and change records containing protected health information.', TRUE, TRUE, 90),
    ('files.read.phi',      'Download clinical files',
     'Download files attached to records containing protected health information.', TRUE, TRUE, 100),
    ('audit.read',          'Read the audit log',
     'Read your organisation''s audit log. This app''s own actions remain visible in it.', TRUE, TRUE, 110);

INSERT INTO app_scope_permissions (scope_code, permission_id)
SELECT s.scope_code, p.permission_id
  FROM (VALUES
        ('users.read',           'users:read'),
        ('records.read.nonphi',  'records:read'),
        ('records.write.nonphi', 'records:write'),
        ('files.read.nonphi',    'files:read'),
        ('billing.read',         'billing:read'),
        ('webhooks.manage',      'webhooks:manage'),
        ('records.read.phi',     'records:read'),
        ('records.write.phi',    'records:write'),
        ('files.read.phi',       'files:read'),
        ('audit.read',           'audit:read')
       ) AS s(scope_code, permission_code)
  JOIN permissions p ON p.code = s.permission_code;
