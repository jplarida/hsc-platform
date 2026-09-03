/**
 * Cross-task cache invalidation over Redis pub/sub.
 *
 * `performance/01` applies three invalidation strategies deliberately rather than
 * uniformly, and this is the third: needed only where staleness is a *security* issue.
 *
 * Session revocation is that case. A 60-second TTL is fine for an ordinary logout and is
 * not fine for a compromised account — the whole point of revoking is that it takes effect
 * now. With 2–20 API tasks, one task deleting its own cache entry does nothing for the
 * other nineteen, which will happily keep admitting the revoked token until their copies
 * expire.
 *
 * PUB/SUB IS BEST EFFORT. A task that was disconnected at the moment of publication never
 * receives the message. So the TTL stays as a backstop rather than being replaced by this —
 * belt and braces, because the failure mode is a live session that should be dead.
 *
 * The subscriber needs its own connection: a Redis client in subscriber mode cannot run
 * ordinary commands, so sharing the cache client would break every read on the process.
 */

import { Redis } from 'ioredis';

const CHANNEL = 'cache:invalidate';

export interface InvalidationMessage {
  readonly ns: string;
  readonly tenant: string;
  readonly key: string;
}

type Handler = (message: InvalidationMessage) => void | Promise<void>;

let subscriber: Redis | undefined;
const handlers = new Set<Handler>();

function stateUrl(): string {
  const url = process.env['REDIS_STATE_URL'];
  if (!url) throw new Error('REDIS_STATE_URL is not set');
  return url;
}

/** Start listening. Idempotent; safe to call from every task at boot. */
export function startInvalidationListener(): void {
  if (subscriber) return;

  subscriber = new Redis(stateUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: null,     // a subscriber reconnects rather than failing commands
    enableOfflineQueue: true,
  });

  subscriber.on('error', (err: Error) => {
    console.warn(`[invalidation] ${err.message}`);
  });

  subscriber.on('message', (_channel: string, payload: string) => {
    let message: InvalidationMessage;
    try {
      message = JSON.parse(payload) as InvalidationMessage;
    } catch {
      return;
    }
    for (const handler of handlers) {
      void Promise.resolve(handler(message)).catch((err: unknown) => {
        console.warn(`[invalidation] handler failed: ${(err as Error).message}`);
      });
    }
  });

  void subscriber.connect()
    .then(() => subscriber?.subscribe(CHANNEL))
    .catch(() => undefined);
}

export function onInvalidate(handler: Handler): void {
  handlers.add(handler);
}

/**
 * Announce an invalidation to every task.
 *
 * Published on the STATE connection rather than the cache one, so a cache eviction policy
 * can never interfere with delivery. Failure is swallowed deliberately: the caller has
 * already dropped its own copy and the TTL will catch the rest, so a publish failure must
 * not fail the revocation that prompted it.
 */
export async function publishInvalidation(message: InvalidationMessage): Promise<void> {
  const { redis } = await import('./client.js');
  try {
    await redis('state').publish(CHANNEL, JSON.stringify(message));
  } catch (err) {
    console.warn(`[invalidation] publish failed: ${(err as Error).message}`);
  }
}

export async function stopInvalidationListener(): Promise<void> {
  handlers.clear();
  if (subscriber) {
    await subscriber.quit().catch(() => undefined);
    subscriber = undefined;
  }
}
