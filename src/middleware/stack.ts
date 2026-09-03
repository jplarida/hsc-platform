/**
 * The request pipeline, in the order `api/06_MIDDLEWARE_ARCHITECTURE.md` specifies.
 *
 * Implemented: stages 1, 2, 4, 6, 7, 8, 9, 10, 13 and 17.
 * Still absent: validation (11), idempotency (12), PHI access logging (14) and response
 * caching (15). Each needs its own pass.
 *
 * THE ORDERING IS THE SECURITY PROPERTY. `API_ARCHITECTURE.md` places tenant resolution
 * at stage 2 and authentication at stage 3. That inversion is correction 1 of `api/01`
 * and the single most important change in the whole API layer: deriving tenancy from an
 * untrusted header *before* verifying the token means a valid token plus a forged
 * `X-Tenant-ID` reads another tenant's data, and RLS enforces the attacker's choice
 * without raising anything. Authentication comes first here, always.
 */

import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, errorBody } from '../http/errors.js';
import { formatError } from '../http/safeLog.js';
import { deriveContext, type VerifiedTenantContext } from '../db/context.js';
import { verifyAccessToken } from '../auth/token.js';
import { isSessionLive } from '../services/sessions.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      /** Set only by `authenticate`, only from verified claims. */
      ctx?: VerifiedTenantContext;
      permissions?: readonly string[];
      /** From the token’s sid claim. Absent for API keys and app tokens. */
      sessionId?: string | undefined;
    }
  }
}

/** Stage 1 — request context. First, because everything downstream logs the id. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/** Stage 2 — security headers. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // api/06 correction 6: no CDN or intermediary may cache an authenticated response.
  res.setHeader('Cache-Control', 'private, no-store');
  next();
}

/**
 * Stage 6 — authentication.
 *
 * Produces verified claims and nothing else. It does not read `X-Tenant-ID`, and cannot:
 * `deriveContext` is the only way to build the context type, and it takes claims.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.header('authorization');
    if (!header) throw new ApiError('MISSING_AUTHORIZATION', 'Authorization header is required');

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new ApiError('INVALID_TOKEN', 'Expected a Bearer token');
    }

    const claims = await verifyAccessToken(token);

    req.ctx = deriveContext({
      tenantId: claims.tenantId,
      userId: claims.userId,
      role: 'app_user',
    });
    req.permissions = claims.permissions;
    req.sessionId = claims.sessionId ?? undefined;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Stage 8 — tenant binding.
 *
 * The context is already set from verified claims. This stage exists only to *reject* a
 * contradicting header, never to read one. A header is accepted as a no-op when it
 * agrees, because browsers and proxies genuinely send stale values; when it disagrees it
 * is 403 TENANT_MISMATCH.
 *
 * For an app-authenticated request `partners/02` requires the header be rejected
 * outright rather than compared — an app obtained a token bound to one tenant and has no
 * excuse for sending a different one. That branch arrives with app tokens.
 */
export function bindTenant(req: Request, _res: Response, next: NextFunction): void {
  const ctx = req.ctx;
  if (!ctx) {
    next(new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context'));
    return;
  }

  const header = req.header('x-tenant-id');
  if (header && header !== ctx.tenantId) {
    next(new ApiError('TENANT_MISMATCH', 'X-Tenant-ID contradicts the authenticated token'));
    return;
  }
  next();
}

/** Stage 10 — authorization. Permissions are tenant-scoped, so this follows binding. */
export function requirePermission(code: string) {
  return function authorize(req: Request, _res: Response, next: NextFunction): void {
    if (!req.ctx) {
      next(new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context'));
      return;
    }
    if (!req.permissions?.includes(code)) {
      next(new ApiError('INSUFFICIENT_PERMISSIONS', `Requires ${code}`));
      return;
    }
    next();
  };
}

/**
 * Stage 17 — the error handler, outermost so it catches failures from every layer above.
 *
 * Express 5 forwards rejected promises from async handlers automatically, which is why
 * handlers here do not each need a try/catch wrapper.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const apiErr =
    err instanceof ApiError
      ? err
      : new ApiError('INTERNAL_ERROR', 'An unexpected error occurred');

  if (!(err instanceof ApiError)) {
    // Redacted, not raw. A PostgreSQL error carries the offending column value in
    // `detail` — a duplicate MRN prints the MRN — and stdout goes to CloudWatch, outside
    // the audit trail and outside the BAA boundary. observability/01 prescribes an
    // allowlist for exactly this, so formatError names what may be logged rather than
    // trying to remember what may not.
    console.error(`[${req.requestId}] unhandled: ${formatError(err)}`);
  }

  res.status(apiErr.status).json(errorBody(apiErr, req.requestId));
}

/**
 * Stage 7 — session check.
 *
 * After authentication, because it needs `session_id` from the verified claims. Before
 * tenant binding, per `api/06`'s stage order.
 *
 * A token whose session has been revoked is refused here. Without this stage, logout,
 * password change, admin revocation and refresh-token reuse detection all write
 * `sessions.revoked_at` and none of them take effect until the access token expires.
 *
 * A token carrying no `sid` is allowed through: API-key and app-token paths have no user
 * session, and rejecting them here would break the machine-to-machine routes entirely.
 * Their revocation lives in `api_keys.revoked_at` and `app_tokens.revoked_at`.
 */
export async function checkSession(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = req.ctx;
    if (!ctx) throw new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context');

    const sid = req.sessionId;
    if (!sid) {
      next();
      return;
    }

    const state = await isSessionLive(ctx, sid);
    if (state !== 'live') {
      // TOKEN_REVOKED, not INVALID_TOKEN: the client needs to know it should log in
      // again rather than retry or refresh.
      throw new ApiError('TOKEN_REVOKED', 'Session is no longer valid');
    }
    next();
  } catch (err) {
    next(err);
  }
}
