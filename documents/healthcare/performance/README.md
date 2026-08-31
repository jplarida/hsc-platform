# Phase 7 — Scalability & Performance

Implementation-ready specifications for the section of `../NEXT_STAGE_NOTES.md` titled
"Phase 7: Scalability & Performance Implementation".

| Doc | Covers | Checklist item |
|---|---|---|
| [01_CACHING_ARCHITECTURE.md](01_CACHING_ARCHITECTURE.md) | Redis layer, key design, invalidation, failure behaviour, eviction | Caching Strategy Implementation |
| [02_SCALING_AND_TUNING.md](02_SCALING_AND_TUNING.md) | Auto-scaling policy, resource allocation, load balancing, plus a map of where the rest already lives | Database Performance Optimization · Auto-Scaling Implementation |

## Two documents, not three

Most of Phase 7.1 had already been specified while working through Phases 1, 3, 4 and 5. Of the
twelve sub-bullets in the checklist, eight were already covered — query optimization in
`database/06`, connection pooling and the scaling ladder in `database/08`, partitioning in
`database/04`, monitoring in `observability/02`, CDN in `frontend/04`, load balancing and cost in
`infrastructure/04` and `observability/02`.

Restating them would produce two copies that drift. Doc 02 therefore opens with a table pointing
to where each item actually lives, and specifies only what had no home.

## What was genuinely missing

**The Redis layer had never been designed.** It is referenced across six documents — session
checks in `api/01`, tenant config in `api/06`, rate limiter state in `api/03`, idempotency keys in
`api/02`, sticky-primary markers in `database/08`, tenant projections in `api/05` — as the answer
to a specific problem each time, with no key taxonomy, no eviction policy, no sizing, and no
agreement on what happens when it is unavailable. Doc 01 is that design, and its inventory of
twelve consumers is the thing that did not previously exist anywhere.

**Auto-scaling policy and resource allocation** were unspecified. Doc 02 covers both.

## Findings worth reading first

1. **Cache and state must not share a Redis instance** (doc 01). Under memory pressure
   `allkeys-lru` evicts rate limiter windows, idempotency keys and circuit breaker state. Nothing
   errors — the limit silently resets, a retried request creates a duplicate charge, the breaker
   forgets an open circuit. Two stores, `volatile-lru` for cache and `noeviction` for state.
2. **No PHI in Redis** (doc 01). Caching record content breaks erasure propagation, retention and
   PHI read-auditing, and buys little given the indexes in `database/06`. Configuration, derived
   values and metadata only.
3. **Redis failure is a fall-through, not a fail-open/fail-closed choice** (doc 01). This resolves
   the question `api/01` and `api/06` both left open, and better than either option offered: a
   cache falls through to its source, so a Redis outage makes the platform slower rather than
   wrong. Only the rate limiter and billing idempotency have no source to fall through to.
4. **Auto-scaling must never trigger on latency** (doc 02), and its maximum is bounded by the
   database connection budget rather than by CPU headroom. Latency rises when the database
   saturates; scaling out at that moment adds queue depth and deepens the incident.
5. **Node's default heap in a memory-limited container** (doc 02) means the OOM killer takes the
   process before V8 runs a full GC — appearing as an unexplained restart with no stack trace.

## Dependencies

Doc 01 needs a `config_version` column on `tenant_configurations` for version-stamped cache keys —
a small Phase 1 addition that does not exist yet. Doc 02's scaling threshold needs a measured
single-task capacity, which requires the load test that `infrastructure/02` already schedules.
