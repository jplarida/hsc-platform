# What the platform can actually do

An inventory of **built and verified functionality**, as distinct from what was specified.
Three documents answer three different questions, and conflating them is how a project comes
to believe it has something it does not:

| Document | Answers |
|---|---|
| `documents/healthcare/` | What was *designed* — 71 documents, the specification corpus |
| `documents/healthcare/IMPLEMENTATION_GAPS.md` | What is *missing*, and whether it was ever specified |
| **this file** | What is *built*, working, and covered by tests |
| `documents/ROADMAP.md` | What is missing that was never specified as an endpoint |
| `documents/STATUS_AND_TODO.md` | Where we are and what to do next |

**Verified against source at `82626f1` on 2026-09-16.** Everything listed here is exercised by
the test suite: 224 tests, serial, green from an empty volume. Nothing is listed on the
strength of a design document alone.

---

## The gap that governs everything below

**None of these endpoints is reachable by a real user.** `src/auth/token.ts` verifies tokens
and can mint them, but `signAccessToken` has no caller outside `tests/` — no production path
issues a credential. There is no password handling anywhere in `src/`, and no hashing library
in `package.json` at all.

So the platform is a complete engine with no ignition. A caller holding `JWT_SECRET` can
exercise all of it; a real user cannot get in by any route. Read every table below with that
qualifier attached.

---

## API endpoints — 12 of 19 contracted paths

| # | Method | Path | Functionality |
|---|---|---|---|
| 1 | `GET` | `/v1/records` | List records. Cursor pagination (limit 1–200, default 50), filters on `type`, `status`, `updated_after`, and free-text `q` |
| 2 | `POST` | `/v1/records` | Create a record. Idempotency-key replay, emits `ETag` |
| 3 | `GET` | `/v1/records/{id}` | Fetch one record, returns `ETag` for concurrency |
| 4 | `PATCH` | `/v1/records/{id}` | JSON Merge Patch, guarded by `If-Match`; `428` if the header is absent, `412` on version mismatch |
| 5 | `DELETE` | `/v1/records/{id}` | Soft delete, also `If-Match` guarded |
| 6 | `GET` | `/v1/records/{id}/links` | List a record's links |
| 7 | `POST` | `/v1/records/{id}/links` | Create a link. Cardinality and permissibility enforced by a database trigger, not the handler; refusals matched on SQLSTATE, never on message text |
| 8 | `DELETE` | `/v1/records/{id}/links/{link_id}` | Remove a link, scoped by `from_record_id` so a link hanging off another record cannot be deleted through this path |
| 9 | `POST` | `/v1/imports` | Start an import. `202` plus a job URL, dry-run by default, declarative column-to-field mapping, staging rows and job row written in one transaction |
| 10 | `GET` | `/v1/imports/{id}` | Job status and counts — read from PostgreSQL, never from the queue |
| 11 | `GET` | `/v1/imports/{id}/errors` | Paginated per-row errors carrying the original source row. Audited as PHI access, because a rejected patient row is still a patient row |
| 12 | `POST` | `/v1/imports/{id}/reverse` | Undo an import. **Refuses** if any imported record has been edited since, rather than discarding the tenant's own work |

## Import pipeline

| Capability | Functionality |
|---|---|
| Async execution | Redis Stream consumer group. The queue carries only a wake-up signal; `import_jobs` is the sole source of truth |
| Crash recovery | `XAUTOCLAIM` reclaims messages from a worker that died mid-job; a database sweep re-enqueues jobs whose signal was lost entirely |
| Duplicate safety | The claim is a conditional `UPDATE`, so double delivery is a non-event rather than a double import |
| Dry run | A full validate-and-report pass that writes no records |
| Cleansing | Four declared transforms: `trim`, `upper`, `iso_date`, `e164`. Nothing undeclared is altered |
| Validation | Required fields, transforms, JSON Schema against the record type's form, and `external_id` uniqueness both within the batch and against stored records |
| Link resolution | Second pass matching legacy foreign keys by `external_id`, with savepoints so one refused link does not poison the batch |
| Error reporting | Per-row errors with typed codes, retained for the customer to read back |

## Cross-cutting platform capabilities

| Capability | Functionality |
|---|---|
| Multi-tenant isolation | Row-level security in PostgreSQL, forced on 69 tables. Enforcement lives in the database, not in handlers |
| Token verification | JWT verify with claims, issuer and audience checks, bounded clock tolerance |
| Session revocation | Redis-backed liveness check on every request, with cross-instance invalidation |
| Permissions | `requirePermission()` gate per route |
| PHI audit | Every access recorded, attached to the response and written only once it succeeds; survives error paths |
| Rate limiting | Per-IP at the edge, per-plan and per-user buckets, plus per-endpoint cost limits with correct `RateLimit-*` headers |
| Idempotency | Key-based replay with in-progress conflict detection |
| Contract validation | Requests validated from `openapi.yaml` itself, so the published spec and the runtime cannot drift |
| Optimistic concurrency | `ETag` / `If-Match` across create, update and delete |
| Caching | Plan limits, record types, tenant config and sessions cached in Redis, invalidated across instances by pub/sub |
| Safe logging | PHI scrubbed from PostgreSQL error objects before anything reaches stdout |
| Error contract | Typed error codes with a fixed HTTP status mapping; clients branch on the code, never on the message |

## Data and tooling

| Area | State |
|---|---|
| Schema | 10 SQL-first migrations, 83 tables, 69 under forced row-level security with a policy each |
| Seed | 5 plans, 4 system roles, an `acme` dev tenant with an owner |
| Migration lint | `lint:migrations` verifies RLS enabled, forced and policied across the whole corpus |
| Tests | 224, serial, green from an empty volume |

---

## Not built

```
[ ] /auth/login, /auth/refresh, /auth/logout      BLOCKED — see STATUS_AND_TODO decision 1
[ ] /auth/verify-mfa                              BLOCKED — see STATUS_AND_TODO decision 1
[ ] /files, /files/{id}/download
[ ] /sync/pull, /sync/push
[ ] /records/{id}/advance
[ ] /webhooks
[ ] /audit-logs
[ ] any user interface at all
```

Two of these are worth understanding rather than just noting. **`/audit-logs`** means the audit
trail is write-only: everything is recorded correctly and nothing can read any of it back, so a
compliance officer has no view of the thing the platform is built around. **`/files`** is why
imports are inline-only and capped at 5,000 rows; a `source_file_id` is refused rather than
accepted and ignored.

---

## Keeping this honest

This file claims things are *built*, which makes it the most expensive kind of document to let
drift — a reader trusts it precisely where being wrong costs most. It was written by reading
the source, not the design corpus, and it should be corrected the same way.

To re-verify:

```bash
grep -rnE "\.(get|post|patch|delete)\(" src/routes/   # the endpoints that actually exist
grep -n "app.use" src/app.ts                          # what is actually mounted
npm test                                              # 224, serial, from an empty volume
```

If any row here cannot be traced to code that way, the row is wrong and not the code.
