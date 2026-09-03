# Database

The schema is **SQL-first**. `prisma/migrations/*/migration.sql` is the source of truth;
Prisma generates the typed client from the live database and does not own the schema.

## Status

**The schema runs and the tests pass.** All eight migrations apply cleanly from an empty
database, and the 44 assertions in `tests/` pass — verified twice from a freshly recreated
volume, serially.

```
npm run db:up        # docker compose up -d
npm run db:migrate   # prisma migrate deploy
npm test             # 44 pass, 0 fail
```

The stack is Docker Compose: PostgreSQL 17.6 on **5433** (5432 is taken by a native
install on this machine) plus the two Redis instances `performance/01` requires, all bound
to `127.0.0.1` only. Container credentials are development-only and deliberately in the
compose file; nothing in it is a real secret.

### Still outstanding

- **No seed data.** `permissions` and `app_scopes` are seeded by migrations, but there are
  no `plans`, no system `roles`, and no dev tenant — the database comes up empty and is
  not manually explorable. The `partner_sandbox` plan row that `partners/01` requires is
  among the missing. Tests build their own fixtures, so this blocks exploration, not CI.
- **`prisma db pull` has not been run**, so `schema.prisma` still has no model blocks and
  no typed client exists. This is the next hard blocker for any application code.
- **The `deepmerge-ts` override** (`package.json`) forces a transitive dependency past a
  major version. `prisma validate` and eight migrations pass through it, but config paths
  those do not exercise remain untested.
- **`data_audit_log.changed_by` is an open design question** — see defect 13 below. Not a
  bug to fix blindly; it needs a decision.

### The suite must run serially

`npm test` passes `--test-concurrency=1`. The four files share one database and teardown
toggles triggers on shared tables; run in parallel they race, and the symptom is a
*shifting* set of failures rather than a consistent one. Two debugging rounds were spent
on noise from this before it was diagnosed.

### What tests cannot cover

Teardown suppresses the audit triggers to delete its fixtures. It has to: with the
triggers live there is **no ordering that works**, because deleting from an audited table
writes fresh audit rows, and `data_audit_log` holds foreign keys to both `tenants` and
`tenant_users`. That is the design succeeding, not failing — production never hard-deletes
a tenant (`database/01` soft-deletes via `deleted_at`). It does mean the delete path is
exercised only with auditing off, so audit-on-delete behaviour is untested.


## Why not Prisma-first

Counted across `documents/healthcare/database/`, `api/` and `partners/`, the schema uses:

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
npm test                    # 44 assertions, serial

npm run lint:migrations     # static checks, no database needed
npm run db:pull             # introspect into schema.prisma (not yet run)
npm run db:nuke             # destroy volumes and start clean
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

`tests/` asserts the boundaries the schema exists to enforce. They test the **database**,
not the application — there is no application yet. `infrastructure/02` writes the same
tests against a Prisma `withTenantContext` helper; these use `pg` directly, which is what
that helper would wrap.

| File | Asserts |
|---|---|
| `schema-invariants.test.mjs` | Catalogue-level: every `tenant_id` table has RLS enabled *and* forced, every RLS table has a policy, `partner_portal_user` holds no grant on tenant data, audit tables are append-only and partitioned with a composite PK |
| `tenant-isolation.test.mjs` | Cross-tenant reads and counts, forged `tenant_id` on write, cross-tenant links, the pooled-connection GUC leak, fail-closed with no context |
| `audit.test.mjs` | Trigger fires on `records`, `tenant_users` and `files` (fault 1), no-op updates write nothing, credentials masked, immutability under both `app_user` and the owner, actor attribution including `app_id` |
| `partner-isolation.test.mjs` | Partner axis: own apps only, own installs only, own usage only, and no privilege at all on tenant tables |

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
PostgreSQL manual, **not** by running it (see LIMITATIONS above). Recorded so they are not
rediscovered, and so they can be confirmed once the schema is applied:

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

Items 1–4, 8 and 9 are new; 5–7 are corrections to documented claims; 10–13 were found by
executing the schema, and 14 in the application layer. Defects 8–14 were observed. Defects 1–7 were reasoned from the
manual, and 1–4 were confirmed correct when the migrations applied first try.

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
| `partner_sandbox` plan | seed data — **not yet written** | `partners/01` |
| `phi_class` annotations | `form_versions.schema` convention | `analytics/01` |
| `{system, code, display}` | `form_versions.schema` convention | `interoperability/01` |
