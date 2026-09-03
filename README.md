# HSC Platform

A multi-tenant health, safety and compliance platform. HIPAA-oriented, industry-agnostic,
offline-capable.

This repository holds both the design documents and the implementation. The documents came
first and are still the source of truth: where the code and a specification disagree, the
specification is normally right and the code is the thing to fix.

## Status

| | |
|---|---|
| Design documents | 71 markdown files, Phases 1–8, 42 of 45 checklist items |
| Database schema | 8 migrations, 79 tables, 65 under row-level security |
| API | Full middleware pipeline, 4 of 14 specified paths implemented |
| Tests | 175, all passing from an empty database |

Everything runs locally from nothing:

```bash
npm install
cp .env.example .env      # then fill in the compose values, see db/README.md
npm run db:up             # postgres + two redis instances
npm run db:migrate
npm run db:seed
npm test                  # 175 tests
```

## What this is

An industry-agnostic record platform, not a clinical system with a generic layer bolted on.
There is no `patients` table. There is a `records` table with a JSONB payload and a
per-tenant `record_type_definitions` registry, where each tenant declares what `patient`
means, which form describes it, and which workflow governs it. That is what lets one schema
serve a clinic and a construction firm.

`record_type_definitions.is_phi` is the single switch that drives four separate things: PHI
read-logging, webhook payload restriction, marketplace scope tiers, and de-identification.
One definition of "this is protected health information", four consumers — rather than four
that drift apart.

**Tenant isolation is PostgreSQL row-level security, not application filtering.** Every
table carrying `tenant_id` has RLS enabled *and* forced, with a policy keyed on a
transaction-local GUC. A query path that bypasses it is a compliance defect rather than a
bug, which is why there is no `WHERE tenant_id = …` anywhere in the route handlers.

## Layout

```
documents/healthcare/     the design corpus — 71 documents across 10 areas
  api/                    endpoints, auth, rate limiting, webhooks, openapi.yaml
  database/               ERDs, indexing, migrations, scaling
  frontend/  infrastructure/  observability/  analytics/
  experience/  interoperability/  performance/  partners/

prisma/migrations/        SQL-first schema. See db/README.md
src/                      the API
tests/                    175 tests, run serially against a real database
scripts/                  db lifecycle, seed, migration lint
db/README.md              schema decisions, roles, and every defect found so far
```

## The schema is SQL-first

`prisma/migrations/*/migration.sql` is the source of truth. Prisma generates the typed
client by introspecting the result; it does not own the schema.

That is not a preference. The schema uses row-level security on 65 tables, 65 policies,
40-odd role grants, ~76 partial indexes, 12 triggers, 7 plpgsql functions and three
partitioned tables — **none of which Prisma's schema language can express**. A Prisma-first
workflow regenerates migrations from the model blocks and would silently drop every one of
them.

Never run `prisma migrate dev` here. `db/README.md` explains the workflow.

## The API

The request pipeline follows `api/06_MIDDLEWARE_ARCHITECTURE.md`, and **the stage order is a
security property rather than a style choice**:

```
1  request context      7  session check      13  transaction + tenant GUC
2  security headers     8  tenant binding     14  PHI access log
3  CORS                 9  rate limit         15  caching
4  body limits         10  authorization      16  envelope + headers
5  IP rate limit       11  validation         17  error handler
6  authentication      12  idempotency
```

`API_ARCHITECTURE.md` originally placed tenant resolution at stage 2 and authentication at
stage 3. That inversion means a valid token plus a forged `X-Tenant-ID` reads another
tenant's data, with RLS faithfully enforcing the attacker's choice and nothing raising an
error. Authentication comes first here, and a test fails if that is ever reordered.

### Endpoints

```
[x] GET    /v1/records                              [ ] /auth/login, /refresh, /logout
[x] POST   /v1/records                              [ ] /files, /files/{id}/download
[x] GET    /v1/records/{id}                         [ ] /sync/pull, /sync/push
[x] PATCH  /v1/records/{id}                         [ ] /records/{id}/advance
[x] DELETE /v1/records/{id}                         [ ] /webhooks
[x] GET    /v1/records/{id}/links                   [ ] /audit-logs
[x] POST   /v1/records/{id}/links
[x] DELETE /v1/records/{id}/links/{link_id}
```

Responses are validated against `openapi.yaml` by contract tests, and requests are validated
from the same document — so the two cannot drift without a test failing.

## What the documents got wrong

The specifications were written against SQL and code that had never been run. Executing them
surfaced 14 defects, and the distribution is the useful part:

- **Careful reading** found the syntax-level problems — two `IMMUTABLE` violations that make
  the documented DDL uncreatable, an invalid plpgsql `INTO` target, a `SECURITY DEFINER`
  against `FORCE ROW LEVEL SECURITY` deadlock.
- **A migration lint** found a missing RLS policy that exposed every partner's install
  counts, and a permissive `USING` clause that let any tenant author a platform-wide system
  role.
- **Executing the schema** found two triggers that cancel each other out, audit rows
  unorderable within a transaction, and partitions not inheriting RLS.
- **Seeding** found the audit trigger reading `NEW.tenant_id` on a table that has no such
  column — the same reasoning error as a fault the documents had already diagnosed and
  fixed one line earlier.
- **Writing tests** found that no database role could be assumed at all, and that a
  PostgreSQL error object carries the offending column value, so a duplicate MRN printed a
  medical record number to the logs.

None of them were found by review. `db/README.md` records all of them.

## Open decisions

Two things are deliberately unresolved and need a human:

**The vertical.** Clinical healthcare, or workplace health and safety? It does not block the
schema — that is what the generic record model buys — but it decides the first industry
pack and whether PHI is the common case. It gates the last three checklist items.

**`data_audit_log.changed_by`.** It is a foreign key to `tenant_users`, so a user who has
ever written anything cannot be deleted for the six years their audit history is retained.
But `user_audit_log.user_email` is denormalised specifically "so it survives user deletion".
Both cannot be intended, and it interacts with GDPR erasure — which `database/04` resolves
by anonymising rather than deleting.

## Conventions

- Commit messages record reasoning, not file lists.
- Every specification document ends with a corrections table and its open questions.
- Tests run **serially** (`--test-concurrency=1`): they share one database and teardown
  toggles triggers. In parallel they race, and the symptom is a *shifting* set of failures
  rather than a consistent one.
