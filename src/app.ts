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
  bindTenant,
  errorHandler,
} from './middleware/stack.js';
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

  // 6 — authentication, 8 — tenant binding. Nothing below this line runs without a
  // verified context.
  app.use('/v1', authenticate, bindTenant);
  app.use('/v1/records', recordsRouter);

  // 17 — error handler, registered last so it wraps everything above.
  app.use(errorHandler);

  return app;
}
