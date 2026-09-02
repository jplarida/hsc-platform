/**
 * Resolved plan limits for a tenant.
 *
 * `api/03`: the limiter reads the plan, and the four tiers `API_ARCHITECTURE.md`
 * hard-codes become seed data. Another cache over a table, so Redis being down makes
 * this slower rather than wrong.
 */

import { withTenantContext, type VerifiedTenantContext } from '../db/context.js';
import { tryRedis, UNAVAILABLE } from '../redis/client.js';

export interface PlanLimits {
  readonly requestsPerHour: number;
  readonly userRequestsPerMinute: number;
  readonly maxUploadBytes: number;
  readonly storageBytes: number;
}

/**
 * Used when a tenant has no live subscription at all — a trial that lapsed, or a
 * provisioning state. Deliberately the smallest tier rather than unlimited: an absent
 * plan must not read as "no limit", which is the failure mode where a billing edge case
 * becomes an availability incident.
 */
const FALLBACK: PlanLimits = {
  requestsPerHour: 1_000,
  userRequestsPerMinute: 100,
  maxUploadBytes: 50 * 1024 * 1024,
  storageBytes: 1024 ** 3,
};

const TTL_SECONDS = 300;
const key = (tenantId: string) => `plan:${tenantId}:limits`;

interface PlanRow {
  limits: Record<string, unknown> | null;
}

function toNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function planLimitsFor(ctx: VerifiedTenantContext): Promise<PlanLimits> {
  const cacheKey = key(ctx.tenantId);

  const cached = await tryRedis('cache', (client) => client.get(cacheKey));
  if (cached !== UNAVAILABLE && cached) {
    try {
      return JSON.parse(cached) as PlanLimits;
    } catch {
      // A corrupt entry must not break the request; fall through and overwrite it.
    }
  }

  const limits = await withTenantContext(ctx, async (client) => {
    const result = await client.query<PlanRow>(
      `SELECT p.limits
         FROM subscriptions s
         JOIN plans p ON p.plan_id = s.plan_id
        WHERE s.status IN ('trialing', 'active', 'past_due')
        LIMIT 1`,
    );
    const raw = result.rows[0]?.limits ?? null;
    if (!raw) return FALLBACK;

    return {
      requestsPerHour: toNumber(raw['requests_per_hour'], FALLBACK.requestsPerHour),
      userRequestsPerMinute: toNumber(raw['user_requests_per_minute'], FALLBACK.userRequestsPerMinute),
      maxUploadBytes: toNumber(raw['max_upload_bytes'], FALLBACK.maxUploadBytes),
      storageBytes: toNumber(raw['storage_bytes'], FALLBACK.storageBytes),
    };
  });

  await tryRedis('cache', (client) =>
    client.set(cacheKey, JSON.stringify(limits), 'EX', TTL_SECONDS));

  return limits;
}

/** Called when a subscription changes, so an upgrade takes effect in seconds. */
export async function invalidatePlanLimits(tenantId: string): Promise<void> {
  await tryRedis('cache', (client) => client.del(key(tenantId)));
}
