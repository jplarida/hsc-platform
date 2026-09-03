/**
 * Stages 3 and 5 — CORS, and the pre-authentication IP rate limit.
 *
 * Both run before authentication, and the ordering constraint for stage 5 is the one that
 * matters: authentication does password hashing and database work, so an unauthenticated
 * flood must be cheap to refuse. Rate limiting after auth would mean paying the expensive
 * part for every request in the flood.
 */

import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../http/errors.js';
import { checkLimit, keys } from '../ratelimit/limiter.js';

/**
 * CORS.
 *
 * The allowlist is explicit and there is deliberately no wildcard branch. `Access-Control-
 * Allow-Origin: *` cannot be combined with credentials, and a reflect-any-origin
 * implementation with `Allow-Credentials: true` is a standing CSRF invitation — any site
 * a logged-in user visits can then read the API as them.
 *
 * Tenants get subdomains (`database/01`), so the allowlist is a suffix match against
 * configured apex domains rather than a literal list of every tenant.
 */
function allowedOrigins(): readonly string[] {
  return (process.env['CORS_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowed(origin: string): boolean {
  return allowedOrigins().some((allowed) =>
    allowed.startsWith('*.')
      // Suffix match, anchored on the dot so "evil-example.com" cannot match "*.example.com".
      ? origin.endsWith(allowed.slice(1)) && origin.split('//')[1]?.includes('.') === true
      : origin === allowed);
}

export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');

  if (origin && isAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // Vary matters: without it a shared cache can serve one origin's response, complete
    // with its Allow-Origin header, to a different origin.
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers',
      'Authorization, Content-Type, Idempotency-Key, If-Match, X-Request-Id, X-Tenant-ID');
    res.setHeader('Access-Control-Expose-Headers',
      'ETag, Location, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, ' +
      'Idempotency-Replayed, X-Request-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  // A preflight is answered here and goes no further: it carries no credentials, so
  // running it through authentication would reject it and break every browser client.
  if (req.method === 'OPTIONS') {
    res.status(origin && isAllowed(origin) ? 204 : 403).end();
    return;
  }

  next();
}

/**
 * Stage 5 — IP rate limit, before authentication.
 *
 * Deliberately generous. This is a flood control, not the real quota: the per-tenant and
 * per-user limits at stage 9 do that job with knowledge of the plan. Setting this tight
 * would break shared egress — a hospital behind one NAT is many legitimate users on one
 * address, and they must not throttle each other.
 */
const IP_LIMIT = Number(process.env['IP_RATE_LIMIT_PER_MINUTE'] ?? 300);

export async function ipRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ip = req.ip;
    if (!ip) {
      next();
      return;
    }

    const decision = await checkLimit(
      { key: keys.loginByIp(ip), limit: IP_LIMIT, windowMs: 60_000, scope: 'ip' },
      req.requestId,
    );

    // Redis gave no answer. Fail open, as at stage 9: the connection pool is the real
    // backstop, and refusing all traffic because the limiter is unavailable turns a
    // degraded cache into a full outage.
    if (decision.indeterminate) {
      next();
      return;
    }

    if (!decision.allowed) {
      res.setHeader('Retry-After', decision.resetSeconds);
      next(new ApiError('RATE_LIMIT_EXCEEDED', 'Too many requests from this address', {
        scope: 'ip',
        retry_after: decision.resetSeconds,
      }));
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
