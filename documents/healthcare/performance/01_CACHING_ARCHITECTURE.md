# 01 — Caching Architecture

**Phase 7.1 deliverable** · Sources: `api/01`, `api/02`, `api/03`, `api/06`, `database/08`, `frontend/04`, `infrastructure/06`
**Status:** Draft for review — new documentation, no prior source document

Covers the Redis layer, cache key design, invalidation, failure behaviour, and eviction policy.

Redis has been referenced across six documents as the answer to a specific problem each time — a
session check here, rate limiter state there — without ever being designed as one thing. This
document is that design.

---

## Two rules that come before anything else

### Every key is tenant-scoped

`api/06_MIDDLEWARE_ARCHITECTURE.md` establishes this and it is worth restating as the foundation:
a cache key built from a record id alone is a **cross-tenant leak that row-level security cannot
catch**, because the read is answered from memory and never reaches the database.

This is the same class of failure as the pooled-connection GUC leak in `database/08`, one layer
up, and it needs the same structural answer rather than discipline:

```ts
// The only cache client. The raw ioredis client is not exported from this module.
export function cacheKey(ns: Namespace, ...parts: string[]): string {
  const tenantId = requireTenantContext();     // throws if unset — never silently global
  return `${ns}:${tenantId}:${parts.join(':')}`;
}
```

Genuinely global values — the `plans` catalogue, the `permissions` catalogue, industry pack
definitions — use an explicit `global:` namespace, so a missing tenant is a deliberate choice
that reads as one, not an omission.

### No PHI in Redis

Caching record content is the obvious performance move and it is the wrong one here.

| Consequence | Detail |
|---|---|
| Erasure does not propagate | A record purged under `database/04` retention or a GDPR erasure request stays readable from cache until its TTL expires |
| Retention does not apply | Cached PHI has no retention policy and no audit trail |
| Reads bypass audit | `database/04` requires PHI *reads* to be logged; a cache hit that skips the handler skips the audit row |
| Wider blast radius | A cache-key defect exposes records rather than config |

And the benefit is small. `database/06_INDEXING_STRATEGY.md` puts record reads on covering indexes
with keyset pagination; a primary-key lookup on an indexed table is already sub-millisecond, and
the cache saves a network hop rather than real work.

**Cache configuration, derived values and metadata. Not record content, not file content, not
anything a `records.data` field could contain.**

The one deliberate exception is aggregated analytics results (`analytics/01`), which are counts
over suppressed small cells and are not PHI — cached briefly, still tenant-scoped.

---

## What is actually cached

Pulled from every document that assumed Redis. This inventory is the thing that did not exist.

| # | Consumer | Namespace | TTL | Source | On miss |
|---|---|---|---|---|---|
| 1 | Session validity | `sess` | 60 s | `api/01` | Query `sessions` |
| 2 | Tenant config, features, branding | `cfg` | 5 min | `api/06`, `frontend/01` | Query `tenant_configurations` |
| 3 | Record type registry | `rtd` | 5 min | `database/03` | Query `record_type_definitions` |
| 4 | Resolved plan limits | `plan` | 5 min | `api/03` | Join `subscriptions`/`plans` |
| 5 | Tenant tier (for alert weighting) | `tier` | 15 min | `observability/04` | Query `subscriptions` |
| 6 | Rate limiter windows and buckets | `rl` | window length | `api/03` | **State, not cache** |
| 7 | Idempotency keys and responses | `idem` | 24 h | `api/02` | **State, not cache** |
| 8 | Circuit breaker state | `cb` | 60 s | `api/03` | **State, not cache** |
| 9 | Read-after-write sticky-primary marker | `raw` | lag budget | `database/08` | Route to primary |
| 10 | Tenant OpenAPI projection | `oas` | 1 h | `api/05` | Regenerate |
| 11 | Analytics query results | `agg` | 5 min | `analytics/01` | Query `analytics` schema |
| 12 | Form schema by version | `form` | 1 h | `database/03` | Query `form_versions` |

Rows 6, 7 and 8 are marked **state, not cache**, and that distinction drives the eviction policy
below — it is the single most consequential decision in this document.

Two things are deliberately absent. **KMS data keys stay in process memory only**
(`infrastructure/06`): they are key material, and putting them in a shared store extends the
compromise radius of that store to every tenant's encryption. **Refresh tokens and session
secrets** likewise — `sess` caches a boolean validity plus expiry, never the token.

---

## Key design

```
<namespace>:<tenant_id>:<entity>:<id>[:<version>]

sess:7f3a…:s:6f1c…                       session validity
cfg:7f3a…:v:41                           tenant config, version-stamped
rtd:7f3a…:v:41                           record type registry
rl:7f3a…:u:9c2e…:m                       per-user minute bucket
idem:7f3a…:9f8e7d6c-…                    idempotency key
global:plans:v:12                        platform catalogue
```

**Version-stamped keys instead of invalidation, wherever a version exists.** `tenant_configurations`
gains a monotonic `config_version`; the key includes it, and the version travels in the JWT or is
read once per request. Updating config writes a new key and the old one expires on its own.

This removes an entire class of bug. There is no invalidation message to lose, no ordering race
between the write and the invalidation, and no stale read window — a reader either has the new
version number and misses, or has the old one and correctly reads old data.

---

## Invalidation

Three strategies, applied deliberately rather than uniformly:

| Strategy | Used for | Trade |
|---|---|---|
| **Version-stamped key** | Config, registry, form schemas | Best. Needs a version column on the source |
| **TTL only** | Plan limits, tier, analytics | Simple; accepts a bounded stale window |
| **Pub/sub invalidation** | Session revocation | Needed when staleness is a security issue |

Session revocation is the case where TTL is not good enough. `api/01` requires that a revoked
session stops working promptly; a 60-second TTL means a revoked session survives up to a minute,
which is acceptable for an ordinary logout and not for a compromised account. So revocation
publishes:

```
PUBLISH cache:invalidate  {"ns":"sess","tenant":"7f3a…","key":"s:6f1c…"}
```

Every API task subscribes and drops the key locally. **Pub/sub is best-effort** — a task that was
disconnected misses the message — so the TTL remains as the backstop rather than being replaced.
Belt and braces, because the failure mode is a live session that should be dead.

### The offline-sync interaction

A sync push (`api/02`) can update hundreds of records in one request. Nothing cached holds record
content, so no record-level invalidation is needed — which is a direct benefit of the no-PHI rule
above.

What a push *can* invalidate is derived: analytics aggregates for the affected days. Those are
handled by TTL plus the provisional-day marking in `analytics/01`, not by targeted invalidation,
because a push touching three days of backdated records would otherwise fan out into a large
invalidation set on every sync.

---

## Failure behaviour: Redis is a cache, not a dependency

`api/03` and `api/06` both left this open, and both noted the answers must agree. They do now.

The framing in those documents — fail open or fail closed — was the wrong question for most
consumers. **A cache falls through to its source.** Redis being unavailable should make the
platform slower, not wrong and not down.

| Consumer | Redis unavailable | Why |
|---|---|---|
| Session validity | **Query `sessions` directly** | It is a cache over a table. Slower, still correct |
| Tenant config, registry, form schemas | Query the database | Same |
| Plan limits, tier | Query the database | Same |
| Analytics results | Query the `analytics` schema | Same |
| Rate limiter — `/auth/*` | **Fail closed, 503** | An unlimited login endpoint is a credential-stuffing target. This has no source to fall through to |
| Rate limiter — everything else | Fail open, alarm loudly | The connection pool is the real backstop; refusing all traffic turns a degraded cache into an outage |
| Idempotency — billing mutations | **Fail closed, 503** | Cannot guarantee no duplicate charge |
| Idempotency — everything else | Fail open, log | A duplicate record is recoverable; a rejected clinical write during an outage is worse |
| Circuit breakers | Local in-process fallback | Per-task rather than shared; degraded but safe |
| Sticky-primary marker | Route to primary | Slower, always correct |

The fall-through answer resolves `api/01` open question 2 better than either option it offered:
the session check does not need to choose between security and availability, because `sessions`
is right there.

It does mean **a Redis outage causes a database load spike**, as every cached read becomes a
query. That is a real risk and it is why the fall-through path must be rate-limited and why
`database/08`'s connection saturation alarm is the one to watch during a cache incident.

---

## Eviction: cache and state must not share an instance

This is the finding most likely to cause a subtle production failure.

Under memory pressure Redis evicts according to `maxmemory-policy`. The common choice,
`allkeys-lru`, evicts **any** key — including rate limiter windows, idempotency keys and circuit
breaker state. The consequences are not slower responses; they are correctness failures:

| Evicted | Result |
|---|---|
| Rate limiter window | The limit silently resets. An attacker under sustained load benefits |
| Idempotency key | A retried request creates a duplicate — a duplicate charge or clinical record |
| Circuit breaker state | The breaker forgets an open circuit and hammers a failing dependency |

Nothing errors. The system just quietly stops enforcing things it reports as enforced.

**Two logical stores, separated:**

| | Cache | State |
|---|---|---|
| Namespaces | `sess`, `cfg`, `rtd`, `plan`, `tier`, `oas`, `agg`, `form` | `rl`, `idem`, `cb`, `raw` |
| Eviction | `volatile-lru` | `noeviction` |
| Loss tolerance | Total — falls through to source | **None** — loss is a correctness failure |
| Sizing | Best effort | Provisioned for peak with headroom |

Separate ElastiCache replication groups is the clean implementation; separate logical databases on
one instance is cheaper and does not isolate the memory, which is the whole point. Recommend
separate instances, sized independently.

With `noeviction` on the state store, running out of memory returns errors on write rather than
silently dropping keys — which is the correct behaviour, because a visible failure is recoverable
and a silent one is not. That makes memory headroom on the state store an alarm, not a nice-to-have.

---

## Security

| Control | Requirement |
|---|---|
| Encryption in transit | TLS enabled, `AUTH` token required (`infrastructure/06`) |
| Encryption at rest | ElastiCache at-rest encryption with a CMK |
| Network | Private subnets, security group restricted to the application tier |
| BAA | ElastiCache is HIPAA-eligible (`infrastructure/04`) |
| Key material | **Never in Redis** — KMS data keys stay in process memory |
| Tokens | Never in Redis — `sess` holds validity, not credentials |
| Auth token rotation | 90 days with a dual-token window (`infrastructure/04`) |

Even with no PHI cached by policy, encryption at rest and in transit is not optional: tenant
configuration, session identifiers and tenant identifiers are all sensitive, and the cost of
enabling both is negligible.

---

## Application-level caching

In-process caching sits in front of Redis for values that are read on nearly every request and
change rarely:

| Value | TTL | Note |
|---|---|---|
| Route metadata, compiled schemas | Process lifetime | Immutable after boot |
| JWKS public keys | 10 min | With a refresh on unknown `kid` |
| Global catalogues (`plans`, `permissions`) | 5 min | Not tenant-scoped |
| Tenant config | **30 s only** | Per-task copies diverge; keep the window short |

The last row is the trap. An in-process cache is per-task, so with twenty tasks a config change
takes effect at twenty different moments. Thirty seconds bounds the divergence to something users
read as "it took a moment" rather than "it didn't save". Anything where divergence is visible
should skip the in-process layer entirely.

## CDN

Specified in `frontend/04_PERFORMANCE_OPTIMIZATION.md` and not restated. The two rules that matter
are carried forward: **no authenticated API response is CDN-cached** (`private, no-store`), and
**attachments never transit a CDN** — they are served by authorized redirect to a short-lived
pre-signed URL, because a CDN copy would be reachable without authorization and invisible to the
audit trail.

---

## Monitoring

| Signal | Threshold | Note |
|---|---|---|
| Hit rate per namespace | Below 80% sustained | A namespace that never hits should be removed, not tuned |
| **Evictions on the state store** | **Any** | Correctness failure, per above |
| Evictions on the cache store | Rising | Undersized |
| Memory used vs max | > 75% | Both stores |
| Command latency p99 | > 5 ms | Usually a large key or a slow command |
| Connected clients | Approaching limit | Task count × pool size |
| Fall-through rate | Spike | Redis degraded; watch database connections |
| Keys without TTL | Any on the cache store | A leak — `api/03` flagged this for rate-limit keys |

Hit rate is measured **per namespace**, not globally. A global 90% hides a config cache at 99% and
a session cache at 40%, and only the second one is a problem.

---

## Design notes

New documentation, so these are positions rather than corrections — each is where the obvious
implementation goes wrong:

| # | Risk in the obvious implementation | Position taken |
|---|---|---|
| 1 | Caching records by id for performance | No PHI in Redis — erasure, retention and read-audit all break |
| 2 | Cache keys built from a record or user id | Tenant-scoped by construction, enforced by a single client |
| 3 | One Redis with `allkeys-lru` | Cache and state separated; eviction of rate-limit or idempotency keys is a silent correctness failure |
| 4 | Choosing fail-open or fail-closed for the session check | Neither — fall through to the `sessions` table |
| 5 | Invalidation messages on every config write | Version-stamped keys where a version exists; pub/sub only where staleness is a security issue |
| 6 | Trusting pub/sub invalidation alone | Best-effort; TTL retained as the backstop |
| 7 | In-process caching of tenant config with a long TTL | 30 s, because per-task copies diverge visibly |
| 8 | KMS data keys or tokens in Redis | Process memory only |

---

## Open questions

1. **Two ElastiCache instances or one.** Separation is correct; the cost is roughly double the
   baseline. A single instance with `noeviction` and disciplined TTLs is the cheaper compromise
   and depends on nobody ever adding an untl'd key.
2. **Fall-through load.** A Redis outage converts every cached read into a query. That should be
   load-tested before it happens in production, and it may need a circuit breaker of its own.
3. **`config_version` does not exist.** Version-stamped keys need a monotonic version column on
   `tenant_configurations` — a small Phase 1 addition, but an addition.
4. **Analytics cache TTL.** Five minutes is a guess. It interacts with the provisional-day marking
   in `analytics/01` and should be set once real query patterns exist.
5. **Cluster mode.** Single-node with a replica is sufficient at the documented scale. Cluster
   mode changes key distribution and breaks multi-key operations, so it is worth confirming the
   rate limiter's Lua scripts remain single-slot before it is ever enabled.
