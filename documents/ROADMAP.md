# Roadmap — the subsystems with schema and no code

**Written 2026-09-16 against `dc52965`; amended 2026-09-17** when fixing the
`/auth/verify-mfa` contract drift turned up two more tables with no code.

This plans five subsystems that do not appear on any existing gap list, because every list so
far describes *endpoints in the contract that are not built yet*. These are different: the
database was built for the whole product, and several subsystems have tables, **no contract
path, and no code**. Nothing in the test suite or the migration lint can notice them.

| Document | Answers |
|---|---|
| `documents/CAPABILITIES.md` | What is built |
| `documents/healthcare/IMPLEMENTATION_GAPS.md` | What is missing of what was specified |
| **this file** | What is missing that was never specified as an endpoint |
| `documents/STATUS_AND_TODO.md` | Where we are and what to do next |

---

## What the audit found

| Schema subsystem | Code in `src/` | In `openapi.yaml`? |
|---|---|---|
| `tenant_users`, `user_roles`, `roles`, `role_permissions` | none | no |
| `user_invitations`, `user_verification_tokens` | none | no |
| `user_permission_overrides` | none | no |
| `tenant_provisioning_tasks`, `tenant_domains` | none | no |
| `retention_policies`, `retention_holds`, `purge_jobs` | none | no |
| `partner_users`, `tenant_installed_packs` | none | no |
| `mfa_methods`, `mfa_backup_codes` | none | no |
| `user_devices` | none | no |

Reproduce it with a loop over the `CREATE TABLE` names in `prisma/migrations/*/migration.sql`,
grepping each against `src/`. This is the inverse of the check open decision 6 proposes, and it
is the same class of defect that lost the import tables: something reads as handled because a
design document covers it.

## The finding that shapes the plan

**Most of this is exposure work rather than design work, and none of it needs a new table.**

The hard thinking is already in the schema. `effective_user_permissions` is a recursive view
resolving role hierarchy, temporal expiry and deny-wins overrides in a single query.
`purge_jobs` is already shaped like `import_jobs`, with the same status enum.
`record_link_rules` carries composite foreign keys to `record_type_definitions`. The work is
contracts, handlers and tests over structures that already exist and already carry their
constraints.

---

## Phase A — Configuration

**Blocked by no decision. Recommended first.**

Load-bearing in a way that is easy to miss: `/records` and `/imports` both *read*
`record_type_definitions` and `forms`, and today only `scripts/seed.mjs` writes them. **A real
tenant cannot use any of the twelve built endpoints**, because it would have no record types.
This is less a new feature than the thing that makes the existing ones reachable.

| Endpoint | Notes |
|---|---|
| `GET` / `POST /v1/record-types` | `code`, `display_name`, `is_phi`, `indexed_fields` |
| `PATCH /v1/record-types/{code}` | `is_active` toggle. `code` is referenced by composite FK, so a rename needs the `ON UPDATE CASCADE` path thought through |
| `GET` / `POST /v1/forms` | JSON Schema in `forms.schema`, which the importer already compiles |
| `POST /v1/forms/{id}/versions` | The subtle part: `forms.version` and `form_versions` both exist and can disagree. Decide which is authoritative before writing either |
| `GET` / `POST` / `DELETE /v1/record-link-rules` | The trigger already enforces these; this exposes authoring |

**Risk.** `record_type_definitions.is_phi` drives PHI audit logging. Letting a tenant flip it
downgrades an audit obligation, so it likely wants to be write-once, or gated on a different
permission from ordinary type editing.

## Phase B — RBAC administration

**Buildable today**, and testable exactly as the current suite is, with signed tokens.

| Endpoint | Notes |
|---|---|
| `GET /v1/users` | Tenant users, status, last login |
| `PATCH /v1/users/{id}` | Deactivate; unlock — `failed_login_count` and `locked_until` already exist |
| `GET /v1/roles` | System templates (`tenant_id IS NULL`) and tenant roles |
| `PUT` / `DELETE /v1/users/{id}/roles/{role_id}` | `user_roles.expires_at` already supports temporary elevation |
| `GET /v1/users/{id}/permissions` | A straight read of `effective_user_permissions` |
| `POST` / `DELETE /v1/users/{id}/permission-overrides` | `reason` is `NOT NULL`: the schema already insists an override be justifiable at audit |

**Open question this raises.** Permissions currently travel in JWT claims, so revoking a role
leaves the user holding it until their token expires. Three options: accept the window and
document it; resolve `effective_user_permissions` per request, which is a join on every call;
or invalidate the session on a permission change, for which the machinery already exists in
`src/services/sessions.ts`. Worth deciding before Phase B is built rather than after.

## Phase C — Authentication, and the half that needs email

Blocked on **decision 1** (the `auth_service` SECURITY DEFINER review) and **decision 2**
(email, therefore a BAA).

`/auth/login`, `/auth/refresh` and `/auth/logout` first. Then `user_invitations` — already
schema'd with a hashed token, an expiry, and a partial unique index permitting one pending
invite per email per tenant — plus email verification and password reset.

It needs a password hashing library. There is none in `package.json` today, which is worth
knowing before this gets estimated as "one endpoint". `api/01` specifies **argon2id**, so the
choice is made even though the dependency is absent. `scripts/seed.mjs` also writes
`'PLACEHOLDER-NOT-A-VALID-HASH'` deliberately, so there is no working credential anywhere yet,
not even in the dev tenant.

**MFA is part of this phase and was missing from the audit above until 2026-09-17.**
`mfa_methods` and `mfa_backup_codes` have no code, and the contract had no
`/auth/verify-mfa` path at all while already answering `mfa_required` with a
`challenge_id` — a dead end a client could be sent into with no way out. The path is now in
`openapi.yaml`; nothing implements it.

**MFA happens at two separate moments, and they are easy to conflate** — this document did, on
2026-09-17, and said `MFA_REQUIRED` should probably be deleted. It should not. The two are:

| Moment | Shape |
|---|---|
| Login handshake | `/auth/login` answers `200 {mfa_required: true, challenge_id}`, redeemed at `/auth/verify-mfa` |
| Authorization | An already-authenticated request whose session has `mfa_verified: false` hits a route requiring MFA — `403 MFA_REQUIRED` (`api/01` authorization flowchart, and its error catalogue) |

`src/http/errors.ts` maps `MFA_REQUIRED` to 403 for the second, which is correct and should
stay. What is missing is the **enforcement**, and that is Phase C work rather than a defect:
nothing reads `sessions.mfa_verified`, and no route has any way to declare that it requires
MFA. The error code is waiting for a check that was never built.

## Phase D — Tenant provisioning

Depends on B and C. `tenant_provisioning_tasks` exists to track the steps, and
`tenant_installed_packs` together with `record_type_definitions.industry_pack_code` is the
intended mechanism for seeding a new tenant's configuration — which ties this to **decision 3,
the vertical**, since the first industry pack decides what a new tenant starts with.

**The bootstrap problem, worth deciding early.** A new tenant's first owner cannot be invited
by an existing user, and cannot be emailed if email is out of scope. Either provisioning issues
an out-of-band set-password token, or tenant creation stays deliberately an operator action.
That is a product decision, not an implementation detail.

## Phase E — Retention and erasure

Depends on **TODO 3, generalising the job runner**, and is the strongest argument for doing it.
`purge_jobs` is already shaped like `import_jobs`. Building retention on its own queue is
precisely the "four features answering the same five questions" outcome that
`IMPLEMENTATION_GAPS.md` Part D warns against.

Two things it will need:

- **A grant migration for the sweep role**, the same shape as
  `20260913120900_import_platform_grant`, and with the same silent failure mode if forgotten:
  `app_platform` holds BYPASSRLS, which is an exemption from row policies and not a privilege
  on the table.
- **`retention_holds` must fail closed.** Purging data under legal hold is spoliation, and the
  schema comment already says this is the one place where failing closed matters more than
  completing the job.

Unaddressed anywhere so far: there is no tenant offboarding or delete path at all, and
**decision 4** — `data_audit_log.changed_by` as an FK versus GDPR erasure — lands here.

## Phase F — Outbound

Gated on **decision 2**. No email, no notifications, nothing outbound exists at all. For a
health and safety product, "notify someone an incident was reported" is plausibly the core use
case.

Webhooks are the one piece needing no BAA, and could precede email.

---

## Sequence

```
A (config) ──► B (RBAC admin) ──► [decision 1] ──► C (auth) ──► [decision 2] ──► invites, email
                    │
                    ├──► TODO 3 (job runner) ──► E (retention)
                    │
                    └──► D (provisioning, also needs C)
```

## One change to the current TODO

**Phase A should come before `/audit-logs`.** Both are unblocked by any decision. But
`/audit-logs` adds visibility to a platform nobody can configure, while Phase A is what makes
the twelve endpoints that already exist usable by anyone not running SQL by hand.

## New decisions this planning surfaced

Not in the `STATUS_AND_TODO.md` register, and should be added there if they survive review:

| # | Decision | Blocks |
|---|---|---|
| A | Is `record_type_definitions.is_phi` mutable by a tenant, given that flipping it downgrades an audit obligation? | Phase A |
| B | Stale permissions in JWT claims: accept the window, resolve per request, or invalidate the session? | Phase B |
| C | Which of `forms.version` and `form_versions` is authoritative? | Phase A |
| D | How does a new tenant's first owner get a credential when there is no email? | Phase D |

---

## Status

**Nothing here is approved or started.** It is a plan produced by reading the schema against
`src/` on 2026-09-16, and every phase is an estimate of shape rather than a commitment. The
four decisions above are the parts most likely to change it.
