/**
 * Tenant context and the single database entry point.
 *
 * `database/08_SCALING_ARCHITECTURE.md` identifies the highest-severity failure in the
 * platform, and it lives here: a session-scoped tenant GUC survives a pooled connection
 * being returned to the pool, so the *next* request inherits the previous request's
 * tenant. Row-level security then enforces that stale tenant, correctly and silently.
 * No error is raised at any layer. It is a cross-tenant read that looks like a
 * successful request.
 *
 * Three properties make this safe, and all three are easy to lose:
 *
 *   1. An explicit transaction. `set_config(..., true)` means "local to the transaction"
 *      and is reverted at COMMIT. Outside a transaction, "local" means the rest of the
 *      session — which is the leak.
 *   2. `SET LOCAL ROLE`, not `SET ROLE`. Also reverted at COMMIT, so a connection is
 *      never returned to the pool still wearing `app_user`.
 *   3. One entry point. Everything below is deliberately not exported: there is no way
 *      to obtain a client from this module without a tenant context attached to it.
 */

import pg from 'pg';

/** A verified tenant context. Only `deriveContext` can produce one. */
export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly appId: string | null;
  readonly installationId: string | null;
  /** The database role to assume. Never the migration owner on a request path. */
  readonly role: 'app_user' | 'app_platform';
}

/**
 * The branded shape a request must carry to reach the database.
 *
 * The brand exists so a plain object — say, one built from request headers — cannot be
 * passed where a TenantContext is required. `api/01`'s correction 1 is that tenancy must
 * derive from verified claims and never from an untrusted header; this makes the wrong
 * thing a type error rather than a code review responsibility.
 */
declare const verified: unique symbol;
export type VerifiedTenantContext = TenantContext & { readonly [verified]: true };

/**
 * Build a verified context from claims that have already been cryptographically checked.
 *
 * The name is the point: call this with a decoded, signature-verified token payload, and
 * nothing else. There is deliberately no overload taking a header value.
 */
export function deriveContext(claims: {
  tenantId: string;
  userId?: string | null;
  appId?: string | null;
  installationId?: string | null;
  role?: 'app_user' | 'app_platform';
}): VerifiedTenantContext {
  if (!claims.tenantId) {
    throw new Error('deriveContext requires a tenant id from verified claims');
  }
  return {
    tenantId: claims.tenantId,
    userId: claims.userId ?? null,
    appId: claims.appId ?? null,
    installationId: claims.installationId ?? null,
    role: claims.role ?? 'app_user',
  } as VerifiedTenantContext;
}

let pool: pg.Pool | undefined;
/**
 * Set by closePool(). Without it getPool() silently builds a NEW pool after shutdown.
 *
 * That is not theoretical: the PHI audit middleware runs in a res.on('finish') handler,
 * so it touches the database AFTER the response has been sent. During shutdown those
 * late handlers resurrected the pool, and its idle timer then kept the process alive
 * indefinitely — a drain that never finishes. Refusing is correct: once the pool is
 * closed there is no more database work to do.
 */
let closed = false;

export function getPool(): pg.Pool {
  if (closed) {
    throw new Error('The database pool is closed; this process is shutting down');
  }
  if (!pool) {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString,
      // Sized against the connection budget in database/08, not against expected load:
      // the ceiling is what PgBouncer and RDS can carry, not what the app would like.
      max: Number(process.env['DB_POOL_MAX'] ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  closed = true;
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Tests only: allow a fresh pool after a close. */
export function reopenPoolForTest(): void {
  closed = false;
  pool = undefined;
}

/** The only handle a caller ever gets. Deliberately narrower than pg.PoolClient. */
export interface TenantClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * Run `fn` inside a transaction with the role assumed and the tenant GUC set.
 *
 * Held open for the minimum time — `api/06` stage 13 places the transaction immediately
 * around the handler for exactly this reason. Anything slow (an external call, a token
 * refresh) belongs outside it.
 */
export async function withTenantContext<T>(
  ctx: VerifiedTenantContext,
  fn: (client: TenantClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Role first: the GUC is read by policies evaluated as this role.
    await client.query(`SET LOCAL ROLE ${roleLiteral(ctx.role)}`);
    await client.query('SELECT set_tenant_context($1, $2, $3, $4)', [
      ctx.tenantId,
      ctx.userId,
      ctx.appId,
      ctx.installationId,
    ]);

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // ROLLBACK can itself fail if the connection died; that must not mask the original
    // error, which is the one that explains what happened.
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    // release() returns the connection to the pool. COMMIT/ROLLBACK has already reverted
    // both the role and the GUC, which is the property the whole design rests on.
    client.release();
  }
}

/**
 * Role names cannot be parameterised in `SET LOCAL ROLE`, so they are matched against a
 * closed set rather than interpolated. The union type already prevents this at compile
 * time; this is the runtime half, for values that arrive from outside the type system.
 */
function roleLiteral(role: TenantContext['role']): string {
  switch (role) {
    case 'app_user':
      return 'app_user';
    case 'app_platform':
      return 'app_platform';
    default: {
      const exhaustive: never = role;
      throw new Error(`Unknown database role: ${String(exhaustive)}`);
    }
  }
}
