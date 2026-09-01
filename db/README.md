# Database

The schema is **SQL-first**. `prisma/migrations/*/migration.sql` is the source of truth;
Prisma generates the typed client from the live database and does not own the schema.

## LIMITATIONS — read this first

**Nothing in this directory has ever been executed.** As of the last commit, no migration
has been applied to any database and no test has passed. PostgreSQL 17.6 is installed and
running locally, but `pg_hba.conf` requires `scram-sha-256` and no credential is available
to the tooling, so the whole stack below is verified only by static analysis.

What that means concretely:

| Artefact | Verified by | Not verified |
|---|---|---|
| 8 migrations, 79 tables | `npm run lint:migrations` — forward references, `$$` balance, RLS checklist | That PostgreSQL accepts a single statement |
| 38 tests across 4 files | `node --check`, and all four reaching the credential check | That any assertion is correct |
| 8 documented defects | Reasoning against the PostgreSQL manual | Only #8 was observed (by the lint) |

### To resume

```
psql -U postgres -c "CREATE ROLE hsc_owner LOGIN CREATEROLE PASSWORD 'devpassword'; CREATE DATABASE hsc_dev OWNER hsc_owner;"
printf 'DATABASE_URL="postgresql://hsc_owner:devpassword@localhost:5432/hsc_dev?schema=public"\n' > .env
npm run db:migrate && npm test
```

Expect failures on the first run. Work through them in this order — a migration failure
invalidates every test downstream of it, so there is no point reading test output until
`db:migrate` is clean.

### Known-suspect assertions

These were written from the manual rather than from observation, and are the most likely
to be wrong in the test rather than in the schema:

1. **`a write cannot forge another tenant_id`** (`tenant-isolation`). Relies on a
   `FOR ALL` policy applying its `USING` expression as `WITH CHECK` when the latter is
   omitted. Believed correct, but if this fails the fix is probably an explicit
   `WITH CHECK` on every policy — a schema change, not a test change, and a real gap if so.
2. **`42501` error codes** (`partner-isolation`). A missing table privilege may surface
   with a different SQLSTATE than the one asserted. If these fail, check the actual code
   before assuming the grant is wrong.
3. **`even the owner cannot UPDATE an audit row`** (`audit`). Asserts the statement-level
   trigger fires for the table owner. If the owner turns out to bypass it, audit
   immutability is weaker than `database/04` claims and needs rethinking.
4. **The `audit_append` policy** (`0005`). Resolves the `SECURITY DEFINER` / `FORCE RLS`
   deadlock (defect 3 below) by granting the migration owner `INSERT` on `data_audit_log`.
   If the deadlock analysis is wrong, this policy is unnecessary — harmless, but it should
   then be removed rather than left as cargo.
5. **Partition coverage.** `0005` creates partitions from three months back to thirteen
   months forward. Tests inserting audit rows outside that window land in the DEFAULT
   partition and still pass, so the window itself is untested.

### Also outstanding

- **No seed data.** `permissions` and `app_scopes` are seeded by migrations, but there are
  no `plans`, no system `roles`, and no dev tenant — the database comes up empty and is
  not manually explorable. The `partner_sandbox` plan row that `partners/01` requires is
  among the missing.
- **`prisma db pull` has never run**, so `schema.prisma` has no model blocks and no
  Prisma client has been generated. Nothing can query this schema through Prisma yet.
- **The `deepmerge-ts` override** (`package.json`) forces a transitive dependency past a
  major version. `prisma validate` passes, but config-loading paths not exercised by that
  command are untested. First thing to suspect if Prisma misbehaves around config.


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
cp .env.example .env          # fill in PGSUPERPASS and pick a password for the owner role
npm install
npm run db:create             # create database + owner role
npm run db:migrate            # prisma migrate deploy
npm run db:pull               # introspect into schema.prisma
npm run db:generate           # generate the client
npm run lint:migrations       # static checks, no database needed
npm test                      # the suite below, needs a migrated database
```

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

Items 1–4 and 8 are new; 5–7 are corrections to documented claims.

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
