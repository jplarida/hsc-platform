/**
 * Redacted error logging.
 *
 * `observability/01` found that the documented monitoring stack would send PHI to
 * observability vendors, and prescribed an ALLOWLIST at the collector — never a denylist,
 * because a denylist only excludes the fields someone thought of.
 *
 * The same reasoning applies before the collector ever sees anything. A PostgreSQL error
 * carries the offending value:
 *
 *   detail: 'Key (mrn)=(MRN-000123-SMITH-JOHN) already exists.'
 *
 * `database/03` puts a UNIQUE index on `gc_mrn`, so a duplicate patient write printed a
 * medical record number to stdout — and from there to CloudWatch, outside the audit
 * trail, outside the retention policy, and outside the BAA boundary. `where` carries
 * plpgsql context that can quote row values, and `internalQuery` can carry SQL with
 * literals in it.
 *
 * So nothing is logged unless it is named here.
 */

/** Fields known to be safe: identifiers and classifications, never values. */
const ALLOWED_PG_FIELDS = [
  'code',        // SQLSTATE, e.g. 23505
  'severity',
  'schema',
  'table',
  'column',
  'constraint',
  'routine',     // the C function that raised it
  'file',
  'line',
] as const;

/**
 * Deliberately excluded, and worth naming so nobody re-adds them:
 *   detail          contains the offending column VALUES
 *   where           plpgsql context, can quote row contents
 *   internalQuery   generated SQL, can contain literals
 *   hint            occasionally echoes input
 *   query/params    the statement and its bound values
 */
export interface SafeError {
  readonly kind: string;
  readonly message: string;
  readonly stack?: string;
  readonly pg?: Record<string, unknown>;
}

/**
 * `message` is included, and that is a judgement rather than an oversight.
 *
 * PostgreSQL's messages for the errors that reach here are templates naming constraints
 * and relations — "duplicate key value violates unique constraint \"uq_records_mrn\"" —
 * not values; the value lives in `detail`. Losing the message would make the logs close
 * to useless, and the residual risk is a message from application code that interpolates
 * something sensitive. That is a rule for authors of `throw` sites, and the ApiError
 * messages in this codebase all follow it.
 */
export function safeError(err: unknown): SafeError {
  if (!(err instanceof Error)) {
    return { kind: 'unknown', message: 'a non-Error value was thrown' };
  }

  const out: SafeError = {
    kind: err.name,
    message: err.message,
    ...(err.stack ? { stack: err.stack } : {}),
  };

  const source = err as unknown as Record<string, unknown>;
  if (typeof source['code'] === 'string' && typeof source['severity'] === 'string') {
    const pg: Record<string, unknown> = {};
    for (const field of ALLOWED_PG_FIELDS) {
      const value = source[field];
      if (value !== undefined && value !== null) pg[field] = value;
    }
    return { ...out, pg };
  }

  return out;
}

/** Format for a log line. Never pass a raw error object to console. */
export function formatError(err: unknown): string {
  const safe = safeError(err);
  const pg = safe.pg ? ` pg=${JSON.stringify(safe.pg)}` : '';
  return `${safe.kind}: ${safe.message}${pg}\n${safe.stack ?? ''}`;
}
