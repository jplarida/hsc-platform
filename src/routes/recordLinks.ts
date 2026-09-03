/**
 * /v1/records/{record_id}/links
 *
 * The first endpoint whose rules live in the DATABASE rather than the handler.
 * `enforce_record_link_rule` (migration 0004) checks every link against a declared
 * `record_link_rules` row and enforces its cardinality, because a plain foreign key cannot
 * express "an appointment links to exactly one patient" when both live in the same table.
 *
 * That makes the interesting work here translation, not logic. The trigger raises
 * `check_violation`, and `api/02` is explicit that the client must see
 * `422 LINK_RULE_VIOLATION` "rather than a database error". A 500 with a plpgsql message in
 * it tells a client nothing it can act on, and leaks the schema while doing it.
 */

import type { Request, Response, Router } from 'express';
import { withTenantContext, type VerifiedTenantContext } from '../db/context.js';
import { requirePermission } from '../middleware/stack.js';
import { validateBody } from '../middleware/validate.js';
import { ApiError } from '../http/errors.js';
import { success } from '../http/envelope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LinkRow {
  link_id: string;
  from_record_id: string;
  to_record_id: string;
  link_type: string;
  metadata: Record<string, unknown> | null;
}

/** Shaped as `components/schemas/RecordLink`. */
function toLink(r: LinkRow): Record<string, unknown> {
  return {
    link_id: r.link_id,
    from_record_id: r.from_record_id,
    to_record_id: r.to_record_id,
    link_type: r.link_type,
    ...(r.metadata && Object.keys(r.metadata).length > 0 ? { metadata: r.metadata } : {}),
  };
}

function pathId(req: Request, name: string): string {
  const raw = req.params[name];
  const id = typeof raw === 'string' ? raw : '';
  if (!UUID.test(id)) throw new ApiError('RESOURCE_NOT_FOUND', 'Not found');
  return id;
}

function requireCtx(req: Request): VerifiedTenantContext {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError('MISSING_AUTHORIZATION', 'No verified tenant context');
  return ctx;
}

/**
 * Confirm the record is visible to this tenant before doing anything with it.
 *
 * Without this, an impermissible link against a record belonging to someone else would
 * return LINK_RULE_VIOLATION — which confirms the record exists. RLS makes it invisible,
 * so the answer has to be 404, and it has to be decided before the trigger speaks.
 */
async function assertRecordVisible(
  ctx: VerifiedTenantContext,
  recordId: string,
): Promise<string> {
  const type = await withTenantContext(ctx, async (client) => {
    const result = await client.query<{ record_type: string }>(
      `SELECT record_type FROM records WHERE record_id = $1 AND deleted_at IS NULL`,
      [recordId],
    );
    return result.rows[0]?.record_type ?? null;
  });
  if (!type) throw new ApiError('RESOURCE_NOT_FOUND', 'Record not found');
  return type;
}

/**
 * PostgreSQL error codes the link trigger and its constraints can produce.
 *
 * Matched on SQLSTATE rather than on message text. Message wording is not a stable
 * interface — it changes with a PostgreSQL upgrade or a rewritten RAISE — and a client
 * behaviour keyed to it breaks silently on a minor version bump.
 */
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

function translateLinkError(err: unknown): never {
  const code = (err as { code?: string } | null)?.code;

  if (code === CHECK_VIOLATION) {
    // Raised by enforce_record_link_rule: either no rule permits the combination, or the
    // rule's cardinality is already satisfied. The trigger's message says which, and it
    // names only types and link names — no row values — so it is safe to pass through.
    throw new ApiError('LINK_RULE_VIOLATION', (err as Error).message);
  }
  if (code === UNIQUE_VIOLATION) {
    // UNIQUE (from_record_id, to_record_id, link_type). Linking twice is not an error
    // worth inventing a state for, but it is not a silent success either.
    throw new ApiError('LINK_RULE_VIOLATION', 'That link already exists');
  }
  if (code === FK_VIOLATION) {
    // The target record does not exist. Reported as a missing target rather than a
    // dangling reference, which is what the caller can act on.
    throw new ApiError('RESOURCE_NOT_FOUND', 'The target record was not found');
  }
  throw err;
}

export function registerRecordLinkRoutes(router: Router): void {
  router.get(
    '/:record_id/links',
    requirePermission('records:read'),
    async (req: Request, res: Response) => {
      const ctx = requireCtx(req);
      const id = pathId(req, 'record_id');
      await assertRecordVisible(ctx, id);

      const raw = req.query['direction'];
      const direction = typeof raw === 'string' ? raw : 'both';
      if (!['from', 'to', 'both'].includes(direction)) {
        throw new ApiError('VALIDATION_FAILED', 'direction is invalid', {
          field_errors: [{
            field: 'direction', code: 'enum', message: 'must be from, to or both',
          }],
        });
      }

      const links = await withTenantContext(ctx, async (client) => {
        const result = await client.query<LinkRow>(
          `SELECT link_id, from_record_id, to_record_id, link_type, metadata
             FROM record_links
            WHERE ($2 IN ('from', 'both') AND from_record_id = $1)
               OR ($2 IN ('to',   'both') AND to_record_id   = $1)
            ORDER BY created_at DESC, link_id DESC`,
          [id, direction],
        );
        return result.rows;
      });

      // The linked records are other records, and reading a link reveals which. That is a
      // relationship rather than content, but for a PHI type the fact that two records are
      // linked is itself clinical information.
      req.auditAccess = {
        resourceType: 'record_link',
        recordTypes: [await assertRecordVisible(ctx, id)],
        resourceId: id,
        resultCount: links.length,
      };

      res.json(success(links.map(toLink), req.requestId));
    },
  );

  router.post(
    '/:record_id/links',
    requirePermission('records:write'),
    validateBody('/records/{record_id}/links', 'post'),
    async (req: Request, res: Response) => {
      const ctx = requireCtx(req);
      const id = pathId(req, 'record_id');
      const fromType = await assertRecordVisible(ctx, id);

      const body = req.body as {
        to_record_id: string;
        link_type: string;
        metadata?: Record<string, unknown>;
      };

      if (body.to_record_id === id) {
        // The CHECK constraint catches this too, but as a check_violation it would be
        // reported as a rule violation, which is misleading — no rule could ever permit it.
        throw new ApiError('VALIDATION_FAILED', 'A record cannot link to itself', {
          field_errors: [{
            field: 'to_record_id', code: 'self_link', message: 'must differ from the source',
          }],
        });
      }

      // The TARGET has to be checked too, not just the source.
      //
      // enforce_record_link_rule raises check_violation for both "no rule permits this"
      // and "that endpoint is not in your tenant", because RLS makes another tenant's
      // record simply invisible to the trigger's lookup. Translating that SQLSTATE
      // blindly returned 422 LINK_RULE_VIOLATION for a record the caller cannot see —
      // which tells them a rule is missing, when the truth is there is nothing there.
      //
      // 404 has to be decided here, before the trigger speaks, for the same reason
      // api/01 makes a tenant-mismatched record a 404 rather than a 403.
      await assertRecordVisible(ctx, body.to_record_id);

      const link = await withTenantContext(ctx, async (client) => {
        const result = await client.query<LinkRow>(
          `INSERT INTO record_links
             (tenant_id, from_record_id, to_record_id, link_type, metadata, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING link_id, from_record_id, to_record_id, link_type, metadata`,
          [ctx.tenantId, id, body.to_record_id, body.link_type,
            JSON.stringify(body.metadata ?? {}), ctx.userId],
        );
        const row = result.rows[0];
        if (!row) throw new ApiError('INTERNAL_ERROR', 'Insert returned no row');
        return row;
      }).catch(translateLinkError);

      req.auditAccess = {
        resourceType: 'record_link',
        recordTypes: [fromType],
        resourceId: link.link_id,
        action: 'create',
      };

      res.status(201).json(success(toLink(link), req.requestId));
    },
  );

  /**
   * Unlink. A hard delete, unlike a record.
   *
   * A link is a relationship assertion rather than a record: it carries no retention
   * obligation of its own, and the `data_audit_log` trigger on `record_links` already
   * preserves what was removed, so the history survives the row.
   */
  router.delete(
    '/:record_id/links/:link_id',
    requirePermission('records:write'),
    async (req: Request, res: Response) => {
      const ctx = requireCtx(req);
      const recordId = pathId(req, 'record_id');
      const linkId = pathId(req, 'link_id');

      const removed = await withTenantContext(ctx, async (client) => {
        // The from_record_id predicate matters: without it, a link id alone would let a
        // caller delete a link hanging off a different record in the same tenant, which is
        // not what the path they requested says they are doing.
        const result = await client.query<LinkRow>(
          `DELETE FROM record_links
            WHERE link_id = $1 AND from_record_id = $2
          RETURNING link_id, from_record_id, to_record_id, link_type, metadata`,
          [linkId, recordId],
        );
        return result.rows[0] ?? null;
      });

      if (!removed) throw new ApiError('RESOURCE_NOT_FOUND', 'Link not found');

      req.auditAccess = {
        resourceType: 'record_link',
        recordTypes: [await assertRecordVisible(ctx, recordId)],
        resourceId: removed.link_id,
        action: 'delete',
      };

      res.status(204).end();
    },
  );
}
