/**
 * The import worker.
 *
 * Polls the queue on an interval, exactly like the audit writer, and for the same reason:
 * `redis/client.ts` bounds command timeouts and disables offline queueing so an outage
 * degrades instead of hanging, and a blocking read would fight all three.
 *
 * Three sources of work, in descending order of how much they should happen:
 *
 *   1. `takeJobs`       — the normal path. A signal was published and delivered.
 *   2. `reclaimStalled` — a consumer died between delivery and acknowledgement. Redis knows
 *                         how long the message has been idle; PostgreSQL cannot tell a dead
 *                         worker from a slow one, so this is the only thing that can.
 *   3. `sweepPendingJobs` — the signal never arrived at all: Redis was down when the job was
 *                         created, or the stream was trimmed or flushed. This is what keeps
 *                         PostgreSQL authoritative rather than merely nominally so.
 *
 * Without (3), "job state lives in PostgreSQL" would be a claim the system does not honour:
 * a lost signal would leave a `pending` row that nothing ever looks at again, and the
 * customer would be told their import is queued forever.
 */

import { getPool } from '../db/context.js';
import { claimJob, runJob } from './pipeline.js';
import { acknowledge, enqueueJob, reclaimStalled, takeJobs } from './queue.js';

const POLL_INTERVAL_MS = Number(process.env['IMPORT_POLL_MS'] ?? 500);

/** How often to look for jobs the queue never told us about. */
const SWEEP_INTERVAL_MS = Number(process.env['IMPORT_SWEEP_MS'] ?? 30_000);

/**
 * Grace before the sweep adopts a `pending` job.
 *
 * A job is enqueued immediately after its row commits, so a `pending` row a second old is
 * almost certainly in flight. Re-enqueueing it would be harmless — the claim arbitrates —
 * but it would mean every import got queued twice under normal operation, which makes the
 * logs lie about how often the backstop is needed.
 */
const SWEEP_GRACE_MS = 60_000;

const MAX_PER_POLL = 4;

let timer: NodeJS.Timeout | undefined;
let sweepTimer: NodeJS.Timeout | undefined;
let running = false;
let inFlight = 0;

/** Visible for tests and for an operator asking whether the worker is doing anything. */
export function importWorkerDepth(): number {
  return inFlight;
}

async function handle(signal: {
  messageId: string; importJobId: string; tenantId: string; userId: string | null;
}, allowStalled: boolean): Promise<void> {
  inFlight += 1;
  try {
    const job = await claimJob(signal.tenantId, signal.userId, signal.importJobId, {
      allowStalled,
    });
    // No row means someone else owns it, or it is already finished. Either way this
    // delivery is spent, so acknowledge it rather than leaving it to be reclaimed forever.
    if (job) await runJob(job);
    await acknowledge(signal.messageId);
  } catch (err) {
    console.error(`[import] handling ${signal.importJobId} failed:`, (err as Error).message);
    // NOT acknowledged. Leaving it pending in the consumer group is what lets XAUTOCLAIM
    // hand it to another worker; acknowledging here would silently discard the job.
  } finally {
    inFlight -= 1;
  }
}

/** Returns how many jobs this cycle handled, which is what lets a test drain deterministically. */
async function poll(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const fresh = await takeJobs(MAX_PER_POLL);
    for (const signal of fresh) await handle(signal, false);

    if (fresh.length === 0) {
      const stalled = await reclaimStalled(MAX_PER_POLL);
      for (const signal of stalled) await handle(signal, true);
      return stalled.length;
    }
    return fresh.length;
  } finally {
    running = false;
  }
}

/**
 * Find jobs the queue forgot and put them back on it.
 *
 * Runs as `app_platform`, because finding work means looking across every tenant — the same
 * justification the audit writer and the webhook sweep use. It deliberately only re-enqueues
 * a *signal*; the claim still happens as `app_user` inside the job's own tenant, so nothing
 * here widens what the loader itself is allowed to touch.
 *
 * Only `pending` jobs. A `running` job that is genuinely stuck is the queue's problem to
 * redeliver, because idle time is the only reliable evidence of a dead worker and Redis is
 * the only thing that has it.
 */
export async function sweepPendingJobs(): Promise<number> {
  const client = await getPool().connect().catch(() => null);
  if (!client) return 0;

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_platform');
    const result = await client.query<{
      import_job_id: string; tenant_id: string; created_by: string | null;
    }>(
      `SELECT import_job_id, tenant_id, created_by
         FROM import_jobs
        WHERE status = 'pending'
          AND created_at < NOW() - ($1 || ' milliseconds')::interval
        ORDER BY created_at
        LIMIT 100`,
      [String(SWEEP_GRACE_MS)],
    );
    await client.query('COMMIT');

    let requeued = 0;
    for (const row of result.rows) {
      if (await enqueueJob(row.import_job_id, row.tenant_id, row.created_by)) requeued += 1;
    }
    if (requeued > 0) {
      console.warn(`[import] sweep re-enqueued ${requeued} job(s) the queue had lost`);
    }
    return requeued;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[import] sweep failed:', (err as Error).message);
    return 0;
  } finally {
    client.release();
  }
}

export function startImportWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    poll().catch((err: unknown) => {
      console.error('[import] poll failed:', (err as Error).message);
    });
  }, POLL_INTERVAL_MS);
  // unref'd, unlike the audit writer's. A queued import is a durable row that the sweep
  // will find after a restart, so holding the process open for it buys nothing — whereas
  // an unwritten audit event exists only in memory and is genuinely lost on exit.
  timer.unref();

  sweepTimer = setInterval(() => {
    sweepPendingJobs().catch((err: unknown) => {
      console.error('[import] sweep failed:', (err as Error).message);
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export async function stopImportWorker(): Promise<void> {
  if (timer) { clearInterval(timer); timer = undefined; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined; }
  // Let an in-flight job finish rather than abandoning it mid-transaction. Bounded: a job
  // wedged on a slow query must not hold up a deploy indefinitely, and leaving it `running`
  // is recoverable because the stall reclaim exists.
  for (let i = 0; i < 100 && inFlight > 0; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Tests only: run the queue dry, synchronously.
 *
 * `poll` awaits every job it takes, so a cycle that takes nothing means there is nothing
 * left. Returning on that rather than sleeping a fixed number of times is the difference
 * between a suite that finishes in seconds and one that spends its time waiting to be told
 * what it already knows.
 */
export async function drainImportsForTest(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await poll() === 0) return;
  }
}
