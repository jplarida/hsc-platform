# 02 — Scaling & Tuning

**Phase 7.1 deliverable** · Consolidates `database/06`, `database/08`, `observability/02`, `infrastructure/03`, `frontend/04`
**Status:** Draft for review

Covers the remaining Phase 7.1 items — database performance and auto-scaling — as a consolidated
reference plus the material that genuinely had no home.

Most of Phase 7.1 was already specified while working through Phases 1, 3, 4 and 5. Restating it
here would create two copies that drift, so this document **points to where each item lives** and
then specifies only what was missing: resource allocation, auto-scaling policy, and the constraint
that governs both.

---

## Where Phase 7.1 is already specified

| Checklist sub-item | Specified in |
|---|---|
| Query optimization procedures | [`database/06`](../database/06_INDEXING_STRATEGY.md) — index selection, composite ordering, keyset pagination, N+1 on `record_links`, `EXPLAIN` under RLS, maintenance |
| Connection pooling configuration | [`database/08`](../database/08_SCALING_ARCHITECTURE.md) — PgBouncer transaction mode, sizing arithmetic, Prisma `pgbouncer=true`, the `SET LOCAL` requirement |
| Database partitioning | [`database/04`](../database/04_AUDIT_COMPLIANCE_ERD.md) — monthly range partitions on audit tables; [`database/08`](../database/08_SCALING_ARCHITECTURE.md) — stage 3 of the ladder |
| Performance monitoring and tuning | [`observability/02`](../observability/02_INFRASTRUCTURE_MONITORING.md) — database signals, PgBouncer, idle-in-transaction; [`database/08`](../database/08_SCALING_ARCHITECTURE.md) — thresholds |
| Redis caching layer | [`01_CACHING_ARCHITECTURE.md`](01_CACHING_ARCHITECTURE.md) |
| CDN configuration | [`frontend/04`](../frontend/04_PERFORMANCE_OPTIMIZATION.md) — with attachments excluded from CDN entirely |
| Application-level caching | [`01_CACHING_ARCHITECTURE.md`](01_CACHING_ARCHITECTURE.md) |
| Cache invalidation | [`01_CACHING_ARCHITECTURE.md`](01_CACHING_ARCHITECTURE.md) |
| Horizontal scaling triggers | [`database/08`](../database/08_SCALING_ARCHITECTURE.md) — the five-stage ladder |
| Load balancing | [`infrastructure/04`](../infrastructure/04_INFRASTRUCTURE_AS_CODE.md) — ALB as Terraform; [`observability/02`](../observability/02_INFRASTRUCTURE_MONITORING.md) — signals |
| Cost management and budgeting | [`observability/02`](../observability/02_INFRASTRUCTURE_MONITORING.md) — spend tracking, anomaly detection, per-tenant unit cost |

What follows is the remainder.

---

## The constraint that governs auto-scaling

Generic auto-scaling advice says: watch CPU, add tasks. That is wrong for this platform, and
getting it wrong produces an outage rather than a slowdown.

**Every API task consumes database connections. Scaling out the application tier scales out
pressure on a fixed-size database.** From `database/08`:

```
20 API tasks × 10 Prisma pool connections  = 200
 4 workers   × 10                          =  40
 2 sync      × 10                          =  20
                                             ---
                                             260 → PgBouncer → ~40 server connections
```

PgBouncer is what makes this survivable, and it does not make the ceiling disappear — it moves it.
Two consequences:

- **The maximum task count is bounded by PgBouncer's `default_pool_size` and RDS
  `max_connections`**, not by CPU headroom. An auto-scaling policy that can exceed that ceiling
  will, under load, take the database down at exactly the moment traffic is highest.
- **Scaling out during a database incident makes it worse.** If latency is rising because the
  database is saturated, adding tasks adds queue depth. The scaling policy must not react to
  latency alone.

So the maximum task count is set explicitly from the connection budget, and reviewed whenever pool
sizing changes:

```
max_tasks = (pgbouncer_default_pool_size × pooler_count) / prisma_connection_limit
```

with headroom reserved for workers, the sync service, migrations and break-glass access.

## Scaling policy

**Target tracking on request concurrency, not CPU.** A Node API is rarely CPU-bound; it is bound
by the event loop and by waiting on I/O. CPU utilisation on such a service can sit at 30% while
requests queue.

| Metric | Suitability |
|---|---|
| `ALBRequestCountPerTarget` | **Primary.** Directly proportional to load, reacts before saturation |
| Event loop lag (`observability/02`) | **Secondary.** The leading indicator of latency for this runtime |
| CPU utilisation | Poor primary signal; useful as a ceiling guard |
| Memory | Not a scaling signal — a leak scales out forever without fixing anything |
| Response latency | **Never a scaling trigger.** Latency rises when the database saturates, and scaling out then makes it worse |

```
Target:        requests per target = 80% of measured single-task capacity
Scale out:     aggressive — 2 tasks or 50%, whichever is greater; 60 s cooldown
Scale in:      conservative — 1 task at a time; 300 s cooldown
Minimum:       2 (never 1 — a single task is a single point of failure and blocks deploys)
Maximum:       from the connection budget above
```

**Asymmetric cooldowns are deliberate.** Scaling out late costs an outage; scaling in early costs
a few minutes of an instance. Aggressive out, patient in.

Scale-in protection is enabled for tasks processing a long-running job — an import
(`database/07`), a bulk export, a webhook delivery batch — so a scale-in event does not kill work
in flight.

Scheduled scaling matters more than it usually would: clinical usage is sharply diurnal, so
pre-warming ahead of the morning ramp beats reacting to it, and reactive scaling alone will always
be one step behind a predictable spike.

## Resource allocation

Unspecified anywhere until now.

| Component | vCPU | Memory | Notes |
|---|---|---|---|
| API task | 0.5 | 1 GB | Node heap capped below the container limit — see below |
| Worker | 1 | 2 GB | File processing and imports are memory-hungry |
| Sync service | 1 | 2 GB | Batch assembly holds records in memory |
| Migration task | 0.5 | 1 GB | One-shot (`infrastructure/03`) |

```dockerfile
# Heap ceiling below the container limit, or the OOM killer takes the process
# before V8 ever runs a full GC — which presents as an unexplained restart.
ENV NODE_OPTIONS="--max-old-space-size=768"   # 1 GB container
```

That line prevents a specific and confusing failure: without it, V8 grows the heap toward its own
default ceiling, the container hits its memory limit first, and the process is killed with no
stack trace and no error — appearing in `observability/02` only as an OOM kill.

`UV_THREADPOOL_SIZE` is raised above the default of 4 where file hashing and compression are on
the request path, since those occupy libuv threads and starve DNS and filesystem work.

Requests and limits are set equal for memory (no overcommit — the failure is a kill, not
throttling) and limits set above requests for CPU (throttling is survivable).

## Load balancing

| Setting | Value | Reason |
|---|---|---|
| Algorithm | **Least outstanding requests** | Round robin distributes evenly regardless of task state; with variable request latency it will keep feeding a task that is already struggling |
| Sticky sessions | **Off** | The API is stateless (`api/01`); stickiness would defeat even distribution and is unnecessary |
| Health check | `/health/ready` (`infrastructure/01`) | Checks dependencies, unlike `/health/live` |
| Interval / threshold | 10 s, 2 healthy, 3 unhealthy | Fast enough to shed a bad task, slow enough not to flap on a database blip |
| Deregistration delay | 60 s | Must exceed the longest in-flight request, or draining kills active work |
| Idle timeout | 65 s | Above the client timeout, below the target's |

Deregistration delay and the graceful shutdown sequence in `infrastructure/03` have to agree: the
task must stop accepting work, drain, close its pool and exit **within** the delay, or deploys
terminate live requests.

---

## Cost

`observability/02` covers spend tracking, anomaly detection and per-tenant unit cost. Three
levers that belong here rather than there:

| Lever | Applies to | Note |
|---|---|---|
| Savings Plans / Reserved Instances | Fargate baseline, RDS | Commit to the floor, not the peak — auto-scaling handles the rest on demand |
| Non-production shutdown | dev and staging | Overnight and weekends; roughly 65% of their cost |
| Storage lifecycle | S3 attachments | Already specified (`database/05`) — `idx_files_lifecycle` drives the nightly transition |

The per-tenant unit cost from `observability/02` is what makes scaling a business decision rather
than a technical one: it identifies which tenant's load justifies the move to a dedicated database
in stage 4 of `database/08`'s ladder, before that tenant becomes an incident.

---

## Design notes

| # | Risk in the obvious implementation | Position taken |
|---|---|---|
| 1 | Auto-scale on CPU | Request concurrency; a Node API is I/O-bound and CPU stays low while requests queue |
| 2 | Auto-scale on latency | Never — latency rises when the database saturates, and scaling out then adds queue depth |
| 3 | Unbounded maximum task count | Bounded by the connection budget; exceeding it takes the database down under peak load |
| 4 | Symmetric scaling cooldowns | Aggressive out, patient in |
| 5 | Minimum of one task | Minimum two — one task is a single point of failure and blocks rolling deploys |
| 6 | Default Node heap in a memory-limited container | `--max-old-space-size` below the container limit, or the OOM killer produces unexplained restarts |
| 7 | Round-robin load balancing | Least outstanding requests, given variable request latency |
| 8 | Deregistration delay shorter than in-flight requests | 60 s, aligned with the graceful shutdown sequence |

---

## Open questions

1. **Single-task capacity is unmeasured.** The target-tracking threshold is "80% of measured
   capacity" and that measurement does not exist. It needs a load test before the policy is
   meaningful, and `infrastructure/02` already schedules nightly performance runs that could
   produce it.
2. **The connection budget depends on the unresolved PgBouncer placement** (`database/08`, open
   question 1): sidecar, shared instance, or RDS Proxy. Each gives a different ceiling.
3. **Scheduled scaling needs a usage profile.** Clinical usage is diurnal in theory; the actual
   curve is unknown until there are tenants, and it will differ by vertical and time zone.
4. **Worker sizing is a guess.** 2 GB assumes imports stream rather than buffer
   (`database/07` open question 2, which is still open). If they buffer, this is wrong.
5. **Reserved capacity timing.** Committing before traffic patterns are known risks paying for
   the wrong shape. Usually worth waiting one or two quarters.
