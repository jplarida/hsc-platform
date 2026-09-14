/**
 * /v1/imports
 *
 * The first endpoint whose work does not happen during the request. `api/02` specifies
 * `202 Accepted` with a job URL, and Part B's pipeline is long enough that doing it inline
 * would hold a transaction open across validation, loading and link resolution.
 *
 * So the handler's job is narrow: validate the request, write the job and its rows down
 * durably, and signal the worker. Everything after that is `imports/pipeline.ts`.
 *
 * The staging write and the job row go in **one transaction**. A job whose rows did not
 * commit is a job that reports `total_rows: 0` and succeeds at importing nothing, which is
 * indistinguishable to the customer from an empty file.
 */

import { Router, type Request, type Response } from 'express';
import { withTenantContext, type VerifiedTenantContext } from '../db/context.js';
import { requirePermission } from '../middleware/stack.js';
import { idempotency } from '../middleware/idempotency.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { endpointRateLimit } from '../middleware/rateLimit.js';
import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor, success } from '../http/envelope.js';
import { parseTarget } from '../imports/mapping.js';
import { enqueueJob } from '../imports/queue.js';

export const importsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `api/03`: one import per ten minutes per tenant. */
const IMPORT_LIMIT = { name: 'imports', limit: 1, windowMs: 10 * 60_000, per: 'tenant' } as const;

interface JobRow {
  import_job_id: string;
  source_type: string;
  target_record_type: string;
  is_dry_run: boolean;
  status: string;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  imported_rows: number;
  created_by: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  reversed_at: Date | null;
  created_at: Date;
}

const JOB_COLUMNS = `import_job_id, source_type, target_record_type, is_dry_run, status,
                     total_rows, valid_rows, error_rows, imported_rows, created_by,
                     started_at, completed_at, reversed_at, created_at`;

/** Shaped as `components/schemas/ImportJob`. Absent rather than null, as elsewhere. */
function toJob(r: JobRow): Record<string, unknown> {
  return {
    import_job_id: r.import_job_id,
    source_type: r.source_type,
    target_record_type: r.target_record_type,
    is_dry_run: r.is_dry_run,
    status: r.status,
    total_rows: r.total_rows,
    valid_rows: r.valid_rows,
    error_rows: r.error_rows,
    imported_rows: r.imported_rows,
    ...(r.created_by !== null ? { created_by: r.created_by } : {}),
    ...(r.started_at !== null ? { started_at: r.started_at.toISOString() } : {}),
    ...(r.completed_at !== null ? { completed_at: r.completed_at.toISOString() } : {}),
    ...(r.reversed_at !== null ? { reversed_at: r.reversed_at.toISOString() } : {}),
    created_at: r.created_at.toISOString(),
  };
}

function requireCtx(req: Request): VerifiedTenantContext {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context');
  return ctx;
}

function pathJobId(req: Request): string {
  const raw = req.params['import_job_id'];
  const id = typeof raw === 'string' ? raw : '';
  // A malformed id is 404 rather than a 500 from the database rejecting the cast, and 404
  // rather than 400 so it is indistinguishable from another tenant's job.
  if (!UUID.test(id)) throw new ApiError('RESOURCE_NOT_FOUND', 'Not found');
  return id;
}

interface ImportBody {
  source_type?: string;
  source_file_id?: string;
  target_record_type: string;
  is_dry_run?: boolean;
  mapping_template_name?: string;
  mappings: {
    source_column: string;
    target_path: string;
    transform?: string;
    is_required?: boolean;
    default_value?: string;
  }[];
  rows: Record<string, unknown>[];
}

/**
 * POST /v1/imports
 *
 * Idempotency is optional here rather than required, unlike `POST /records`. The endpoint is
 * already limited to one call per ten minutes per tenant, and a retried import is visible as
 * a second job rather than silently doubling a tenant's records — `external_id` uniqueness
 * turns a re-run into `duplicate_key` row errors, which is Part B's stated design. A client
 * that does send a key still gets the replay.
 */
importsRouter.post(
  '/',
  requirePermission('records:import'),
  endpointRateLimit(IMPORT_LIMIT),
  validateBody('/imports', 'post'),
  idempotency({ required: false, criticality: 'standard' }),
  async (req: Request, res: Response) => {
    const ctx = requireCtx(req);
    const body = req.body as ImportBody;

    // Rejected rather than ignored. Accepting a source_file_id and then importing the
    // inline rows instead would be the worst of both: the customer believes their uploaded
    // file was processed, and the job reports success.
    if (body.source_file_id !== undefined) {
      throw new ApiError('VALIDATION_FAILED', 'Importing from a stored file is not available yet', {
        field_errors: [{
          field: 'source_file_id',
          code: 'unsupported',
          message: 'file-backed imports need /files, which is not built; supply rows inline',
        }],
      });
    }

    // Mapping targets are checked here, not per row. An unparseable target is a fault in
    // the mapping itself and would otherwise produce the same error against every one of
    // five thousand rows — burying the one thing the customer needs to fix.
    const badTargets = body.mappings
      .filter((m) => parseTarget(m.target_path) === null)
      .map((m) => m.target_path);

    if (badTargets.length > 0) {
      throw new ApiError('VALIDATION_FAILED', 'One or more mapping targets are not recognised', {
        field_errors: badTargets.map((t) => ({
          field: 'mappings.target_path',
          code: 'unknown_target',
          message:
            `"${t}" is not a destination; expected title, description, status, external_id, ` +
            `data.<path>, or link:<link_type>:<record_type>`,
        })),
      });
    }

    const isDryRun = body.is_dry_run ?? true;

    const job = await withTenantContext(ctx, async (client) => {
      // The composite FK on (tenant_id, target_record_type) would catch an unknown type,
      // but as a 500 carrying a constraint name. Checking first turns it into the 422 the
      // contract promises. RLS scopes the lookup, so another tenant's type is not visible.
      const known = await client.query(
        `SELECT 1 FROM record_type_definitions WHERE code = $1 AND is_active`,
        [body.target_record_type],
      );
      if (known.rowCount === 0) {
        throw new ApiError('VALIDATION_FAILED', 'Unknown record type', {
          field_errors: [{
            field: 'target_record_type',
            code: 'unknown',
            message: `"${body.target_record_type}" is not a declared record type in this tenant`,
          }],
        });
      }

      const created = await client.query<JobRow>(
        `INSERT INTO import_jobs
           (tenant_id, source_type, target_record_type, is_dry_run, status, total_rows,
            created_by)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING ${JOB_COLUMNS}`,
        [ctx.tenantId, body.source_type ?? 'api', body.target_record_type, isDryRun,
          body.rows.length, ctx.userId],
      );
      const row = created.rows[0];
      if (!row) throw new ApiError('INTERNAL_ERROR', 'Insert returned no job');

      const mappingValues: unknown[] = [];
      const mappingTuples = body.mappings.map((m, i) => {
        const o = i * 8;
        mappingValues.push(
          ctx.tenantId, row.import_job_id, body.mapping_template_name ?? null,
          m.source_column, m.target_path, m.transform ?? null,
          m.is_required ?? false, m.default_value ?? null,
        );
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
      });
      await client.query(
        `INSERT INTO import_field_mappings
           (tenant_id, import_job_id, template_name, source_column, target_path, transform,
            is_required, default_value)
         VALUES ${mappingTuples.join(',')}`,
        mappingValues,
      );

      // Chunked because the parameter list is the binding constraint: PostgreSQL caps a
      // statement at 65,535 parameters, and 5,000 rows at five each would exceed it.
      const CHUNK = 500;
      for (let start = 0; start < body.rows.length; start += CHUNK) {
        const chunk = body.rows.slice(start, start + CHUNK);
        const values: unknown[] = [];
        const tuples = chunk.map((source, i) => {
          const o = i * 4;
          // 1-based, and counted from the whole batch rather than the chunk, so the number
          // in an error report matches the line the customer is looking at.
          values.push(ctx.tenantId, row.import_job_id, start + i + 1, JSON.stringify(source));
          return `($${o + 1},$${o + 2},$${o + 3},$${o + 4}::jsonb)`;
        });
        await client.query(
          `INSERT INTO import_staging (tenant_id, import_job_id, row_number, source_row)
           VALUES ${tuples.join(',')}`,
          values,
        );
      }

      return row;
    });

    // After the commit, deliberately. Signalling from inside the transaction would let the
    // worker claim a job whose rows are not visible yet — and a failed enqueue is not a
    // failed import, because the sweep is the backstop. Hence no await on the outcome
    // beyond logging it.
    const queued = await enqueueJob(job.import_job_id, ctx.tenantId, ctx.userId);
    if (!queued) {
      console.warn(
        `[${req.requestId}] import ${job.import_job_id} not signalled; the sweep will pick it up`,
      );
    }

    res.setHeader('Location', `/v1/imports/${job.import_job_id}`);
    res.status(202).json(success(toJob(job), req.requestId));
  },
);

/** GET /v1/imports/{import_job_id} — counts come from the table, never from the queue. */
importsRouter.get(
  '/:import_job_id',
  requirePermission('records:import'),
  async (req: Request, res: Response) => {
    const ctx = requireCtx(req);
    const jobId = pathJobId(req);

    const job = await withTenantContext(ctx, async (client) => {
      const result = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM import_jobs WHERE import_job_id = $1`,
        [jobId],
      );
      return result.rows[0] ?? null;
    });

    if (!job) throw new ApiError('RESOURCE_NOT_FOUND', 'Not found');
    res.json(success(toJob(job), req.requestId));
  },
);

/**
 * GET /v1/imports/{import_job_id}/errors
 *
 * Returns `source_row`, which is the customer's raw data — so this is a PHI read whenever
 * the target type is, and is audited as one. That it happens to be *failed* data changes
 * nothing: a rejected patient row is still a patient row.
 */
importsRouter.get(
  '/:import_job_id/errors',
  requirePermission('records:import'),
  validateQuery('/imports/{import_job_id}/errors', 'get'),
  async (req: Request, res: Response) => {
    const ctx = requireCtx(req);
    const jobId = pathJobId(req);

    const limitRaw = Number(req.query['limit'] ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const cursorRaw = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : null;
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      throw new ApiError('VALIDATION_FAILED', 'cursor is malformed', {
        field_errors: [{ field: 'cursor', code: 'format', message: 'not a valid cursor' }],
      });
    }

    const result = await withTenantContext(ctx, async (client) => {
      const job = await client.query<{ target_record_type: string }>(
        `SELECT target_record_type FROM import_jobs WHERE import_job_id = $1`,
        [jobId],
      );
      if (job.rowCount === 0) return null;

      const rows = await client.query<{
        error_id: string; row_number: number; error_code: string; error_message: string;
        source_row: Record<string, unknown>; created_at: Date;
      }>(
        `SELECT error_id, row_number, error_code, error_message, source_row, created_at
           FROM import_row_errors
          WHERE import_job_id = $1
            AND ($2::timestamptz IS NULL OR
                 (created_at, error_id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, error_id DESC
          LIMIT $4`,
        [jobId, cursor?.createdAt ?? null, cursor?.recordId ?? null, limit + 1],
      );
      return { recordType: job.rows[0]?.target_record_type ?? null, rows: rows.rows };
    });

    if (!result) throw new ApiError('RESOURCE_NOT_FOUND', 'Not found');

    const hasMore = result.rows.length > limit;
    const page = result.rows.slice(0, limit);
    const last = page[page.length - 1];

    req.auditAccess = {
      resourceType: 'import_row_error',
      recordTypes: result.recordType ? [result.recordType] : [],
      resourceId: jobId,
      resultCount: page.length,
    };

    res.json(
      success(
        page.map((r) => ({
          error_id: r.error_id,
          row_number: r.row_number,
          error_code: r.error_code,
          error_message: r.error_message,
          source_row: r.source_row,
          created_at: r.created_at.toISOString(),
        })),
        req.requestId,
        {
          limit,
          has_more: hasMore,
          ...(hasMore && last
            ? { next_cursor: encodeCursor(last.created_at, last.error_id) }
            : {}),
        },
      ),
    );
  },
);

/**
 * POST /v1/imports/{import_job_id}/reverse
 *
 * `database/07`: "Reversal must refuse to run once any imported record has been modified —
 * otherwise it destroys the tenant's own work. Check first; fail loudly rather than
 * deleting."
 *
 * The check is `updated_at > created_at`, and that comparison is only trustworthy because of
 * how the two columns behave. `bump_record_version()` is a BEFORE **UPDATE** trigger, so it
 * never fires on insert; on insert both columns take `DEFAULT NOW()`, which is transaction
 * time and therefore identical to the microsecond. So the pair is exactly equal for an
 * untouched imported record and strictly greater for an edited one. If a future migration
 * gave `records` a BEFORE INSERT trigger that set `updated_at`, this guard would silently
 * start refusing every reversal — which is the failure direction to prefer, but worth
 * knowing about.
 */
importsRouter.post(
  '/:import_job_id/reverse',
  requirePermission('records:import'),
  async (req: Request, res: Response) => {
    const ctx = requireCtx(req);
    const jobId = pathJobId(req);

    const job = await withTenantContext(ctx, async (client) => {
      const found = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM import_jobs WHERE import_job_id = $1 FOR UPDATE`,
        [jobId],
      );
      const row = found.rows[0];
      if (!row) return null;

      if (row.reversed_at !== null) {
        throw new ApiError('IMPORT_NOT_REVERSIBLE', 'This import has already been reversed');
      }
      if (row.is_dry_run) {
        throw new ApiError(
          'IMPORT_NOT_REVERSIBLE',
          'A dry run wrote no records, so there is nothing to reverse',
        );
      }
      if (row.status === 'pending' || row.status === 'running') {
        throw new ApiError(
          'IMPORT_NOT_REVERSIBLE',
          'This import is still running; wait for it to finish',
        );
      }

      const edited = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM records
          WHERE import_job_id = $1 AND updated_at > created_at`,
        [jobId],
      );
      const editedCount = Number(edited.rows[0]?.count ?? '0');
      if (editedCount > 0) {
        throw new ApiError(
          'IMPORT_NOT_REVERSIBLE',
          `${editedCount} imported record(s) have been edited since the import; ` +
          `reversing now would discard that work`,
          { edited_records: editedCount },
        );
      }

      // Links first: record_links cascades from records, but deleting explicitly keeps the
      // reversal honest about what it removed, and the audit trigger on record_links then
      // records each removal rather than having them vanish through a cascade.
      await client.query(
        `DELETE FROM record_links
          WHERE from_record_id IN (SELECT record_id FROM records WHERE import_job_id = $1)
             OR to_record_id   IN (SELECT record_id FROM records WHERE import_job_id = $1)`,
        [jobId],
      );
      const removed = await client.query(
        `DELETE FROM records WHERE import_job_id = $1`,
        [jobId],
      );

      const updated = await client.query<JobRow>(
        `UPDATE import_jobs
            SET reversed_at = NOW(), status = 'skipped', imported_rows = 0
          WHERE import_job_id = $1
        RETURNING ${JOB_COLUMNS}`,
        [jobId],
      );

      req.auditAccess = {
        resourceType: 'import',
        recordTypes: [row.target_record_type],
        resourceId: jobId,
        action: 'delete',
        resultCount: removed.rowCount ?? 0,
      };

      return updated.rows[0] ?? null;
    });

    if (!job) throw new ApiError('RESOURCE_NOT_FOUND', 'Not found');
    res.json(success(toJob(job), req.requestId));
  },
);
