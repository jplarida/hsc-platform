/**
 * The response envelope from `api/openapi.yaml`.
 *
 * Every success response is `{ success: true, data, meta }` and every error is
 * `{ success: false, error, meta }`. This is not a house style — it is the published
 * contract, and `api/05` establishes the spec as the source of truth rather than
 * something generated from the implementation.
 *
 * The first version of these routes returned a bare `{ data, has_more }`. That drifted
 * from the contract immediately and silently, which is the failure mode contract tests
 * exist to prevent: nothing errors, the tests pass, and the spec quietly becomes fiction.
 */

export interface Page {
  readonly limit: number;
  readonly next_cursor?: string;
  readonly has_more: boolean;
}

export interface Meta {
  readonly request_id: string;
  readonly timestamp: string;
  readonly api_version: string;
  readonly page?: Page;
}

export const API_VERSION = 'v1';

export function meta(requestId: string, page?: Page): Meta {
  return {
    request_id: requestId,
    timestamp: new Date().toISOString(),
    api_version: API_VERSION,
    ...(page ? { page } : {}),
  };
}

export function success<T>(data: T, requestId: string, page?: Page): {
  success: true; data: T; meta: Meta;
} {
  return { success: true, data, meta: meta(requestId, page) };
}

/**
 * Cursor encoding.
 *
 * The spec calls the cursor opaque and says offsets are not supported. Both halves
 * matter: keyset pagination stays correct when rows are inserted mid-scan, where an
 * offset silently skips or repeats rows — and if the cursor looks readable, clients
 * start parsing it and it stops being changeable.
 *
 * Base64url of the sort key. Not encryption, and not pretending to be: it is a signal
 * that the contents are ours, not a security boundary.
 */
export function encodeCursor(createdAt: Date, recordId: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${recordId}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; recordId: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep <= 0) return null;
    const createdAt = raw.slice(0, sep);
    const recordId = raw.slice(sep + 1);
    if (!createdAt || !recordId) return null;
    // A malformed cursor is a client error, not a server one — but it must not become a
    // SQL parameter that fails deep in the query with an unhelpful message.
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, recordId };
  } catch {
    return null;
  }
}
