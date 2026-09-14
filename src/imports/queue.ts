/**
 * The import job queue.
 *
 * A Redis Stream with a consumer group, on the STATE instance.
 *
 * ## Why Redis holds a signal and not the job
 *
 * The obvious risk in putting jobs on a queue is ending up with two sources of truth: the
 * queue's idea of what is outstanding, and `import_jobs.status`. When they disagree — and
 * they will, because one of them is a cache and the other is a durable table — every
 * question about a job has two answers.
 *
 * So the stream carries the job id, the tenant and the actor, and nothing else. It is a
 * wake-up signal. Every fact about a job (status, counts, timestamps) lives in PostgreSQL,
 * and the endpoint that answers "how is my import going" reads the table, never the queue.
 *
 * That makes the failure modes small and boring:
 *
 *   * **Signal lost** (Redis restarted, stream trimmed, message never delivered) — the job
 *     sits at `pending`, and `sweepPendingJobs` re-enqueues it. Late, not lost.
 *   * **Signal delivered twice** (a retry, or a sweep racing a delivery) — the claim is a
 *     conditional UPDATE in PostgreSQL, so the second consumer claims nothing and stops.
 *   * **Redis unavailable when the job is created** — enqueue fails quietly and the sweep
 *     picks it up on its next pass. The request still returns 202, because the job is
 *     genuinely accepted: it is a durable row.
 *
 * ## Why not BullMQ
 *
 * It was the obvious candidate and it would work. Two things decided against it. It wants a
 * connection configured opposite to this codebase's (`maxRetriesPerRequest: null`, offline
 * queueing on, blocking reads) — `redis/client.ts` deliberately bounds all three so an
 * outage degrades rather than hangs, so BullMQ would need its own connection with its own
 * failure behaviour. And it stores job payloads, attempts and state in Redis, which is
 * precisely the second source of truth the design above is arranged to avoid.
 *
 * Streams give at-least-once delivery and `XAUTOCLAIM` for a consumer that died mid-job,
 * which is the part worth having, and nothing else.
 */

import { randomUUID } from 'node:crypto';
import { tryRedis, UNAVAILABLE } from '../redis/client.js';

/** STATE, never cache: on `volatile-lru` a pending signal can be evicted silently. */
const STREAM = 'imports:jobs';
const GROUP = 'workers';

/** Identifies this process within the consumer group. */
const CONSUMER = `w-${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * How long a message may sit unacknowledged before another consumer may take it.
 *
 * Longer than any import should take. Reclaiming a message from a consumer that is merely
 * slow means two workers racing for the same job — harmless, because the PostgreSQL claim
 * arbitrates, but it wastes a pass and muddies the logs.
 */
const STALLED_AFTER_MS = 5 * 60_000;

/** Cap the stream. Signals are worthless once consumed; this bounds a pathological backlog. */
const MAX_STREAM_LEN = 10_000;

export interface JobSignal {
  readonly messageId: string;
  readonly importJobId: string;
  readonly tenantId: string;
  readonly userId: string | null;
}

let groupReady = false;

/**
 * Create the consumer group, once.
 *
 * `MKSTREAM` so the group can be created before the first job exists. BUSYGROUP means
 * another process got there first, which is the normal case with more than one instance
 * and is not an error.
 */
async function ensureGroup(): Promise<boolean> {
  if (groupReady) return true;

  const result = await tryRedis('state', async (client) => {
    try {
      await client.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err as Error).message.includes('BUSYGROUP')) throw err;
    }
    return true;
  });

  if (result === UNAVAILABLE) return false;
  groupReady = true;
  return true;
}

/**
 * Signal that a job is ready to run.
 *
 * Never throws. A failure here is not a failed import — the row is committed and the sweep
 * is the backstop — so it must not turn a successful 202 into a 500.
 */
export async function enqueueJob(
  importJobId: string,
  tenantId: string,
  userId: string | null,
): Promise<boolean> {
  if (!(await ensureGroup())) return false;

  const result = await tryRedis('state', (client) =>
    client.xadd(
      STREAM, 'MAXLEN', '~', String(MAX_STREAM_LEN), '*',
      'job', importJobId,
      'tenant', tenantId,
      'user', userId ?? '',
    ));

  return result !== UNAVAILABLE;
}

/** Parse one `XREADGROUP`/`XAUTOCLAIM` entry. Malformed entries are dropped, not thrown on. */
function toSignal(id: string, fields: readonly string[]): JobSignal | null {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    map.set(fields[i] as string, fields[i + 1] as string);
  }
  const importJobId = map.get('job');
  const tenantId = map.get('tenant');
  if (!importJobId || !tenantId) return null;
  const userId = map.get('user');
  return { messageId: id, importJobId, tenantId, userId: userId ? userId : null };
}

type StreamReply = [string, [string, string[]][]][] | null;

/**
 * Take up to `count` signals.
 *
 * Deliberately non-blocking. `redis/client.ts` sets a 500 ms command timeout and disables
 * offline queueing, both on purpose; a blocking `XREADGROUP` would trip the timeout on
 * every idle poll and fill the log with failures that mean nothing. The worker polls on an
 * interval instead, exactly like the audit writer.
 */
export async function takeJobs(count: number): Promise<readonly JobSignal[]> {
  if (!(await ensureGroup())) return [];

  const reply = await tryRedis('state', (client) =>
    client.xreadgroup(
      'GROUP', GROUP, CONSUMER, 'COUNT', String(count), 'STREAMS', STREAM, '>',
    ) as Promise<StreamReply>);

  if (reply === UNAVAILABLE || !reply) return [];

  const signals: JobSignal[] = [];
  for (const [, entries] of reply) {
    for (const [id, fields] of entries) {
      const signal = toSignal(id, fields);
      if (signal) signals.push(signal);
      else await acknowledge(id);
    }
  }
  return signals;
}

/**
 * Reclaim messages abandoned by a consumer that died mid-job.
 *
 * Without this a worker crashing between delivery and acknowledgement leaves the message
 * pending against a consumer that no longer exists, and no one else may take it. The job
 * row would stay `running` — which the sweep deliberately does not rescue, because it
 * cannot tell a dead worker from a slow one. This can, because Redis tracks idle time.
 */
export async function reclaimStalled(count: number): Promise<readonly JobSignal[]> {
  if (!(await ensureGroup())) return [];

  const reply = await tryRedis('state', (client) =>
    client.xautoclaim(
      STREAM, GROUP, CONSUMER, String(STALLED_AFTER_MS), '0', 'COUNT', String(count),
    ) as Promise<[string, [string, string[]][], string[]] | null>);

  if (reply === UNAVAILABLE || !reply) return [];

  const [, entries] = reply;
  const signals: JobSignal[] = [];
  for (const [id, fields] of entries) {
    const signal = toSignal(id, fields);
    if (signal) signals.push(signal);
    else await acknowledge(id);
  }
  return signals;
}

/**
 * Acknowledge and delete.
 *
 * `XACK` alone leaves the entry in the stream until `MAXLEN` trims it; `XDEL` reclaims the
 * memory now. The signal has no value once the job has been claimed in PostgreSQL.
 */
export async function acknowledge(messageId: string): Promise<void> {
  await tryRedis('state', async (client) => {
    await client.xack(STREAM, GROUP, messageId);
    await client.xdel(STREAM, messageId);
    return true;
  });
}

/** Tests only. */
export async function resetQueueForTest(): Promise<void> {
  groupReady = false;
  await tryRedis('state', (client) => client.del(STREAM));
}
