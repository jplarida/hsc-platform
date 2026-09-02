/**
 * Which record types hold PHI.
 *
 * `record_type_definitions.is_phi` is the single switch that drives PHI read-logging
 * here, webhook payload restriction in `api/04`, marketplace scope tiers in `partners/02`
 * and de-identification in `analytics/01`. One definition, four consumers — which is why
 * it is read from the registry rather than inferred from a type name.
 *
 * Types are tenant-defined, so this is per-tenant and cached. Another cache over a table:
 * Redis down means slower, not wrong.
 */

import { withTenantContext, type VerifiedTenantContext } from '../db/context.js';
import { tryRedis, UNAVAILABLE } from '../redis/client.js';

const TTL_SECONDS = 300;
const key = (tenantId: string) => `rtd:${tenantId}:phi`;

/** The set of record type codes flagged is_phi for this tenant. */
async function phiTypesFor(ctx: VerifiedTenantContext): Promise<ReadonlySet<string>> {
  const cached = await tryRedis('cache', (client) => client.get(key(ctx.tenantId)));
  if (cached !== UNAVAILABLE && cached) {
    try {
      return new Set(JSON.parse(cached) as string[]);
    } catch {
      // Corrupt entry: fall through and overwrite rather than fail the request.
    }
  }

  const codes = await withTenantContext(ctx, async (client) => {
    const result = await client.query<{ code: string }>(
      `SELECT code FROM record_type_definitions WHERE is_phi = TRUE`,
    );
    return result.rows.map((r) => r.code);
  });

  await tryRedis('cache', (client) =>
    client.set(key(ctx.tenantId), JSON.stringify(codes), 'EX', TTL_SECONDS));

  return new Set(codes);
}

/**
 * Does this set of record types include any PHI?
 *
 * An UNKNOWN type counts as PHI. That is deliberate and it is the safe direction: a type
 * missing from the registry — a race with a pack install, a cache filled before the type
 * was created — must not silently produce an unlogged clinical read. Over-logging is a
 * storage cost; under-logging is a compliance failure that is invisible until an audit.
 */
export async function anyIsPhi(
  ctx: VerifiedTenantContext,
  types: readonly string[],
): Promise<boolean> {
  if (types.length === 0) return false;

  const phi = await phiTypesFor(ctx);
  const known = await knownTypesFor(ctx);

  return types.some((t) => phi.has(t) || !known.has(t));
}

const knownKey = (tenantId: string) => `rtd:${tenantId}:all`;

async function knownTypesFor(ctx: VerifiedTenantContext): Promise<ReadonlySet<string>> {
  const cached = await tryRedis('cache', (client) => client.get(knownKey(ctx.tenantId)));
  if (cached !== UNAVAILABLE && cached) {
    try {
      return new Set(JSON.parse(cached) as string[]);
    } catch {
      // As above.
    }
  }

  const codes = await withTenantContext(ctx, async (client) => {
    const result = await client.query<{ code: string }>(
      `SELECT code FROM record_type_definitions`,
    );
    return result.rows.map((r) => r.code);
  });

  await tryRedis('cache', (client) =>
    client.set(knownKey(ctx.tenantId), JSON.stringify(codes), 'EX', TTL_SECONDS));

  return new Set(codes);
}

/** Called when a type is created or its is_phi flag changes. */
export async function invalidateRecordTypes(tenantId: string): Promise<void> {
  await tryRedis('cache', (client) => client.del(key(tenantId), knownKey(tenantId)));
}
