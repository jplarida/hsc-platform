/**
 * The rate limiter.
 *
 * Limits come from `plans.limits`, not from code (`api/03`). Two consequences worth
 * stating: a plan upgrade takes effect within minutes rather than at the next deploy,
 * and "custom rate limits for enterprise" needs no code at all — it is a row edit.
 *
 * Buckets live on the STATE Redis instance, never the cache. On `volatile-lru` a limiter
 * window can be evicted under memory pressure, which silently resets the limit — the
 * exact failure `performance/01` separates the instances to prevent.
 */

import { redis, tryRedis } from '../redis/client.js';
import { LOG_ALGORITHM_MAX_LIMIT, SLIDING_WINDOW_LOG, TOKEN_BUCKET } from './scripts.js';

export type LimitScope = 'tenant' | 'user' | 'ip' | 'endpoint' | 'device';

export interface LimitRule {
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly scope: LimitScope;
  readonly cost?: number;
}

export interface LimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the next slot frees. */
  readonly resetSeconds: number;
  readonly scope: LimitScope;
  /** True when Redis gave no answer and the caller must apply its fallback policy. */
  readonly indeterminate: boolean;
}

/**
 * Evaluate one rule.
 *
 * Returns `indeterminate` rather than a decision when Redis is unreachable. It does not
 * decide the fallback itself, because the right fallback differs by endpoint: `/auth/*`
 * fails closed, everything else fails open (`api/03`, `performance/01`). A limiter that
 * silently picks one is a limiter that gets it wrong for half the routes.
 */
export async function checkLimit(rule: LimitRule, requestId: string): Promise<LimitDecision> {
  const now = Date.now();
  const cost = rule.cost ?? 1;

  const raw = await tryRedis('state', async (client) => {
    if (rule.limit <= LOG_ALGORITHM_MAX_LIMIT) {
      return (await client.eval(
        SLIDING_WINDOW_LOG, 1, rule.key,
        String(now), String(rule.windowMs), String(rule.limit), requestId,
      )) as [number, number, string | number];
    }
    // Refill rate that drains a full window's allowance over that window.
    const refillPerSecond = rule.limit / (rule.windowMs / 1000);
    return (await client.eval(
      TOKEN_BUCKET, 1, rule.key,
      String(now), String(rule.limit), String(refillPerSecond), String(cost),
    )) as [number, number, string | number];
  });

  if (raw === null) {
    return {
      allowed: false, limit: rule.limit, remaining: 0, resetSeconds: 0,
      scope: rule.scope, indeterminate: true,
    };
  }

  const [allowedFlag, countOrTokens, third] = raw;
  const allowed = allowedFlag === 1;

  if (rule.limit <= LOG_ALGORITHM_MAX_LIMIT) {
    const remaining = Math.max(0, rule.limit - Number(countOrTokens));
    // Reset from the oldest entry, not from now — the window slides.
    const oldestMs = Number(third) || now;
    const resetSeconds = allowed
      ? Math.ceil(rule.windowMs / 1000)
      : Math.max(1, Math.ceil((oldestMs + rule.windowMs - now) / 1000));
    return { allowed, limit: rule.limit, remaining, resetSeconds, scope: rule.scope, indeterminate: false };
  }

  const remaining = Number(countOrTokens);
  const resetSeconds = allowed ? 0 : Math.max(1, Math.ceil(Number(third) / 1000));
  return { allowed, limit: rule.limit, remaining, resetSeconds, scope: rule.scope, indeterminate: false };
}

/**
 * Key layout, following `performance/01`: every key is tenant-scoped.
 *
 * Not cosmetic. A key built from a record id alone collides across tenants, and RLS
 * never sees a cache read — so a tenant-blind key is a cross-tenant leak on a path the
 * database cannot protect.
 */
export const keys = {
  tenantHour: (tenantId: string) => `rl:${tenantId}:t:h`,
  userMinute: (tenantId: string, userId: string) => `rl:${tenantId}:u:${userId}:m`,
  endpoint: (tenantId: string, name: string, subject: string) =>
    `rl:${tenantId}:e:${name}:${subject}`,
  /**
   * Login buckets are pre-authentication, so there is no tenant yet, and the email is
   * hashed: an unauthenticated endpoint's keys should not turn a Redis dump into a list
   * of customer email addresses.
   */
  loginByIp: (ip: string) => `rl:anon:ip:${ip}:login`,
  loginByEmail: (emailSha256: string) => `rl:anon:em:${emailSha256}:login`,
};

/** Reset a bucket. Tests only — there is no production reason to clear a limit. */
export async function resetLimit(key: string): Promise<void> {
  await tryRedis('state', (client) => client.del(key));
}

export { redis };
