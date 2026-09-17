# Status and TODO

Coverage: hsc-platform:default
**Last updated:** 2026-09-14 · branch `main`. Everything through `9e24136` is pushed: the
import loader, the `target_path` contract constraint, and the empty-volume verification.
This note can itself sit a commit or two ahead of `origin/main` — `git status -sb` is the
authority on that, not this line.
**Read first:** `README.md` (what the project is), `documents/CAPABILITIES.md` (what is
actually built, as against what was designed), `documents/healthcare/IMPLEMENTATION_GAPS.md`
(what is missing and whether it was ever specified), `db/README.md` (schema decisions and every
defect found so far).

---

## Resume here

**Nothing is half-finished.** No feature was left mid-implementation, no test was left failing,
and the last full verification was green. This is a clean stopping point rather than an
interrupted one — so resuming means picking up the next item, not reconstructing state.

| | |
|---|---|
| Repository | `main`; pushed through `9e24136`. Confirm with `git status -sb` |
| Last verification | 2026-09-14, from an empty volume, **224 of 224 green** |
| Next action | **TODO 1 — the `auth_service` SECURITY DEFINER review.** It is a decision, not code |
| Blocked on you | 6 decisions below; 1 and 2 gate everything user-facing |

The next action is a human decision rather than an implementation task, which is the single
most important thing to know before starting: picking up TODO 2 (`/auth/login`) without
clearing TODO 1 first means building on a security decision nobody has reviewed. If the
decisions cannot be made, **TODO 4 (`/audit-logs`) is the best unblocked work** — it is
self-contained, needs no decision, and closes a real compliance gap.

---

## Recently landed

**The import loader is committed** at `076d3df` — `src/imports/`, the four `/v1/imports`
endpoints, the `app_platform` SELECT grant, `endpointRateLimit()`, and the contract and
documentation changes that go with them.

A **prototype pollution defect** was found in `src/imports/mapping.ts` while reviewing that
work before committing it, and fixed in the same commit. `target_path` is customer-supplied,
and `assignPath` walked it creating objects as it descended — so `data.__proto__.isAdmin`
wrote to `Object.prototype`. That write is process-wide: it reaches every object in the
process, including requests being served for other tenants at the time, which makes it an
isolation defect under RULE-HSC-02 rather than a hardening nicety. `parseTarget` now refuses
`__proto__`, `prototype` and `constructor` as whole segments, and the payload tree is
null-prototype so the descent is safe independently of its caller. Covered by
`tests/import-mapping.test.mjs`, which needs no database.

`openapi.yaml` then gained a `pattern` on `target_path` (`baa5024`), so the contract
states the grammar instead of leaving a client to discover it by trial. One consequence worth
knowing: an unusable `target_path` is now refused by `validateBody` with code `pattern`
before it reaches the router's own `badTargets` check, which had the friendlier message. The
router check is kept as defence in depth rather than deleted — it is what covers mappings read
back from the database in the worker.

**Verified from an empty volume on 2026-09-14**, which the loader commit could not claim
because the Docker engine was not reachable when it was written — wrongly diagnosed at the
time as Docker not running, see the runbook below. `db:nuke` → `db:migrate` →
`db:seed` → `npm test`: all ten migrations applied to a fresh database, lint clean at 83
tables with 69 of 69 forced and a policy each, and **224 of 224 tests pass** in 23s. That
exercises `20260913120900_import_platform_grant` on a fresh apply rather than against a
database that already had it — which matters here specifically, because a missing
`app_platform` grant is invisible until the sweep runs.

---

## Where the project stands

| | |
|---|---|
| Design documents | 71 files, Phases 1–8, 42 of 45 checklist items |
| Database | 10 migrations, 83 tables, 69 under row-level security |
| API contract | 19 paths in `openapi.yaml` |
| API implemented | 12 of 19 paths |
| Tests | 224, serial, green from an empty volume |

### Implemented

```
[x] GET    /v1/records                    [x] POST   /v1/imports
[x] POST   /v1/records                    [x] GET    /v1/imports/{id}
[x] GET    /v1/records/{id}               [x] GET    /v1/imports/{id}/errors
[x] PATCH  /v1/records/{id}               [x] POST   /v1/imports/{id}/reverse
[x] DELETE /v1/records/{id}
[x] GET    /v1/records/{id}/links
[x] POST   /v1/records/{id}/links
[x] DELETE /v1/records/{id}/links/{link_id}
```

### Not implemented

```
[ ] /auth/login, /auth/refresh, /auth/logout      BLOCKED — see decision 1
[ ] /auth/verify-mfa                              BLOCKED — see decision 1
[ ] /files, /files/{id}/download
[ ] /sync/pull, /sync/push
[ ] /records/{id}/advance
[ ] /webhooks
[ ] /audit-logs
[ ] any user interface at all
```

---

## Getting running again

```bash
npm install
npm run db:up          # postgres 5433, redis-cache 6379, redis-state 6381
npm run db:migrate
npm run db:seed        # 5 plans, 4 system roles, an 'acme' dev tenant
npm test               # 224, serial — the suite MUST NOT run in parallel
```

`npm run db:nuke` destroys the volumes and starts clean. Every commit here is verified from an
empty volume, not just against whatever the local database happens to hold — several of the
recorded defects only appear on a fresh apply.

**Docker Desktop being *running* is not the same as its engine being *ready*.** The processes
come up well before the daemon accepts connections, and in between, `docker compose` fails
with `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified` —
which reads like Docker is not installed. `docker version --format '{{.Server.Version}}'`
is the check that actually means something. This cost a wrong diagnosis on 2026-09-14, and a
commit message went out saying Docker was unavailable when it was merely still starting.

**`db:nuke` reseeds with new UUIDs.** The `acme` tenant and its owner get fresh ids every
time, and `npm run db:seed` prints both. Nothing should be hardcoded against them; if
something breaks right after a nuke with a row simply not found, that is the first thing to
suspect.

---

## TODO, in the order worth doing it

`documents/ROADMAP.md` plans five subsystems that are absent from this list because they were
never specified as endpoints — RBAC administration, tenant provisioning, configuration,
retention and outbound. It proposes one change to the order below: **configuration before
`/audit-logs`**, on the grounds that both are unblocked but nobody can use the twelve existing
endpoints without it. Not yet accepted.

### 1. Clear the `auth_service` SECURITY DEFINER review
**This is the longest-standing blocker in the project and it gates everything user-facing.**

`database/02` open question 4 asks for a security review of the decision to give `auth_service`
a `SECURITY DEFINER` function instead of `BYPASSRLS`. The reasoning was sound — `BYPASSRLS` is a
cluster-wide role attribute and would have exempted the login role from RLS on `records` too —
but the review it asked for has never happened, and `/auth/login` is the path that uses it.

Until this clears, there is no login, and without login there is no user interface.

### 2. Build `/auth/login`, `/refresh`, `/logout`
Specified in `api/01` and already in `openapi.yaml`. Needs decision 2 below (email) resolved,
because authentication is by email address and that implies verification and password reset.

### 3. Generalise the job runner
The loader shipped with a working queue, but an import-shaped one: a Redis Stream consumer
group on the STATE instance carrying a signal, with `import_jobs` as the source of truth.

`IMPLEMENTATION_GAPS.md` Part D argues batch PDF, batch email and bulk export all need the same
substrate. **Generalising what exists is much smaller than starting one**, and doing it before
the second consumer is what stops four features answering the same five questions — retries,
idempotency, visibility, per-tenant fairness, what happens when a scale-in kills a worker — in
four different ways.

### 4. `/audit-logs`
Everything is being recorded and nothing can read it back. A compliance officer currently has no
way to see the audit trail the whole platform is built around. Unblocked, self-contained, and
arguably the highest value per hour of anything on this list.

### 5. `/files`, then file-backed imports
Import currently takes rows inline, bounded at 5,000 per request, because Part B's flow starts
at an uploaded document and `/files` does not exist. A `source_file_id` is **refused** rather
than accepted and ignored. Once `/files` lands, the seam is already there.

### 6. Everything else
`/records/{id}/advance`, `/webhooks`, `/sync/*`, and eventually a UI.

---

## Decisions that need a human

These cannot be resolved by reading the code. Several have been open since 2026-09-01.

| # | Decision | Blocks |
|---|---|---|
| 1 | **`auth_service` SECURITY DEFINER review** (`database/02` OQ4) | `/auth/login`, therefore everything user-facing |
| 2 | **Is email in scope now?** It is a prerequisite of login, not a marketing feature — `api/01` authenticates by email address. A vendor touching PHI needs a **BAA**, which is a procurement lead time rather than a config flag | `/auth/*`, notifications, anything outbound |
| 3 | **The vertical** — clinical healthcare, or workplace health and safety? Does not block the schema; decides the first industry pack, whether PHI is the common case, and the last three checklist items | 6.3 (FHIR), the first industry pack |
| 4 | **`data_audit_log.changed_by`** — an FK to `tenant_users`, so anyone who has ever written cannot be deleted for the six-year retention window, while `user_audit_log.user_email` is denormalised *specifically* to survive user deletion. Both cannot be intended; interacts with GDPR erasure | Tenant offboarding, GDPR erasure |
| 5 | **Are newsletters/announcements a tenant feature or a platform one?** The only item in the register that could reasonably be answered "no" | Scope of C4 |
| 6 | **Should `lint-migrations.mjs` compare the corpus against the migrations?** A documented `CREATE TABLE` with no migration is currently undetectable by any test — that is how the import tables went missing | Nothing; it is prevention |

---

## Traps that have already cost real debugging time

Written down so they are not rediscovered. `db/README.md` has the full defect list; these are
the ones most likely to bite whoever picks this up next.

**The test suite must run serially.** `--test-concurrency=1` is not a preference. The files
share one database and teardown toggles triggers on shared tables. In parallel the symptom is a
*shifting* set of failures, which reads as flakiness and costs a day before it is diagnosed as
concurrency.

**`app_platform` has BYPASSRLS but that is not a table grant.** Three times now a background
task has failed because the role was exempt from every policy on a table it had no privilege to
read. It surfaces as work that silently never happens, not as an error anyone sees — there is no
response code to notice.

**The migration owner is subject to `FORCE ROW LEVEL SECURITY` too.** A query against `records`
as the owner with no tenant GUC set returns **zero rows, not all rows**. A test that sub-selects
from `records` outside a tenant context will pass or fail for reasons unrelated to what it is
testing. This cost a debugging round while writing the import tests.

**Composite foreign keys break teardown in a way that looks like something else.** Both
`record_link_rules` and `import_jobs` hold composite FKs to `record_type_definitions`, so type
definitions cannot be deleted until those rows are gone. Left unhandled it leaves state behind
and makes an unrelated audit assertion fail *intermittently*.

**The reversal guard rests on a schema property, not on application logic.**
`records.updated_at > created_at` distinguishes an edited row from an untouched one only because
`bump_record_version()` is `BEFORE UPDATE` and both columns take `DEFAULT NOW()` — the same
transaction timestamp — on insert. A future `BEFORE INSERT` trigger touching `updated_at` would
make **every** reversal refuse. There is a test asserting the equality directly so it fails
loudly rather than silently.

**`target_path` is customer-supplied and lands in a path walk.** It is constrained now —
by `UNSAFE_SEGMENTS` in `mapping.ts` and by the `pattern` in `openapi.yaml` — but the
shape of the mistake generalises: any field that a customer writes and the platform then uses
to *index into an object* can reach the prototype chain. `/files` will add a second consumer
of these same mappings, and a bulk-export column selector would be a third.

**Piping a long test run through `head` hides its output.** `node --test … | head -60` buffers
and can look exactly like a hang. Redirect to a file instead.

**Never run `prisma migrate dev`.** It regenerates migrations from the model blocks and would
silently drop 69 policies, 12 triggers and 40-odd grants that Prisma's schema language cannot
express. `db/README.md` explains the SQL-first workflow.

---

## Known stale documentation

Not fixed, deliberately, to avoid widening an unrelated diff — but it is wrong and should be
corrected in a pass of its own:

- **`db/README.md` → "Still outstanding"** claims there is no seed data: "no `plans`, no system
  `roles`, and no dev tenant". `npm run db:seed` now produces all three. It also still lists the
  `partner_sandbox` plan as missing, which may or may not still be true. The section appears not
  to have been revisited since seeding landed, so **other claims in it may have drifted too**.
- **`db/README.md` → "Tests"** still says the tests "test the database, not the application —
  there is no application yet". There has been an application since 2026-09-03.
