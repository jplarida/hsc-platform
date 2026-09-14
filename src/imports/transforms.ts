/**
 * Cleansing transforms.
 *
 * `database/07` Part B is emphatic about the boundary here: cleansing applies **only** the
 * transforms declared in `import_field_mappings.transform`. Anything not declared is not
 * silently altered, because guessing at a customer's data is how an import becomes
 * untrustworthy — and an import the customer does not trust is one they redo by hand,
 * which is the outcome the whole feature exists to prevent.
 *
 * So every function here is opt-in per column, and each one either succeeds or reports why
 * it could not. None of them "do their best".
 */

/** The declared set. Matches `ImportFieldMapping.transform` in `openapi.yaml`. */
export type TransformName = 'trim' | 'iso_date' | 'e164' | 'upper';

export const TRANSFORMS: readonly TransformName[] = ['trim', 'iso_date', 'e164', 'upper'];

export function isTransform(value: unknown): value is TransformName {
  return typeof value === 'string' && (TRANSFORMS as readonly string[]).includes(value);
}

/**
 * A transform either produces a value or explains itself.
 *
 * The error code is part of the contract (`ImportRowError.error_code`), so it is chosen
 * here rather than mapped from a message later — the same reason the link rule matches on
 * SQLSTATE rather than on wording.
 */
export type TransformResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: 'bad_date' | 'bad_number'; readonly message: string };

/**
 * ISO-8601 date normalisation.
 *
 * This one is load-bearing beyond tidiness. `database/03`'s `gc_dob` generated column is
 * built with `to_date(data ->> 'date_of_birth', 'YYYY-MM-DD')`, so a single non-ISO date
 * in an imported batch fails the column build for the whole table. Part B calls this out
 * directly, which is why a date that cannot be parsed is a row error rather than a value
 * passed through and dealt with later.
 *
 * Deliberately narrow: unambiguous ISO forms, plus the two unambiguous slash forms where
 * a four-digit year fixes the order. `03/04/2026` is NOT accepted — it is March 4th in the
 * United States and April 3rd almost everywhere else, and picking one silently would put a
 * wrong date of birth in a medical record.
 */
export function isoDate(raw: string): TransformResult {
  const value = raw.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value);
  if (iso) return checkParts(iso[1], iso[2], iso[3], value);

  // YYYY/MM/DD — the year leads, so the order cannot be misread.
  const slashed = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value);
  if (slashed) return checkParts(slashed[1], slashed[2], slashed[3], value);

  // DD/MM/YYYY vs MM/DD/YYYY is genuinely ambiguous and is refused, even when the day
  // exceeds twelve and the order could in principle be inferred. Accepting the
  // inferrable half of a format means the same column imports under two different
  // readings depending on its values, which is worse than refusing all of it.
  return {
    ok: false,
    code: 'bad_date',
    message: `"${raw}" is not an unambiguous ISO-8601 date (expected YYYY-MM-DD)`,
  };
}

function checkParts(
  y: string | undefined, m: string | undefined, d: string | undefined, original: string,
): TransformResult {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  // Date.UTC rolls over silently — 2026-02-31 becomes March 3rd. Comparing the parts back
  // is what turns that into a rejection instead of a plausible wrong date.
  const at = new Date(Date.UTC(year, month - 1, day));
  if (
    at.getUTCFullYear() !== year ||
    at.getUTCMonth() !== month - 1 ||
    at.getUTCDate() !== day
  ) {
    return { ok: false, code: 'bad_date', message: `"${original}" is not a real calendar date` };
  }

  return { ok: true, value: `${String(year).padStart(4, '0')}-${m}-${d}` };
}

/**
 * E.164 phone normalisation.
 *
 * Only strips formatting and validates the shape. It does NOT guess a country code: a bare
 * ten-digit number is meaningless without one, and defaulting to +1 would quietly relabel
 * every non-US number in the batch.
 */
export function e164(raw: string): TransformResult {
  const stripped = raw.trim().replace(/[\s()\-.]/g, '');

  if (!stripped.startsWith('+')) {
    return {
      ok: false,
      code: 'bad_number',
      message: `"${raw}" has no country code; E.164 requires a leading +`,
    };
  }
  if (!/^\+[1-9]\d{7,14}$/.test(stripped)) {
    return { ok: false, code: 'bad_number', message: `"${raw}" is not a valid E.164 number` };
  }
  return { ok: true, value: stripped };
}

/** Apply one declared transform. */
export function applyTransform(name: TransformName, raw: string): TransformResult {
  switch (name) {
    case 'trim':
      return { ok: true, value: raw.trim() };
    case 'upper':
      return { ok: true, value: raw.toUpperCase() };
    case 'iso_date':
      return isoDate(raw);
    case 'e164':
      return e164(raw);
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown transform: ${String(exhaustive)}`);
    }
  }
}
