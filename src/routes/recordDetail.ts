/**
 * /v1/records/{record_id} — GET, PATCH, DELETE.
 *
 * These are the endpoints that make the `ETag` the create endpoint already emits mean
 * something. Until now it was decoration; here it is the optimistic-concurrency token
 * `api/02` designed it to be.
 *
 * Split from `records.ts` only for size. The routes attach to the same router, so the
 * pipeline and permissions apply identically.
 */

import type { Request, Response, Router } from 'express';
import { withTenantContext, type VerifiedTenantContext } from '../db/context.js';
import { requirePermission } from '../middleware/stack.js';
import { ApiError } from '../http/errors.js';
import { success } from '../http/envelope.js';
import { applyMergePatch, immutableViolations, type Json } from '../http/mergePatch.js';
import { requireIfMatch } from '../http/preconditions.js';
import { SELECT_COLUMNS, toRecord, type RecordRow } from './records.js';

/** Checked before the query, so a malformed id is a clean 404 rather than a cast error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recordId(req: Request): string {
  const raw = req.params['record_id'];
  // Express 5 types a path param as string | string[]; the array case cannot occur for a
  // single-segment route, but narrowing it here is cheaper than asserting it away.
  const id = typeof raw === 'string' ? raw : '';
  // 404, not 422. A malformed id is indistinguishable to the caller from an id that does
  // not exist, and saying "that is not a valid uuid" tells an enumerator their probe was
  // at least well-formed.
  if (!UUID.test(id)) throw new ApiError('RESOURCE_NOT_FOUND', 'Record not found');
  return id;
}

function preconditionFailed(res: Response, expected: number, current: number): never {
  res.setHeader('ETag', `"${current}"`);
  throw new ApiError(
    'PRECONDITION_FAILED',
    'The record has changed since you fetched it. Re-fetch and retry.',
    { expected_version: expected, current_version: current },
  );
}

export function registerRecordDetailRoutes(router: Router): void {
  /**
   * GET one record.
   *
   * Missing and another-tenant's are the same 404, because RLS makes them
   * indistinguishable — and that is the correct externally-visible behaviour. `api/01`: a
   * 403 would confirm the record exists. A permission failure *inside* your own tenant is
   * a genuine 403, and that is decided earlier by requirePermission.
   */
  router.get(
    '/:record_id',
    requirePermission('records:read'),
    async (req: Request, res: Response) => {
      const ctx = requireCtx(req);
      const id = recordId(req);

      const record = await withTenantContext(ctx, async (client) => {
        const result = await client.query<RecordRow>(
          `SELECT ${SELECT_COLUMNS} FROM records
            WHERE record_id = $1 AND deleted_at IS NULL`,
          [id],
        );
        return result.rows[0] ?? null;
      });

      if (!record) throw new ApiError('RESOURCE_NOT_FOUND', 'Record not found');

      req.auditAccess = {
        resourceType: 'record',
        recordTypes: [record.record_type],
        resourceId: record.record_id,
      };

      res.setHeader('ETag', `"${record.version}"`);
      res.json(success(toRecord(record), req.requestId));
    },
  );

  /**
   * PATCH — JSON Merge Patch, guarded by If-Match.
   *
   * The version guard is IN the UPDATE's WHERE clause, not checked beforehand. A
   * read-then-write leaves a window in which another client commits, which is precisely
   * the lost update this exists to prevent: the check has to be part of the statement
   * that does the writing.
   */
  router.patch(
    '/:record_id',
    requirePermission('records:write'),
    async (req: Request, res: Response) => {
      const ctx = requireCtx(req);
      const id = recordId(req);
      const expected = requireIfMatch(req.header('if-match'));
      const patch = (req.body ?? {}) as Record<string, unknown>;

      const forbidden = immutableViolations(patch);
      if (forbidden.length > 0) {
        throw new ApiError('VALIDATION_FAILED', 'These fields cannot be patched', {
          field_errors: forbidden.map((f) => ({
            field: f, code: 'immutable', message: 'cannot be changed by a patch',
          })),
        });
      }

      const outcome = await withTenantContext(ctx, async (client) => {
        const current = await client.query<RecordRow & { data: Record<string, unknown> }>(
          `SELECT ${SELECT_COLUMNS}, data FROM records
            WHERE record_id = $1 AND deleted_at IS NULL`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return { kind: 'missing' as const };

        // Merge computed inside the same transaction as the guarded write, against the
        // row that write will actually target.
        const merged = 'data' in patch
          ? applyMergePatch((row.data ?? {}) as Json, patch['data'] as Json)
          : row.data;

        const result = await client.query<RecordRow>(
          `UPDATE records
              SET title       = CASE WHEN $3 THEN $4        ELSE title       END,
                  description = CASE WHEN $5 THEN $6        ELSE description END,
                  status      = CASE WHEN $7 THEN COALESCE($8, 'active') ELSE status END,
                  data        = $9::jsonb,
                  updated_by  = $10
            WHERE record_id = $1 AND version = $2 AND deleted_at IS NULL
          RETURNING ${SELECT_COLUMNS}`,
          [id, expected,
            'title' in patch, (patch['title'] ?? null) as string | null,
            'description' in patch, (patch['description'] ?? null) as string | null,
            'status' in patch, (patch['status'] ?? null) as string | null,
            JSON.stringify(merged ?? {}), ctx.userId],
        );

        const updated = result.rows[0];
        // Zero rows while the record exists means the version moved on: someone else
        // committed between this client's read and its write.
        return updated
          ? { kind: 'ok' as const, row: updated }
          : { kind: 'stale' as const, row };
      });

      if (outcome.kind === 'missing') {
        throw new ApiError('RESOURCE_NOT_FOUND', 'Record not found');
      }
      if (outcome.kind === 'stale') {
        preconditionFailed(res, expected, outcome.row.version);
      }

      req.auditAccess = {
        resourceType: 'record',
        recordTypes: [outcome.row.record_type],
        resourceId: outcome.row.record_id,
        action: 'update',
      };

      res.setHeader('ETag', `"${outcome.row.version}"`);
      res.json(success(toRecord(outcome.row), req.requestId));
    },
  );

  /**
   * DELETE — soft, never hard.
   *
   * Sets `deleted_at`. A hard delete would take the row out from under its audit history
   * and its file associations, and `database/04`'s retention model expects it to survive
   * until a purge job with a stated legal basis removes it. Erasure under GDPR is an
   * anonymise rather than a DELETE, for the same reason.
   */
  router.delete(
    '/:record_id',
    requirePermission('records:delete'),
    async (req: Request, res: Response) => {
      const ctx = requireCtx(req);
      const id = recordId(req);
      const expected = requireIfMatch(req.header('if-match'));

      const outcome = await withTenantContext(ctx, async (client) => {
        const result = await client.query<RecordRow>(
          `UPDATE records SET deleted_at = NOW(), updated_by = $3
            WHERE record_id = $1 AND version = $2 AND deleted_at IS NULL
          RETURNING ${SELECT_COLUMNS}`,
          [id, expected, ctx.userId],
        );
        const row = result.rows[0];
        if (row) return { kind: 'ok' as const, row };

        const current = await client.query<RecordRow>(
          `SELECT ${SELECT_COLUMNS} FROM records
            WHERE record_id = $1 AND deleted_at IS NULL`,
          [id],
        );
        const existing = current.rows[0];
        return existing
          ? { kind: 'stale' as const, row: existing }
          : { kind: 'missing' as const };
      });

      if (outcome.kind === 'missing') {
        throw new ApiError('RESOURCE_NOT_FOUND', 'Record not found');
      }
      if (outcome.kind === 'stale') {
        preconditionFailed(res, expected, outcome.row.version);
      }

      req.auditAccess = {
        resourceType: 'record',
        recordTypes: [outcome.row.record_type],
        resourceId: outcome.row.record_id,
        action: 'delete',
      };

      // 204 carries no body, so no envelope — the spec declares no content for it.
      res.status(204).end();
    },
  );
}

function requireCtx(req: Request): VerifiedTenantContext {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context');
  return ctx;
}
