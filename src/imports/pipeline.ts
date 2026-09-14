/**
 * The import pipeline.
 *
 * `database/07` Part B, in order: stage, validate, cleanse, dry-run report, load, resolve
 * links on a second pass, reconcile. Reversal lives in the route, because it is triggered
 * by a request rather than by the worker.
 *
 * ## Transaction boundaries, and why there are three
 *
 * Not one. A single transaction around the whole job would mean that a failure during the
 * load rolls back the row errors as well — destroying the diagnosis along with the attempt,
 * and leaving the customer with a failed import and nothing to look at.
 *
 *   T1  claim          pending -> running, conditionally
 *   T2  validate       write every row error, update counts, commit
 *   T3  load           insert records and links atomically, finalise, commit
 *
 * A dry run stops after T2. A crash between T2 and T3 leaves the job `running` with its
 * errors intact and its records unwritten, and `XAUTOCLAIM` redelivers it — which is why
 * `claimJob` can also take over a job that is already `running` but has been idle too long.
 *
 * ## Role
 *
 * Everything here runs inside `withTenantContext` as `app_user`. The worker legitimately
 * crosses tenants to *find* work, but it must not cross one to *do* work: loading as
 * `app_platform` would make the importer the only write path in the platform not subject to
 * row-level security, and RULE-HSC-02 makes that a compliance defect rather than a shortcut.
 * The tenant id comes from a committed `import_jobs` row — trusted server state, not a
 * request header — which is what makes `deriveContext` honest here.
 */

import { Ajv, type ValidateFunction } from 'ajv';
import { deriveContext, withTenantContext, type TenantClient } from '../db/context.js';
import { recordAccess } from '../audit/phiLog.js';
import { mapRow, type FieldMapping, type MappedRow } from './mapping.js';

/** Matches `ImportRowError.error_code` in `openapi.yaml`. */
export type RowErrorCode =
  | 'required_missing' | 'bad_date' | 'bad_number' | 'duplicate_key'
  | 'unknown_column' | 'schema_invalid' | 'link_unresolved' | 'link_rule_violation';

interface RowError {
  readonly rowNumber: number;
  readonly code: RowErrorCode;
  readonly message: string;
  readonly sourceRow: Record<string, unknown>;
}

export interface ImportJobRow {
  import_job_id: string;
  tenant_id: string;
  target_record_type: string;
  is_dry_run: boolean;
  status: string;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  imported_rows: number;
  created_by: string | null;
}

/**
 * Rows inserted per statement during the load.
 *
 * Part B's throughput section is about imports far larger than one request can carry, but
 * the shape of the problem starts here: one multi-row INSERT per chunk rather than one per
 * record turns N round trips into N/500.
 */
const LOAD_CHUNK = 500;

/** A `running` job idle longer than this may be taken over. Matches the queue's stall window. */
const STALLED_AFTER_MS = 5 * 60_000;

/**
 * Take ownership of a job.
 *
 * The conditional UPDATE is the real mutual exclusion in this design — not the queue. Redis
 * guarantees at-least-once delivery, the sweep deliberately re-enqueues, and both mean a job
 * can arrive twice. Whoever flips `pending` to `running` owns it; everyone else gets no row
 * and stops. That is why duplicate delivery is a non-event rather than a duplicate import.
 */
export async function claimJob(
  tenantId: string,
  userId: string | null,
  importJobId: string,
  { allowStalled = false }: { allowStalled?: boolean } = {},
): Promise<ImportJobRow | null> {
  const ctx = deriveContext({ tenantId, userId });

  return withTenantContext(ctx, async (client) => {
    const result = await client.query<ImportJobRow>(
      `UPDATE import_jobs
          SET status = 'running', started_at = NOW()
        WHERE import_job_id = $1
          AND (status = 'pending'
               OR ($2::boolean AND status = 'running'
                   AND started_at < NOW() - ($3 || ' milliseconds')::interval))
      RETURNING import_job_id, tenant_id, target_record_type, is_dry_run, status,
                total_rows, valid_rows, error_rows, imported_rows, created_by`,
      [importJobId, allowStalled, String(STALLED_AFTER_MS)],
    );
    return result.rows[0] ?? null;
  });
}

/** Run a claimed job to completion. Never throws; a failure marks the job `failed`. */
export async function runJob(job: ImportJobRow): Promise<void> {
  const ctx = deriveContext({ tenantId: job.tenant_id, userId: job.created_by });

  try {
    const validated = await validatePass(ctx, job);

    if (job.is_dry_run) {
      await finalise(ctx, job.import_job_id, 'succeeded', {
        valid: validated.valid.length,
        errors: validated.errorCount,
        imported: 0,
      });
      await auditJob(job, 'dry_run', validated.valid.length, validated.isPhi);
      return;
    }

    const imported = await loadPass(ctx, job, validated.valid);
    await finalise(ctx, job.import_job_id, 'succeeded', {
      valid: validated.valid.length,
      errors: validated.errorCount + imported.lateErrors,
      imported: imported.count,
    });
    await auditJob(job, 'create', imported.count, validated.isPhi);
  } catch (err) {
    console.error(`[import] job ${job.import_job_id} failed:`, (err as Error).message);
    // Best effort. If this also fails the job stays `running` and the stall reclaim is the
    // backstop — which is why that path exists rather than trusting this one.
    await finalise(ctx, job.import_job_id, 'failed', null).catch(() => undefined);
  }
}

interface ValidatedRow {
  readonly rowNumber: number;
  readonly staged: MappedRow;
}

interface ValidationOutcome {
  readonly valid: readonly ValidatedRow[];
  readonly errorCount: number;
  readonly isPhi: boolean;
}

/**
 * T2 — cleanse and validate every staged row.
 *
 * Part B's validation table in order: required, type (via the declared transforms),
 * schema (against the target type's published form), uniqueness (`external_id`, both within
 * the batch and against records already present). Referential and business checks belong to
 * the second pass, because they need the loaded rows to exist.
 */
async function validatePass(
  ctx: ReturnType<typeof deriveContext>,
  job: ImportJobRow,
): Promise<ValidationOutcome> {
  return withTenantContext(ctx, async (client) => {
    const mappings = await loadMappings(client, job.import_job_id);
    const staged = await client.query<{
      row_number: number; external_id: string | null; source_row: Record<string, unknown>;
    }>(
      `SELECT row_number, external_id, source_row
         FROM import_staging
        WHERE import_job_id = $1
        ORDER BY row_number`,
      [job.import_job_id],
    );

    const typeInfo = await client.query<{ is_phi: boolean; default_form_id: string | null }>(
      `SELECT is_phi, default_form_id FROM record_type_definitions WHERE code = $1`,
      [job.target_record_type],
    );
    // An unknown type is treated as PHI, matching how the PHI audit middleware resolves an
    // unrecognised record type. The safe default is the expensive one.
    const isPhi = typeInfo.rows[0]?.is_phi ?? true;
    const schema = await loadFormSchema(client, typeInfo.rows[0]?.default_form_id ?? null);

    const errors: RowError[] = [];
    const valid: ValidatedRow[] = [];
    const seenExternalIds = new Map<string, number>();

    for (const row of staged.rows) {
      const mapped = mapRow(row.source_row, mappings);
      if (!mapped.ok) {
        for (const failure of mapped.failures) {
          errors.push({
            rowNumber: row.row_number, code: failure.code,
            message: failure.message, sourceRow: row.source_row,
          });
        }
        continue;
      }

      if (schema && !schema(mapped.row.data)) {
        const detail = (schema.errors ?? [])
          .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`)
          .join('; ');
        errors.push({
          rowNumber: row.row_number, code: 'schema_invalid',
          message: `does not match the form schema: ${detail}`,
          sourceRow: row.source_row,
        });
        continue;
      }

      const externalId = mapped.row.externalId;
      if (externalId !== null) {
        const firstSeen = seenExternalIds.get(externalId);
        if (firstSeen !== undefined) {
          errors.push({
            rowNumber: row.row_number, code: 'duplicate_key',
            message: `external id "${externalId}" also appears at row ${firstSeen}`,
            sourceRow: row.source_row,
          });
          continue;
        }
        seenExternalIds.set(externalId, row.row_number);
      }

      valid.push({ rowNumber: row.row_number, staged: mapped.row });
    }

    // Uniqueness against what is already stored. One query for the whole batch rather than
    // one per row: at 5,000 rows the difference is a round trip against a cheap index scan.
    const candidates = valid
      .map((v) => v.staged.externalId)
      .filter((id): id is string => id !== null);

    if (candidates.length > 0) {
      const existing = await client.query<{ external_id: string }>(
        `SELECT external_id FROM records
          WHERE record_type = $1 AND external_id = ANY($2::text[]) AND deleted_at IS NULL`,
        [job.target_record_type, candidates],
      );
      const taken = new Set(existing.rows.map((r) => r.external_id));
      if (taken.size > 0) {
        for (let i = valid.length - 1; i >= 0; i -= 1) {
          const entry = valid[i] as ValidatedRow;
          const id = entry.staged.externalId;
          if (id !== null && taken.has(id)) {
            const source = staged.rows.find((r) => r.row_number === entry.rowNumber);
            errors.push({
              rowNumber: entry.rowNumber, code: 'duplicate_key',
              message: `a record with external id "${id}" already exists`,
              sourceRow: source?.source_row ?? {},
            });
            valid.splice(i, 1);
          }
        }
      }
    }

    await writeRowErrors(client, job, errors);
    await client.query(
      `UPDATE import_jobs SET valid_rows = $2, error_rows = $3 WHERE import_job_id = $1`,
      [job.import_job_id, valid.length, errors.length],
    );

    return { valid, errorCount: errors.length, isPhi };
  });
}

interface LoadOutcome {
  readonly count: number;
  readonly lateErrors: number;
}

/**
 * T3 — insert the records, then resolve links.
 *
 * Atomic. A half-loaded batch is worse than none: reversal is by `import_job_id` and would
 * happily delete the half that landed, but the customer has no way to know which half that
 * was without diffing their source against the platform.
 */
async function loadPass(
  ctx: ReturnType<typeof deriveContext>,
  job: ImportJobRow,
  valid: readonly ValidatedRow[],
): Promise<LoadOutcome> {
  if (valid.length === 0) return { count: 0, lateErrors: 0 };

  return withTenantContext(ctx, async (client) => {
    const idsByExternal = new Map<string, string>();
    let inserted = 0;

    for (let start = 0; start < valid.length; start += LOAD_CHUNK) {
      const chunk = valid.slice(start, start + LOAD_CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((entry, i) => {
        const o = i * 8;
        values.push(
          job.tenant_id, job.target_record_type, entry.staged.title,
          entry.staged.description, JSON.stringify(entry.staged.data),
          entry.staged.status ?? 'active', entry.staged.externalId, job.import_job_id,
        );
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5}::jsonb,$${o + 6},` +
               `$${o + 7},$${o + 8})`;
      });

      const result = await client.query<{ record_id: string; external_id: string | null }>(
        `INSERT INTO records
           (tenant_id, record_type, title, description, data, status, external_id,
            import_job_id)
         VALUES ${tuples.join(',')}
         RETURNING record_id, external_id`,
        values,
      );

      inserted += result.rowCount ?? 0;
      for (const row of result.rows) {
        if (row.external_id !== null) idsByExternal.set(row.external_id, row.record_id);
      }
    }

    const lateErrors = await resolveLinks(client, job, valid, idsByExternal);
    return { count: inserted, lateErrors };
  });
}

/**
 * The second pass.
 *
 * Links cannot be created until both endpoints exist, which is the entire reason Part B
 * splits the load in two. The target is matched on `external_id` — a legacy
 * `appointment.patient_id` is a lookup key in the source system, not a UUID here.
 *
 * Two failures are expected rather than exceptional, and both become row errors instead of
 * failing the batch:
 *
 *   * the target external id is absent from this tenant — `link_unresolved`
 *   * `enforce_record_link_rule` refuses the link — `link_rule_violation`
 *
 * The second is matched on SQLSTATE `23514`, never on the message, for the same reason the
 * links route does: wording changes with a PostgreSQL upgrade and a string match would fail
 * silently at exactly the wrong moment.
 */
async function resolveLinks(
  client: TenantClient,
  job: ImportJobRow,
  valid: readonly ValidatedRow[],
  idsByExternal: ReadonlyMap<string, string>,
): Promise<number> {
  const wanted = valid.filter((v) => v.staged.links.length > 0);
  if (wanted.length === 0) return 0;

  const errors: RowError[] = [];

  for (const entry of wanted) {
    const fromId = entry.staged.externalId === null
      ? null
      : idsByExternal.get(entry.staged.externalId) ?? null;

    if (fromId === null) {
      // A row that declares a link but carries no external_id of its own cannot be the
      // source of one: there is nothing to match it back to after insertion.
      errors.push({
        rowNumber: entry.rowNumber, code: 'link_unresolved',
        message: 'a row that declares links must also map external_id',
        sourceRow: {},
      });
      continue;
    }

    for (const link of entry.staged.links) {
      const target = await client.query<{ record_id: string }>(
        `SELECT record_id FROM records
          WHERE record_type = $1 AND external_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [link.toTypeCode, link.toExternalId],
      );
      const toId = target.rows[0]?.record_id;

      if (!toId) {
        errors.push({
          rowNumber: entry.rowNumber, code: 'link_unresolved',
          message:
            `no ${link.toTypeCode} with external id "${link.toExternalId}" exists in this tenant`,
          sourceRow: {},
        });
        continue;
      }

      try {
        // Savepoint: a refused link must not poison the transaction carrying the whole
        // batch. Without it the first rule violation aborts every insert that followed.
        await client.query('SAVEPOINT link_attempt');
        await client.query(
          `INSERT INTO record_links (tenant_id, from_record_id, to_record_id, link_type)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (from_record_id, to_record_id, link_type) DO NOTHING`,
          [job.tenant_id, fromId, toId, link.linkType],
        );
        await client.query('RELEASE SAVEPOINT link_attempt');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT link_attempt');
        const code = (err as { code?: string }).code;
        if (code !== '23514') throw err;
        errors.push({
          rowNumber: entry.rowNumber, code: 'link_rule_violation',
          message: `no rule permits a link to ${link.toTypeCode} via "${link.linkType}"`,
          sourceRow: {},
        });
      }
    }
  }

  if (errors.length > 0) {
    await writeRowErrors(client, job, errors);
    await client.query(
      `UPDATE import_jobs SET error_rows = error_rows + $2 WHERE import_job_id = $1`,
      [job.import_job_id, errors.length],
    );
  }
  return errors.length;
}

async function loadMappings(
  client: TenantClient,
  importJobId: string,
): Promise<readonly FieldMapping[]> {
  const result = await client.query<FieldMapping>(
    `SELECT source_column, target_path, transform, is_required, default_value
       FROM import_field_mappings
      WHERE import_job_id = $1
      ORDER BY mapping_id`,
    [importJobId],
  );
  return result.rows;
}

/**
 * Compile the target type's published form schema, if it has one.
 *
 * A type with no form is not an error — the registry allows it, and `records.data` has no
 * shape requirement of its own. It simply means the schema stage has nothing to check.
 */
const schemaCache = new Map<string, ValidateFunction>();

async function loadFormSchema(
  client: TenantClient,
  formId: string | null,
): Promise<ValidateFunction | null> {
  if (!formId) return null;

  const result = await client.query<{ form_version_id: string; schema: unknown }>(
    `SELECT fv.form_version_id, fv.schema
       FROM forms f
       JOIN form_versions fv ON fv.form_version_id = f.current_version_id
      WHERE f.form_id = $1`,
    [formId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const cached = schemaCache.get(row.form_version_id);
  if (cached) return cached;

  try {
    // A tenant-authored schema is untrusted input. `strict: false` keeps Ajv from rejecting
    // annotations it does not know — `phi_class` and the `{system, code, display}` triple
    // both live inside these schemas by convention (`analytics/01`, `interoperability/01`).
    const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false });
    const validate = ajv.compile(row.schema as object);
    schemaCache.set(row.form_version_id, validate);
    return validate;
  } catch (err) {
    // An uncompilable form schema must not fail every import against that type. Skipping
    // the stage is visible in the logs; refusing the batch would be a platform failure
    // reported as a data failure.
    console.warn(
      `[import] form version ${row.form_version_id} has an uncompilable schema: ` +
      `${(err as Error).message}`,
    );
    return null;
  }
}

async function writeRowErrors(
  client: TenantClient,
  job: ImportJobRow,
  errors: readonly RowError[],
): Promise<void> {
  if (errors.length === 0) return;

  for (let start = 0; start < errors.length; start += LOAD_CHUNK) {
    const chunk = errors.slice(start, start + LOAD_CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((e, i) => {
      const o = i * 6;
      values.push(
        job.tenant_id, job.import_job_id, e.rowNumber,
        JSON.stringify(e.sourceRow), e.code, e.message,
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4}::jsonb,$${o + 5},$${o + 6})`;
    });
    await client.query(
      `INSERT INTO import_row_errors
         (tenant_id, import_job_id, row_number, source_row, error_code, error_message)
       VALUES ${tuples.join(',')}`,
      values,
    );
  }
}

async function finalise(
  ctx: ReturnType<typeof deriveContext>,
  importJobId: string,
  status: 'succeeded' | 'failed',
  counts: { valid: number; errors: number; imported: number } | null,
): Promise<void> {
  await withTenantContext(ctx, async (client) => {
    if (counts) {
      await client.query(
        `UPDATE import_jobs
            SET status = $2, completed_at = NOW(),
                valid_rows = $3, error_rows = $4, imported_rows = $5
          WHERE import_job_id = $1`,
        [importJobId, status, counts.valid, counts.errors, counts.imported],
      );
    } else {
      await client.query(
        `UPDATE import_jobs SET status = $2, completed_at = NOW() WHERE import_job_id = $1`,
        [importJobId, status],
      );
    }
    return true;
  });
}

/**
 * One audit entry for the job, not one per row.
 *
 * The rows themselves are already audited: the `records` trigger writes a `data_audit_log`
 * entry per insert, which is the evidentiary record of what changed. This is the access
 * entry — who ran a bulk load of what, and how much of it — which is the question an auditor
 * actually asks about an import.
 *
 * Part B flags per-row auditing above roughly 100k rows as needing compliance sign-off. That
 * ceiling is not reached here, because a request carries at most 5,000 rows; it will be when
 * `/files` lets a job carry a whole document, and this is the seam where the exception would
 * go.
 */
async function auditJob(
  job: ImportJobRow,
  action: 'create' | 'dry_run',
  affected: number,
  isPhi: boolean,
): Promise<void> {
  recordAccess({
    tenantId: job.tenant_id,
    userId: job.created_by,
    sessionId: null,
    appId: null,
    installationId: null,
    // A dry run reads and validates the supplied data without writing a record, so it is
    // an access rather than a creation. Recording it as 'create' would put writes in the
    // audit trail that never happened.
    action: action === 'create' ? 'create' : 'view',
    resourceType: 'import',
    resourceId: job.import_job_id,
    isPhiAccess: isPhi,
    ipAddress: null,
    userAgent: null,
    details: {
      import_job_id: job.import_job_id,
      record_type: job.target_record_type,
      is_dry_run: job.is_dry_run,
      affected_rows: affected,
    },
    at: new Date(),
  });
}
