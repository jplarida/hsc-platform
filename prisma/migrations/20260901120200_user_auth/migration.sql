-- 0003 — Users, authentication and RBAC
--
-- Source: DATABASE_SCHEMA.md (base tenant_users), database/02_USER_AUTH_ERD.md,
--         infrastructure/05 and experience/02 (amendments), partners/02 (apps:install).

CREATE TYPE user_status          AS ENUM ('invited', 'active', 'suspended', 'deactivated');
CREATE TYPE mfa_method_type      AS ENUM ('totp', 'sms', 'email', 'webauthn');
CREATE TYPE sso_protocol         AS ENUM ('saml', 'oidc');
CREATE TYPE permission_effect    AS ENUM ('allow', 'deny');
CREATE TYPE verification_purpose AS ENUM ('email_verify', 'password_reset', 'phone_verify');

-- ─────────────────────────────────────────────────────────────────────────────
-- Users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tenant_users (
    user_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    email                VARCHAR(255) NOT NULL,

    -- CORRECTION (database/02 #7): NOT NULL in the base schema makes SSO-only users
    -- impossible to represent, since they never set a local password.
    password_hash        VARCHAR(255),

    first_name           VARCHAR(100),
    last_name            VARCHAR(100),
    job_title            VARCHAR(150),
    phone_e164           VARCHAR(20),
    phone_verified_at    TIMESTAMP WITH TIME ZONE,
    email_verified_at    TIMESTAMP WITH TIME ZONE,

    status               user_status NOT NULL DEFAULT 'invited',

    -- CORRECTION (database/02 #8): no account-lockout state existed, though
    -- SECURITY_ARCHITECTURE.md branches on failed logins. Rate limiting throttles the
    -- request; lockout disables the account. Both are needed — see api/03.
    failed_login_count   INTEGER NOT NULL DEFAULT 0,
    locked_until         TIMESTAMP WITH TIME ZONE,

    password_changed_at  TIMESTAMP WITH TIME ZONE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    last_login           TIMESTAMP WITH TIME ZONE,
    deleted_at           TIMESTAMP WITH TIME ZONE,

    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- CORRECTION (database/02 #6): the base UNIQUE(tenant_id, email) is case-sensitive, so
-- Bob@x.com and bob@x.com are two accounts in one tenant while login treats them as one.
CREATE UNIQUE INDEX uq_tenant_users_email_ci ON tenant_users(tenant_id, lower(email));

-- ─────────────────────────────────────────────────────────────────────────────
-- RBAC
-- ─────────────────────────────────────────────────────────────────────────────
-- CORRECTION (database/02 #4): the base schema stored roles and permissions as JSONB,
-- which cannot be joined, constrained or reported on. "Who has records:delete?" was a
-- full scan with JSON parsing, and no FK stopped a typo becoming a silent non-permission.
CREATE TABLE roles (
    role_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID REFERENCES tenants(tenant_id) ON DELETE CASCADE,  -- NULL = system template
    parent_role_id UUID REFERENCES roles(role_id) ON DELETE SET NULL,
    code           VARCHAR(50) NOT NULL,
    name           VARCHAR(150) NOT NULL,
    description    TEXT,
    is_system      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_roles_tenant_code ON roles(tenant_id, code) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX uq_roles_system_code ON roles(code)            WHERE tenant_id IS NULL;

CREATE TABLE permissions (
    permission_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code          VARCHAR(100) NOT NULL UNIQUE,   -- 'records:read'
    resource      VARCHAR(50)  NOT NULL,
    action        VARCHAR(50)  NOT NULL,
    description   TEXT,
    is_phi_scoped BOOLEAN NOT NULL DEFAULT FALSE, -- drives HIPAA read-logging (migration 0005)
    UNIQUE (resource, action)
);

CREATE TABLE role_permissions (
    role_id       UUID NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
    user_id    UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,
    role_id    UUID NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
    granted_by UUID REFERENCES tenant_users(user_id),
    granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,             -- temporary elevation
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE user_permission_overrides (
    override_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
    effect        permission_effect NOT NULL,
    reason        TEXT NOT NULL,          -- required: overrides must be justifiable at audit
    granted_by    UUID REFERENCES tenant_users(user_id),
    expires_at    TIMESTAMP WITH TIME ZONE,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, permission_id)
);

-- Effective permissions: role tree upward, plus allow overrides, minus deny overrides.
-- Deny always wins and is evaluated last.
CREATE OR REPLACE VIEW effective_user_permissions AS
WITH RECURSIVE role_tree AS (
    SELECT ur.user_id, r.role_id, r.parent_role_id
      FROM user_roles ur
      JOIN roles r ON r.role_id = ur.role_id
     WHERE ur.expires_at IS NULL OR ur.expires_at > NOW()
    UNION
    SELECT rt.user_id, p.role_id, p.parent_role_id
      FROM role_tree rt
      JOIN roles p ON p.role_id = rt.parent_role_id
),
granted AS (
    SELECT DISTINCT rt.user_id, rp.permission_id
      FROM role_tree rt
      JOIN role_permissions rp ON rp.role_id = rt.role_id
    UNION
    SELECT o.user_id, o.permission_id
      FROM user_permission_overrides o
     WHERE o.effect = 'allow' AND (o.expires_at IS NULL OR o.expires_at > NOW())
)
SELECT g.user_id, g.permission_id, p.code
  FROM granted g
  JOIN permissions p ON p.permission_id = g.permission_id
 WHERE NOT EXISTS (
       SELECT 1 FROM user_permission_overrides d
        WHERE d.user_id = g.user_id
          AND d.permission_id = g.permission_id
          AND d.effect = 'deny'
          AND (d.expires_at IS NULL OR d.expires_at > NOW()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Sessions and tokens
-- ─────────────────────────────────────────────────────────────────────────────
-- CORRECTION (database/02 #1): the JWT carries session_id, device_id and a refresh jti
-- "for revocation", but the base schema persisted none of them — so logout, password
-- change and device revocation could not invalidate a live token.
CREATE TABLE user_devices (
    device_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,
    fingerprint  VARCHAR(255) NOT NULL,
    platform     VARCHAR(20),            -- 'ios' | 'android' | 'web'
    app_version  VARCHAR(20),
    push_token   TEXT,
    trusted_at   TIMESTAMP WITH TIME ZONE,   -- set once the device passes MFA
    last_seen_at TIMESTAMP WITH TIME ZONE,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, fingerprint)
);

CREATE TABLE sessions (
    session_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id        UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,
    device_id      UUID REFERENCES user_devices(device_id) ON DELETE SET NULL,

    ip_address     INET,
    user_agent     TEXT,
    mfa_verified   BOOLEAN NOT NULL DEFAULT FALSE,
    security_level VARCHAR(20) NOT NULL DEFAULT 'normal',  -- 'low' | 'normal' | 'high'

    -- AMENDMENT (infrastructure/05): step-up authentication compares the age of the last
    -- MFA challenge against the route's requirement. mfa_verified alone is a boolean that
    -- never expires, so a session that passed MFA twelve hours ago still satisfies a
    -- high-security route.
    last_mfa_at    TIMESTAMP WITH TIME ZONE,

    -- AMENDMENT (experience/02): support impersonation must be a distinct session type.
    -- Without this column every audit row written during an impersonated session
    -- attributes the action to the customer's own user, which is worse than a gap —
    -- it is a false attribution in a HIPAA audit trail.
    impersonated_by UUID REFERENCES tenant_users(user_id),

    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_seen_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at     TIMESTAMP WITH TIME ZONE,
    revoked_reason VARCHAR(50)   -- 'logout'|'password_change'|'admin'|'reuse_detected'|'idle_timeout'
);

CREATE TABLE refresh_tokens (
    token_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- the JWT 'jti' claim
    session_id           UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id              UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,

    -- The hash, never the token: a database disclosure yields no usable refresh tokens.
    token_hash           VARCHAR(64) NOT NULL UNIQUE,
    issued_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at           TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at              TIMESTAMP WITH TIME ZONE,
    replaced_by_token_id UUID REFERENCES refresh_tokens(token_id) ON DELETE SET NULL,
    revoked_at           TIMESTAMP WITH TIME ZONE
);

-- Refresh-token reuse means the token leaked. Revoke the whole session chain, not just
-- the presented token — the safe assumption is that the attacker got there first.
CREATE OR REPLACE FUNCTION revoke_session_on_token_reuse(p_token_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE sessions s
       SET revoked_at = NOW(), revoked_reason = 'reuse_detected'
      FROM refresh_tokens rt
     WHERE rt.token_id = p_token_id
       AND s.session_id = rt.session_id
       AND s.revoked_at IS NULL;

    UPDATE refresh_tokens
       SET revoked_at = NOW()
     WHERE session_id = (SELECT session_id FROM refresh_tokens WHERE token_id = p_token_id)
       AND revoked_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- MFA
-- ─────────────────────────────────────────────────────────────────────────────
-- CORRECTION (database/02 #2): the base mfa_secret VARCHAR(255) stores a TOTP seed in
-- plaintext and supports only one factor. A TOTP seed is a bearer credential — anyone
-- who can read that column can generate valid second factors indefinitely.
CREATE TABLE mfa_methods (
    mfa_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id          UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,
    method_type      mfa_method_type NOT NULL,
    secret_encrypted TEXT,               -- envelope-encrypted TOTP seed / WebAuthn credential
    phone_e164       VARCHAR(20),        -- for sms
    is_primary       BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at     TIMESTAMP WITH TIME ZONE,   -- NULL until the enrollment challenge passes
    last_used_at     TIMESTAMP WITH TIME ZONE,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_mfa_primary ON mfa_methods(user_id) WHERE is_primary;

-- CORRECTION (database/02 #3): Phase 1.1 requires backup codes; none existed.
CREATE TABLE mfa_backup_codes (
    code_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,
    code_hash  VARCHAR(64) NOT NULL,
    used_at    TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mfa_backup_unused ON mfa_backup_codes(user_id) WHERE used_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- SSO
-- ─────────────────────────────────────────────────────────────────────────────
-- CORRECTION (database/02 #5): SSO is named as a launch requirement with no data model.
CREATE TABLE sso_connections (
    connection_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                    UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    protocol                     sso_protocol NOT NULL,
    provider_name                VARCHAR(100) NOT NULL,   -- 'Okta', 'Azure AD', ...

    idp_entity_id                TEXT,
    idp_sso_url                  TEXT,
    idp_certificate              TEXT,

    oidc_issuer                  TEXT,
    oidc_client_id               VARCHAR(255),
    oidc_client_secret_encrypted TEXT,

    attribute_mapping            JSONB NOT NULL DEFAULT '{}',  -- IdP claim -> column
    jit_provisioning             BOOLEAN NOT NULL DEFAULT FALSE,
    default_role_id              UUID REFERENCES roles(role_id) ON DELETE SET NULL,
    enforced_email_domain        VARCHAR(255),
    is_active                    BOOLEAN NOT NULL DEFAULT TRUE,

    created_at                   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Prevents JIT provisioning without a default role, which silently creates users
    -- who can authenticate but do nothing.
    CHECK (jit_provisioning = FALSE OR default_role_id IS NOT NULL)
);

CREATE TABLE sso_identities (
    identity_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,
    connection_id       UUID NOT NULL REFERENCES sso_connections(connection_id) ON DELETE CASCADE,

    -- Keyed on the IdP subject, not email: IdPs let users change their email address,
    -- and matching on a mutable attribute is an account-takeover path.
    external_subject_id VARCHAR(255) NOT NULL,
    last_login_at       TIMESTAMP WITH TIME ZONE,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (connection_id, external_subject_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification tokens and invitations
-- ─────────────────────────────────────────────────────────────────────────────
-- CORRECTION (database/02 #9): onboarding requires email verification and password
-- reset, with nowhere to store either token.
CREATE TABLE user_verification_tokens (
    token_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES tenant_users(user_id) ON DELETE CASCADE,
    purpose      verification_purpose NOT NULL,
    token_hash   VARCHAR(64) NOT NULL UNIQUE,
    expires_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at      TIMESTAMP WITH TIME ZONE,
    requested_ip INET,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_verification_live
    ON user_verification_tokens(user_id, purpose) WHERE used_at IS NULL;

CREATE TABLE user_invitations (
    invitation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    email         VARCHAR(255) NOT NULL,
    role_id       UUID NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
    invited_by    UUID REFERENCES tenant_users(user_id),
    token_hash    VARCHAR(64) NOT NULL UNIQUE,
    expires_at    TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at   TIMESTAMP WITH TIME ZONE,
    revoked_at    TIMESTAMP WITH TIME ZONE,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_invitations_pending
    ON user_invitations(tenant_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- The login chicken-and-egg
-- ─────────────────────────────────────────────────────────────────────────────
-- app.current_tenant_id comes from the JWT, but the login endpoint has no JWT yet: it
-- must find a user by email before any tenant context exists.
--
-- DEVIATION from database/02, which suggests granting auth_service "BYPASSRLS on
-- tenant_users alone". BYPASSRLS is a cluster-wide role attribute — it cannot be scoped
-- to one table, so that grant would exempt the role from RLS on every table in the
-- database, including records and the audit log. database/02 OQ4 offers the alternative
-- and asks for a security-review decision; the tighter option is taken here.
--
-- A SECURITY DEFINER function with a narrow signature returns only what the login path
-- needs. The bypass is confined to one auditable code path rather than a role attribute,
-- and the function cannot be used to read anything else.
CREATE ROLE auth_service NOLOGIN;
GRANT USAGE ON SCHEMA public TO auth_service;

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
SET search_path = public
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

REVOKE EXECUTE ON FUNCTION auth_resolve_login(TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION auth_resolve_login(TEXT, TEXT) TO auth_service;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE tenant_users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users              FORCE  ROW LEVEL SECURITY;
ALTER TABLE roles                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles                     FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_roles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles                FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permission_overrides FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_devices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices              FORCE  ROW LEVEL SECURITY;
ALTER TABLE sessions                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens            ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens            FORCE  ROW LEVEL SECURITY;
ALTER TABLE mfa_methods               ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_methods               FORCE  ROW LEVEL SECURITY;
ALTER TABLE mfa_backup_codes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_backup_codes          FORCE  ROW LEVEL SECURITY;
ALTER TABLE sso_connections           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_connections           FORCE  ROW LEVEL SECURITY;
ALTER TABLE sso_identities            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_identities            FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_verification_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_verification_tokens  FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_invitations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invitations          FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_users             FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON user_devices             FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON sessions                 FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON refresh_tokens           FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON mfa_methods              FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON mfa_backup_codes         FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON sso_connections          FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON sso_identities           FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON user_verification_tokens FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON user_invitations         FOR ALL TO app_user
    USING (tenant_id = current_tenant_id());

-- roles carries a nullable tenant_id: system templates must be visible to every tenant.
CREATE POLICY tenant_isolation ON roles FOR ALL TO app_user
    USING (tenant_id IS NULL OR tenant_id = current_tenant_id());

-- user_roles and user_permission_overrides have no tenant_id of their own; both are
-- scoped through the user they attach to.
CREATE POLICY tenant_isolation ON user_roles FOR ALL TO app_user
    USING (EXISTS (SELECT 1 FROM tenant_users u
                    WHERE u.user_id = user_roles.user_id
                      AND u.tenant_id = current_tenant_id()));
CREATE POLICY tenant_isolation ON user_permission_overrides FOR ALL TO app_user
    USING (EXISTS (SELECT 1 FROM tenant_users u
                    WHERE u.user_id = user_permission_overrides.user_id
                      AND u.tenant_id = current_tenant_id()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    tenant_users, roles, user_roles, user_permission_overrides, user_devices, sessions,
    refresh_tokens, mfa_methods, mfa_backup_codes, sso_connections, sso_identities,
    user_verification_tokens, user_invitations
    TO app_user;

-- permissions and role_permissions are a platform-owned catalogue: the application
-- reads them to resolve access but must not be able to invent a permission for itself.
GRANT SELECT ON permissions, role_permissions TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON permissions, role_permissions TO app_platform;
GRANT SELECT ON effective_user_permissions TO app_user;
GRANT EXECUTE ON FUNCTION revoke_session_on_token_reuse(UUID) TO app_user;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_users_tenant_status   ON tenant_users(tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_email_lookup    ON tenant_users(lower(email));
CREATE INDEX idx_sessions_user_live    ON sessions(user_id, last_seen_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expiry       ON sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_session       ON refresh_tokens(session_id);
CREATE INDEX idx_refresh_cleanup       ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_roles_role       ON user_roles(role_id);
CREATE INDEX idx_role_permissions_perm ON role_permissions(permission_id);
CREATE INDEX idx_sso_identities_user   ON sso_identities(user_id);
CREATE INDEX idx_devices_user          ON user_devices(user_id, last_seen_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Permission catalogue
-- ─────────────────────────────────────────────────────────────────────────────
-- Seeded here rather than in a seed script because permission codes are referenced by
-- route metadata in the API layer: an absent row is a route that can never authorize.
-- Codes come from api/01; apps:install is the addition required by partners/02.
INSERT INTO permissions (code, resource, action, description, is_phi_scoped) VALUES
    ('records:read',    'records',  'read',    'Read records',                    TRUE),
    ('records:write',   'records',  'write',   'Create and update records',       TRUE),
    ('records:delete',  'records',  'delete',  'Soft-delete records',             TRUE),
    ('records:export',  'records',  'export',  'Export records in bulk',          TRUE),
    ('records:import',  'records',  'import',  'Import records in bulk',          TRUE),
    ('files:read',      'files',    'read',    'Download files',                  TRUE),
    ('files:write',     'files',    'write',   'Upload and replace files',        TRUE),
    ('files:share',     'files',    'share',   'Create sharing links for files',  TRUE),
    ('users:read',      'users',    'read',    'View users in the tenant',        FALSE),
    ('users:write',     'users',    'write',   'Invite, edit and deactivate users', FALSE),
    ('billing:read',    'billing',  'read',    'View subscription and invoices',  FALSE),
    ('billing:write',   'billing',  'write',   'Change plan and payment methods', FALSE),
    ('webhooks:manage', 'webhooks', 'manage',  'Create and manage webhooks',      FALSE),
    ('api_keys:manage', 'api_keys', 'manage',  'Create and revoke API keys',      FALSE),
    -- Reading the audit log is itself an auditable, PHI-scoped event (api/01).
    ('audit:read',      'audit',    'read',    'Read the tenant audit log',       TRUE),
    -- AMENDMENT (partners/02): installing an app authorizes a disclosure to an external
    -- party. It is not a settings:write sub-case, and must not be grantable to ordinary
    -- users by default.
    ('apps:install',    'apps',     'install', 'Install and authorize marketplace apps', FALSE);
