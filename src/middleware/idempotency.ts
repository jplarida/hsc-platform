/**
 * Stage 12 — idempotency.
 *
 * After validation, per `api/06`: an invalid request should not burn a key. Before the
 * transaction, so a replay never opens one at all.
 */

import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../http/errors.js';
import { claim, complete, hashBody, release, type Criticality } from '../idempotency/store.js';

interface Options {
  /** When false the header is honoured if present and not demanded if absent. */
  readonly required: boolean;
  readonly criticality: Criticality;
}

/** RFC-ish: a key must be a bounded, printable token. Not a place to accept anything. */
const KEY_PATTERN = /^[\w.:-]{8,255}$/;

export function idempotency({ required, criticality }: Options) {
  return async function idempotent(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const ctx = req.ctx;
      if (!ctx) throw new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context');

      const idemKey = req.header('idempotency-key');

      if (!idemKey) {
        if (required) {
          throw new ApiError(
            'IDEMPOTENCY_KEY_REQUIRED',
            'Idempotency-Key header is required for this endpoint',
          );
        }
        next();
        return;
      }

      if (!KEY_PATTERN.test(idemKey)) {
        throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is malformed');
      }

      const bodyHash = hashBody(req.body);
      const result = await claim(ctx.tenantId, idemKey, bodyHash);

      switch (result.kind) {
        case 'replay':
          // The original answer, not a re-execution. Header so a client can tell the
          // difference — useful when debugging a retry storm.
          res.setHeader('Idempotency-Replayed', 'true');
          res.status(result.stored.status).json(result.stored.body);
          return;

        case 'conflict':
          throw new ApiError(
            'IDEMPOTENCY_KEY_REUSE',
            'This Idempotency-Key was used with a different request body',
          );

        case 'reserved':
          // An identical request is still in flight. Retrying gets the replay.
          res.setHeader('Retry-After', '1');
          throw new ApiError(
            'IDEMPOTENT_REQUEST_IN_PROGRESS',
            'An identical request is already in progress',
          );

        case 'unavailable':
          // performance/01: a duplicate record is recoverable, a rejected clinical write
          // during a cache outage is worse — EXCEPT where money moves, because there is
          // no way to promise a charge will not be made twice.
          if (criticality === 'billing') {
            console.error(
              `[${req.requestId}] idempotency store unavailable on a billing mutation, refusing`,
            );
            throw new ApiError('INTERNAL_ERROR', 'Service temporarily unavailable');
          }
          console.warn(
            `[${req.requestId}] idempotency store unavailable, proceeding without a key`,
          );
          res.setHeader('X-Idempotency-Degraded', '1');
          next();
          return;

        case 'miss':
          break;
      }

      // The key is reserved and this request owns it. Capture the outcome on the way out
      // so a retry can replay it.
      const originalJson = res.json.bind(res);
      let settled = false;

      res.json = (body: unknown): Response => {
        if (!settled) {
          settled = true;
          if (res.statusCode < 400) {
            void complete(ctx.tenantId, idemKey, {
              bodyHash, status: res.statusCode, body,
            });
          } else {
            // A failed request has nothing to be idempotent about, and holding the
            // reservation would make a legitimate retry wait out its TTL.
            void release(ctx.tenantId, idemKey);
          }
        }
        return originalJson(body);
      };

      // A handler that throws never reaches res.json, so the reservation is released
      // here too. Without this a 500 wedges the key for the reservation TTL.
      res.on('finish', () => {
        if (!settled) {
          settled = true;
          void release(ctx.tenantId, idemKey);
        }
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}
