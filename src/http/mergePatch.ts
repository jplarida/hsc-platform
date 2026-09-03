/**
 * JSON Merge Patch (RFC 7396).
 *
 * The rule that matters and is easy to get wrong: **`null` means delete, not "set to
 * null"**. `{"title": null}` clears the title; `{}` leaves it alone. Treating an explicit
 * null as a value makes it impossible for a client to clear a field, and treating an
 * absent key as null wipes everything the client did not mention — which, for a patch
 * against a clinical record, means silently destroying data.
 *
 * Merging is recursive for objects, and NOT recursive for arrays: RFC 7396 replaces an
 * array wholesale. That is a deliberate part of the spec, because merging arrays has no
 * single sensible definition — there is no identity to match elements on.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function applyMergePatch(target: Json, patch: Json): Json {
  // A non-object patch replaces the target entirely, including when it is null.
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }

  const base: { [k: string]: Json } =
    target !== null && typeof target === 'object' && !Array.isArray(target)
      ? { ...target }
      : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
    } else {
      base[key] = applyMergePatch(base[key] ?? null, value);
    }
  }
  return base;
}

/**
 * Fields a patch may not touch.
 *
 * `record_type` is part of the composite foreign key to `record_type_definitions` and
 * decides whether the row is PHI — changing it by patch would move a record between
 * types, and with it whether its reads are audited. That is a migration, not an edit.
 *
 * `version` is maintained by the `bump_record_version` trigger; letting a client set it
 * would break the optimistic-concurrency check that reads it.
 */
export const IMMUTABLE_FIELDS = new Set([
  'record_id', 'record_type', 'tenant_id', 'version',
  'created_at', 'created_by', 'updated_at', 'search_vector', 'deleted_at',
]);

export function immutableViolations(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k) => IMMUTABLE_FIELDS.has(k));
}
