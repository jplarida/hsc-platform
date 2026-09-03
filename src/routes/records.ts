/**
 * /v1/records
 *
 * There is no `WHERE tenant_id = ...` anywhere in this file, and that is the point.
 * Isolation is the database's job (RULE-HSC-02); an application-layer filter is what the
 * design explicitly rejects, because one missing predicate there is a breach rather than
 * a bug. The queries are written as if the tenant were alone in the database, and
 * row-level security makes that true.
 *
 * Shapes follow `api/openapi.yaml` exactly — field names, envelope, pagination, headers.
 * `api/05` makes the spec the source of truth, so where the two disagreed it was this
 * file that was wrong: the first version returned a bare `{ data, has_more }` with `id`
 * and `type`, and drifted from the published contract on day one.
 */

import { Router, type Request, type Response } from 'express';
import { withTenantContext } from '../db/context.js';
import { requirePermission } from '../middleware/stack.js';
import { idempotency } from '../middleware/idempotency.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor, success } from '../http/envelope.js';

export const recordsRouter = Router();

interface RecordRow {
  record_id: string;
  record_type: string;
  title: string | null;
  description: string | null;
  status: string | null;
  workflow_state: string | null;
  version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Shaped as `components/schemas/Record`. Absent rather than null for optional fields. */
function toRecord(r: RecordRow): Record<string, unknown> {
  return {
    record_id: r.record_id,
    record_type: r.record_type,
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.description !== null ? { description: r.description } : {}),
    ...(r.status !== null ? { status: r.status } : {}),
    ...(r.workflow_state !== null ? { workflow_state: r.workflow_state } : {}),
    version: r.version,
    ...(r.created_by !== null ? { created_by: r.created_by } : {}),
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

const SELECT_COLUMNS = `record_id, record_type, title, description, status,
                        workflow_state, version, created_by, created_at, updated_at`;

recordsRouter.get(
  '/',
  requirePermission('records:read'),
  validateQuery('/records', 'get'),
  async (req: Request, res: Response) => {
    const ctx = req.ctx;
    if (!ctx) throw new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context');

    const limitRaw = Number(req.query['limit'] ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const type = typeof req.query['type'] === 'string' ? req.query['type'] : null;
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    const updatedAfter =
      typeof req.query['updated_after'] === 'string' ? req.query['updated_after'] : null;
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : null;

    const cursorRaw = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : null;
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      throw new ApiError('VALIDATION_FAILED', 'cursor is malformed', {
        field_errors: [{ field: 'cursor', code: 'format', message: 'not a valid cursor' }],
      });
    }

    // One row over the limit, to learn whether another page exists without a COUNT.
    // `include_count` is opt-in in the spec precisely because counting a large tenant's
    // records is expensive and most callers only need "is there more?".
    const rows = await withTenantContext(ctx, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM records
          WHERE deleted_at IS NULL
            AND ($1::text IS NULL OR record_type = $1)
            AND ($2::text IS NULL OR status = $2)
            AND ($3::timestamptz IS NULL OR updated_at > $3::timestamptz)
            AND ($4::text IS NULL OR search_vector @@ plainto_tsquery('english', $4))
            AND ($5::timestamptz IS NULL OR
                 (created_at, record_id) < ($5::timestamptz, $6::uuid))
          ORDER BY created_at DESC, record_id DESC
          LIMIT $7`,
        [type, status, updatedAfter, q,
          cursor?.createdAt ?? null, cursor?.recordId ?? null, limit + 1],
      );
      return result.rows;
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    req.auditAccess = {
      resourceType: 'record',
      recordTypes: [...new Set(page.map((r) => r.record_type))],
      resultCount: page.length,
    };

    res.json(
      success(page.map(toRecord), req.requestId, {
        limit,
        has_more: hasMore,
        ...(hasMore && last
          ? { next_cursor: encodeCursor(last.created_at, last.record_id) }
          : {}),
      }),
    );
  },
);

/**
 * POST /v1/records
 *
 * Idempotency is required, not optional. `api/02` lists this route explicitly: mobile
 * clients retry over unreliable networks, and without a key a retried create is a
 * duplicate record.
 *
 * Body validation is the spec's job now — `validateBody` compiles `RecordInput` out of
 * `openapi.yaml`. The hand-rolled checks that used to live here were deleted rather than
 * kept alongside, because a bespoke validator that has to agree with the spec is exactly
 * how the two drift apart.
 */
recordsRouter.post(
  '/',
  requirePermission('records:write'),
  validateBody('/records', 'post'),
  idempotency({ required: true, criticality: 'standard' }),
  async (req: Request, res: Response) => {
    const ctx = req.ctx;
    if (!ctx) throw new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context');

    const body = req.body as {
      record_type: string;
      title?: string;
      description?: string;
      data?: Record<string, unknown>;
      status?: string;
      external_id?: string;
    };

    const created = await withTenantContext(ctx, async (client) => {
      const result = await client.query<RecordRow>(
        `INSERT INTO records
           (tenant_id, record_type, title, description, data, status, external_id, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, 'active'), $7, $8)
         RETURNING ${SELECT_COLUMNS}`,
        [ctx.tenantId, body.record_type, body.title ?? null, body.description ?? null,
          JSON.stringify(body.data ?? {}), body.status ?? null, body.external_id ?? null,
          ctx.userId],
      );
      const row = result.rows[0];
      if (!row) throw new ApiError('INTERNAL_ERROR', 'Insert returned no row');
      return row;
    });

    // A create against a clinical type is PHI handling just as much as a read is, so the
    // record type decides, not the verb.
    req.auditAccess = {
      resourceType: 'record',
      recordTypes: [created.record_type],
      resourceId: created.record_id,
      action: 'create',
    };

    // ETag carries the version api/02 uses for optimistic concurrency on later writes.
    res.setHeader('ETag', `"${created.version}"`);
    res.setHeader('Location', `/v1/records/${created.record_id}`);
    res.status(201).json(success(toRecord(created), req.requestId));
  },
);
