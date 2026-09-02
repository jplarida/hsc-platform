/**
 * GET /v1/records — one real endpoint, to prove the stack carries a request end to end.
 *
 * There is no `WHERE tenant_id = ...` anywhere in this file, and that is the point.
 * Isolation is the database's job (RULE-HSC-02); an application-layer filter is the
 * thing the design explicitly rejects, because one missing predicate is a breach rather
 * than a bug. The query below is written as if the tenant were the only one in the
 * database, and RLS makes that true.
 */

import { Router, type Request, type Response } from 'express';
import { withTenantContext } from '../db/context.js';
import { requirePermission } from '../middleware/stack.js';
import { idempotency } from '../middleware/idempotency.js';
import { ApiError } from '../http/errors.js';

export const recordsRouter = Router();

interface RecordRow {
  record_id: string;
  record_type: string;
  title: string | null;
  status: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

recordsRouter.get(
  '/',
  requirePermission('records:read'),
  async (req: Request, res: Response) => {
    const ctx = req.ctx;
    if (!ctx) throw new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context');

    // Cursor pagination, not offset: api/02 specifies it, and an offset scan over a
    // large tenant's records degrades with depth while a keyset seek does not.
    const limitRaw = Number(req.query['limit'] ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const type = typeof req.query['type'] === 'string' ? req.query['type'] : null;

    const rows = await withTenantContext(ctx, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record_id, record_type, title, status, version, created_at, updated_at
           FROM records
          WHERE deleted_at IS NULL
            AND ($1::text IS NULL OR record_type = $1)
          ORDER BY created_at DESC, record_id DESC
          LIMIT $2`,
        [type, limit],
      );
      return result.rows;
    });

    // Stage 14 needs the record types that actually came back, not the ones the query
    // asked for: an unfiltered list returns whatever the tenant has, and guessing from
    // the query parameter would miss every PHI read made without a filter.
    req.auditAccess = {
      resourceType: 'record',
      recordTypes: [...new Set(rows.map((r) => r.record_type))],
      resultCount: rows.length,
    };

    res.json({
      data: rows.map((r) => ({
        id: r.record_id,
        type: r.record_type,
        title: r.title,
        status: r.status,
        version: r.version,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      // A page smaller than the limit means there is nothing after it.
      has_more: rows.length === limit,
    });
  },
);

interface CreateBody {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  data?: unknown;
}

/**
 * POST /v1/records — the first mutation endpoint.
 *
 * Idempotency is required here, not optional. `api/02` lists this route explicitly:
 * mobile clients retry over unreliable networks, and without a key a retried create is
 * a duplicate record. Requiring it from the first day is much cheaper than retrofitting
 * it onto endpoints that already have callers.
 *
 * Validation here is deliberately minimal and hand-rolled. Stage 11 validates against
 * `openapi.yaml`, and when it lands this block goes away — writing a bespoke validator
 * that then has to agree with the spec is how the two drift apart.
 */
recordsRouter.post(
  '/',
  requirePermission('records:write'),
  idempotency({ required: true, criticality: 'standard' }),
  async (req: Request, res: Response) => {
    const ctx = req.ctx;
    if (!ctx) throw new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context');

    const body = (req.body ?? {}) as CreateBody;
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    const title = typeof body.title === 'string' ? body.title : null;
    const description = typeof body.description === 'string' ? body.description : null;
    const data = body.data && typeof body.data === 'object' ? body.data : {};

    if (!type) {
      throw new ApiError('VALIDATION_FAILED', 'type is required', {
        fields: { type: 'must be a non-empty string' },
      });
    }

    const created = await withTenantContext(ctx, async (client) => {
      const result = await client.query<RecordRow>(
        `INSERT INTO records (tenant_id, record_type, title, description, data, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING record_id, record_type, title, status, version, created_at, updated_at`,
        [ctx.tenantId, type, title, description, JSON.stringify(data), ctx.userId],
      );
      const row = result.rows[0];
      if (!row) throw new ApiError('INTERNAL_ERROR', 'Insert returned no row');
      return row;
    });

    // Stage 14 records this as a create. Whether it counts as PHI access is decided from
    // the type, not from the endpoint — a create against a clinical type is PHI handling
    // just as much as a read is.
    req.auditAccess = {
      resourceType: 'record',
      recordTypes: [created.record_type],
      resourceId: created.record_id,
      action: 'create',
    };

    // The version is the ETag api/02 uses for optimistic concurrency on later writes.
    res.setHeader('ETag', `"${created.version}"`);
    res.status(201).json({
      id: created.record_id,
      type: created.record_type,
      title: created.title,
      status: created.status,
      version: created.version,
      created_at: created.created_at,
      updated_at: created.updated_at,
    });
  },
);
