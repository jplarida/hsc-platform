# 08 — Database Scaling Architecture

**Phase 1.1 deliverable** ("Implementation Diagrams") · Sources: `ARCHITECTURE_DESIGN.md`, `TECH_STACK_PLAN.md`, `ENHANCEMENT_OPPORTUNITIES.md`, ERD docs 01–07
**Status:** Draft for review

Covers connection pooling, read replicas, the scaling ladder from one instance to sharding, and
database monitoring and alerting.

---

## The landmine: connection pooling breaks RLS unless the tenant GUC is transaction-scoped

This is the single highest-severity item in this document, and it is invisible until it causes a
cross-tenant data leak in production.

Tenant isolation depends on `current_setting('app.current_tenant_id')`. That value is set on a
**connection**. `ARCHITECTURE_DESIGN.md` calls for 2–20 auto-scaling API tasks against RDS
PostgreSQL, which requires a connection pooler — and a pooler hands the same physical connection
to different requests, for different tenants, in sequence.

```mermaid
sequenceDiagram
    participant A as Request<br/>(Tenant A)
    participant P as PgBouncer<br/>(transaction mode)
    participant DB as PostgreSQL<br/>connection #7

    A->>P: BEGIN
    P->>DB: SET app.current_tenant_id = 'A'
    Note over DB: session GUC persists<br/>beyond the transaction
    A->>DB: SELECT * FROM records
    DB-->>A: Tenant A rows
    A->>P: COMMIT
    Note over P: connection #7 returned to pool

    participant B as Request<br/>(Tenant B)
    B->>P: BEGIN
    P->>DB: (reuses connection #7)
    Note over DB: app.current_tenant_id<br/>is STILL 'A'
    B->>DB: SELECT * FROM records
    DB-->>B: Tenant A rows ❌
```

If the application ever fails to set the GUC — an early return, an exception path, a background
job, a code path that forgot — the previous tenant's value is still in place and RLS silently
enforces the *wrong* tenant. The query succeeds. Nothing errors. The wrong data is returned.

**The fix is `SET LOCAL` inside an explicit transaction.** `SET LOCAL` is scoped to the
transaction and is discarded at `COMMIT` or `ROLLBACK`, so a connection returned to the pool
carries no tenant context at all:

```sql
BEGIN;
SET LOCAL app.current_tenant_id = '...';
SET LOCAL app.current_user_id   = '...';
-- queries
COMMIT;
```

Two further defences, both cheap:

```sql
-- 1. Default the GUC to a value that matches nothing, so a missed SET LOCAL returns zero rows
--    instead of the previous tenant's rows.
ALTER DATABASE hsc SET app.current_tenant_id = '00000000-0000-0000-0000-000000000000';

-- 2. Make the policy fail closed if the setting is absent entirely, rather than raising a
--    confusing undefined_object error deep inside a query.
CREATE POLICY tenant_isolation ON records FOR ALL TO app_user
    USING (tenant_id = COALESCE(
        NULLIF(current_setting('app.current_tenant_id', TRUE), '')::UUID,
        '00000000-0000-0000-0000-000000000000'::UUID));
```

In Prisma this means every tenant-scoped operation runs inside `prisma.$transaction()` with the
`SET LOCAL` issued as the first statement — not a connection-level hook, not middleware that sets
it once. This constraint should be enforced by a single repository wrapper that no query path can
bypass, and covered by a test that runs two tenants' queries through one pooled connection and
asserts isolation.

`DATABASE_SCHEMA.md` specifies the policies but never says how the GUC is set. That gap is the
defect; the policies themselves are correct.

---

## Connection pooling

### Sizing

Postgres connections are processes, not threads: each costs several MB of RSS and contends on
shared structures. RDS `max_connections` scales with instance memory (roughly
`DBInstanceClassMemory / 9531392`), giving ~410 on `db.t3.medium`, ~1600 on `db.m5.xlarge`.

The naive arithmetic exhausts that quickly:

```
20 API tasks × 10 Prisma pool connections =  200
 4 worker tasks × 10                      =   40
 2 sync-service tasks × 10                =   20
                                          -----
                                            260 direct connections
```

That fits on paper and fails in practice — autoscaling spikes, deploys that run old and new tasks
simultaneously (canary!), and migration jobs all add on top. Put PgBouncer between the app and
RDS and the picture becomes:

```
260 client connections → PgBouncer (transaction mode) → 40 server connections
```

| Setting | Value | Why |
|---|---|---|
| `pool_mode` | `transaction` | Required for the sizing above; also what makes `SET LOCAL` mandatory |
| `default_pool_size` | 20 per database | Server-side connections per user/db pair |
| `max_client_conn` | 1000 | Client side is cheap |
| `server_idle_timeout` | 600 | Reclaim after deploys |
| `query_wait_timeout` | 5 | Fail fast rather than queue unboundedly |

### Prisma specifics

Transaction-mode pooling breaks server-side prepared statements, which Prisma uses by default.
The connection string must disable them:

```
postgresql://user:pass@pgbouncer:6432/hsc?pgbouncer=true&connection_limit=10&pool_timeout=20
```

Omitting `pgbouncer=true` produces intermittent `prepared statement "s0" already exists` errors
under load — a failure that does not reproduce in development, where there is no pooler.

Migrations and the audit-purge job must connect **directly** to RDS, bypassing PgBouncer:
advisory locks and `CREATE INDEX CONCURRENTLY` are session-scoped and do not survive transaction
pooling. Keep a separate `DIRECT_DATABASE_URL` for them.

---

## Read replicas

`ARCHITECTURE_DESIGN.md` lists read replicas as the first database scaling step. What can safely
move to a replica is decided by tolerance for replication lag, not by whether a query is a read:

| Workload | Target | Why |
|---|---|---|
| Login, session validation, token refresh | Primary | A session written milliseconds ago must be visible |
| Record list and detail screens | Replica | Seconds of staleness is invisible to a user |
| Full-text search | Replica | Same |
| Compliance exports, audit reports | Replica | Long-running; keeps analytical load off the primary |
| Billing cron, renewal sweeps | Replica | Tolerant of lag by design |
| Mobile sync delta pull | **Primary** | See below |
| Anything inside a write transaction | Primary | Obviously |

**Mobile sync must read the primary.** The delta pull compares `records.version` against the
client's checkpoint (doc 03). If the client writes, then immediately pulls from a lagging
replica, it sees a version *older* than what it just sent and the conflict resolver in
`OFFLINE_SYNC_PROCESS.md` treats its own successful write as a conflict. That is a data-corruption
path, not a performance concern.

The general rule: **read your own writes from the primary.** Route by tenant for a short window
after any write — a per-tenant "sticky primary until now + lag budget" marker in Redis is the
usual implementation and is cheap.

Replicas inherit RLS policies and the `SET LOCAL` requirement identically. A replica connection
with no tenant GUC set has the same failure mode as a primary one.

---

## The scaling ladder

```mermaid
flowchart TD
    S1["Stage 1 — Single instance<br/>Multi-AZ RDS, PgBouncer<br/>~50-100 tenants"] --> S2
    S2["Stage 2 — Read replicas<br/>1-3 replicas, read routing<br/>~500 tenants"] --> S3
    S3["Stage 3 — Partitioning<br/>Audit tables by month (doc 04)<br/>records by record_type if needed"] --> S4
    S4["Stage 4 — Isolate the heavy<br/>Enterprise tenants to their own<br/>database; shared pool for the rest"] --> S5
    S5["Stage 5 — Shard by tenant_id<br/>Directory-based routing"]

    S1 -. "CPU > 70% sustained<br/>or read latency p95 > 200ms" .-> S2
    S2 -. "Write throughput bound,<br/>or audit tables dominate storage" .-> S3
    S3 -. "One tenant's load affects<br/>others (noisy neighbour)" .-> S4
    S4 -. "Write volume exceeds<br/>one primary" .-> S5
```

Stages 1–3 are the realistic horizon. `TECH_STACK_PLAN.md` targets starting at $50–100/month;
sharding is a decision for a company with a very different cost structure than that, and the
schema is already designed so it does not have to be made early.

### Stage 4 — database-per-tenant for enterprise

`ARCHITECTURE_DESIGN.md` anticipates this: "migrate to database-per-tenant as growth demands".
The hybrid is the practical shape — most tenants share a pooled database, a handful of large or
contractually-isolated ones get their own. It requires:

- A **tenant directory** (on the platform database, not the tenant databases) mapping
  `tenant_id → connection string`.
- Connection routing at tenant resolution, which the API gateway already does per
  `ARCHITECTURE_DESIGN.md`.
- Migrations that run across N databases, with per-database version tracking and partial-failure
  reporting. This is the real cost of stage 4 and it lands on doc 07's pipeline.

RLS stays enabled even in a single-tenant database. It costs nothing and means one codepath, not
two — and no dependence on "this database only has one tenant in it" staying true.

### Stage 5 — sharding

Shard key is `tenant_id`, because every tenant-scoped table already carries it and no query
crosses tenants. What breaks:

| Concern | Impact |
|---|---|
| Global tables (`plans`, `permissions`, `industry_packs`) | Replicate to every shard, or keep on a platform database |
| Cross-tenant platform queries (billing sweep, unpaid invoices) | Must fan out and merge; move billing to the platform database instead |
| `tenants.subdomain` uniqueness | Enforced by the directory, not a shard constraint |
| Platform-wide analytics | Needs a warehouse, not shard fan-out — already Phase 6 in `NEXT_STAGE_NOTES.md` |
| Rebalancing | Moving one tenant means moving every row with its `tenant_id`; feasible precisely because isolation is total |

UUID primary keys need no change — they are already globally unique, so a tenant can move shards
without key collisions.

---

## Monitoring and alerting

Metric collection is OpenTelemetry → Prometheus/CloudWatch per `ENHANCEMENT_OPPORTUNITIES.md:177-227`.
These are the database signals that belong on the dashboard and the pager.

| Signal | Source | Warn | Page |
|---|---|---|---|
| Replication lag | `pg_stat_replication.replay_lag` | > 5 s | > 30 s |
| Connection saturation | `pg_stat_activity` vs `max_connections` | > 70% | > 90% |
| PgBouncer client queue wait | `SHOW POOLS` → `maxwait` | > 1 s | > 5 s |
| Statement latency p95 | `pg_stat_statements` | > 200 ms | > 1 s |
| Cache hit ratio | `pg_statio_user_tables` | < 99% | < 95% |
| Deadlocks | `pg_stat_database.deadlocks` | any | rising |
| Long transactions | `pg_stat_activity.xact_start` | > 60 s | > 5 min |
| Replication slot retention | `pg_replication_slots` | > 5 GB | > 20 GB |
| Storage free | CloudWatch `FreeStorageSpace` | < 25% | < 10% |
| Failed purge jobs | `purge_jobs.status = 'failed'` | any | 2 consecutive |
| Invalid indexes | `pg_index WHERE NOT indisvalid` | any | — |
| Audit write failures | `system_audit_log` severity `critical` | any | any |

Two of these are less obvious than they look:

**Long transactions** are the most common cause of unexplained bloat and replica lag together: an
idle-in-transaction connection holds back the vacuum horizon across the whole database. Alert on
`state = 'idle in transaction'` separately, and set `idle_in_transaction_session_timeout` so the
database ends them itself.

**Audit write failures are a compliance event, not an ops event.** Per `RULE-HSC-02` a write that
skips the audit trail is a defect; if the audit insert starts failing, the correct response is to
stop accepting writes, not to keep serving and investigate later.

### Tenant-level observability

Aggregate database metrics hide the noisy-neighbour problem that triggers stage 4. Track per
tenant, from `usage_counters` (doc 01) and `pg_stat_statements` tagged with the tenant GUC:

- Queries/sec, p95 latency, rows scanned
- Storage: records, files, audit rows
- Sync volume and conflict rate

The tenant at the top of that list is the one to move to its own database, and having the number
ready is what turns that from an emergency into a planned migration.

---

## Backup and recovery

`ARCHITECTURE_DESIGN.md` commits to automated daily backups with PITR, cross-region replication,
and monthly DR drills. Two database-specific notes:

- **The recovery target is the RPO/RTO you have tested**, not the one configured. A monthly drill
  that restores into a scratch environment and runs the smoke suite is the only evidence that a
  backup is restorable.
- **A logical backup is not a substitute.** RLS policies, grants, generated columns, triggers and
  enum types must all survive a restore, and a `pg_dump --data-only` loses them. Restore drills
  must verify that RLS is still enabled *and forced* afterwards — a restored database with RLS
  quietly disabled is a total isolation failure.

---

## Open questions

1. **PgBouncer placement.** Sidecar per ECS task, or a shared instance? A sidecar simplifies
   networking but multiplies server-side connections by the task count, undoing much of the
   benefit. Recommend a small shared pooler pair behind an NLB, or RDS Proxy if the managed
   option is preferred — it handles failover better but has its own transaction-pinning rules.
2. **Read-routing implementation.** Sticky-primary-after-write needs a per-tenant marker with a
   TTL matched to observed replication lag. Where that lives (Redis vs. request context) affects
   correctness across multiple API tasks; Redis is the safe answer.
3. **`records` partitioning.** Doc 04 partitions the audit tables. Whether `records` should also
   be partitioned — by `record_type`, or by tenant hash — depends on tenant size distribution,
   which is unknown until real usage exists. Deliberately deferred.
4. **Replica count and placement.** Cross-region replicas serve DR; same-region replicas serve
   read scaling. These are different instances with different cost profiles and should be
   budgeted separately rather than assumed to be one thing.
5. **`ALTER DATABASE SET` default GUC.** The fail-closed default above is the recommendation, but
   it changes behaviour for any tooling that connects without setting a tenant. Confirm no
   platform job depends on the current implicit behaviour before applying it.
