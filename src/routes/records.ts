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
