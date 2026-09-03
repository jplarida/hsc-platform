// PHI must not reach the logs.
//
// observability/01 found that the documented monitoring stack would send PHI to
// observability vendors, and prescribed an allowlist at the collector rather than a
// denylist — because a denylist only excludes the fields somebody thought of.
//
// The same applies before the collector sees anything. A PostgreSQL error carries the
// offending column value in `detail`, and stdout goes to CloudWatch: outside the audit
// trail, outside the retention policy, outside the BAA boundary. database/03 puts a
// UNIQUE index on gc_mrn, so a duplicate patient write is a direct route from a
// constraint violation to a medical record number in a log aggregator.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { safeError, formatError } = await import('../dist/http/safeLog.js');

/** A PostgreSQL unique-violation error, shaped as the pg driver produces it. */
function pgUniqueViolation(value) {
  const err = new Error('duplicate key value violates unique constraint "uq_records_mrn"');
  err.name = 'error';
  Object.assign(err, {
    severity: 'ERROR',
    code: '23505',
    detail: `Key (mrn)=(${value}) already exists.`,
    schema: 'public',
    table: 'records',
    constraint: 'uq_records_mrn',
    routine: '_bt_check_unique',
    where: `PL/pgSQL function audit() line 3 at SQL statement, row (${value})`,
    internalQuery: `INSERT INTO records (mrn) VALUES ('${value}')`,
    hint: undefined,
  });
  return err;
}

const MRN = 'MRN-000123-SMITH-JOHN';

describe('error redaction', () => {
  test('the offending value never survives redaction', () => {
    const safe = safeError(pgUniqueViolation(MRN));
    assert.ok(!JSON.stringify(safe).includes(MRN),
      `the record number leaked into the redacted error: ${JSON.stringify(safe)}`);
  });

  test('the formatted log line never contains it either', () => {
    const line = formatError(pgUniqueViolation(MRN));
    assert.ok(!line.includes(MRN), `the record number leaked into the log line: ${line}`);
  });

  test('detail, where and internalQuery are all dropped', () => {
    // Each of these can carry row contents. detail always does; where quotes plpgsql
    // context; internalQuery is generated SQL with literals in it.
    const line = formatError(pgUniqueViolation(MRN));
    assert.ok(!line.includes('Key (mrn)'), 'detail must not be logged');
    assert.ok(!line.includes('PL/pgSQL function'), 'where must not be logged');
    assert.ok(!line.includes('INSERT INTO records'), 'internalQuery must not be logged');
  });

  test('what remains is still enough to diagnose', () => {
    // Redaction that destroys the log's usefulness gets removed by the next person on
    // call, so the allowlist has to keep the identifiers.
    const safe = safeError(pgUniqueViolation(MRN));
    assert.equal(safe.pg.code, '23505');
    assert.equal(safe.pg.constraint, 'uq_records_mrn');
    assert.equal(safe.pg.table, 'records');
    assert.match(safe.message, /unique constraint/);
  });

  test('an unknown pg field is dropped rather than passed through', () => {
    // The allowlist property: a field nobody anticipated must not appear by default.
    const err = pgUniqueViolation(MRN);
    Object.assign(err, { some_future_field: `patient ${MRN}` });

    const line = formatError(err);
    assert.ok(!line.includes('some_future_field'),
      'an unanticipated field must be excluded, not included');
    assert.ok(!line.includes(MRN));
  });

  test('an ordinary error is unchanged', () => {
    const safe = safeError(new TypeError('cannot read x of undefined'));
    assert.equal(safe.kind, 'TypeError');
    assert.equal(safe.message, 'cannot read x of undefined');
    assert.equal(safe.pg, undefined);
  });

  test('a thrown non-Error does not crash the logger', () => {
    const safe = safeError('just a string');
    assert.equal(safe.kind, 'unknown');
    assert.ok(!safe.stack);
  });
});
