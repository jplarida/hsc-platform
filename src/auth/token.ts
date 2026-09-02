/**
 * Access token verification.
 *
 * `api/01` specifies short-lived JWTs for user sessions with a Redis-backed session check
 * (stage 7) for revocation. Slice one implements the signature and claims half; the
 * session check arrives with Redis.
 *
 * Marketplace app tokens are deliberately NOT handled here. `partners/02` requires them
 * to be opaque and resolved against `app_tokens` on every request, because uninstall
 * means "stop having my data now" and a self-contained token stays valid until it
 * expires. Two credential types, two verification paths.
 */

import { jwtVerify, SignJWT } from 'jose';
import { ApiError } from '../http/errors.js';

export interface AccessClaims {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string | null;
  readonly permissions: readonly string[];
}

const ISSUER = 'hsc-platform';
const AUDIENCE = 'hsc-api';

/** Seconds of skew allowed past `exp`. See the note at the verify call. */
export const CLOCK_TOLERANCE_SECONDS = 5;

function secret(): Uint8Array {
  const value = process.env['JWT_SECRET'];
  if (!value) {
    throw new Error(
      'JWT_SECRET is not set. Development only — production uses asymmetric keys ' +
        'from KMS so the API never holds signing material (infrastructure/06).',
    );
  }
  if (value.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 bytes');
  }
  return new TextEncoder().encode(value);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Clock tolerance is a deliberate, bounded weakening: it accepts a token for this
      // many seconds PAST its expiry, to absorb skew between the issuer and this process.
      // It is not free — it is a grace period on a revoked-by-time credential — so it is
      // kept small and explicit rather than left at a library default. Covered by a test
      // that asserts the boundary in both directions, so changing it fails loudly.
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }));
  } catch (err) {
    // TOKEN_EXPIRED is distinguished from INVALID_TOKEN so a client knows whether to
    // refresh or to log in again — api/01's correction to a conflated error code.
    const code = err instanceof Error && err.name === 'JWTExpired' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    throw new ApiError(code, code === 'TOKEN_EXPIRED' ? 'Access token has expired' : 'Invalid token');
  }

  const tenantId = typeof payload['tenant_id'] === 'string' ? payload['tenant_id'] : null;
  const userId = typeof payload.sub === 'string' ? payload.sub : null;

  // A token that verifies but carries no tenant is not usable, and must not fall through
  // to a null context that RLS would then interpret as "no rows" — that is a confusing
  // 200 where a 401 is correct.
  if (!tenantId || !userId) {
    throw new ApiError('INVALID_TOKEN', 'Token is missing required claims');
  }

  const permissions = Array.isArray(payload['permissions'])
    ? payload['permissions'].filter((p): p is string => typeof p === 'string')
    : [];

  return {
    tenantId,
    userId,
    sessionId: typeof payload['sid'] === 'string' ? payload['sid'] : null,
    permissions,
  };
}

/**
 * Mint a token. Development and tests only.
 *
 * Real issuance belongs in the login flow (`infrastructure/05`), which does not exist
 * yet. Exported so the test suite can exercise the pipeline with genuinely signed
 * tokens rather than a bypass — a test that stubs authentication does not test the
 * ordering property that stage 8 depends on.
 */
export async function signAccessToken(claims: {
  tenantId: string;
  userId: string;
  sessionId?: string;
  permissions?: readonly string[];
  expiresIn?: string;
}): Promise<string> {
  return new SignJWT({
    tenant_id: claims.tenantId,
    permissions: claims.permissions ?? [],
    ...(claims.sessionId ? { sid: claims.sessionId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? '1h')
    .sign(secret());
}
