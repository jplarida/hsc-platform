/**
 * `If-Match` handling — the optimistic concurrency half of `api/02`.
 *
 * The generic record model plus offline clients makes lost updates likely, and nothing in
 * `API_ARCHITECTURE.md` prevented them: two clients PATCH the same record and the second
 * silently overwrites the first. `records.version` is exposed as an ETag, and a write
 * must state which version it believes it is editing.
 *
 * REQUIRED, NOT OPTIONAL. `api/02` is explicit, and the reasoning is that an optional
 * precondition is one every client eventually forgets — at which point the lost update is
 * back, silently, for exactly the clients that were not careful. A missing header is 428
 * Precondition Required, which tells the client what to do rather than failing obscurely.
 */

import { ApiError } from './errors.js';

/**
 * Parse `If-Match: "18422"` into a version number.
 *
 * Quotes are part of the ETag grammar, not decoration, but clients strip them often
 * enough that accepting both is kinder than being right about it. `W/` weak validators
 * are rejected: a weak comparison is explicitly not good enough for a write, since weak
 * means "semantically equivalent", and two versions of a record are not.
 */
export function requireIfMatch(header: string | undefined): number {
  if (!header) {
    throw new ApiError(
      'PRECONDITION_REQUIRED',
      'If-Match is required on this operation. Fetch the record and retry with its ETag.',
    );
  }

  if (header.startsWith('W/')) {
    throw new ApiError(
      'PRECONDITION_REQUIRED',
      'A weak validator is not sufficient for a write; use the strong ETag',
    );
  }

  // `*` means "any current representation" — valid in the grammar, and useless here: it
  // would defeat the whole point by matching whatever the record happens to be now.
  if (header.trim() === '*') {
    throw new ApiError(
      'PRECONDITION_REQUIRED',
      'If-Match: * does not guard against a lost update; send the record version',
    );
  }

  const value = header.trim().replace(/^"|"$/g, '');
  const version = Number(value);

  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError('PRECONDITION_REQUIRED', 'If-Match must carry a record version');
  }
  return version;
}
