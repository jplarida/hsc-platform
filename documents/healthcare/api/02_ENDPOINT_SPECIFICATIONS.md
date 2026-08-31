# 02 — Endpoint Specifications

**Phase 2.1 deliverable** · Sources: `API_ARCHITECTURE.md`, `database/03_BUSINESS_ENTITY_ERD.md`, `database/06_INDEXING_STRATEGY.md`
**Status:** Draft for review

Covers URL structure, resource conventions, the endpoint catalogue, pagination, concurrency
control, idempotency, the error contract, and versioning.

---

## URL structure

`API_ARCHITECTURE.md:196-197` gives two base URLs without saying which is canonical:

```
https://api.allguds.com/v1                      <- canonical
https://healthcare-plus.allguds.com/api/v1      <- tenant alias
```

**`api.allguds.com/v1` is canonical.** The tenant subdomain remains valid and is what the web app
uses (it keeps cookies and CSP scoped per tenant), but it is an alias: the tenant it names is a
routing hint only, never an authorization input (doc 01). Every response advertises the canonical
form in `Link: <...>; rel="canonical"`, and SDKs and webhooks use it exclusively — otherwise a
tenant renaming its subdomain silently breaks every stored integration URL.

One consequence worth stating: because the subdomain is not authorization, `GET /v1/records`
against `tenant-a.allguds.com` with a tenant-B token returns **tenant B's** records, not a 403.
This is correct, and it is why the canonical host is preferred everywhere the subdomain is not
carrying UI state.

## Conventions

| Rule | Example |
|---|---|
| Plural nouns for collections | `/records`, `/files`, `/users` |
| Verbs only for non-CRUD state transitions | `/records/{id}/advance`, `/api-keys/{id}/revoke` |
| `kebab-case` in paths, `snake_case` in JSON | `/audit-logs`, `{"created_at": ...}` |
| UUIDs in path parameters | `/records/6f1c…` |
| Sub-resources for owned collections | `/records/{id}/files`, `/files/{id}/versions` |
| No trailing slashes | `/records`, never `/records/` |
| Query parameters for filtering, never for identity | `/records?type=patient` |

`PATCH` uses JSON Merge Patch (RFC 7396), not JSON Patch — merge semantics match how clients
actually edit forms, and `null` explicitly clears a field.

---

## Records: canonical route plus projected aliases

The database uses one generic `records` table with a per-tenant type registry
(`database/03_BUSINESS_ENTITY_ERD.md`). The API exposes both shapes over one implementation:

```
GET  /v1/records?type=patient&status=active     canonical, always available
GET  /v1/patients?status=active                 projected alias, generated per tenant
```

Aliases are derived from `record_type_definitions.plural_name` at tenant-config load and cached.
They resolve to the same handler, the same permission checks, and the same response schema — the
alias only injects `type`. This gives integrators domain-shaped URLs without a second code path
or a second permission model.

Rules that keep the two from diverging:

- **The canonical route is always present**, even for types with an alias. Clients that predate a
  type rename keep working.
- **Aliases are read-and-write but never invent fields.** `POST /v1/patients` is exactly
  `POST /v1/records` with `type` fixed; the body shape is identical.
- **An alias for an uninstalled type returns `404 RECORD_TYPE_NOT_ENABLED`**, not a bare 404,
  so an integrator can tell "wrong URL" from "your tenant has not installed this pack".
- **Alias collisions with platform routes are rejected at pack install time.** A tenant creating
  a record type whose plural is `users`, `files`, or `webhooks` gets a validation error rather
  than a shadowed endpoint.

Per-tenant OpenAPI generation is covered in doc 05.

---

## Endpoint catalogue

Permissions are the codes from `database/02_USER_AUTH_ERD.md`. Every route below is
tenant-scoped and requires a valid session unless marked public.

### Authentication

| Method | Path | Permission | Success | Notes |
|---|---|---|---|---|
| POST | `/auth/login` | public | 200 | May return `mfa_required` |
| POST | `/auth/verify-mfa` | public | 200 | Consumes a challenge |
| POST | `/auth/refresh` | public | 200 | Rotates; reuse ends the session |
| POST | `/auth/logout` | authenticated | 204 | Revokes the session |
| POST | `/auth/forgot-password` | public | 202 | Always 202, even for unknown emails |
| POST | `/auth/reset-password` | public | 200 | Revokes all sessions on success |
| POST | `/auth/verify-email` | public | 200 | |
| POST | `/auth/setup-mfa` | authenticated | 200 | Returns provisioning URI |

`/auth/forgot-password` returns `202` unconditionally. Returning 404 for an unknown address
turns password reset into an account-enumeration endpoint.

### Records

| Method | Path | Permission | Success |
|---|---|---|---|
| GET | `/records` | `records:read` | 200 |
| POST | `/records` | `records:write` | 201 |
| GET | `/records/{id}` | `records:read` | 200 |
| PUT | `/records/{id}` | `records:write` | 200 |
| PATCH | `/records/{id}` | `records:write` | 200 |
| DELETE | `/records/{id}` | `records:delete` | 204 |
| GET | `/records/{id}/history` | `audit:read` | 200 |
| GET | `/records/{id}/links` | `records:read` | 200 |
| POST | `/records/{id}/links` | `records:write` | 201 |
| DELETE | `/records/{id}/links/{link_id}` | `records:write` | 204 |
| POST | `/records/{id}/advance` | `records:write` | 200 |
| POST | `/records/bulk` | `records:write` | 207 |

`/records/{id}/links` is new — `API_ARCHITECTURE.md` predates the link model and has no way to
express a relationship. `POST` enforces `record_link_rules`, so an impermissible link returns
`422 LINK_RULE_VIOLATION` rather than a database error.

`/records/{id}/advance` replaces the documented `/workflows/{id}/advance`. The state lives on the
record, not the workflow definition; the original path advances the wrong noun.

`/records/bulk` returns `207 Multi-Status` with a per-item result array. A bulk endpoint that
returns a single 201 or 400 forces clients to re-fetch to discover which of 100 items failed.

### Files

| Method | Path | Permission | Success |
|---|---|---|---|
| GET | `/files` | `files:read` | 200 |
| POST | `/files` | `files:write` | 201 |
| GET | `/files/{id}` | `files:read` | 200 |
| GET | `/files/{id}/download` | `files:read` | 302 |
| GET | `/files/{id}/versions` | `files:read` | 200 |
| DELETE | `/files/{id}` | `files:write` | 204 |
| POST | `/files/uploads` | `files:write` | 201 |
| PUT | `/files/uploads/{id}/chunks/{n}` | `files:write` | 204 |
| POST | `/files/uploads/{id}/complete` | `files:write` | 201 |
| POST | `/files/{id}/shares` | `files:share` | 201 |

`/files/{id}/download` returns `302` to a short-lived pre-signed storage URL rather than
streaming bytes through the API — the API tier should not be a file proxy. It returns
`409 FILE_NOT_AVAILABLE` when `scan_status` is not `clean`
(`database/05_FILE_DOCUMENT_ERD.md`), which is the check that stops the platform serving malware
it has already detected.

Chunked upload paths are restructured from the documented `/files/upload/chunked` +
`/files/{id}/chunk/{n}` into a proper `uploads` sub-resource, matching the `file_uploads` /
`file_upload_chunks` tables.

### Sync

| Method | Path | Permission | Success |
|---|---|---|---|
| POST | `/sync/pull` | `records:read` | 200 |
| POST | `/sync/push` | `records:write` | 200 |
| GET | `/sync/status` | `records:read` | 200 |

`/sync/resolve-conflict` is dropped: conflict resolution happens inside `/sync/push`, which
returns per-item outcomes including `conflict` with both versions attached. A separate endpoint
implies conflicts are resolved out of band, which contradicts `OFFLINE_SYNC_PROCESS.md`.

**Sync cursors are versions, not timestamps.** `API_ARCHITECTURE.md:322` sends
`"last_sync": "2024-09-07T09:00:00Z"`. Device clocks drift, and a device whose clock runs fast
silently skips every record written in the gap. The cursor is an opaque server-issued string
encoding the last `records.version` watermark:

```json
{ "device_id": "…", "cursor": "eyJ2IjoxODQyMiwidCI6InJlY29yZHMifQ", "limit": 100 }
```

Clients treat it as opaque and echo it back. That keeps the encoding a server implementation
detail and lets the watermark change shape without a client release.

### Admin and tenant

| Method | Path | Permission | Success |
|---|---|---|---|
| GET | `/tenant/config` | authenticated | 200 |
| PATCH | `/tenant/config` | `tenant:manage` | 200 |
| GET | `/tenant/usage` | `billing:read` | 200 |
| GET | `/tenant/billing` | `billing:read` | 200 |
| GET | `/users` | `users:read` | 200 |
| POST | `/users` | `users:write` | 201 |
| PATCH | `/users/{id}` | `users:write` | 200 |
| DELETE | `/users/{id}` | `users:write` | 204 |
| GET | `/audit-logs` | `audit:read` | 200 |
| GET/POST | `/webhooks` | `webhooks:manage` | 200/201 |
| GET/POST | `/api-keys` | `api_keys:manage` | 200/201 |
| POST | `/imports` | `records:import` | 202 |

`POST /users` creates an invitation, not a user — it writes `user_invitations`. The distinction
matters because an invited address is not yet an account and must not consume a seat until
accepted.

`POST /imports` returns `202 Accepted` with a job URL; imports are asynchronous
(`database/07_DATA_MIGRATION_WORKFLOWS.md`).

---

## Pagination

`API_ARCHITECTURE.md:288` documents `?limit=20&offset=40`. Offset pagination degrades linearly
with depth and, worse, **skips and duplicates rows** when records are inserted or updated during
paging — which for a sync client walking a large collection is a correctness bug, not a
performance one. `database/06_INDEXING_STRATEGY.md` requires keyset pagination.

```http
GET /v1/records?type=patient&limit=50
GET /v1/records?type=patient&limit=50&cursor=eyJ1IjoiMjAyNi0wOC0zMVQxMDoxNTozMFoiLCJpIjoiNmYxYyJ9
```

```json
{
  "success": true,
  "data": [ … ],
  "meta": {
    "request_id": "req_…",
    "timestamp": "2026-09-01T10:15:30Z",
    "page": { "limit": 50, "next_cursor": "eyJ1Ijoi…", "has_more": true }
  }
}
```

The cursor encodes the sort key and the tiebreak id — `(updated_at, record_id)` — matching the
composite index. No total count is returned by default: counting a large tenant's records is a
full index scan on every page. `?include_count=true` is available and explicitly documented as
expensive.

`limit` defaults to 50 and is capped at 200 (20 for `/audit-logs`, whose rows are far larger).

---

## Concurrency control

The generic record model plus offline clients makes lost updates likely, and nothing in
`API_ARCHITECTURE.md` prevents them: two clients `PATCH` the same record and the second silently
overwrites the first.

`records.version` (`database/03_BUSINESS_ENTITY_ERD.md`) is exposed as an ETag:

```http
GET /v1/records/6f1c…
→ 200 OK
  ETag: "18422"

PATCH /v1/records/6f1c…
  If-Match: "18422"
→ 200 OK  (version now 18423)
→ 412 Precondition Failed  if the record moved on
```

`If-Match` is **required** on `PUT`, `PATCH` and `DELETE` for records; omitting it returns
`428 Precondition Required`. Making it optional means every client that forgets it silently
reintroduces the lost update. The mobile client already tracks versions for sync, so it pays no
extra cost.

## Idempotency

Mobile clients retry over unreliable networks, and a retried `POST` currently creates a duplicate.

```http
POST /v1/records
Idempotency-Key: 9f8e7d6c-…
```

The key is stored with a hash of the request body and the resulting response for 24 hours. A
replay with the same key returns the original response and `Idempotency-Replayed: true`; the same
key with a *different* body returns `422 IDEMPOTENCY_KEY_REUSE`, which catches the client bug of
reusing one key for several requests.

Required on `POST /records`, `POST /records/bulk`, `POST /sync/push`, `POST /files`, and every
billing-affecting mutation. Optional elsewhere.

---

## Errors

The envelope from `API_ARCHITECTURE.md:565-590` is kept as-is. Two changes to what goes inside it.

**5xx responses must not describe the failure.** The documented example returns
`"code": "DATABASE_ERROR", "message": "A database error occurred"` with a support contact. Naming
the failing subsystem tells an attacker which probe worked. All unhandled server errors collapse
to one shape:

```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred. Quote the request_id when contacting support."
  },
  "meta": { "request_id": "req_01J…", "timestamp": "…" }
}
```

The real cause goes to `system_audit_log` and the APM span, correlated by `request_id`. Support
looks it up; the client never sees it.

**Status code additions**, beyond those catalogued in `API_ARCHITECTURE.md`:

| Code | Meaning | Used for |
|---|---|---|
| 207 | Multi-Status | Bulk operations with mixed outcomes |
| 412 | Precondition Failed | `If-Match` version mismatch |
| 423 | Locked | Account lockout (doc 01) |
| 428 | Precondition Required | Mutation without `If-Match` |

New error codes: `TENANT_MISMATCH`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `TOKEN_REUSE_DETECTED`,
`ACCOUNT_LOCKED`, `INSUFFICIENT_SCOPE`, `RECORD_TYPE_NOT_ENABLED`, `LINK_RULE_VIOLATION`,
`FILE_NOT_AVAILABLE`, `IDEMPOTENCY_KEY_REUSE`, `VERSION_CONFLICT`, `QUOTA_EXCEEDED`.

`QUOTA_EXCEEDED` (403) is distinct from `RATE_LIMIT_EXCEEDED` (429): one means "your plan does
not allow this", the other "slow down". Conflating them makes clients retry a request that will
never succeed.

---

## Versioning

Version lives in the path (`/v1/`). Within a version, these are additive and ship without notice:
new endpoints, new optional request fields, new response fields, new enum values in fields
documented as open, new error codes.

These require a new major version: removing or renaming a field, changing a type, making an
optional field required, changing a status code for an existing condition, or changing pagination
semantics.

**Clients must ignore unknown response fields and unknown enum values.** This is stated in the
SDK contract because a client that hard-fails on an unrecognised enum makes every additive change
a breaking one.

Deprecation follows RFC 8594 with a minimum 12-month window for a major version and 6 months for
an individual endpoint:

```http
Deprecation: Wed, 01 Sep 2027 00:00:00 GMT
Sunset: Fri, 01 Sep 2028 00:00:00 GMT
Link: <https://docs.allguds.com/migrations/v2>; rel="deprecation"
```

Usage of deprecated endpoints is tracked per tenant and per API key, so the sunset can be
announced to the specific integrations still calling them rather than to everyone.

---

## Corrections to `API_ARCHITECTURE.md`

| # | Severity | Issue | Resolution |
|---|---|---|---|
| 1 | **High** | Offset pagination skips and duplicates rows under concurrent writes — a correctness bug for sync clients | Keyset cursors |
| 2 | **High** | No optimistic concurrency; concurrent edits silently lose the earlier write | `ETag` / `If-Match` on `records.version`, `428` when absent |
| 3 | **High** | 500 responses name the failing subsystem | Collapsed to `INTERNAL_ERROR` + `request_id` |
| 4 | **High** | Sync cursor is a client wall-clock timestamp; clock skew silently drops records | Opaque server-issued version cursor |
| 5 | Medium | No idempotency mechanism, so retried POSTs duplicate | `Idempotency-Key` |
| 6 | Medium | `/workflows/{id}/advance` advances a workflow definition rather than a record | `/records/{id}/advance` |
| 7 | Medium | No endpoints for record links, which the hybrid model depends on | `/records/{id}/links` |
| 8 | Medium | `/auth/forgot-password` returning 404 enumerates accounts | Always 202 |
| 9 | Medium | Bulk endpoints return a single status for many items | `207 Multi-Status` |
| 10 | Low | Two base URLs with no canonical designation; stored webhook URLs break on subdomain rename | `api.allguds.com/v1` canonical |
| 11 | Low | `QUOTA_EXCEEDED` and `RATE_LIMIT_EXCEEDED` conflated, causing pointless retries | Separated, 403 vs 429 |

---

## Open questions

1. **`If-Match` on files.** Records get optimistic concurrency; files are versioned but have no
   equivalent. Probably wanted for metadata edits — needs confirming before clients depend on
   either behaviour.
2. **Alias namespace collisions.** Reserved-word validation is specified at pack install, but the
   reserved list itself grows every time a platform route is added. New platform routes must
   check existing tenant aliases, which is a release-time check nobody will remember without CI.
3. **Search endpoint shape.** `POST /search/advanced` with a nested filter DSL is powerful and
   hard to bound — an arbitrarily nested filter over JSONB is a query-planner hazard. Recommend
   capping nesting depth and requiring at least one indexed field per query.
4. **WebSocket contract.** `WS /ws/updates` is listed but unspecified. Real-time is optional per
   `ARCHITECTURE_DESIGN.md`; deferring it is reasonable, but it should be explicitly out of v1
   rather than half-documented.
5. **Idempotency key storage.** Redis with a 24-hour TTL is assumed. If keys must survive a Redis
   flush, they need a table — worth deciding for billing mutations specifically.
