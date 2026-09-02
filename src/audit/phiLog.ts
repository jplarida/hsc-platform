/**
 * PHI access logging — the write path.
 *
 * HIPAA 164.312(b) requires recording *access* to PHI, and `database/04` establishes
 * that a database trigger cannot observe a SELECT. Every other audit path has a trigger
 * behind it that catches the application when it forgets; this one does not. Reads are
 * logged here or they are not logged at all.
 *
 * The delivery guarantee is the hard part, and `api/06` is precise about it: never block
 * the response on the audit write, but never drop the event either. Writing synchronously
 * adds a round trip to every PHI read; fire-and-forget loses events on crash. So events
 * go to a bounded in-process queue drained by a background writer — and if that queue
 * saturates or the writer is failing, THE API STOPS ACCEPTING REQUESTS.
 *
 * That last part is the whole design. An audit trail that silently degrades under load is
 * worse than no audit trail, because it looks complete. Refusing traffic is the correct
 * response to being unable to record what you served.
 */

import { getPool } from '../db/context.js';

export type AuditAction = 'view' | 'create' | 'update' | 'delete' | 'export' | 'access_denied';

export interface PhiAccessEvent {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly appId: string | null;
  readonly installationId: string | null;
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly isPhiAccess: boolean;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly details: Record<string, unknown>;
  readonly at: Date;
}

/**
 * Bounded. The bound is the point: an unbounded queue converts a writer outage into a
 * memory leak and then a crash that loses every queued event at once.
 */
const MAX_QUEUE = Number(process.env['AUDIT_QUEUE_MAX'] ?? 5_000);
const DRAIN_INTERVAL_MS = 250;
const BATCH_SIZE = 200;

/** Consecutive write failures before the writer is declared unhealthy. */
const FAILURE_THRESHOLD = 3;

const queue: PhiAccessEvent[] = [];
let consecutiveFailures = 0;
/**
 * Events spliced out of the queue but not yet committed.
 *
 * Without this the depth check is unreachable: drain() removes a batch SYNCHRONOUSLY
 * before its first await, so a burst tops out at MAX_QUEUE - BATCH_SIZE and the gate
 * never trips. The in-flight batch is still unwritten and still at risk, so it counts.
 */
let inFlight = 0;
let draining = false;
let timer: NodeJS.Timeout | undefined;

export interface AuditHealth {
  readonly healthy: boolean;
  readonly queueDepth: number;
  readonly consecutiveFailures: number;
  readonly reason: string | null;
}

/**
 * Whether the API may keep accepting requests.
 *
 * Read by the gate middleware BEFORE the handler runs. Checking after would mean the
 * request had already been served — and the entire point is not to serve PHI that cannot
 * be recorded.
 */
export function auditHealth(): AuditHealth {
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    return {
      healthy: false, queueDepth: queue.length + inFlight, consecutiveFailures,
      reason: 'audit writer is failing',
    };
  }
  if (queue.length + inFlight >= MAX_QUEUE) {
    return {
      healthy: false, queueDepth: queue.length + inFlight, consecutiveFailures,
      reason: 'audit queue is saturated',
    };
  }
  return { healthy: true, queueDepth: queue.length + inFlight, consecutiveFailures, reason: null };
}

/** Enqueue. Never throws and never blocks — the caller is on the response path. */
export function recordAccess(event: PhiAccessEvent): void {
  if (queue.length + inFlight >= MAX_QUEUE) {
    // Already saturated; the gate will have started refusing new requests. Dropping here
    // is visible rather than silent, which is the difference that matters.
    console.error(
      `[audit] queue saturated at ${MAX_QUEUE}, dropping event for tenant ${event.tenantId}`,
    );
    return;
  }
  queue.push(event);
  if (queue.length + inFlight >= BATCH_SIZE) {
    // .catch, not void. drain() is async, so a synchronous throw inside it — a missing
    // DATABASE_URL, a pool that will not construct — becomes a rejected promise, and a
    // discarded rejected promise is an unhandled rejection that takes the process down.
    // recordAccess sits on the response path and is documented as never throwing; a
    // bare void here made that untrue.
    drain().catch((err: unknown) => {
      console.error(`[audit] drain failed: ${(err as Error).message}`);
    });
  }
}

/**
 * Write a batch.
 *
 * Runs as the platform role rather than through withTenantContext: a single batch spans
 * tenants, and the writer legitimately crosses that boundary — it is the same reason
 * app_platform exists for the webhook sweep and the usage rollup.
 */
async function drain(): Promise<void> {
  if (draining || queue.length === 0) return;
  draining = true;

  const batch = queue.splice(0, BATCH_SIZE);
  inFlight = batch.length;
  const client = await getPool().connect().catch(() => null);

  if (!client) {
    // Could not even get a connection. Put the batch back at the FRONT — order matters
    // less than not losing it, and unshifting keeps the oldest events oldest.
    queue.unshift(...batch);
    inFlight = 0;
    consecutiveFailures += 1;
    draining = false;
    return;
  }

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_platform');

    // One multi-row insert rather than N statements: at 200 events a batch, per-statement
    // round trips are the difference between keeping up and falling behind.
    const values: unknown[] = [];
    const tuples = batch.map((e, i) => {
      const o = i * 12;
      values.push(
        e.tenantId, e.userId, e.sessionId, e.appId, e.installationId,
        e.action, e.resourceType, e.resourceId, e.isPhiAccess,
        e.ipAddress, e.userAgent, JSON.stringify(e.details),
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},` +
             `$${o + 8},$${o + 9},$${o + 10},$${o + 11},$${o + 12}::jsonb)`;
    });

    await client.query(
      `INSERT INTO user_audit_log
         (tenant_id, user_id, session_id, app_id, installation_id,
          action, resource_type, resource_id, is_phi_access,
          ip_address, user_agent, details)
       VALUES ${tuples.join(',')}`,
      values,
    );
    await client.query('COMMIT');
    consecutiveFailures = 0;
    inFlight = 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    queue.unshift(...batch);
    inFlight = 0;
    consecutiveFailures += 1;
    console.error(`[audit] batch write failed (${consecutiveFailures}):`, (err as Error).message);
  } finally {
    client.release();
    draining = false;
  }
}

export function startAuditWriter(): void {
  if (timer) return;
  timer = setInterval(() => {
    drain().catch((err: unknown) => {
      console.error(`[audit] scheduled drain failed: ${(err as Error).message}`);
    });
  }, DRAIN_INTERVAL_MS);
  // Deliberately NOT unref'd. An unref'd timer lets the process exit with events still
  // queued, which is exactly the silent loss this design exists to prevent. Shutdown
  // goes through stopAuditWriter, which flushes.
}

/** Flush and stop. Called on shutdown, so a drain is not lost to a deploy. */
export async function stopAuditWriter(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  // Bounded attempts: a permanently failing writer must not block shutdown forever.
  for (let i = 0; i < 20 && queue.length > 0; i += 1) {
    await drain();
    if (draining) await new Promise((r) => setTimeout(r, 50));
  }
  if (queue.length > 0) {
    console.error(`[audit] shutting down with ${queue.length} unwritten events`);
  }
}

/**
 * Tests only.
 *
 * The initial settle is not decoration. Events are enqueued from a res.on('finish')
 * handler that does async work first — resolving whether the returned record types are
 * PHI — so at the moment a test's fetch() resolves, the event has not been queued yet.
 * Flushing immediately measures an empty queue and the assertion passes for the wrong
 * reason, or fails for one.
 */
export async function flushAuditForTest(): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 50 && (queue.length > 0 || inFlight > 0); i += 1) {
    await drain();
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Tests only. */
export function resetAuditForTest(): void {
  queue.length = 0;
  inFlight = 0;
  consecutiveFailures = 0;
}
