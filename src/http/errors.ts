/**
 * The error envelope and code catalogue.
 *
 * Codes come from `api/01`'s auth error table and `api/02`'s corrections. Two of them
 * carry reasoning worth keeping close to the definition:
 *
 *   TOKEN_EXPIRED is separate from INVALID_TOKEN. Clients need to distinguish "refresh
 *   and retry" from "log in again"; collapsing both, as API_ARCHITECTURE.md does, forces
 *   every client to guess.
 *
 *   RESOURCE_NOT_FOUND, not FORBIDDEN, for another tenant's row. RLS makes it invisible,
 *   and that is the correct externally-visible behaviour — a 403 would confirm the
 *   record exists. A permission failure *inside* your own tenant is a genuine 403.
 */

export type ErrorCode =
  | 'MISSING_AUTHORIZATION'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'MFA_REQUIRED'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'TENANT_MISMATCH'
  | 'INVALID_API_KEY'
  | 'INSUFFICIENT_SCOPE'
  | 'RESOURCE_NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'QUOTA_EXCEEDED'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  MISSING_AUTHORIZATION: 401,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  MFA_REQUIRED: 403,
  INSUFFICIENT_PERMISSIONS: 403,
  TENANT_MISMATCH: 403,
  INVALID_API_KEY: 401,
  INSUFFICIENT_SCOPE: 403,
  RESOURCE_NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  // Separated from QUOTA_EXCEEDED deliberately (api/02 correction 11): conflating them
  // makes clients retry a quota failure that will never succeed.
  RATE_LIMIT_EXCEEDED: 429,
  QUOTA_EXCEEDED: 403,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}

export function errorBody(err: ApiError, requestId: string): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      request_id: requestId,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
