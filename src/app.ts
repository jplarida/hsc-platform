/**
 * Application wiring.
 *
 * The order of `app.use` calls below IS the stage order from `api/06`. Changing it is a
 * security change, not a refactor — see the header of `middleware/stack.ts` for why
 * authentication must precede tenant binding.
 */

import express, { type Express, type Request, type Response } from 'express';
import {
  requestContext,
  securityHeaders,
  authenticate,
  checkSession,
  bindTenant,
  errorHandler,
} from './middleware/stack.js';
import { rateLimit } from './middleware/rateLimit.js';
import { auditGate, auditAccess } from './middleware/phiAudit.js';
import { recordsRouter } from './routes/records.js';

export function createApp(): Express {
  const app = express();

  // Express advertises itself in a response header by default; there is no reason to
  // tell an attacker which server and version they are talking to.
  app.disable('x-powered-by');

  // 1 — request context
  app.use(requestContext);
  // 2 — security headers
  app.use(securityHeaders);
  // 4 — body limits, before authentication. api/06 correction 7: otherwise a 5 GB
  // unauthenticated body is buffered before anything decides to reject it.
  app.use(express.json({ limit: '1mb' }));

  // Unauthenticated. Deliberately above the auth middleware, and deliberately empty of
  // anything that touches the database or reveals a version number.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // 6 authentication, 7 session check, 8 tenant binding, 9 rate limit. The order is
  // api/06's and is load-bearing: the session check needs sid from verified claims, and
  // the limiter needs the tenant to resolve its plan.
  // 14a runs BEFORE the handler: if the audit writer cannot keep up, no PHI is served
  // at all. Checking afterwards would mean it had already gone out.
  // 14b attaches to the response and records what was read once it succeeds.
  app.use('/v1', auditGate, authenticate, checkSession, bindTenant, rateLimit(), auditAccess);
  app.use('/v1/records', recordsRouter);

  // 17 — error handler, registered last so it wraps everything above.
  app.use(errorHandler);

  return app;
}
