/**
 * Stage 14 — PHI access logging.
 *
 * Two middlewares, because the obligation has two halves that must run at opposite ends
 * of the request:
 *
 *   auditGate     BEFORE the handler. Refuses traffic when the audit writer cannot keep
 *                 up. Checking afterwards would mean the PHI had already been served.
 *   auditAccess   AFTER the response. Records what was actually read.
 *
 * `api/06` names four details that decide whether this is compliant, and all four are
 * load-bearing:
 *
 *   Log after SUCCESS. A 403 is not an access. Denials are useful but belong under a
 *   separate `access_denied` action — conflating them makes the PHI access report wrong.
 *
 *   Log LIST reads. `GET /records?type=patient` returning 50 patients is 50 PHI
 *   accesses. One event carrying the result count and the query is the practical
 *   compromise, but it must be recorded.
 *
 *   Log EXPORTS and DOWNLOADS. The highest-value events in the log, and the easiest to
 *   miss, because the response is a redirect rather than data.
 *
 *   Never block the response, never drop the event. See `audit/phiLog.ts`.
 */

import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../http/errors.js';
import { auditHealth, recordAccess, type AuditAction } from '../audit/phiLog.js';
import { anyIsPhi } from '../services/recordTypes.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * Filled in by the handler with what it actually read.
       *
       * The handler reports rather than the middleware guessing from the URL: a list
       * endpoint does not know from its path which record types came back, and guessing
       * from a query parameter misses the default-no-filter case entirely.
       */
      auditAccess?: {
        resourceType: string;
        recordTypes?: readonly string[];
        resourceId?: string | null;
        resultCount?: number;
        alwaysAudit?: boolean;
        action?: AuditAction;
      };
    }
  }
}

/** Stage 14a — backpressure. */
export function auditGate(_req: Request, _res: Response, next: NextFunction): void {
  const health = auditHealth();
  if (!health.healthy) {
    console.error(`[audit] refusing traffic: ${health.reason} (depth ${health.queueDepth})`);
    // 503 rather than 500: this is a temporary capacity condition and a client should
    // retry, not treat it as a bug in its request.
    next(new ApiError('INTERNAL_ERROR', 'Service temporarily unavailable'));
    return;
  }
  next();
}

function methodToAction(method: string): AuditAction {
  switch (method) {
    case 'POST': return 'create';
    case 'PUT':
    case 'PATCH': return 'update';
    case 'DELETE': return 'delete';
    default: return 'view';
  }
}

/** Stage 14b — record the access, after the response has been sent. */
export function auditAccess(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    void (async () => {
      try {
        const ctx = req.ctx;
        const access = req.auditAccess;
        if (!ctx || !access) return;

        // Only successful responses are accesses. A denial is recorded by the error
        // path, under its own action, so the two never blur together.
        if (res.statusCode >= 400) return;

        const isPhi = access.recordTypes
          ? await anyIsPhi(ctx, access.recordTypes)
          : false;

        if (!isPhi && !access.alwaysAudit) return;

        recordAccess({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          sessionId: req.sessionId ?? null,
          appId: ctx.appId,
          installationId: ctx.installationId,
          action: access.action ?? methodToAction(req.method),
          resourceType: access.resourceType,
          resourceId: access.resourceId ?? null,
          isPhiAccess: isPhi,
          ipAddress: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
          details: {
            // The query is recorded for list reads because "which patients did they
            // see?" is answerable from the filter plus the count, and is not answerable
            // from a bare event.
            ...(access.resultCount !== undefined ? { result_count: access.resultCount } : {}),
            ...(Object.keys(req.query).length > 0 ? { query: req.query } : {}),
            request_id: req.requestId,
            path: req.path,
          },
          at: new Date(),
        });
      } catch (err) {
        // Never throw from a finish handler: the response is already sent, and an
        // exception here would be an unhandled rejection rather than a useful error.
        console.error(`[audit] failed to record access: ${(err as Error).message}`);
      }
    })();
  });
  next();
}

/**
 * Record a denied access.
 *
 * Separate action, separate call. `api/06` is explicit that denials must not be logged
 * as accesses; a report that counts refused attempts as PHI views overstates exposure
 * and is wrong in the direction that matters at an audit.
 */
export function recordDenial(req: Request, resourceType: string): void {
  const ctx = req.ctx;
  if (!ctx) return;
  recordAccess({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    sessionId: req.sessionId ?? null,
    appId: ctx.appId,
    installationId: ctx.installationId,
    action: 'access_denied',
    resourceType,
    resourceId: null,
    isPhiAccess: false,
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    details: { request_id: req.requestId, path: req.path },
    at: new Date(),
  });
}
