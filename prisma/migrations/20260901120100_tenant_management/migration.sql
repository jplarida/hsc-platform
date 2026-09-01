-- 0002 — Tenant management
--
-- Source: DATABASE_SCHEMA.md (base tables), database/01_TENANT_MANAGEMENT_ERD.md
--         (corrections and additions), performance/01 and partners/03 (amendments).
--
-- Written in final form rather than as base-then-ALTER. The ERD documents are expressed
-- as ALTERs against DATABASE_SCHEMA.md because they were authored as revisions, but this
-- is an initial migration against an empty database and there is no deployed state to
-- expand-and-contract around. Every correction is marked inline with its source.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enumerated types
-- ─────────────────────────────────────────────────────────────────────────────
-- CORRECTION (database/01 #1): DATABASE_SCHEMA.md references tenant_status in
-- CREATE TABLE tenants but never creates it, so the original DDL fails outright on a
-- clean database. This is the first of several defects that existed only because the
-- schema had never been executed.
CREATE TYPE tenant_status       AS ENUM ('pending', 'provisioning', 'active', 'suspended', 'churned');
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'paused', 'canceled', 'expired');
CREATE TYPE invoice_status      AS ENUM ('draft', 'open', 'paid', 'void', 'uncollectible');
CREATE TYPE billing_interval    AS ENUM ('monthly', 'annual');
CREATE TYPE ssl_status          AS ENUM ('pending', 'issued', 'failed', 'expired');
CREATE TYPE job_status          AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');

-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant identity
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
    tenant_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           VARCHAR(255) NOT NULL,
    subdomain      VARCHAR(100) NOT NULL UNIQUE,
    domain         VARCHAR(255),
    status         tenant_status NOT NULL DEFAULT 'active',

    -- DEPRECATED (database/01 #2): cannot express trial windows, renewal periods, seats
    -- or payment state. Superseded by subscriptions; retained only until backfill.
    plan_type      VARCHAR(50) DEFAULT 'basic',

    country_code   CHAR(2),
    company_size   VARCHAR(20),                       -- '1-10', '11-50', '51-200', '200+'
    trial_ends_at  TIMESTAMP WITH TIME ZONE,
    provisioned_at TIMESTAMP WITH TIME ZONE,

    -- ADDITION (database/01 #6): without soft delete, offboarding must hard-delete and
    -- would cascade away invoices that must be retained for tax and audit.
    deleted_at     TIMESTAMP WITH TIME ZONE,

    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Subdomains are user-facing hostnames and must not collide with platform routes.
    CONSTRAINT tenants_subdomain_format CHECK (
        subdomain ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$'
        AND subdomain NOT IN ('www', 'api', 'app', 'admin', 'static', 'cdn', 'status')
    )
);

COMMENT ON COLUMN tenants.plan_type IS
    'DEPRECATED - read the active row in subscriptions instead. Drop after backfill.';

CREATE TABLE tenant_configurations (
    config_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,

    primary_color   VARCHAR(7) DEFAULT '#007AFF',
    secondary_color VARCHAR(7) DEFAULT '#5856D6',
    accent_color    VARCHAR(7) DEFAULT '#FF9500',
    logo_url        TEXT,
    app_name        VARCHAR(255),
    company_name    VARCHAR(255),

    features        JSONB NOT NULL DEFAULT '{}',
    ui_config       JSONB NOT NULL DEFAULT '{}',
    industry_type   VARCHAR(100),
    industry_config JSONB NOT NULL DEFAULT '{}',

    -- AMENDMENT (performance/01): version-stamped cache keys. Without it a config change
    -- either serves stale values for the TTL or requires a fan-out invalidation across
    -- every key that embedded a config value.
    config_version  INTEGER NOT NULL DEFAULT 1,

    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id)
);

-- ADDITION (database/01 #3): backs the domain-verification step in TENANT_ONBOARDING_FLOW.
CREATE TABLE tenant_domains (
    domain_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    domain             VARCHAR(255) NOT NULL UNIQUE,
    is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
    verification_token VARCHAR(64) NOT NULL,
    verified_at        TIMESTAMP WITH TIME ZONE,
    ssl_status         ssl_status NOT NULL DEFAULT 'pending',
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_tenant_domains_primary
    ON tenant_domains(tenant_id) WHERE is_primary;

-- ADDITION (database/01 #4): provisioning is described as a multi-step automated process
-- with no state stored anywhere, so a failure mid-way is unrecoverable and un-resumable.
CREATE TABLE tenant_provisioning_tasks (
    task_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    step         VARCHAR(100) NOT NULL,
    status       job_status NOT NULL DEFAULT 'pending',
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    started_at   TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, step)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Plans and subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
-- plans is a global catalogue: no tenant_id, no RLS policy, readable by every tenant.
CREATE TABLE plans (
    plan_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code             VARCHAR(50) NOT NULL UNIQUE,
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    price_cents      INTEGER NOT NULL DEFAULT 0,
    currency         CHAR(3) NOT NULL DEFAULT 'USD',
    billing_interval billing_interval NOT NULL DEFAULT 'monthly',
    trial_days       INTEGER NOT NULL DEFAULT 0,

    -- Quota ceilings enforced against usage_counters, and the rate limits api/03 reads.
    limits           JSONB NOT NULL DEFAULT '{}',
    features         JSONB NOT NULL DEFAULT '{}',

    is_public        BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    retired_at       TIMESTAMP WITH TIME ZONE,   -- grandfathers existing subscribers
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE subscriptions (
    subscription_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    plan_id                  UUID NOT NULL REFERENCES plans(plan_id),

    status                   subscription_status NOT NULL DEFAULT 'trialing',
    seats                    INTEGER NOT NULL DEFAULT 1 CHECK (seats > 0),

    trial_start              TIMESTAMP WITH TIME ZONE,
    trial_end                TIMESTAMP WITH TIME ZONE,
    current_period_start     TIMESTAMP WITH TIME ZONE NOT NULL,
    current_period_end       TIMESTAMP WITH TIME ZONE NOT NULL,
    cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
    canceled_at              TIMESTAMP WITH TIME ZONE,

    external_provider        VARCHAR(50) DEFAULT 'stripe',
    external_customer_id     VARCHAR(255),
    external_subscription_id VARCHAR(255),

    created_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    CHECK (current_period_end > current_period_start),
    CHECK ((trial_start IS NULL) = (trial_end IS NULL))
);

-- A tenant may keep historical subscription rows but only one that is currently live.
CREATE UNIQUE INDEX uq_subscriptions_active_per_tenant
    ON subscriptions(tenant_id)
    WHERE status IN ('trialing', 'active', 'past_due', 'paused');

CREATE TABLE payment_methods (
    payment_method_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    brand                      VARCHAR(50),
    last4                      CHAR(4),
    exp_month                  SMALLINT CHECK (exp_month BETWEEN 1 AND 12),
    exp_year                   SMALLINT,
    is_default                 BOOLEAN NOT NULL DEFAULT FALSE,
    external_payment_method_id VARCHAR(255) NOT NULL,
    created_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    detached_at                TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX uq_payment_methods_default
    ON payment_methods(tenant_id) WHERE is_default AND detached_at IS NULL;

CREATE TABLE invoices (
    invoice_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- RESTRICT, deliberately unlike the rest of the tenant tree: financial records must
    -- survive tenant deletion for tax and audit retention. Offboarding soft-deletes via
    -- tenants.deleted_at rather than issuing a DELETE.
    tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    subscription_id     UUID REFERENCES subscriptions(subscription_id) ON DELETE SET NULL,
    payment_method_id   UUID REFERENCES payment_methods(payment_method_id) ON DELETE SET NULL,

    status              invoice_status NOT NULL DEFAULT 'draft',
    amount_due_cents    INTEGER NOT NULL,
    amount_paid_cents   INTEGER NOT NULL DEFAULT 0,
    currency            CHAR(3) NOT NULL DEFAULT 'USD',

    period_start        TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end          TIMESTAMP WITH TIME ZONE NOT NULL,
    issued_at           TIMESTAMP WITH TIME ZONE,
    due_at              TIMESTAMP WITH TIME ZONE,
    paid_at             TIMESTAMP WITH TIME ZONE,

    external_invoice_id VARCHAR(255) UNIQUE,
    hosted_url          TEXT,
    pdf_url             TEXT,

    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- AMENDMENT (partners/03): invoices carries a total but no items, so a platform_billed
-- marketplace app charge has nowhere to appear on the tenant's bill. Added here rather
-- than in the partner migration because it is a billing primitive, not a marketplace one.
CREATE TABLE invoice_line_items (
    line_item_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id    UUID NOT NULL REFERENCES invoices(invoice_id) ON DELETE RESTRICT,
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,

    kind          VARCHAR(30) NOT NULL,        -- 'subscription' | 'usage' | 'app' | 'adjustment'
    description   VARCHAR(255) NOT NULL,
    quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_cents    INTEGER NOT NULL,
    amount_cents  INTEGER NOT NULL,
    currency      CHAR(3) NOT NULL DEFAULT 'USD',

    -- Set for kind = 'app'. The FK is added in migration 0008, once app_charges exists.
    app_charge_id UUID,

    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    CHECK (amount_cents = unit_cents * quantity)
);

CREATE TABLE usage_counters (
    counter_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    metric       VARCHAR(50) NOT NULL,     -- 'active_users' | 'storage_bytes' | 'api_calls'
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    value        BIGINT NOT NULL DEFAULT 0,
    recorded_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, metric, period_start)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
-- FORCE also subjects the table owner to the policy. Without it, any connection that
-- happens to own the table silently bypasses tenant isolation.
ALTER TABLE tenant_configurations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configurations     FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_domains            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_domains            FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_provisioning_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_provisioning_tasks FORCE  ROW LEVEL SECURITY;
ALTER TABLE subscriptions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions             FORCE  ROW LEVEL SECURITY;
ALTER TABLE payment_methods           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods           FORCE  ROW LEVEL SECURITY;
ALTER TABLE invoices                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items        FORCE  ROW LEVEL SECURITY;
ALTER TABLE usage_counters            ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters            FORCE  ROW LEVEL SECURITY;

-- tenants itself is scoped by its own primary key rather than a tenant_id column.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON tenant_configurations     FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON tenant_domains            FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON tenant_provisioning_tasks FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON subscriptions             FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON payment_methods           FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON invoices                  FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON invoice_line_items        FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON usage_counters            FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    tenants, tenant_configurations, tenant_domains, tenant_provisioning_tasks,
    subscriptions, payment_methods, invoices, invoice_line_items, usage_counters
    TO app_user;

-- plans is a public catalogue: readable by every tenant, writable only by the platform.
GRANT SELECT ON plans TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON plans TO app_platform;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_tenants_status         ON tenants(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_tenant_configurations_tenant ON tenant_configurations(tenant_id);
CREATE INDEX idx_tenant_domains_tenant  ON tenant_domains(tenant_id);
CREATE INDEX idx_provisioning_pending   ON tenant_provisioning_tasks(status, created_at)
    WHERE status IN ('pending', 'running');
CREATE INDEX idx_subscriptions_tenant   ON subscriptions(tenant_id);
-- Scanned by the billing cron on every run; partial so it stays small as tenants churn.
CREATE INDEX idx_subscriptions_renewal  ON subscriptions(current_period_end)
    WHERE status IN ('trialing', 'active');
CREATE INDEX idx_invoices_tenant_issued ON invoices(tenant_id, issued_at DESC);
CREATE INDEX idx_invoices_unpaid        ON invoices(due_at) WHERE status = 'open';
CREATE INDEX idx_invoice_items_invoice  ON invoice_line_items(invoice_id);
CREATE INDEX idx_usage_counters_lookup  ON usage_counters(tenant_id, metric, period_start DESC);
