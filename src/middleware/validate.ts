/**
 * Stage 11 — request validation against `openapi.yaml`.
 *
 * Placed after authorization, per `api/06`: detailed validation errors on a resource you
 * cannot access leak its shape. And before idempotency, so an invalid request does not
 * burn a key.
 *
 * The validators come from the published spec rather than from hand-written checks. A
 * bespoke validator has to be kept in agreement with the document by somebody
 * remembering to, which is how the two drift apart — and the drift is invisible, because
 * both sides look self-consistent.
 */

import type { NextFunction, Request, Response } from 'express';
import type { ErrorObject } from 'ajv';
import { ApiError } from '../http/errors.js';
import { bodyValidator, queryParams } from '../openapi/spec.js';

/**
 * Ajv errors, shaped as the spec's `FieldError` — which requires field, CODE and message.
 *
 * The code is not decoration, and it was missing until a contract test caught it. The
 * spec's own guidance on `Error.code` applies here too: branch on the code, never on the
 * message. Ajv's `keyword` is already a stable machine token — `required`, `maximum`,
 * `type` — so it is used directly rather than inventing a parallel vocabulary that would
 * then need maintaining alongside it.
 */
function fieldErrors(
  errors: readonly ErrorObject[] | null | undefined,
): { field: string; code: string; message: string }[] {
  return (errors ?? []).map((e) => ({
    // instancePath is "/record_type"; the leading slash is noise to a client.
    field: e.instancePath.replace(/^\//, '') || (e.params as { missingProperty?: string })
      ?.missingProperty || '(body)',
    code: e.keyword,
    message: e.message ?? 'is invalid',
  }));
}

export function validateBody(path: string, method: string) {
  const validate = bodyValidator(path, method);

  return function validateRequestBody(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    if (!validate) {
      next();
      return;
    }

    // An absent body is a validation failure here, not a crash further down. Express
    // gives `{}` when there is no JSON payload, and `{}` fails `required` naturally.
    if (!validate(req.body ?? {})) {
      next(new ApiError('VALIDATION_FAILED', 'Request body does not match the schema', {
        field_errors: fieldErrors(validate.errors),
      }));
      return;
    }
    next();
  };
}

export function validateQuery(path: string, method: string) {
  const params = queryParams(path, method);

  return function validateRequestQuery(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    const errors: { field: string; code: string; message: string }[] = [];

    for (const param of params) {
      const raw = req.query[param.name];

      if (raw === undefined) {
        if (param.required) {
          errors.push({ field: param.name, code: 'required', message: 'is required' });
        }
        continue;
      }

      // Repeated query parameters arrive as an array. None of these accept one, and
      // silently taking the first would make `?limit=1&limit=999` mean something
      // different from what the caller wrote.
      if (Array.isArray(raw)) {
        errors.push({
          field: param.name, code: 'repeated', message: 'must not be repeated',
        });
        continue;
      }

      if (!param.validate) continue;

      // Query values are always strings on the wire. Coerce to what the schema declares
      // before validating, so `limit=50` is an integer rather than a type error — but
      // only where the coercion is unambiguous.
      const coerced = coerce(String(raw), param.validate.schema);
      if (!param.validate(coerced)) {
        errors.push(...fieldErrors(param.validate.errors).map((e) => ({
          field: param.name,
          code: e.code,
          message: e.message,
        })));
      }
    }

    if (errors.length > 0) {
      next(new ApiError('VALIDATION_FAILED', 'Query parameters are invalid', {
        field_errors: errors,
      }));
      return;
    }
    next();
  };
}

function coerce(value: string, schema: unknown): unknown {
  const type = (schema as { type?: string } | undefined)?.type;
  if (type === 'integer' || type === 'number') {
    const n = Number(value);
    // NaN is returned as the original string so the schema reports a type error rather
    // than this function inventing a value the caller never sent.
    return Number.isFinite(n) ? n : value;
  }
  if (type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  return value;
}
