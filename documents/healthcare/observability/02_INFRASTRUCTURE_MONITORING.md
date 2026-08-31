# 02 — Infrastructure Monitoring

**Phase 5.1 deliverable** · Sources: `ENHANCEMENT_OPPORTUNITIES.md`, `database/08_SCALING_ARCHITECTURE.md`, `infrastructure/04_INFRASTRUCTURE_AS_CODE.md`
**Status:** Draft for review

Covers container and service monitoring, database performance, network and load balancer
monitoring, synthetic checks, log management, and cost tracking.

Thresholds defined in `database/08` and encoded as alarms in `infrastructure/04` are referenced
rather than restated; this document covers what to collect and why, and fills the gaps those
documents leave.

---

## Compute

Platform-dependent in mechanism, identical in what matters — the ECS/Kubernetes fork from
`infrastructure/03_DEPLOYMENT_STRATEGIES.md` is still open.

| Signal | Source | Watch for |
|---|---|---|
| CPU / memory utilisation | Container Insights | Sustained above 70%; memory trending up between deploys |
| Task or pod restarts | ECS events / kubelet | Any crash loop |
| Desired vs running count | Service metrics | A scale-out that is not completing |
| Task start duration | Custom | Slow starts extend every deploy and every scale-out |
| OOM kills | Container Insights | Any — the limit is wrong or there is a leak |
| Deployment state | ECS deployment / Rollout status | Stuck rollouts |

**Memory trending upward between deploys is the signal worth building for.** A leak in a
long-running Node process is masked by deploys resetting it; without a chart that spans releases,
it surfaces only when a quiet week lets a task hit its limit.

Task-level granularity matters more than the service average. One task pinned at 100% while five
idle averages to acceptable and is a real problem — usually an unbalanced connection pool or a
stuck event loop.

Node-specific: event loop lag is the metric that actually predicts latency for this workload, and
no infrastructure monitor emits it. It is a custom metric from the application
(`hsc.runtime.event_loop_lag_ms`), and it rises before request latency does.

---

## Database

`database/08` gives the thresholds. Three things it flags need explicit collection here.

| Signal | Source | Note |
|---|---|---|
| Replication lag | `pg_stat_replication.replay_lag` | Drives read routing; sync must read primary (`database/08`) |
| Connection count vs `max_connections` | `pg_stat_activity` | Saturation is the common outage |
| **Idle in transaction** | `pg_stat_activity.state` | Separate alert from long queries — see below |
| Slow statements | `pg_stat_statements` | Must be enabled in the parameter group |
| Cache hit ratio | `pg_statio_user_tables` | Below 99% sustained means undersized or a scan |
| Deadlocks | `pg_stat_database.deadlocks` | Any, rising |
| Replication slot retention | `pg_replication_slots` | An abandoned slot fills the disk silently |
| Sequential scans on large tables | `pg_stat_user_tables` | The index-regression signal (`database/06`) |
| Invalid indexes | `pg_index WHERE NOT indisvalid` | A failed `CREATE INDEX CONCURRENTLY` |
| Table and index bloat | `pgstattuple` sampled | Drives the reindex schedule |

**Idle-in-transaction is the highest-value database alert on this platform** and the least
obvious. A connection left open in a transaction holds back the vacuum horizon across the whole
database, which simultaneously causes table bloat and replica lag — two symptoms that look
unrelated. Given `api/06` wraps every request in an explicit transaction to set the tenant GUC,
a handler that awaits an external call inside that transaction produces exactly this.
`idle_in_transaction_session_timeout` is set so the database ends them itself, and the metric
tracks how often it fires.

### PgBouncer

`database/08` puts a pooler on the request path, and nothing in the source documents monitors it —
so the layer most likely to cause a "database is down" incident is invisible.

| Signal | Source | Threshold |
|---|---|---|
| Client connections waiting | `SHOW POOLS` → `cl_waiting` | > 0 sustained |
| Max wait time | `SHOW POOLS` → `maxwait` | > 1 s warn, > 5 s page |
| Server connections in use | `SHOW POOLS` → `sv_active` | Approaching `default_pool_size` |
| Pool saturation | `sv_active / pool_size` | > 80% |

`maxwait` is the metric that distinguishes "the database is slow" from "the pool is exhausted",
which are different incidents with different fixes and identical symptoms from the application's
point of view.

### Redis

Beyond the standard memory and eviction metrics, two are platform-specific: rate-limiter key
count (`api/03` warned that keys without TTLs leak) and session-check cache hit rate (`api/01`
caches session validity for ~60 s; a collapse there means every request hits Postgres).

---

## Network and edge

| Layer | Signals |
|---|---|
| ALB | Request count, target 5xx vs ALB 5xx, target response time, unhealthy host count, rejected connections, surge queue |
| CloudFront | Cache hit ratio, origin latency, 4xx/5xx by edge |
| WAF | Blocked requests by rule, rate-limit triggers |
| VPC | Flow logs for rejected traffic, NAT gateway bytes |
| Route 53 | Health check status |

**Distinguish ALB 5xx from target 5xx.** `HTTPCode_ELB_5XX_Count` means the load balancer could
not reach a healthy target — an infrastructure failure. `HTTPCode_Target_5XX_Count` means the
application returned an error. They page different people, and a dashboard that sums them hides
which.

NAT gateway bytes is a cost signal as much as a network one: a misconfigured service pulling
container images or S3 objects through NAT instead of a VPC endpoint is a large, silent bill.

## Synthetic monitoring

Real-user metrics only exist when there are real users. Synthetic checks from outside the VPC
answer "is the platform up" independently of whether anyone is looking.

| Check | Frequency | Asserts |
|---|---|---|
| Login flow | 5 min | Auth path end to end against a synthetic tenant |
| Record read/write | 5 min | Full request path including RLS and audit |
| File upload + scan | 15 min | Storage, scanning, availability transition |
| Sync pull | 5 min | The mobile critical path |
| Webhook delivery | 15 min | Outbox to delivery, against a test receiver |
| TLS certificate expiry | Daily | ≥ 30 days remaining |

The synthetic tenant is seeded with synthetic data (`infrastructure/02`) and excluded from
business metrics (doc 03) — otherwise a check running every five minutes dominates the DAU figure.

Certificate expiry is worth its own check even with ACM auto-renewal, because renewal can fail
on DNS validation and the failure is silent until the certificate expires. It also interacts with
the pinning hazard in `infrastructure/06`.

---

## Logs

| Group | Retention | Contents |
|---|---|---|
| Application | 30 days hot, 90 archived | Structured JSON, allowlisted (doc 01) |
| Access | 90 days | Method, route pattern, status, duration, tenant, request id |
| ALB / CloudFront | 90 days | S3, lifecycle to Glacier |
| VPC flow | 30 days | Rejected traffic retained longer |
| CloudTrail | 1 year hot, 7 years archived | Immutable, Object Lock |
| Audit archive | Per retention policy | `database/04`, Object Lock compliance mode |

CloudTrail is separated deliberately: it is compliance evidence (`infrastructure/07`), not
operational logging, and it is retained and protected accordingly.

Access log URLs are **route patterns, not resolved paths** — the same rule as doc 01, applied at
the ALB. An ALB access log records the full request URI by default, which for
`/v1/records/patient/6f1c…` is a patient identifier in a log group with 90-day retention and
broad read access. Where the ALB cannot be configured to elide it, the log group is treated as
PHI-bearing: encrypted with a CMK, access-restricted, and included in audit scope.

---

## Cost monitoring

The Phase 5.1 checklist asks for "cost optimization and resource tracking".
`ENHANCEMENT_OPPORTUNITIES.md`'s monitoring section does not mention cost at all.

| Signal | Source | Purpose |
|---|---|---|
| Daily spend by service | Cost Explorer | Trend and anomaly |
| Spend by `Environment` tag | Cost allocation tags (`infrastructure/04`) | Non-prod creep |
| Spend by `DataClass` | Same | What PHI handling actually costs |
| Cost anomaly alerts | AWS Cost Anomaly Detection | Unexpected changes |
| KMS request volume | CloudWatch | Doc 06 flagged this scales with attachments |
| CloudWatch Logs ingestion | CloudWatch | The usual runaway |
| NAT gateway data processing | CloudWatch | Missing VPC endpoints |
| Per-tenant unit cost | Derived — see below | Margin |

**Per-tenant cost is the number the business needs and nothing produces directly.** It is derived
by allocating shared infrastructure across tenants using `usage_counters` (`database/01`) —
storage bytes, API calls, active users — and comparing it with the subscription revenue for that
tenant (`subscriptions`, `invoices`).

That comparison answers two questions that are otherwise guesswork: whether a plan tier is priced
above its cost to serve, and which tenants are unprofitable. It also gives the noisy-neighbour
signal from `database/08` a financial dimension — the tenant whose load justifies moving to its own
database is usually the one whose unit cost has diverged first.

The allocation is approximate and should be labelled as such. Precision here is not worth the
effort; direction and outliers are.

---

## Corrections and additions to `ENHANCEMENT_OPPORTUNITIES.md`

| # | Severity | Issue | Resolution |
|---|---|---|---|
| 1 | **High** | ALB access logs record full request URIs, which contain patient identifiers | Route patterns where configurable; otherwise the log group is treated as PHI-bearing |
| 2 | **High** | PgBouncer is on the request path (`database/08`) and entirely unmonitored, so pool exhaustion is indistinguishable from database slowness | `SHOW POOLS` metrics, `maxwait` alerting |
| 3 | Medium | No idle-in-transaction monitoring, though `api/06` wraps every request in an explicit transaction; it causes bloat and replica lag simultaneously | Separate metric and alert, plus `idle_in_transaction_session_timeout` |
| 4 | Medium | Cost tracking is a Phase 5.1 deliverable and absent from the source | Cost section, including derived per-tenant unit cost |
| 5 | Medium | No synthetic monitoring; a platform with no users at 3am appears healthy while broken | Synthetic checks against a seeded tenant, excluded from business metrics |
| 6 | Medium | ALB and target 5xx are not distinguished, hiding whether the failure is infrastructure or application | Separate metrics and alerts |
| 7 | Low | No event-loop lag metric, which is the leading indicator of latency for a Node workload | Custom metric |
| 8 | Low | Certificate expiry unmonitored despite auto-renewal, which can fail silently on DNS validation | Daily check with 30-day threshold |

---

## Open questions

1. **The ECS/Kubernetes fork** (`infrastructure/03`) determines the container monitoring
   mechanism. Signals are the same either way; the collection differs.
2. **Log volume budget.** No number exists. It should be set before ingestion charges set it, and
   it interacts with the sampling policy in doc 01.
3. **Synthetic check location.** Running from one region is cheap and cannot distinguish a
   regional network problem from an outage. Multi-region synthetics cost more and are the only
   way to tell.
4. **Per-tenant cost allocation model.** Proportional to `usage_counters` is proposed. Whether
   shared baseline cost is spread evenly or by usage changes which tenants look unprofitable, and
   that is a business decision, not an engineering one.
5. **Bloat monitoring cost.** `pgstattuple` on large tables is not free to run. Sampling weekly
   against the largest tables is proposed; the cadence needs validating against real table sizes.
