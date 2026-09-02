/**
 * Rate-limiter algorithms, as Lua so Redis executes them atomically.
 *
 * `api/03` found three defects in the implementation `API_ARCHITECTURE.md` gives, and
 * all three are corrected here:
 *
 *   1. OFF BY ONE. The original read the count *before* adding, then compared
 *      `count <= limit`. With a limit of 1000, a request arriving at count 1000 was
 *      allowed — every tier permitted limit + 1. The comparison is `count >= limit → deny`.
 *
 *   2. DENIED REQUESTS CONSUMED THE WINDOW. The original ran ZADD unconditionally, so a
 *      client already over its limit kept adding entries and kept pushing its own reset
 *      forward. A retry loop could hold itself out indefinitely, and the reset time
 *      returned to it was wrong. Denials are not recorded.
 *
 *   3. NOT ATOMIC. A pipeline is not a transaction. Between the count and the add,
 *      another of the 2–20 API tasks runs the same sequence, and both admit a request
 *      that should have been refused. Lua runs atomically inside Redis.
 *
 * `reset` is computed from the OLDEST entry plus the window, not `now + window`. The
 * window slides: the next slot frees when the oldest request ages out, which is sooner
 * than a full window away. Returning `now + window` overstates the wait and makes
 * well-behaved clients back off far longer than they need to.
 */

/**
 * Sliding-window log. One sorted-set member per request, so memory is O(limit).
 *
 * Only for small limits. `api/03` works it out: an enterprise tier of 1,000,000
 * requests/hour at ~90 bytes per entry is ~90 MB of Redis for one tenant's hourly
 * bucket, and ten such tenants exhaust a cache.m6g.large. Above ~1,000 the token bucket
 * is used instead.
 */
export const SLIDING_WINDOW_LOG = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])

local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[3]) then
    local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    return {0, count, oldest[2] or ARGV[1]}
end

redis.call('ZADD',    KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1, count + 1, 0}
`;

/**
 * Token bucket. Two hash fields regardless of limit, so memory is O(1).
 *
 * Also the better product fit: it permits a short burst — a page loading twenty
 * resources at once — while holding the sustained rate, which a fixed window does not.
 *
 * `cost` lets an expensive endpoint draw more than one token, so report generation is
 * throttled in proportion to what it actually consumes rather than needing its own
 * bucket.
 */
export const TOKEN_BUCKET = `
local state    = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local capacity = tonumber(ARGV[2])
local refill   = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])
local now      = tonumber(ARGV[1])

local tokens = tonumber(state[1]) or capacity
local ts     = tonumber(state[2]) or now

tokens = math.min(capacity, tokens + ((now - ts) / 1000) * refill)

if tokens < cost then
    local wait = math.ceil(((cost - tokens) / refill) * 1000)
    return {0, math.floor(tokens), wait}
end

redis.call('HSET',    KEYS[1], 'tokens', tokens - cost, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / refill) * 2000))
return {1, math.floor(tokens - cost), 0}
`;

/**
 * The threshold at which the algorithm changes.
 *
 * Below this a log is affordable and gives exact accounting, which is what the auth
 * endpoints want. Above it the log's memory cost is the problem `api/03` quantifies.
 */
export const LOG_ALGORITHM_MAX_LIMIT = 1_000;
