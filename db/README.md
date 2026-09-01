# Database

The schema is **SQL-first**. `prisma/migrations/*/migration.sql` is the source of truth;
Prisma generates the typed client from the live database and does not own the schema.

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
node scripts/lint-migrations.mjs
```

`npm run db:reset` drops and recreates. It refuses to run against a database whose name
does not contain `dev` or `test`.

## Defects found by executing the documented DDL

The specification documents were written against SQL that had never been run. These are
the failures that only appear on execution, recorded so they are not rediscovered:

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
