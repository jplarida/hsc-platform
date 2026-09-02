/**
 * The two Redis connections.
 *
 * `performance/01` is emphatic that cache and state must NOT share an instance. Under
 * memory pressure `allkeys-lru` evicts rate-limiter windows, idempotency keys and
 * circuit-breaker state alongside ordinary cache entries — and nothing errors. The limit
 * silently resets, a retried request creates a duplicate charge, the breaker forgets an
 * open circuit. Two instances, two eviction policies:
 *
 *   cache  → volatile-lru, may drop anything, every consumer falls through to its source
 *   state  → noeviction, an OOM here must be a loud error rather than a silent loss
 *
 * Neither connection is allowed to take the process down. `lazyConnect` plus a bounded
 * retry means a Redis outage degrades the platform rather than preventing it from
 * starting — which is the whole point of the fall-through design.
 */

import { Redis } from 'ioredis';

export type RedisRole = 'cache' | 'state';

const clients = new Map<RedisRole, Redis>();

function urlFor(role: RedisRole): string {
  const key = role === 'cache' ? 'REDIS_CACHE_URL' : 'REDIS_STATE_URL';
  const url = process.env[key];
  if (!url) throw new Error(`${key} is not set`);
  return url;
}

export function redis(role: RedisRole): Redis {
  let client = clients.get(role);
  if (client) return client;

  client = new Redis(urlFor(role), {
    lazyConnect: true,
    // Bounded. The default retries forever with growing backoff, which turns a
    // dependency outage into a queue of stuck commands rather than a fast failure that
    // the fall-through path can handle.
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 500,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
    enableOfflineQueue: false,
  });

  // An unhandled 'error' event on an ioredis client is a process-level crash. A cache
  // being unreachable must never do that.
  client.on('error', (err: Error) => {
    console.warn(`[redis:${role}] ${err.message}`);
  });

  void client.connect().catch(() => undefined);
  clients.set(role, client);
  return client;
}

/** True when the connection is usable right now. Callers fall through when it is not. */
export function isReady(role: RedisRole): boolean {
  return clients.get(role)?.status === 'ready';
}

/**
 * Wait for a connection to become usable, up to `timeoutMs`.
 *
 * Connections are lazy, so the first request after boot can arrive before Redis is
 * ready — and a limiter that answers "indeterminate" for the first few requests of every
 * deploy is a limiter that fails open exactly when a restart storm makes that worst.
 *
 * Called once at startup, never on the request path: blocking a request on a Redis
 * handshake is precisely the coupling the fall-through design exists to avoid.
 */
export async function waitForReady(role: RedisRole, timeoutMs = 2_000): Promise<boolean> {
  const client = redis(role);
  if (client.status === 'ready') return true;

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      resolve(false);
    }, timeoutMs);

    function onReady(): void {
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(true);
    }
    client.once('ready', onReady);
  });
}

export async function closeRedis(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.quit().catch(() => undefined)));
  clients.clear();
}

/**
 * Returned when Redis could not answer at all.
 *
 * A distinct symbol, NOT null. Redis legitimately replies null for several commands —
 * GET on an absent key, and crucially SET..NX when the key already exists — so using
 * null as the "no answer" sentinel conflates a real reply with an outage.
 *
 * That collision is not hypothetical: it silently disabled idempotency entirely. Every
 * replay attempt read SET..NX's null as "store unavailable", took the fail-open branch,
 * and re-executed the request. The mechanism looked present and did nothing.
 */
export const UNAVAILABLE = Symbol('redis-unavailable');

/**
 * Run a Redis operation.
 *
 * Returns UNAVAILABLE if Redis cannot answer. Every caller must distinguish that from a
 * negative reply: treating an unreachable cache as a "no" is how a Redis outage becomes
 * a mass logout or a platform-wide 403.
 */
export async function tryRedis<T>(
  role: RedisRole,
  fn: (client: Redis) => Promise<T>,
): Promise<T | typeof UNAVAILABLE> {
  const client = redis(role);
  if (client.status !== 'ready') return UNAVAILABLE;
  try {
    return await fn(client);
  } catch (err) {
    console.warn(`[redis:${role}] command failed: ${(err as Error).message}`);
    return UNAVAILABLE;
  }
}
