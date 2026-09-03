/**
 * Tenant configuration — consumer 2 in `performance/01`'s cache inventory.
 *
 * VERSION-STAMPED, not invalidated. `tenant_configurations.config_version` is a monotonic
 * counter, and it goes into the cache key. Updating configuration bumps the version, which
 * writes a new key; the old one expires on its own.
 *
 * That removes an entire class of bug rather than mitigating it. There is no invalidation
 * message to lose, no ordering race between the write and the invalidation, and no stale
 * read window — a reader either has the new version number and misses, or has the old one
 * and correctly reads old data. Both are right.
 *
 * The cost is one lightweight read of the version. `performance/01` suggests carrying it in
 * the JWT; that would remove the round trip entirely, but it also means a config change does
 * not take effect until the access token is refreshed, which is up to an hour. A short-TTL
 * pointer key is the compromise: the version is cached for seconds, the payload for minutes.
 */

import { withTenantContext, type VerifiedTenantContext } from '../db/context.js';
import { tryRedis, UNAVAILABLE } from '../redis/client.js';

export interface TenantConfig {
  readonly configVersion: number;
  readonly appName: string | null;
  readonly companyName: string | null;
  readonly primaryColor: string | null;
  readonly industryType: string | null;
  readonly features: Record<string, unknown>;
  readonly uiConfig: Record<string, unknown>;
}

/** Seconds. Short: it only bounds how long a version bump takes to be noticed. */
const POINTER_TTL = 10;
/** Minutes. The payload is immutable for a given version, so this can be generous. */
const PAYLOAD_TTL = 300;

const pointerKey = (tenantId: string) => `cfg:${tenantId}:ver`;
const payloadKey = (tenantId: string, version: number) => `cfg:${tenantId}:v:${version}`;

interface ConfigRow {
  config_version: number;
  app_name: string | null;
  company_name: string | null;
  primary_color: string | null;
  industry_type: string | null;
  features: Record<string, unknown> | null;
  ui_config: Record<string, unknown> | null;
}

function toConfig(row: ConfigRow): TenantConfig {
  return {
    configVersion: row.config_version,
    appName: row.app_name,
    companyName: row.company_name,
    primaryColor: row.primary_color,
    industryType: row.industry_type,
    features: row.features ?? {},
    uiConfig: row.ui_config ?? {},
  };
}

export async function tenantConfig(ctx: VerifiedTenantContext): Promise<TenantConfig | null> {
  const version = await currentVersion(ctx);

  if (version !== null) {
    const cached = await tryRedis('cache', (c) => c.get(payloadKey(ctx.tenantId, version)));
    if (cached !== UNAVAILABLE && cached) {
      try {
        return JSON.parse(cached) as TenantConfig;
      } catch {
        // A corrupt entry must not break the request; fall through and overwrite it.
      }
    }
  }

  const config = await withTenantContext(ctx, async (client) => {
    const result = await client.query<ConfigRow>(
      `SELECT config_version, app_name, company_name, primary_color,
              industry_type, features, ui_config
         FROM tenant_configurations
        LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? toConfig(row) : null;
  });

  if (!config) return null;

  await tryRedis('cache', (c) =>
    c.set(payloadKey(ctx.tenantId, config.configVersion), JSON.stringify(config),
      'EX', PAYLOAD_TTL));
  await tryRedis('cache', (c) =>
    c.set(pointerKey(ctx.tenantId), String(config.configVersion), 'EX', POINTER_TTL));

  return config;
}

async function currentVersion(ctx: VerifiedTenantContext): Promise<number | null> {
  const cached = await tryRedis('cache', (c) => c.get(pointerKey(ctx.tenantId)));
  if (cached !== UNAVAILABLE && cached) {
    const n = Number(cached);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Bump the version, which is what makes a change visible.
 *
 * Note what this does NOT do: delete anything. The old payload key is still there and still
 * correct for anyone holding the old version number — it simply stops being reachable and
 * expires. That is the property that makes version stamping safe under concurrency.
 */
export async function bumpConfigVersion(ctx: VerifiedTenantContext): Promise<number> {
  const version = await withTenantContext(ctx, async (client) => {
    const result = await client.query<{ config_version: number }>(
      `UPDATE tenant_configurations
          SET config_version = config_version + 1, updated_at = NOW()
        RETURNING config_version`,
    );
    return result.rows[0]?.config_version ?? 0;
  });

  // Drop the pointer so the next read sees the new version immediately rather than after
  // the pointer TTL. Best-effort: the TTL is the backstop if this fails.
  await tryRedis('cache', (c) => c.del(pointerKey(ctx.tenantId)));
  return version;
}
