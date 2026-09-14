/**
 * Turning a source row into a record, per the declared mapping.
 *
 * `database/07` Part B gives three rules that hold across every legacy source:
 *
 *   1. Everything lands in `data` unless it is a first-class column.
 *   2. The legacy primary key becomes `records.external_id` — which is what makes
 *      re-running an import idempotent, because `uq_records_external_id` turns a second
 *      load into a conflict rather than a duplicate record.
 *   3. Legacy relationships become `record_links`, resolved by `external_id` on a second
 *      pass, because a legacy `appointment.patient_id` is a lookup key and not a UUID
 *      in this system.
 *
 * Rule 3 needed somewhere to live. `import_field_mappings` has no column for "this is a
 * foreign key to a patient via 'attends'", and adding one would have meant a second
 * migration against a table that shipped days ago. Encoding it in `target_path` instead —
 * `link:<link_type>:<to_type_code>` — costs nothing at the schema level and keeps the
 * declaration next to the column it describes, which is where a customer editing a
 * mapping expects to find it.
 */

import { applyTransform, isTransform, type TransformName } from './transforms.js';

/** A mapping as stored in `import_field_mappings`. */
export interface FieldMapping {
  readonly source_column: string;
  readonly target_path: string;
  readonly transform: string | null;
  readonly is_required: boolean;
  readonly default_value: string | null;
}

/** First-class columns on `records` that a mapping may target directly. */
const SCALAR_TARGETS = ['title', 'description', 'status', 'external_id'] as const;
type ScalarTarget = (typeof SCALAR_TARGETS)[number];

/**
 * Segments that must never be walked when building the `data` object.
 *
 * `assignPath` creates intermediate objects as it descends, so a mapping targeting
 * `data.__proto__.<anything>` walks onto `Object.prototype` and writes there — one
 * tenant's mapping altering every object in the process, including requests being served
 * for other tenants at the time. The mapping is customer-supplied and `openapi.yaml` puts
 * no pattern on `target_path`, so this is the boundary that has to refuse it.
 *
 * Refused rather than sanitised. A legacy export with a column genuinely called
 * `__proto__` is not worth the ambiguity of silently renaming it, and refusing puts the
 * problem in the same `unknown_target` report as every other unusable mapping — which the
 * route already surfaces once for the mapping rather than once per row.
 */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export type TargetSpec =
  | { readonly kind: 'scalar'; readonly column: ScalarTarget }
  | { readonly kind: 'data'; readonly path: readonly string[] }
  | { readonly kind: 'link'; readonly linkType: string; readonly toTypeCode: string };

/**
 * Parse a `target_path`.
 *
 * Returns null for anything unrecognised rather than throwing. An unknown target is a
 * fault in the customer's mapping, not in the platform, so it belongs in the validation
 * report next to the row it affects.
 */
export function parseTarget(path: string): TargetSpec | null {
  if ((SCALAR_TARGETS as readonly string[]).includes(path)) {
    return { kind: 'scalar', column: path as ScalarTarget };
  }

  if (path.startsWith('data.')) {
    const segments = path.slice('data.'.length).split('.').filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    // A segment containing a quote or a backslash would be awkward inside a JSON pointer
    // and has no legitimate use as a field name here.
    if (segments.some((s) => /["\\]/.test(s))) return null;
    if (segments.some((seg) => UNSAFE_SEGMENTS.has(seg))) return null;
    return { kind: 'data', path: segments };
  }

  if (path.startsWith('link:')) {
    const [, linkType, toTypeCode, ...rest] = path.split(':');
    if (!linkType || !toTypeCode || rest.length > 0) return null;
    return { kind: 'link', linkType, toTypeCode };
  }

  return null;
}

export interface MappedRow {
  readonly title: string | null;
  readonly description: string | null;
  readonly status: string | null;
  readonly externalId: string | null;
  readonly data: Record<string, unknown>;
  /** Deferred to the second pass: the external id of the record to link to. */
  readonly links: readonly { linkType: string; toTypeCode: string; toExternalId: string }[];
}

export interface MappingFailure {
  readonly code: 'required_missing' | 'bad_date' | 'bad_number' | 'unknown_column';
  readonly message: string;
}

export type MapResult =
  | { readonly ok: true; readonly row: MappedRow }
  | { readonly ok: false; readonly failures: readonly MappingFailure[] };

/**
 * Apply every mapping to one source row.
 *
 * Collects all failures rather than stopping at the first. A customer fixing a mapping
 * wants the whole list for the row in front of them; returning one error per pass turns a
 * five-column problem into five round trips through a dry run.
 */
export function mapRow(
  source: Record<string, unknown>,
  mappings: readonly FieldMapping[],
): MapResult {
  const failures: MappingFailure[] = [];
  // Null-prototype, so there is no inherited object to reach even if a segment were ever
  // to get past parseTarget. See UNSAFE_SEGMENTS.
  const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const links: { linkType: string; toTypeCode: string; toExternalId: string }[] = [];
  let title: string | null = null;
  let description: string | null = null;
  let status: string | null = null;
  let externalId: string | null = null;

  for (const mapping of mappings) {
    const target = parseTarget(mapping.target_path);
    if (!target) {
      failures.push({
        code: 'unknown_column',
        message: `mapping target "${mapping.target_path}" is not a recognised destination`,
      });
      continue;
    }

    const raw = source[mapping.source_column];
    // An absent column and an empty string are the same thing for import purposes: a CSV
    // has no way to distinguish them, so treating them differently would make behaviour
    // depend on which exporter produced the file.
    const present = raw !== undefined && raw !== null && String(raw).trim() !== '';
    const value = present ? String(raw) : (mapping.default_value ?? null);

    if (value === null || value.trim() === '') {
      if (mapping.is_required) {
        failures.push({
          code: 'required_missing',
          message: `"${mapping.source_column}" is required and has no value`,
        });
      }
      continue;
    }

    let cleansed = value;
    if (mapping.transform !== null) {
      if (!isTransform(mapping.transform)) {
        failures.push({
          code: 'unknown_column',
          message: `transform "${mapping.transform}" is not declared`,
        });
        continue;
      }
      const result = applyTransform(mapping.transform as TransformName, value);
      if (!result.ok) {
        failures.push({ code: result.code, message: `"${mapping.source_column}": ${result.message}` });
        continue;
      }
      cleansed = result.value;
    }

    switch (target.kind) {
      case 'scalar':
        if (target.column === 'title') title = cleansed;
        else if (target.column === 'description') description = cleansed;
        else if (target.column === 'status') status = cleansed;
        else externalId = cleansed;
        break;
      case 'data':
        assignPath(data, target.path, cleansed);
        break;
      case 'link':
        links.push({
          linkType: target.linkType,
          toTypeCode: target.toTypeCode,
          toExternalId: cleansed,
        });
        break;
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, row: { title, description, status, externalId, data, links } };
}

/**
 * Write a value at a dotted path, creating intermediate objects.
 *
 * A conflict — `data.name` and `data.name.first` in the same mapping — overwrites rather
 * than merging into a string. The mapping is contradictory either way; this at least
 * fails in a shape the customer can see in the dry-run output.
 *
 * Every object in the tree is null-prototype. `parseTarget` already refuses the segments
 * that make this walk dangerous, but the descent below is what would do the damage, so it
 * does not rely on its caller having checked.
 */
function assignPath(target: Record<string, unknown>, path: readonly string[], value: string): void {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] as string;
    const existing = cursor[segment];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      cursor[segment] = Object.create(null) as Record<string, unknown>;
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path[path.length - 1] as string] = value;
}
