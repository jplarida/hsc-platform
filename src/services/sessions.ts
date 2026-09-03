/**
 * Session validity — stage 7.
 *
 * Without this, a revoked session's access token keeps working until it expires. Logout,
 * password change, admin revocation and refresh-token reuse detection all write
 * `sessions.revoked_at`, and none of them mean anything if nothing reads it.
 *
 * This is a CACHE OVER A TABLE, and that framing is the answer to a question `api/01`
 * and `api/06` both left open. When Redis is unavailable the check does not have to
 * choose between security and availability — it queries `sessions` directly. Slower,
 * still correct. `performance/01` resolves it that way, and better than either of the
 * fail-open/fail-closed options those documents offered.
 *
 * The cost is real and worth stating: a Redis outage turns every request into a session
 * query, so the fall-through path is a database load multiplier. `database/08`'s
 * connection saturation alarm is the one to watch during a cache incident.
 */

import { withTenantContext, type VerifiedTenantContext } from '../db/context.js';
import { tryRedis, UNAVAILABLE } from '../redis/client.js';
import { onInvalidate, publishInvalidation } from '../redis/invalidation.js';

/** Seconds. Short, because it bounds how long a revoked session keeps working. */
const TTL_SECONDS = 60;

const key = (tenantId: string, sessionId: string) => `sess:${tenantId}:s:${sessionId}`;

export type SessionState = 'live' | 'revoked' | 'unknown';

/**
 * Is this session still live?
 *
 * `unknown` is returned only when the session does not exist at all — which is treated
 * as revoked by the caller, since a token naming a session that was never recorded is
 * not a token to trust.
 */
export async function isSessionLive(
  ctx: VerifiedTenantContext,
  sessionId: string,
): Promise<SessionState> {
  const cacheKey = key(ctx.tenantId, sessionId);

  const cached = await tryRedis('cache', (client) => client.get(cacheKey));
  // UNAVAILABLE and a cache miss take the same path — straight to the table — but they
  // are written separately so the fall-through is a decision a reader can see rather
  // than a consequence of a symbol never equalling a string.
  if (cached !== UNAVAILABLE) {
    if (cached === 'live') return 'live';
    if (cached === 'revoked') return 'revoked';
  }

  // Cache miss, or Redis unavailable. Fall through to the table — the source of truth is
  // right there, which is why this needs no availability trade-off.
  const state = await withTenantContext(ctx, async (client) => {
    const result = await client.query<{ revoked_at: Date | null; expires_at: Date }>(
      `SELECT revoked_at, expires_at FROM sessions WHERE session_id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) return 'unknown' as const;
    if (row.revoked_at !== null) return 'revoked' as const;
    if (row.expires_at.getTime() <= Date.now()) return 'revoked' as const;
    return 'live' as const;
  });

  // A negative result is cached too. Without that, a revoked token hammers the database
  // on every retry — and a client whose session was just killed retries hard.
  if (state !== 'unknown') {
    await tryRedis('cache', (client) => client.set(cacheKey, state, 'EX', TTL_SECONDS));
  }
  return state;
}

/**
 * Drop a session's cache entry.
 *
 * Called synchronously by every revocation path. Without it a logout takes up to
 * TTL_SECONDS to take effect, which is precisely the window this design exists to close.
 */
export async function invalidateSession(tenantId: string, sessionId: string): Promise<void> {
  await tryRedis('cache', (client) => client.del(key(tenantId, sessionId)));
  // Drop it everywhere, not just here. With 2-20 API tasks, deleting the local copy leaves
  // every other task admitting the revoked token until its own copy expires - up to the
  // full TTL. That is fine for an ordinary logout and not fine for a compromised account,
  // which is the case revocation exists for.
  await publishInvalidation({ ns: 'sess', tenant: tenantId, key: sessionId });
}

/** Registered at boot so a revocation published by another task lands here too. */
export function subscribeToSessionInvalidation(): void {
  onInvalidate(async (message) => {
    if (message.ns !== 'sess') return;
    await tryRedis('cache', (c) => c.del(key(message.tenant, message.key)));
  });
}
