# Database

The schema is **SQL-first**. `prisma/migrations/*/migration.sql` is the source of truth;
Prisma generates the typed client from the live database and does not own the schema.

## Status

**The schema runs and the tests pass.** All eleven migrations apply cleanly from an empty
database and the tests in `tests/` pass — verified from a freshly recreated volume, serially,
on **2026-09-22: 230 of 230 green**.

That run also settled two things about migration 0011 that static checks could not. `GRANT
auth_definer TO <owner>` is usable by the `ALTER FUNCTION … OWNER TO` in the same transaction,
so the migration needed no splitting. And the live catalogue was inspected directly rather than
inferred from the migration having run: `auth_resolve_login` is owned by `auth_definer`, which
holds neither `SUPERUSER` nor `BYPASSRLS`, with `search_path=public, pg_temp`, three `SELECT`
grants and three `FOR SELECT` policies and nothing else.

**It also disproved the finding that produced 0011 as originally written** — see defect 16,
and defect 18 for what that turned into.

```
npm run db:up        # docker compose up -d
npm run db:migrate   # prisma migrate deploy
npm run db:seed      # 5 plans, 4 system roles, an 'acme' dev tenant
npm test             # 230 pass, 0 fail
```

`npm run lint:migrations` needs no database and re-derives the shape of the schema —
currently 11 migrations, 83 tables, 61 tenant-scoped, 69 with RLS enabled, forced and
policied. Prefer running it over quoting the counts below, which are the ones that drift.

Migration 0009 was added later than the rest and for a different reason: `database/07`
Part B specified tenant data import in full and **its tables were never extracted**, which
no test could detect — `schema-invariants` asserts properties of the tables that exist, and
a table never created has no properties to assert. The rest of Phase 1 was audited for the
same gap and is clean. See `documents/healthcare/IMPLEMENTATION_GAPS.md` Part F.

The stack is Docker Compose: PostgreSQL 17.6 on **5433** (5432 is taken by a native
install on this machine) plus the two Redis instances `performance/01` requires, all bound
to `127.0.0.1` only. Container credentials are development-only and deliberately in the
compose file; nothing in it is a real secret.

### Still outstanding

> Revised 2026-09-22. The first two entries had been wrong since `5d65c7e` (2026-09-01) —
> the commit that closed them was the one that should have edited this list. Both are kept
> below as struck records rather than deleted, because a list that silently loses entries
> gives no reason to trust the ones still on it.

- **The `deepmerge-ts` override** (`package.json`) forces a transitive dependency past a
  major version. `prisma validate` and all eleven migrations pass through it, but config paths
  those do not exercise remain untested.
- **`data_audit_log.changed_by` is an open design question** — see defect 13 below. Not a
  bug to fix blindly; it needs a decision. Still open, and now tracked as decision 4 in
  `documents/STATUS_AND_TODO.md`.
- **`FORCE ROW LEVEL SECURITY` is inert on the Docker stack**, because its owner role is a
  superuser — defect 18. Not a patch; it needs a decision about the dev stack.

**Closed, and recorded so the correction is visible:**

- ~~The `auth_service` `SECURITY DEFINER` security review (`database/02` OQ4).~~ **Reviewed
  2026-09-22; the deviation is approved.** `BYPASSRLS` is a cluster-wide role attribute and
  cannot be scoped to `tenant_users` as database/02 asks (defect 5), so granting it would have
  exempted the login role from RLS on all 69 RLS tables. The `SECURITY DEFINER` function is a
  fixed query returning seven columns for one `(subdomain, email)` pair, executable only by
  `auth_service`, and it filters on the subdomain — so it is not a cross-tenant email oracle.
  The review found the function could never return a row (defect 16) and one hardening gap
  (defect 17); 0011 fixes the first and half of the second. **`EXECUTE` on this function is
  equivalent to reading any user's password hash in any tenant given a subdomain and an email,
  so the grant surface must stay exactly as narrow as it is.**

- ~~No seed data.~~ Closed by `5d65c7e` (2026-09-01). `npm run db:seed` produces 5 plans —
  `partner_sandbox` among them, so the `partners/01` requirement is met — 4 system role
  templates with their permission grants, and an `acme` dev tenant carrying a configuration
  row, a subscription, two record type definitions, an owner user and that user's role
  assignment. **`db:seed` reseeds with fresh UUIDs after a `db:nuke`**, so nothing should be
  hardcoded against the ids it prints.
- ~~`prisma db pull` has not been run.~~ Also closed by `5d65c7e`. `schema.prisma` now holds
  79 generated model blocks, and its header carries the warning against `prisma migrate dev`.
  The claim that this was "the next hard blocker for any application code" was wrong in its
  own right: the application that arrived on 2026-09-03 uses `pg` directly and does not
  depend on the generated client at all.

### The suite must run serially

`npm test` passes `--test-concurrency=1`. The test files share one database and teardown
toggles triggers on shared tables; run in parallel they race, and the symptom is a
*shifting* set of failures rather than a consistent one. Two debugging rounds were spent
on noise from this before it was diagnosed. The count has grown from four files to sixteen
since that was written, which makes the flag more load-bearing rather than less.

A related trap, since it presents the same way: `node --test … | head -N` buffers, and a
full passing run behind a pipe looks exactly like a hang. Redirect to a file instead.

### What tests cannot cover

Teardown suppresses the audit triggers to delete its fixtures. It has to: with the
triggers live there is **no ordering that works**, because deleting from an audited table
writes fresh audit rows, and `data_audit_log` holds foreign keys to both `tenants` and
`tenant_users`. That is the design succeeding, not failing — production never hard-deletes
a tenant (`database/01` soft-deletes via `deleted_at`). It does mean the delete path is
exercised only with auditing off, so audit-on-delete behaviour is untested.


## Why not Prisma-first

Counted across the **design documents** — `documents/healthcare/database/`, `api/` and
`partners/` — as they stood when the decision was taken. These are not counts of
`prisma/migrations/`, and should not be read as current: the migrations have since grown to
69 RLS tables and 14 triggers, and `npm run lint:migrations` is what reports the live figures.
The argument does not turn on the numbers, only on the column at the right.

| Feature | Count | Prisma schema language |
|---|---|---|
| `ENABLE` / `FORCE ROW LEVEL SECURITY` | 65 tables | Cannot express |
| `CREATE POLICY` | 65 | Cannot express |
| Role grants | 40+ | Cannot express |
| Partial indexes (`WHERE …`) | ~76 | Cannot express |
| `CHECK` constraints | 20+ | Cannot express |
| plpgsql triggers and functions | 12 | Cannot express |
| Declarative range partitioning | 3 tables | Cannot express |
| Generated columns | 1 | Limited |

Tenant isolation, audit immutability and the partner-portal boundary all live in that
column. A Prisma-first workflow regenerates migrations from the model blocks and would
silently drop every one of them — which `RULE-HSC-02` classes as a compliance defect
rather than a bug. `database/07_DATA_MIGRATION_WORKFLOWS.md` already assumes
`prisma migrate deploy`, so the migration *runner* is unchanged; only authorship moves.

## Layout

```
prisma/
  schema.prisma                     datasource + generator only; models are generated
  migrations/
    20260901120000_extensions_and_roles/    roles, tenant-context helpers
    20260901120100_tenant_management/       tenants, plans, subscriptions, invoices
    20260901120200_user_auth/               users, RBAC, sessions, MFA, SSO
    20260901120300_business_entity/         records, forms, type registry, links
    20260901120400_audit_compliance/        audit logs (partitioned), retention, DSR
    20260901120500_file_document/           files, versions, variants, shares
    20260901120600_api_layer/               API keys, webhooks, outbox, integrations
    20260901120700_partner_ecosystem/       partners, apps, consent, marketplace, payouts
    20260911120800_tenant_data_import/      import jobs, mappings, staging, row errors
    20260913120900_import_platform_grant/   app_platform SELECT, for the import sweep
    20260922121000_auth_resolve_login_definer/  auth_definer owns the login lookup
scripts/
  db-create.mjs                     creates the dev database and owner role
  lint-migrations.mjs               static checks; encodes database/07's per-table checklist
```

## Roles

| Role | Purpose | RLS |
|---|---|---|
| *(migration owner)* | Owns objects, runs migrations | Subject to `FORCE` |
| `app_user` | The request path | Subject to every `tenant_isolation` policy |
| `app_platform` | Background workers that legitimately cross tenants — webhook delivery sweep, usage rollups, retention purge, backfills | `BYPASSRLS`; **never** used on the request path |
| `partner_portal_user` | The partner portal | Isolated on `partner_id`, not `tenant_id`. No grant on any tenant table |
| `auth_service` | Login lookup only | No `BYPASSRLS`; reaches `auth_resolve_login()` and nothing else |

## Tenant context

Policies read `app.current_tenant_id`. Set it with `set_tenant_context(...)`, which uses
`set_config(..., true)` — the transaction-local form.

This is not a style preference. A session-scoped `SET` survives a pooled connection being
returned to the pool, so the next request inherits the previous request's tenant — a
cross-tenant read with no error raised anywhere (`database/08`). Transaction-local is
reverted at `COMMIT`, which is what makes pooling safe.

## Usage

```bash
npm install
cp .env.example .env        # or write the compose values, see below
npm run db:up               # postgres + both redis instances
npm run db:migrate          # prisma migrate deploy
npm run db:seed             # plans, system roles, the 'acme' dev tenant
npm test                    # 230 tests, serial

npm run lint:migrations     # static checks, no database needed
npm run db:pull             # re-introspect into schema.prisma after a new migration
npm run db:nuke             # destroy volumes and start clean — reseeds with NEW UUIDs
```

For the compose stack, `.env` wants:

```
DATABASE_URL="postgresql://hsc_owner:hsc_dev_password@localhost:5433/hsc_dev?schema=public"
REDIS_CACHE_URL="redis://localhost:6379"
REDIS_STATE_URL="redis://localhost:6381"
```

`db:create:native` is the alternative path for a natively-installed PostgreSQL rather
than the container; it needs a superuser password in `PGSUPERPASS`.

`npm run db:reset` drops and recreates. It refuses to run against a database whose name
does not contain `dev` or `test`.

## Tests

`tests/` asserts the boundaries the schema exists to enforce. **There has been an application
since 2026-09-03**, and the suite has grown with it: the four schema files below were the whole
suite when this section was written, and there are now sixteen. `infrastructure/02` writes the
same tests against a Prisma `withTenantContext` helper; these use `pg` directly, which is what
that helper would wrap.

The four that test the **database** itself, which is what this README is about:

| File | Asserts |
|---|---|
| `schema-invariants.test.mjs` | Catalogue-level: every `tenant_id` table has RLS enabled *and* forced, every RLS table has a policy, `partner_portal_user` holds no grant on tenant data, audit tables are append-only and partitioned with a composite PK |
| `tenant-isolation.test.mjs` | Cross-tenant reads and counts, forged `tenant_id` on write, cross-tenant links, the pooled-connection GUC leak, fail-closed with no context |
| `audit.test.mjs` | Trigger fires on `records`, `tenant_users` and `files` (fault 1), no-op updates write nothing, credentials masked, immutability under both `app_user` and the owner, actor attribution including `app_id` |
| `partner-isolation.test.mjs` | Partner axis: own apps only, own installs only, own usage only, and no privilege at all on tenant tables |

The remaining eleven test the application over that schema, and are documented with it rather
than here: `api-caching`, `api-contract`, `api-idempotency`, `api-imports`, `api-isolation`,
`api-phi-audit`, `api-ratelimit`, `api-record-detail`, `api-record-links`, `safe-logging` and
`import-mapping`. The last two need no database.

`auth-login-lookup.test.mjs` sits between the two groups: it tests the database boundary the
login path depends on, and is listed here because defect 16 is a schema defect rather than an
application one.

Three of these are regression tests for defects the documents recorded but nothing had
ever executed:

- **`writing tenant_users produces an audit row`** and **`writing files produces an audit
  row`** — fault 1. Before the `TG_ARGV[0]` fix both tables were unwritable, failing with
  `record "new" has no field "record_id"`.
- **`a write with no request context does not abort`** — fault 2. `current_setting`
  without `missing_ok` aborted every background job, migration and psql write.
- **`tenant context does not leak across a pooled connection`** uses a pool of exactly
  one, because with a normal pool the two requests probably land on different connections
  and the test passes while the bug is present.

The catalogue tests in `schema-invariants` are the ones that earn their keep over time:
they catch a *future* migration that adds a tenant table and forgets its policy, which is
otherwise found in production by the wrong person.

## Defects found while extracting the documented DDL

The specification documents were written against SQL that had never been run. These are
failures that would only appear on execution — found by reading the DDL against the
PostgreSQL manual, **not** by running it (see "What tests cannot cover" above). Recorded so
they are not rediscovered, and so they can be confirmed once the schema is applied:

1. **`to_tsvector('english', …)` in a generated column is rejected.** The two-argument
   text form is `STABLE`; a generation expression must be `IMMUTABLE`. Needs
   `'english'::regconfig`. `records.search_vector` in `DATABASE_SCHEMA.md` cannot be
   created as written.
2. **`(data ->> 'date_of_birth')::DATE` likewise.** Text-to-date casting depends on
   `DateStyle`. `database/03` hedges that it "is only immutable for a fixed input
   format"; the planner does not accept hedges. `to_date(…, 'YYYY-MM-DD')` works.
3. **`SECURITY DEFINER` + `FORCE ROW LEVEL SECURITY` deadlock.** `database/04` specifies
   both, with `tenant_isolation` declared only `FOR app_user`. `FORCE` subjects the owner
   to RLS, and a policy naming one role does not apply to another — so the audit trigger
   matches no policy and every audited write fails. Resolved with an append-only policy
   for the function owner.
4. **`SELECT … INTO NEW.tenant_id` is not valid plpgsql.** `INTO` targets must be plain
   variables. `database/03`'s `enforce_record_link_rule()` would not compile.
5. **`BYPASSRLS` cannot be scoped to one table.** `database/02` describes granting it
   "on `tenant_users` alone"; it is a cluster-wide role attribute. Taking that route would
   have exempted `auth_service` from RLS on every table including `records`. Implemented
   as the `SECURITY DEFINER` alternative its own OQ4 offers.
6. **Retention cannot bypass the immutability triggers by running as the owner.**
   `database/04` says it can; triggers fire regardless of role. It does not matter,
   because the designed path is `DROP PARTITION`, which fires no `DELETE` trigger — but
   a `DELETE`-based purge would have failed in production.
7. **A partitioned table needs the partition key in its primary key**, so all three audit
   logs take `(audit_id, timestamp)`. Noted in `database/04`, and easy to miss.
8. **`app_usage_daily` had no RLS** while `partner_portal_user` held `SELECT` on it —
   every partner could read every other partner's install counts and PHI read volumes.
   Caught by `lint-migrations.mjs`, not by reading.
9. **The `roles` policy permitted tenant escalation.** `USING` allows `tenant_id IS NULL`
   so system role templates are readable by all tenants; PostgreSQL reuses `USING` as
   `WITH CHECK` when the latter is omitted, so any `app_user` could have *inserted* a
   platform-wide system role. The only asymmetric policy of the 65. Found while resolving
   a test assertion flagged as suspect.

10. **The no-op audit guard was dead code.** `database/04`'s trigger skips writing an
    audit row when nothing changed; `database/03`'s `bump_record_version()` fires BEFORE
    UPDATE and always sets `updated_at` and `version`. Neither document is wrong alone —
    together the guard could never fire, and every touch of a record wrote an audit row.
    Mechanical columns are now excluded from the comparison.
11. **Audit rows written in one transaction were unorderable.** `NOW()` is transaction
    start time, so every row from a single transaction carried an identical timestamp,
    and there is no sequence column. "Which change came first?" was unanswerable — for an
    audit trail, a real gap. The trigger now writes `clock_timestamp()`.
12. **Partitions do not inherit RLS.** All 51 audit partitions have `relrowsecurity =
    false`. Not exploitable: `app_user` holds no grant on any partition and a direct read
    is refused. But the only thing preventing a full cross-tenant audit leak is the
    *absence of a grant*, so a test now asserts that grant surface — a future
    `GRANT ... ON ALL TABLES IN SCHEMA public` would look harmless and open everything.
13. **The audit trail makes tenants and users genuinely undeletable — and one FK
    contradicts its own schema.** There is no ordering of deletes that succeeds while the
    audit triggers are live, because deleting from an audited table writes fresh audit
    rows. For `tenants` that is correct and intended (`database/01` soft-deletes via
    `deleted_at`). For **users it is contradictory**: `data_audit_log.changed_by` is a
    foreign key to `tenant_users`, so a user who has ever written anything cannot be
    deleted for the six years their audit history is retained — while
    `user_audit_log.user_email` is denormalised specifically "so it survives user
    deletion". Both cannot be intended. **Left as-is pending a decision**, because it
    interacts with GDPR erasure, which `database/04` resolves by anonymising rather than
    deleting. The equivalent FK on `app_id` was dropped for exactly this reason.

14. **A PostgreSQL error object leaks the offending column value.** `console.error(err)`
    on a constraint violation prints `detail: Key (mrn)=(…) already exists`, and `database/03`
    puts a UNIQUE index on `gc_mrn` — so a duplicate patient write printed a medical record
    number to stdout, and from there to CloudWatch: outside the audit trail, outside the
    retention policy, outside the BAA boundary. `observability/01` identified this class of
    leak and prescribed an allowlist rather than a denylist, because three fields carry row
    contents (`detail`, `where`, `internalQuery`) and a denylist written today would likely
    have caught only the first. Found by constructing a real error and printing it, not by
    reading the code — `console.error(msg, err)` looks entirely reasonable.

15. **The retention policy `database/07` requires for import data could not be expressed.**
    Part B is explicit that `import_row_errors.source_row` — the raw failed row, PHI when
    the import is a patient list — needs a retention policy, "because keeping failed rows
    indefinitely creates a second, unmanaged copy of regulated data". But `retention_scope`
    is `('record_type', 'file', 'audit_log')`, and none of the three covers import data, so
    the instruction was unimplementable as written. Migration 0009 adds `'import_data'`.
    Found by trying to satisfy the requirement rather than by reading either document —
    each is internally consistent, and the gap is only visible where they meet.

    Worth knowing for the next enum change: `ALTER TYPE … ADD VALUE` is legal inside
    Prisma's transaction wrapper on PostgreSQL 12+, but the new value **cannot be used in
    the same transaction**. Nothing in 0009 uses it, so it applies. A migration that also
    inserted a policy row using the new value would fail.

16. **`auth_resolve_login()` worked or returned nothing depending on how the database was
    provisioned.** Found by the `database/02` OQ4 security review on 2026-09-22, not by a test,
    because nothing calls the function and nothing covered it.

    `tenant_users`, `tenants` and `mfa_methods` are all `ENABLE` + `FORCE ROW LEVEL SECURITY`
    and the only policy on each is `tenant_isolation … FOR ALL TO app_user`. A `SECURITY
    DEFINER` function executes as its owner, and the owner was whichever role applied 0002 —
    so the outcome turned on whether that role was a superuser:

    | Provisioning path | Owner | Result |
    |---|---|---|
    | `docker-compose.yml` (`POSTGRES_USER: hsc_owner`) | **SUPERUSER** | Bypasses RLS entirely. The lookup worked |
    | `scripts/db-create.mjs` (`db:create:native`) | `CREATEROLE` only | Subject to `FORCE`, matches no policy, **zero rows for every input** |

    **The review first recorded this as a flat "could never return a row", which was wrong** —
    it was checked against the catalogue rather than against a running database, and the
    running database is the superuser one. The correction matters in both directions: the
    defect is real, but it is a works-here-fails-there difference rather than a dead function,
    and that is the more dangerous shape. The Roles table above documents the intended owner as
    "Subject to `FORCE`", which is the failing configuration.

    **Related to fault 4 / defect 3**, which fixed the same deadlock for the audit trigger by
    giving its owner a narrow policy. The pattern worth naming: *any* `SECURITY DEFINER`
    function here needs its owner to match a policy on every table it touches — or to be a
    superuser, which is not something to rely on. Both failures are silent: no error, just an
    empty result.

    **The suite could not have caught it, and still could not.** `schema-invariants` asserts
    that `relforcerowsecurity` is *set*; nothing asserts that `FORCE` has any *effect*. Against
    a superuser-owned database it has none, so every owner-path RLS assertion in the suite is
    vacuous there.

    Fixed by 0011, which gives the function a dedicated `auth_definer` owner — a plain role,
    no superuser, no `BYPASSRLS` — holding `SELECT` on exactly those three tables with three
    `FOR SELECT` policies. The point is that it now reads **by policy rather than by bypass**,
    so it behaves identically under both provisioning paths. Owner policies would have been
    cheaper and were rejected: they would have widened owner access on the native path while
    changing nothing on the Docker one.

    `tests/auth-login-lookup.test.mjs` asserts a real user resolves to exactly one row, and —
    the assertion that actually holds the line — that the function's owner is neither a
    superuser nor a `BYPASSRLS` role.

17. **Both `SECURITY DEFINER` functions had an unsafe `search_path`.** PostgreSQL searches the
    temporary schema first for relations when `pg_temp` is not listed, so a session able to
    create temp objects can shadow a table a definer function reads. `auth_resolve_login()` set
    `search_path = public`, omitting it; 0011 now sets `public, pg_temp`.

    **The audit trigger function (0004) sets no `search_path` at all, and is NOT fixed.** It
    inserts into `data_audit_log` and calls `mask_sensitive()`, `current_actor_id()`,
    `current_app_id()` and `current_installation_id()`, all unqualified, and `TEMP` on the
    database has never been revoked from `PUBLIC`. Shadowing `data_audit_log` there would
    redirect audit writes — audit evasion, which `RULE-HSC-02` classes as a compliance defect.

    **Not reachable from the API today**, and the severity claim rests on that: every query in
    `src/` is parameterised and role names go through the closed set in `src/db/context.ts`,
    so there is no way to execute arbitrary SQL. This is defence in depth — it is what turns a
    future SQL-injection read bug into audit evasion plus owner-privileged execution. Left
    open deliberately rather than folded into 0011, because it is a different function, a
    different migration and a different blast radius from the one OQ4 asked about.

18. **`FORCE ROW LEVEL SECURITY` is inert in the environment the test suite runs against.**
    The generalisation of 16, and the larger half of it. `docker-compose.yml` sets
    `POSTGRES_USER: hsc_owner`, and the postgres image creates that role as a **SUPERUSER**.
    Superusers bypass row-level security entirely, so on the Docker stack `FORCE` constrains
    nobody — while `scripts/db-create.mjs` provisions the same logical role with `CREATEROLE`
    and nothing else, where `FORCE` does constrain it.

    The Roles table above says the migration owner is "Subject to `FORCE`". On the path
    everything is actually developed and tested against, it is not.

    Why it matters beyond the login function: `FORCE` is the control that stops a connection
    holding the owner's credentials from reading across tenants, which is a `RULE-HSC-02`
    guarantee. Every test that exercises an owner-side RLS boundary passes on the Docker stack
    whether or not that boundary exists, and `schema-invariants` checks only that the *flag* is
    set. A genuine owner-path isolation defect would ship green.

    **Not fixed, and it is a decision rather than a patch.** Making the compose owner a
    non-superuser means migration 0001 still needs `CREATEROLE`, the seed and teardown paths
    need reviewing for anything that silently relied on bypass, and `db:nuke` has to keep
    working from empty. That is its own piece of work. Recorded here so the next person does
    not read a green suite as evidence that owner-side isolation holds.

Items 1–4, 8 and 9 are new; 5–7 are corrections to documented claims; 10–13 were found by
executing the schema, 14 in the application layer, and 15 by implementing a requirement
that spanned two documents. Defects 8–15 were observed. Defects 1–7 were reasoned from the
manual, and 1–4 were confirmed correct when the migrations applied first try.

16–18 were found by the OQ4 security review. 16 was **first recorded wrongly** — reasoned
from the catalogue, as 1–7 were, and stated as "the function can never return a row" without
running it. The empty-volume run on 2026-09-22 disproved that: the function returned a row,
because the owner on the Docker stack is a superuser. Correcting it produced 18, which is the
more serious finding of the two. The lesson is the one 1–7 were careful about and this review
was not: **a claim about RLS behaviour reasoned from the catalogue is a hypothesis until it is
executed**, because the catalogue does not show you who is exempt.

They share the other lesson with 15: each was invisible because the thing that would have
noticed it did not exist. Nothing called `auth_resolve_login()`, and nothing asserts that
`FORCE` has an effect rather than merely being set.

## Amendments folded in

Nine schema additions had accumulated across Phases 4–8. Seven are DDL and are applied in
the migration that owns the table; two are JSONB conventions, documented at
`form_versions.schema` rather than added as columns.

| Addition | Where | Source |
|---|---|---|
| `config_version` | `tenant_configurations` | `performance/01` |
| `invoice_line_items` | new table | `partners/03` |
| `sessions.last_mfa_at` | `sessions` | `infrastructure/05` |
| `sessions.impersonated_by` | `sessions` | `experience/02` |
| `apps:install` permission | `permissions` seed | `partners/02` |
| `app_id` / `installation_id` | both audit tables | `partners/02` |
| `partner_sandbox` plan | `scripts/seed.mjs` — written, not public, carries real limits | `partners/01` |
| `phi_class` annotations | `form_versions.schema` convention | `analytics/01` |
| `{system, code, display}` | `form_versions.schema` convention | `interoperability/01` |
