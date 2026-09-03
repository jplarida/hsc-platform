/**
 * Process entry point.
 *
 * Kept separate from `app.ts` so tests can build an app without binding a port.
 */

import { createApp } from './app.js';
import { closePool } from './db/context.js';
import { closeRedis, waitForReady } from './redis/client.js';
import { startAuditWriter, stopAuditWriter } from './audit/phiLog.js';
import { startInvalidationListener, stopInvalidationListener } from './redis/invalidation.js';
import { subscribeToSessionInvalidation } from './services/sessions.js';

const port = Number(process.env['PORT'] ?? 3001);

// Warm the connections before accepting traffic. Not required for correctness — every
// consumer falls through — but a limiter that answers indeterminate for the first
// requests after a deploy fails open exactly when a restart storm makes that worst.
await Promise.all([waitForReady('cache'), waitForReady('state')]);

startAuditWriter();
startInvalidationListener();
subscribeToSessionInvalidation();

const server = createApp().listen(port, () => {
  console.log(`hsc-platform api listening on :${port}`);
});

// Drain rather than drop. An in-flight request holds an open transaction, and killing
// the process mid-transaction rolls it back — which is safe, but returns a 502 to a
// caller whose write actually could have completed.
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, draining`);
  server.close(async () => {
    // Flush before the pool closes, or queued events die with the process.
    await stopAuditWriter();
    await stopInvalidationListener();
    await closePool();
    await closeRedis();
    process.exit(0);
  });
  // Bounded: a hung connection must not keep the process alive indefinitely.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
