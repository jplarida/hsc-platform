/**
 * The OpenAPI document, loaded once and compiled into validators.
 *
 * `api/05` is explicit that this is spec-first, not generated from code: the document is
 * authored, and the implementation conforms to it. That only means anything if something
 * checks — otherwise the spec is a description of what someone once intended, and the
 * two drift apart quietly. This module is that check.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Ajv, type ValidateFunction } from 'ajv';
// ajv-formats v3 ships its callable as a named export under nodenext resolution;
// the default import is the module namespace and is not callable.
import { fullFormats } from 'ajv-formats/dist/formats.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The spec lives with the design documents, which is where `api/05` puts it and where it
 * is reviewed. Overridable so a container image can ship a copy rather than the whole
 * documents tree.
 */
const SPEC_PATH = process.env['OPENAPI_SPEC_PATH']
  ?? resolve(here, '../../documents/healthcare/api/openapi.yaml');

export interface OpenApiDocument {
  paths: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, unknown> };
}

interface OperationObject {
  parameters?: ParameterObject[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, ResponseObject>;
}

interface ParameterObject {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: unknown;
  $ref?: string;
}

interface ResponseObject {
  content?: Record<string, { schema?: unknown }>;
}

let document: OpenApiDocument | undefined;
let ajv: Ajv | undefined;

export function spec(): OpenApiDocument {
  if (!document) {
    document = parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;
  }
  return document;
}

/**
 * One Ajv instance holding the whole document, so `$ref` resolves naturally.
 *
 * `strict: false` because an OpenAPI document carries keywords Ajv does not know —
 * `example`, `tags`, `discriminator`. Failing on those would mean rewriting the spec to
 * suit the validator, which inverts which one is the source of truth.
 */
function validator(): Ajv {
  if (!ajv) {
    ajv = new Ajv({
      strict: false,
      allErrors: true,
      // Absent in a response means absent, not null. Coercion here would let a
      // non-conforming response pass by being quietly fixed up.
      coerceTypes: false,
    });
    for (const [name, format] of Object.entries(fullFormats)) {
      ajv.addFormat(name, format);
    }
    ajv.addSchema({ $id: 'openapi', ...spec() } as object);
  }
  return ajv;
}

/** Resolve a local `$ref` against the document. */
function deref<T>(node: unknown): T {
  if (node && typeof node === 'object' && '$ref' in node) {
    const ref = (node as { $ref: string }).$ref;
    const path = ref.replace(/^#\//, '').split('/');
    let current: unknown = spec();
    for (const segment of path) {
      current = (current as Record<string, unknown>)[segment];
    }
    return deref<T>(current);
  }
  return node as T;
}

function operation(path: string, method: string): OperationObject | null {
  return spec().paths?.[path]?.[method] ?? null;
}

const compiled = new Map<string, ValidateFunction>();

function compile(cacheKey: string, schema: unknown): ValidateFunction | null {
  if (!schema) return null;
  const existing = compiled.get(cacheKey);
  if (existing) return existing;
  // Rewrite local refs to point at the registered document, so components resolve.
  const rooted = JSON.parse(
    JSON.stringify(schema).replace(/"#\/components\//g, '"openapi#/components/'),
  ) as object;
  const fn = validator().compile(rooted);
  compiled.set(cacheKey, fn);
  return fn;
}

/** Request-body validator for an operation, or null when it takes no body. */
export function bodyValidator(path: string, method: string): ValidateFunction | null {
  const op = operation(path, method);
  const schema = op?.requestBody?.content?.['application/json']?.schema;
  return schema ? compile(`body:${method}:${path}`, schema) : null;
}

/**
 * Query-parameter validators for an operation.
 *
 * Returned per parameter rather than as one object schema, because query values arrive
 * as strings and each needs its own coercion decision — a `limit` of "50" is valid, a
 * `limit` of "abc" is not, and only the parameter's own schema knows which.
 */
export interface QueryParam {
  readonly name: string;
  readonly required: boolean;
  readonly validate: ValidateFunction | null;
}

export function queryParams(path: string, method: string): readonly QueryParam[] {
  const op = operation(path, method);
  if (!op?.parameters) return [];

  return op.parameters
    .map((raw) => deref<ParameterObject>(raw))
    .filter((p) => p.in === 'query' && typeof p.name === 'string')
    .map((p) => ({
      name: p.name as string,
      required: p.required === true,
      validate: p.schema
        ? compile(`query:${method}:${path}:${p.name as string}`, p.schema)
        : null,
    }));
}

/** Response-body validator for a status code. Used by the contract tests. */
export function responseValidator(
  path: string,
  method: string,
  status: string,
): ValidateFunction | null {
  const op = operation(path, method);
  const response = deref<ResponseObject>(op?.responses?.[status]);
  const schema = response?.content?.['application/json']?.schema;
  return schema ? compile(`res:${method}:${path}:${status}`, schema) : null;
}
