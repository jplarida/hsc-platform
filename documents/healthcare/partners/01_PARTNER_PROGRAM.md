# 01 — Partner Program & App Identity

**Phase 8.1 deliverable** · Sources: `../REMAINING_PLANNING_AREAS.md` §10, `../BUSINESS_PRODUCT_PLANNING.md`, `../api/01_AUTH_AUTHORIZATION_FLOWS.md`, `../api/05_OPENAPI_SPECIFICATION.md`, `../database/01_TENANT_MANAGEMENT_ERD.md`
**Status:** Draft for review

Covers the partner organisation and application identity model, app registration and versioning,
partner credentials, the partner portal, partner-facing documentation, per-app usage analytics,
and the sandbox environment.

Authorization, consent and installation are doc 02. Listings, certification and money are doc 03.

---

## There is a third identity, and nothing models it

The platform authenticates two things today:

| Identity | Table | Tenancy | Human |
|---|---|---|---|
| A user | `tenant_users` | Belongs to exactly one tenant | Yes |
| An API key | `api_keys` | Belongs to exactly one tenant | No — created by a user, acts with a subset of their permissions |

Both are tenant-scoped, and both are protected by RLS keyed on `app.current_tenant_id`
(`api/01`, RULE-HSC-02). A marketplace application is neither. It belongs to **no tenant**, is
installed by **many** tenants, and must hold a separate authorization from each one.

This is the modelling decision the rest of Phase 8 rests on, and the one that is easiest to get
wrong. `api_keys` looks like a natural fit — it is already a non-human credential with scopes —
but `api_keys.tenant_id` is `NOT NULL` and carries an RLS policy. Reusing it would mean either one
key row per (app, tenant) pair with no entity tying them together, or an app that can only ever
serve a single tenant.

### Why a partner is not a tenant either

The other tempting shortcut is to give each partner a `tenants` row and reuse everything.
It fails on three counts:

1. **Partner staff need to see data across tenant boundaries** — the list of tenants that
   installed their app. A `tenants` row plus RLS forbids exactly that, and the fix would be a hole
   punched in the tenant isolation policy. RULE-HSC-02 makes that a compliance defect, not a
   convenience trade.
2. **A partner has no subscription, no plan, no seats and no PHI.** Every quota, limit and
   retention policy hanging off `tenants` would be meaningless or actively wrong for it.
3. **Offboarding differs.** A departing tenant is soft-deleted with financial records retained
   (`database/01`). A departing partner must have its app disabled across every install it holds —
   a fan-out operation with no analogue in tenant offboarding.

`partners` and `partner_apps` are therefore **global catalogue tables with no `tenant_id` and no
tenant RLS policy**, in the same category as `plans` in `database/01`.

They are not public, though. `partner_apps` holds every competitor's `client_id` and
`webhook_url`, so doc 02 puts RLS on it keyed on `app.current_partner_id` for the partner portal's
database role — isolation along the partner axis rather than the tenant axis. The application role
`app_user` gets no grant on either table at all.

---

## Data model

```sql
CREATE TYPE partner_status AS ENUM ('pending', 'active', 'suspended', 'terminated');
CREATE TYPE app_status     AS ENUM ('draft', 'in_review', 'certified', 'suspended', 'retired');
CREATE TYPE app_phi_tier   AS ENUM ('none', 'phi');

CREATE TABLE partners (
    partner_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name       VARCHAR(255) NOT NULL,      -- the entity that signs the BAA
    display_name     VARCHAR(150) NOT NULL,      -- shown in the marketplace
    slug             VARCHAR(80)  NOT NULL UNIQUE,
    website_url      TEXT,
    support_email    VARCHAR(255) NOT NULL,          -- stored lowercased
    security_contact VARCHAR(255) NOT NULL,          -- required; see doc 03 certification

    status           partner_status NOT NULL DEFAULT 'pending',
    suspended_reason TEXT,

    -- Set by doc 03. Null until an agreement is executed.
    baa_executed_at  TIMESTAMP WITH TIME ZONE,
    baa_document_id  UUID,                       -- files(file_id), platform-tenant scoped
    baa_expires_at   TIMESTAMP WITH TIME ZONE,

    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE partner_users (
    partner_user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id      UUID NOT NULL REFERENCES partners(partner_id) ON DELETE CASCADE,
    email           VARCHAR(255) NOT NULL,       -- stored lowercased
    full_name       VARCHAR(200),
    password_hash   VARCHAR(255),                -- argon2id, as tenant_users
    role            VARCHAR(30) NOT NULL DEFAULT 'developer',  -- owner | developer | finance
    mfa_enrolled_at TIMESTAMP WITH TIME ZONE,
    last_login_at   TIMESTAMP WITH TIME ZONE,
    deactivated_at  TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE (partner_id, email)
);

CREATE TABLE partner_apps (
    app_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id    UUID NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
    name          VARCHAR(150) NOT NULL,
    slug          VARCHAR(80)  NOT NULL UNIQUE,

    status        app_status   NOT NULL DEFAULT 'draft',
    phi_tier      app_phi_tier NOT NULL DEFAULT 'none',

    client_id     VARCHAR(40)  NOT NULL UNIQUE,   -- public identifier, hscapp_<random>
    redirect_uris TEXT[]       NOT NULL DEFAULT '{}',

    webhook_url   TEXT,                           -- app-level lifecycle events, see doc 02
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Redirect URIs are HTTPS-only and exact-match. Enforced in a trigger rather than a CHECK
-- because a CHECK cannot contain a subquery over unnest().
CREATE OR REPLACE FUNCTION validate_redirect_uris() RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM unnest(NEW.redirect_uris) AS u
                WHERE u NOT LIKE 'https://%' OR u LIKE '%*%') THEN
        RAISE EXCEPTION 'redirect_uris must be https and must not contain wildcards';
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
    secret_hash   VARCHAR(64) NOT NULL UNIQUE,   -- SHA-256, as api_keys
    created_by    UUID REFERENCES partner_users(partner_user_id),
    last_used_at  TIMESTAMP WITH TIME ZONE,
    expires_at    TIMESTAMP WITH TIME ZONE,
    revoked_at    TIMESTAMP WITH TIME ZONE,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- An app's scope set and metadata are versioned, because a scope increase must not
-- silently apply to existing installs. See doc 02.
CREATE TABLE app_versions (
    app_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id         UUID NOT NULL REFERENCES partner_apps(app_id) ON DELETE CASCADE,
    version        INTEGER NOT NULL,
    scope_codes    TEXT[] NOT NULL,               -- from app_scopes, doc 02
    phi_tier       app_phi_tier NOT NULL,
    changelog      TEXT,

    submitted_at   TIMESTAMP WITH TIME ZONE,
    certified_at   TIMESTAMP WITH TIME ZONE,
    certified_by   VARCHAR(150),                  -- platform reviewer
    published_at   TIMESTAMP WITH TIME ZONE,
    retired_at     TIMESTAMP WITH TIME ZONE,

    UNIQUE (app_id, version)
);

CREATE INDEX idx_app_secrets_prefix ON partner_app_secrets(secret_prefix)
    WHERE revoked_at IS NULL;
CREATE INDEX idx_app_versions_published ON app_versions(app_id, version DESC)
    WHERE published_at IS NOT NULL AND retired_at IS NULL;
```

`partner_apps.partner_id` is `ON DELETE RESTRICT`. A partner with a certified app that tenants have
installed cannot be deleted out from under them — termination is a status change plus the fan-out
in doc 02's revocation matrix, never a row delete.

`app_versions.phi_tier` is duplicated from `partner_apps` deliberately. The current app record says
what the app *is*; the version record says what each install actually consented to. When a
non-PHI app becomes PHI-capable in version 4, installs still on version 3 must remain non-PHI, and
only the version row preserves that.

---

## Credentials

Two credential shapes exist on the platform and they must not be confused:

| | Tenant API key (`api/01`) | Partner app credential |
|---|---|---|
| Format | `hsc_live_<prefix>_<32 chars>` | `client_id` public, plus `hscapp_<prefix>_<48 chars>` secret |
| Identifies | A tenant | An application |
| Grants | A fixed permission subset within one tenant | Nothing on its own — it only authenticates the app at the token endpoint |
| Sent as | `Authorization` on every request | Only to `POST /oauth/token`, never on a data request |

**A partner app credential is not an access token and never authorizes data access by itself.** It
authenticates the app while exchanging an authorization code or refresh token for a tenant-scoped
access token (doc 02). An implementation that lets `hscapp_…` read records directly has rebuilt
tenant-scoped API keys with a marketplace label on them, and has no consent record behind the
access.

Secret handling follows `api/01` exactly: shown once at creation, stored as SHA-256, looked up by
prefix, compared in constant time, rotated with an overlap window rather than a cutover.
`partner_app_secrets` allows several live rows per app so rotation needs no coordinated deploy on
the partner's side; `last_used_at` on the old row is what tells the partner it is safe to revoke.

The `hscapp_` marker exists for the same reason `hsc_live_` does — secret scanners recognise it,
and the platform can grep its own logs for accidental capture.

---

## The partner portal

A separate application, a separate authentication realm, and a separate database role.

**Partner staff are not `tenant_users` and must not be able to authenticate into the tenant
application with the same identity.** They are outside every tenant, they have not been invited by
a tenant admin, and they are not covered by any tenant's access review. Sharing the user table
would put a row in `tenant_users` with a null or synthetic `tenant_id`, which breaks the RLS
predicate for every query that touches the table.

Concretely: distinct table (`partner_users`), distinct session cookie scoped to
`partners.allguds.com`, distinct JWT audience claim, and MFA mandatory rather than optional — a
compromised partner account can reach install metadata for every tenant that installed the app.

| Portal capability | Notes |
|---|---|
| Register and edit an app | Draft status only; edits after certification create a new `app_versions` row |
| Manage redirect URIs and secrets | HTTPS-only, exact match, no wildcards |
| Request scopes | Each scope requires a written justification, reviewed at certification (doc 03) |
| Submit for certification | Tier follows `phi_tier`; see doc 03 |
| View installs | Tenant display name, version installed, granted scopes, install date, status |
| View usage analytics | Per-app and per-install; see below |
| Manage payouts | `finance` role only; see doc 03 |
| Sandbox management | Reset and reseed the partner's sandbox tenant |

The `finance` role exists so that a developer with an API token cannot change the bank account that
receives payouts. That separation is worth having from the first day rather than after the first
incident.

---

## Partner-facing documentation

The partner docs site is generated from the same `openapi.yaml` that `api/05` already specifies as
the source of truth. Nothing new is authored; the spec is **filtered** to the operations reachable
by at least one grantable app scope, and each operation is annotated with the scope it requires.

```
openapi.yaml  ──filter by x-app-scope──▶  openapi.partner.yaml  ──▶  docs site + partner SDKs
```

Two consequences worth stating, because both are easy to get backwards.

**Per-tenant projected aliases do not apply to partner documentation.** `api/05` projects
tenant-specific field and resource names into a tenant's own spec — a tenant that renamed
`patients` to `clients` sees `clients`. An app serves many tenants at once and cannot be shown any
one tenant's vocabulary. Partner docs use canonical names only, and the projection layer must be
documented to integrators as a per-tenant view they will encounter at runtime rather than a thing
they can hard-code against.

**Every operation not reachable by any app scope must be absent, not merely undocumented.**
Publishing a spec that describes `POST /v1/tenants/{id}/offboard` and relying on a 403 to stop it
tells a partner exactly what to probe. The filter is the security boundary's public face.

---

## Per-app usage analytics

`usage_counters` (`database/01`) is per-tenant, per-metric, and RLS-scoped. It cannot answer "how
many API calls did app X make across all its installs last month", because that question crosses
tenant boundaries by construction.

```sql
CREATE TABLE app_usage_daily (
    app_id          UUID NOT NULL REFERENCES partner_apps(app_id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    day             DATE NOT NULL,

    request_count   BIGINT NOT NULL DEFAULT 0,
    error_4xx_count BIGINT NOT NULL DEFAULT 0,
    error_5xx_count BIGINT NOT NULL DEFAULT 0,
    throttled_count BIGINT NOT NULL DEFAULT 0,
    p95_duration_ms INTEGER,
    phi_read_count  BIGINT NOT NULL DEFAULT 0,   -- reads where is_phi_access = true

    is_provisional  BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (app_id, tenant_id, day)
);
```

Written by a nightly rollup running as the platform role over the request log, in the same shape as
`observability/03`'s business metrics rollups. It is a derived table: losing it costs a re-run, not
data.

Three rules on what a partner may see:

1. **Only tenants that installed the app.** The install is the authorization to know that the
   tenant exists at all. There is no aggregate over non-installers.
2. **`phi_read_count` is a count, never content.** It exists so a tenant and the platform can both
   see whether an app's PHI access matches what it claimed at certification — an app certified for
   "monthly billing export" reading ten thousand patient records daily is the signal this column
   exists to produce.
3. **Late-arriving data marks the day provisional.** Offline sync means a request attributed to
   Tuesday can land on Thursday. `analytics/01` established the reprocessing window and
   provisional-day marking; `is_provisional` inherits both rather than inventing a second answer.

---

## The sandbox

Every partner gets one dedicated sandbox tenant at registration, provisioned by the same
`tenant_provisioning_tasks` path as a real tenant (`database/01`) with
`plans.code = 'partner_sandbox'`.

**The sandbox is seeded with synthetic data and never with a clone of a production tenant.** Cloning
is the obvious way to make a realistic sandbox and it is a disclosure of PHI to an entity with no
BAA and no relationship to the patients involved. `infrastructure/02`'s test-data section already
generates synthetic fixtures for CI; the sandbox uses the same generator at a larger volume.

The sandbox tenant is otherwise a normal tenant: real RLS, real audit logging, real rate limits at
the `partner_sandbox` plan's values. A sandbox that relaxes any of those trains partners to write
apps that break on their first real install — 429 handling in particular, which doc 03's
conformance suite tests explicitly.

Sandbox data is reset on demand from the portal and automatically after 90 days of inactivity.

---

## Additions and corrections to existing documents

| # | Severity | Document | Issue | Resolution |
|---|---|---|---|---|
| 1 | **High** | `api/01` | OQ5 defers partner identity entirely; the only non-human identity is tenant-scoped, so an app cannot serve two tenants | `partners`, `partner_apps`, `app_versions` as global catalogue tables |
| 2 | **High** | `api/05` | Publishing the full spec to partners describes operations no app scope can reach | Spec filtered by `x-app-scope`; unreachable operations removed, not 403'd |
| 3 | Medium | `api/05` | Per-tenant projected aliases are meaningless for an app serving many tenants | Partner docs use canonical names; projection documented as a runtime view |
| 4 | Medium | `database/01` | `usage_counters` cannot express per-app usage across tenants | `app_usage_daily` rollup, written by the platform role |
| 5 | Medium | `api/01` | Reusing `api_keys` for apps looks natural and silently limits an app to one tenant | Separate credential shape; `hscapp_` secret authenticates only at the token endpoint |
| 6 | Low | `database/02` | Partner staff in `tenant_users` would need a null `tenant_id`, breaking the RLS predicate | Separate `partner_users` table and auth realm |

---

## Open questions

1. **Partner identity verification at registration.** Anyone can type a legal name. For non-PHI
   apps, a verified email plus domain control is probably proportionate; for PHI-capable apps the
   BAA signature process supplies it. The gap is a partner who registers, builds against the
   sandbox, and is only verified at submission — the right order for developer experience, but it
   means the sandbox is open to anyone who can receive email.
2. **App ownership transfer.** Acquisitions happen, and `partners.legal_name` is the BAA
   counterparty. A transfer invalidates the executed BAA and should force re-consent by every
   install; that is disruptive enough that partners will look for ways around it. Needs a defined
   process before the first acquisition, not after.
3. **Sandbox data volume.** Synthetic fixtures at CI scale are too small to surface pagination and
   rate-limit bugs. A useful sandbox is probably tens of thousands of records, which makes reset
   slow enough to need a job rather than a request.
4. **Partner SDK support burden.** `api/04` ships SDKs for TypeScript, Python and a mobile wrapper.
   Partners will ask for more languages, and each one is a permanent maintenance commitment.
   Generated-only support for additional targets, without the hand-written correctness layer, is
   worse than no support — that layer is where webhook verification and retry live.
