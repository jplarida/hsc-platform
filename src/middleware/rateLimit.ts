/**
 * Stage 9 — rate limiting.
 *
 * After tenant binding, because limits come from the tenant's plan.
 *
 * Two buckets apply to an ordinary request: the tenant's hourly allowance and the user's
 * per-minute allowance. When several apply, the headers describe the MOST CONSTRAINED
 * one (`api/03`) — a client backing off on a bucket that is not the binding one backs
 * off too little and gets throttled again immediately.
 */

import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../http/errors.js';
import { checkLimit, keys, type LimitDecision, type LimitRule } from '../ratelimit/limiter.js';
import { planLimitsFor } from '../services/planLimits.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Emit both header families.
 *
 * `RateLimit-Reset` is SECONDS REMAINING; `X-RateLimit-Reset` is a UNIX TIMESTAMP. They
 * are genuinely different units, and `api/03` calls emitting the same number in both a
 * common and confusing bug. They are computed separately here for that reason.
 */
function setHeaders(res: Response, d: LimitDecision, windowSeconds: number): void {
  res.setHeader('RateLimit-Limit', d.limit);
  res.setHeader('RateLimit-Remaining', d.remaining);
  res.setHeader('RateLimit-Reset', d.resetSeconds);
  res.setHeader('RateLimit-Policy', `${d.limit};w=${windowSeconds}`);

  res.setHeader('X-RateLimit-Limit', d.limit);
  res.setHeader('X-RateLimit-Remaining', d.remaining);
  res.setHeader('X-RateLimit-Reset', Math.floor(Date.now() / 1000) + d.resetSeconds);
  res.setHeader('X-RateLimit-Window', windowSeconds);
}

/** The binding bucket is whichever has the least headroom, proportionally. */
function mostConstrained(decisions: readonly LimitDecision[]): LimitDecision {
  return decisions.reduce((worst, d) =>
    d.remaining / Math.max(d.limit, 1) < worst.remaining / Math.max(worst.limit, 1) ? d : worst);
}

/**
 * A per-endpoint allowance, on top of the plan's buckets.
 *
 * `api/03` tabulates these separately from the plan limits for a reason: they exist to bound
 * *cost*, not fairness. An import, a report generation or a bulk export is expensive enough
 * that a tenant well inside its hourly request allowance can still overwhelm the platform
 * with them. `LimitScope` already had `'endpoint'` and `keys.endpoint` already existed;
 * only the middleware had nowhere to put one.
 */
export interface EndpointLimit {
  /** Appears in the Redis key, so it must be stable across deploys. */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  /** Per tenant, or per user within the tenant. `api/03` specifies which for each route. */
  readonly per: 'tenant' | 'user';
}

/**
 * A per-endpoint allowance, applied ON ITS OWN.
 *
 * Mounted per route, *after* the router-wide `rateLimit()` has already run. It therefore
 * evaluates only its own bucket — re-evaluating the plan's rules here would consume two
 * slots from the tenant's hourly allowance for a single request, which is a limiter that
 * silently halves the limit it advertises.
 */
export function endpointRateLimit(endpoint: EndpointLimit) {
  return async function limit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const ctx = req.ctx;
    if (!ctx) {
      next(new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context'));
      return;
    }

    // Falls back to the tenant when there is no user — an API key or an app has no
    // user_id, and keying them all on a literal "null" would put every one of them in a
    // single shared bucket (partners/02, the same reasoning as the per-user rule).
    const subject = endpoint.per === 'user' && ctx.userId && !ctx.appId
      ? ctx.userId
      : ctx.tenantId;

    try {
      const decision = await checkLimit({
        key: keys.endpoint(ctx.tenantId, endpoint.name, subject),
        limit: endpoint.limit,
        windowMs: endpoint.windowMs,
        scope: 'endpoint',
      }, req.requestId);

      // Same fail-open policy as the plan buckets, for the same reason: a degraded limiter
      // must not become an outage. The plan's hourly bucket still applies underneath.
      if (decision.indeterminate) {
        res.setHeader('X-RateLimit-Degraded', '1');
        next();
        return;
      }

      const windowSeconds = Math.ceil(endpoint.windowMs / 1000);
      if (!decision.allowed) {
        setHeaders(res, decision, windowSeconds);
        res.setHeader('Retry-After', decision.resetSeconds);
        next(new ApiError('RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', {
          scope: 'endpoint',
          retry_after: decision.resetSeconds,
        }));
        return;
      }

      // Headers are deliberately NOT set on the allowed path. The router-wide limiter has
      // already described the plan buckets, and overwriting them with a 1-per-10-minutes
      // policy would tell a client its whole allowance is one request an hour.
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function rateLimit() {
  return async function limit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const ctx = req.ctx;
    if (!ctx) {
      next(new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context'));
      return;
    }

    try {
      const plan = await planLimitsFor(ctx);

      const rules: LimitRule[] = [
        {
          key: keys.tenantHour(ctx.tenantId),
          limit: plan.requestsPerHour,
          windowMs: HOUR_MS,
          scope: 'tenant',
        },
      ];

      // Apps have no user_id, and counting them against a null user key would put every
      // app in one shared bucket (partners/02). They are excluded from this dimension.
      if (ctx.userId && !ctx.appId) {
        rules.push({
          key: keys.userMinute(ctx.tenantId, ctx.userId),
          limit: plan.userRequestsPerMinute,
          windowMs: MINUTE_MS,
          scope: 'user',
        });
      }

      const decisions = await Promise.all(rules.map((r) => checkLimit(r, req.requestId)));

      // Redis gave no answer. FAIL OPEN, LOUDLY — the connection pool is the real
      // backstop, and refusing all traffic because the limiter is unavailable converts a
      // degraded cache into a full outage (api/03). /auth/* is the exception and fails
      // closed, but nothing on this router is /auth/*.
      //
      // Per-process fallback counters are deliberately not used: with 20 tasks a
      // per-process limit is effectively 20x the intended one, which is close enough to
      // no limit to be misleading while looking like a safeguard.
      if (decisions.some((d) => d.indeterminate)) {
        console.warn(
          `[${req.requestId}] rate limiter unavailable, failing open for tenant ${ctx.tenantId}`,
        );
        res.setHeader('X-RateLimit-Degraded', '1');
        next();
        return;
      }

      // Window per decision, taken from the rule that produced it rather than inferred
      // from its scope. Inferring worked while every scope had exactly one window; an
      // endpoint rule can carry any window at all — api/03 gives /imports ten minutes —
      // and `RateLimit-Policy` announcing 3600 for a 600-second bucket tells a client to
      // back off for the wrong hour.
      const windowFor = (d: (typeof decisions)[number]): number => {
        const rule = rules[decisions.indexOf(d)];
        return Math.ceil((rule?.windowMs ?? HOUR_MS) / 1000);
      };

      const binding = mostConstrained(decisions);
      setHeaders(res, binding, windowFor(binding));

      const denied = decisions.find((d) => !d.allowed);
      if (denied) {
        setHeaders(res, denied, windowFor(denied));
        res.setHeader('Retry-After', denied.resetSeconds);
        // `scope` tells the client whether backing off will help, or whether every user
        // in the tenant is blocked and waiting alone will not.
        next(new ApiError('RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', {
          scope: denied.scope,
          retry_after: denied.resetSeconds,
        }));
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
