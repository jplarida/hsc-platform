// /v1/imports — the loader.
//
// database/07 Part B specified this pipeline and its tables were never extracted; migration
// 0009 added the schema and this is the code that uses it. The tests are grouped the way the
// pipeline runs: stage, validate, dry run, load, second-pass links, reverse.
//
// The queue is deliberately not exercised through its timer. startImportWorker polls on an
// interval, and a test that waits for an interval is a test that is slow when it passes and
// flaky when it does not — so these drive one poll cycle synchronously and assert on the
// durable state afterwards, which is the thing that actually matters.

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, asOwner, seedTenant, cleanup, withTenantContext } from './helpers/db.mjs';

process.env.JWT_SECRET ??= 'test-secret-at-least-32-bytes-long!!';
process.env.REDIS_CACHE_URL ??= 'redis://localhost:6379';
process.env.REDIS_STATE_URL ??= 'redis://localhost:6381';

const { createApp } = await import('../dist/app.js');
const { signAccessToken } = await import('../dist/auth/token.js');
const { closePool } = await import('../dist/db/context.js');
const { closeRedis, waitForReady } = await import('../dist/redis/client.js');
const { responseValidator } = await import('../dist/openapi/spec.js');
const { drainImportsForTest, sweepPendingJobs } = await import('../dist/imports/worker.js');
const { resetQueueForTest } = await import('../dist/imports/queue.js');
const { flushAuditForTest, resetAuditForTest } = await import('../dist/audit/phiLog.js');
const { resetLimit } = await import('../dist/ratelimit/limiter.js');
const { keys } = await import('../dist/ratelimit/limiter.js');

let pool, server, base, t, other, token, otherToken;
const created = [];
const PERMS = ['records:read', 'records:write', 'records:import'];

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

async function call(method, path, { body, tok, headers } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tok ?? token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** The per-tenant 1-per-10-minutes bucket would block every test after the first. */
async function clearImportLimit(tenantId) {
  await resetLimit(keys.endpoint(tenantId, 'imports', tenantId));
}

async function declareType(tenantId, code, { isPhi = false } = {}) {
  await asOwner(pool, (c) => c.query(
    `INSERT INTO record_type_definitions (tenant_id, code, display_name, plural_name, is_phi)
     VALUES ($1, $2, $2, $2, $3) ON CONFLICT (tenant_id, code) DO NOTHING`,
    [tenantId, code, isPhi]));
}

async function declareLinkRule(tenantId, from, to, linkType, cardinality = 'many_to_many') {
  await asOwner(pool, (c) => c.query(
    `INSERT INTO record_link_rules (tenant_id, from_type_code, to_type_code, link_type, cardinality)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, from_type_code, to_type_code, link_type) DO NOTHING`,
    [tenantId, from, to, linkType, cardinality]));
}

/** POST an import and run it to completion, returning the finished job. */
async function runImport(bodyOverrides, { tok, tenantId } = {}) {
  await clearImportLimit(tenantId ?? t.id);
  const posted = await call('POST', '/v1/imports', {
    tok,
    body: {
      target_record_type: 'note',
      mappings: [{ source_column: 'Title', target_path: 'title' }],
      rows: [{ Title: 'One' }],
      ...bodyOverrides,
    },
  });
  if (posted.status !== 202) return { posted, job: null };
  await drainImportsForTest();
  const job = await call('GET', `/v1/imports/${posted.body.data.import_job_id}`, { tok });
  return { posted, job: job.body.data };
}

before(async () => {
  pool = createPool();
  await Promise.all([waitForReady('cache'), waitForReady('state')]);

  t = await seedTenant(pool);
  other = await seedTenant(pool);
  created.push(t.id, other.id);

  token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: PERMS });
  otherToken = await signAccessToken({
    tenantId: other.id, userId: other.userId, permissions: PERMS,
  });

  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  resetAuditForTest();
  await resetQueueForTest();
});

after(async () => {
  await new Promise((r) => server.close(r));
  await cleanup(pool, created);
  await pool.end();
  await closePool();
  await closeRedis();
});

describe('starting an import', () => {
  test('a valid request is 202 with a job URL and a pending job', async () => {
    await clearImportLimit(t.id);
    const res = await call('POST', '/v1/imports', {
      body: {
        target_record_type: 'note',
        mappings: [{ source_column: 'Title', target_path: 'title' }],
        rows: [{ Title: 'A' }, { Title: 'B' }],
      },
    });

    assert.equal(res.status, 202);
    assert.equal(res.headers.get('location'), `/v1/imports/${res.body.data.import_job_id}`);
    assert.equal(res.body.data.status, 'pending');
    assert.equal(res.body.data.total_rows, 2);
    // Part B's dry run is the loop, not a formality, so it is what you get by default.
    assert.equal(res.body.data.is_dry_run, true);
  });

  test('the 202 matches the contract schema', async () => {
    await clearImportLimit(t.id);
    const res = await call('POST', '/v1/imports', {
      body: {
        target_record_type: 'note',
        mappings: [{ source_column: 'Title', target_path: 'title' }],
        rows: [{ Title: 'A' }],
      },
    });
    const validate = responseValidator('/imports', 'post', '202');
    assert.ok(validate, 'the spec declares a 202 schema');
    assert.ok(validate(res.body), JSON.stringify(validate.errors));
  });

  test('the rows are staged durably before the response returns', async () => {
    await clearImportLimit(t.id);
    const res = await call('POST', '/v1/imports', {
      body: {
        target_record_type: 'note',
        mappings: [{ source_column: 'Title', target_path: 'title' }],
        rows: [{ Title: 'A' }, { Title: 'B' }, { Title: 'C' }],
      },
    });

    const staged = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query('SELECT row_number FROM import_staging WHERE import_job_id = $1 ORDER BY row_number',
        [res.body.data.import_job_id]));

    assert.deepEqual(staged.rows.map((r) => r.row_number), [1, 2, 3]);
  });

  test('writing needs records:import, not records:write', async () => {
    const weak = await signAccessToken({
      tenantId: t.id, userId: t.userId, permissions: ['records:read', 'records:write'],
    });
    const res = await call('POST', '/v1/imports', {
      tok: weak,
      body: {
        target_record_type: 'note',
        mappings: [{ source_column: 'Title', target_path: 'title' }],
        rows: [{ Title: 'A' }],
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'INSUFFICIENT_PERMISSIONS');
  });

  test('an unknown record type is 422, not a foreign-key 500', async () => {
    await clearImportLimit(t.id);
    const res = await call('POST', '/v1/imports', {
      body: {
        target_record_type: 'not_a_type',
        mappings: [{ source_column: 'Title', target_path: 'title' }],
        rows: [{ Title: 'A' }],
      },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.field_errors[0].field, 'target_record_type');
  });

  test('an unrecognised mapping target is refused once, not once per row', async () => {
    await clearImportLimit(t.id);
    const res = await call('POST', '/v1/imports', {
      body: {
        target_record_type: 'note',
        mappings: [{ source_column: 'X', target_path: 'nonsense' }],
        rows: [{ X: '1' }, { X: '2' }, { X: '3' }],
      },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.field_errors.length, 1);
  });

  test('a file-backed import is refused rather than silently importing nothing', async () => {
    await clearImportLimit(t.id);
    const res = await call('POST', '/v1/imports', {
      body: {
        target_record_type: 'note',
        source_file_id: randomUUID(),
        mappings: [{ source_column: 'Title', target_path: 'title' }],
        rows: [{ Title: 'A' }],
      },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.field_errors[0].field, 'source_file_id');
  });

  test('api/03: a second import inside ten minutes is 429', async () => {
    await clearImportLimit(t.id);
    const body = {
      target_record_type: 'note',
      mappings: [{ source_column: 'Title', target_path: 'title' }],
      rows: [{ Title: 'A' }],
    };
    const first = await call('POST', '/v1/imports', { body });
    const second = await call('POST', '/v1/imports', { body });

    assert.equal(first.status, 202);
    assert.equal(second.status, 429);
    assert.equal(second.body.error.details.scope, 'endpoint');
    assert.ok(Number(second.headers.get('retry-after')) > 0);
  });
});

describe('the dry run', () => {
  test('validates every row and writes no records', async () => {
    const { job } = await runImport({
      rows: [{ Title: 'A' }, { Title: 'B' }],
    });

    assert.equal(job.status, 'succeeded');
    assert.equal(job.valid_rows, 2);
    assert.equal(job.imported_rows, 0);

    const records = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query('SELECT COUNT(*)::int AS n FROM records WHERE import_job_id = $1',
        [job.import_job_id]));
    assert.equal(records.rows[0].n, 0);
  });

  test('a missing required value becomes a row error, not a failed job', async () => {
    const { job } = await runImport({
      mappings: [
        { source_column: 'Title', target_path: 'title' },
        { source_column: 'MRN', target_path: 'data.mrn', is_required: true },
      ],
      rows: [{ Title: 'A', MRN: '123' }, { Title: 'B' }],
    });

    assert.equal(job.status, 'succeeded');
    assert.equal(job.valid_rows, 1);
    assert.equal(job.error_rows, 1);

    const errors = await call('GET', `/v1/imports/${job.import_job_id}/errors`);
    assert.equal(errors.status, 200);
    assert.equal(errors.body.data[0].error_code, 'required_missing');
    assert.equal(errors.body.data[0].row_number, 2);
  });

  test('the error list carries the raw row so the customer can see what failed', async () => {
    const { job } = await runImport({
      mappings: [{ source_column: 'DOB', target_path: 'data.dob', transform: 'iso_date' }],
      rows: [{ DOB: 'not-a-date', Other: 'kept' }],
    });

    const errors = await call('GET', `/v1/imports/${job.import_job_id}/errors`);
    assert.equal(errors.body.data[0].error_code, 'bad_date');
    assert.deepEqual(errors.body.data[0].source_row, { DOB: 'not-a-date', Other: 'kept' });
  });

  test('an ambiguous date is refused rather than guessed', async () => {
    const { job } = await runImport({
      mappings: [{ source_column: 'DOB', target_path: 'data.dob', transform: 'iso_date' }],
      // March 4th in the US, April 3rd almost everywhere else. Picking one silently would
      // put a wrong date of birth in a medical record.
      rows: [{ DOB: '03/04/2026' }],
    });
    assert.equal(job.error_rows, 1);
  });

  test('a rolled-over date is caught rather than becoming a plausible wrong one', async () => {
    const { job } = await runImport({
      mappings: [{ source_column: 'DOB', target_path: 'data.dob', transform: 'iso_date' }],
      rows: [{ DOB: '2026-02-31' }],   // Date.UTC would silently make this March 3rd
    });
    assert.equal(job.error_rows, 1);
  });

  test('a phone without a country code is refused rather than assumed', async () => {
    const { job } = await runImport({
      mappings: [{ source_column: 'Phone', target_path: 'data.phone', transform: 'e164' }],
      rows: [{ Phone: '555 123 4567' }, { Phone: '+1 (555) 123-4567' }],
    });
    assert.equal(job.valid_rows, 1);
    assert.equal(job.error_rows, 1);
  });

  test('duplicate external ids inside one batch are reported against the later row', async () => {
    const { job } = await runImport({
      mappings: [
        { source_column: 'Id', target_path: 'external_id' },
        { source_column: 'Title', target_path: 'title' },
      ],
      rows: [{ Id: 'X1', Title: 'A' }, { Id: 'X1', Title: 'B' }],
    });

    assert.equal(job.valid_rows, 1);
    assert.equal(job.error_rows, 1);
    const errors = await call('GET', `/v1/imports/${job.import_job_id}/errors`);
    assert.equal(errors.body.data[0].error_code, 'duplicate_key');
    assert.equal(errors.body.data[0].row_number, 2);
  });

  test('an undeclared column is left exactly as it arrived', async () => {
    const { job } = await runImport({
      is_dry_run: false,
      mappings: [{ source_column: 'Title', target_path: 'title' }],
      rows: [{ Title: '  spaced  ' }],
    });

    const row = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query('SELECT title FROM records WHERE import_job_id = $1', [job.import_job_id]));
    // No trim was declared, so none was applied. Part B: anything not declared is not
    // silently altered.
    assert.equal(row.rows[0].title, '  spaced  ');
  });
});

describe('the load', () => {
  test('a committed import writes records tagged with the job', async () => {
    const { job } = await runImport({
      is_dry_run: false,
      mappings: [
        { source_column: 'Title', target_path: 'title' },
        { source_column: 'MRN', target_path: 'data.mrn', transform: 'trim' },
      ],
      rows: [{ Title: 'A', MRN: ' 123 ' }, { Title: 'B', MRN: '456' }],
    });

    assert.equal(job.status, 'succeeded');
    assert.equal(job.imported_rows, 2);

    const rows = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query(`SELECT title, data ->> 'mrn' AS mrn FROM records
                WHERE import_job_id = $1 ORDER BY title`, [job.import_job_id]));

    assert.deepEqual(rows.rows.map((r) => r.title), ['A', 'B']);
    assert.equal(rows.rows[0].mrn, '123', 'the declared trim was applied');
  });

  test('nested data paths become nested JSON', async () => {
    const { job } = await runImport({
      is_dry_run: false,
      mappings: [
        { source_column: 'Title', target_path: 'title' },
        { source_column: 'City', target_path: 'data.address.city' },
      ],
      rows: [{ Title: 'A', City: 'Manila' }],
    });

    const row = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query(`SELECT data FROM records WHERE import_job_id = $1`, [job.import_job_id]));
    assert.deepEqual(row.rows[0].data.address, { city: 'Manila' });
  });

  test('re-running the same import is refused per row, not duplicated', async () => {
    const mappings = [
      { source_column: 'Id', target_path: 'external_id' },
      { source_column: 'Title', target_path: 'title' },
    ];
    const rows = [{ Id: 'R1', Title: 'A' }];

    const first = await runImport({ is_dry_run: false, mappings, rows });
    assert.equal(first.job.imported_rows, 1);

    const second = await runImport({ is_dry_run: false, mappings, rows });
    assert.equal(second.job.imported_rows, 0);
    assert.equal(second.job.error_rows, 1);

    const errors = await call('GET', `/v1/imports/${second.job.import_job_id}/errors`);
    assert.equal(errors.body.data[0].error_code, 'duplicate_key');
  });

  test('the records trigger audits every imported row', async () => {
    const { job } = await runImport({
      is_dry_run: false,
      rows: [{ Title: 'A' }, { Title: 'B' }],
    });

    // The ids are collected inside a tenant context, not in the audit query. `records` is
    // FORCE ROW LEVEL SECURITY, so the migration owner is subject to the policy too and a
    // sub-select against it with no tenant GUC set returns nothing — which would make this
    // assertion pass or fail for a reason unrelated to auditing.
    const ids = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query('SELECT record_id FROM records WHERE import_job_id = $1', [job.import_job_id]));
    assert.equal(ids.rows.length, 2);

    const audit = await asOwner(pool, (c) => c.query(
      `SELECT COUNT(*)::int AS n FROM data_audit_log
        WHERE tenant_id = $1 AND table_name = 'records' AND operation = 'INSERT'
          AND record_id = ANY($2::uuid[])`,
      [t.id, ids.rows.map((r) => r.record_id)]));

    assert.equal(audit.rows[0].n, 2);
  });

  test('the job itself is recorded as one PHI access, not one per row', async () => {
    await declareType(t.id, 'patient', { isPhi: true });
    const { job } = await runImport({
      is_dry_run: false,
      target_record_type: 'patient',
      rows: [{ Title: 'A' }, { Title: 'B' }, { Title: 'C' }],
    });
    await flushAuditForTest();

    const audit = await asOwner(pool, (c) => c.query(
      `SELECT action, is_phi_access, details FROM user_audit_log
        WHERE tenant_id = $1 AND resource_type = 'import' AND resource_id = $2`,
      [t.id, job.import_job_id]));

    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].action, 'create');
    assert.equal(audit.rows[0].is_phi_access, true);
    assert.equal(audit.rows[0].details.affected_rows, 3);
  });

  test('a dry run is audited as a view, not a create', async () => {
    await declareType(t.id, 'patient', { isPhi: true });
    const { job } = await runImport({ target_record_type: 'patient', rows: [{ Title: 'A' }] });
    await flushAuditForTest();

    const audit = await asOwner(pool, (c) => c.query(
      `SELECT action FROM user_audit_log WHERE resource_id = $1 AND resource_type = 'import'`,
      [job.import_job_id]));
    assert.equal(audit.rows[0].action, 'view');
  });
});

describe('the second pass — links', () => {
  test('a link resolves by external id once both sides exist', async () => {
    await declareType(t.id, 'patient');
    await declareType(t.id, 'appointment');
    await declareLinkRule(t.id, 'appointment', 'patient', 'attends');

    const patients = await runImport({
      is_dry_run: false,
      target_record_type: 'patient',
      mappings: [
        { source_column: 'Id', target_path: 'external_id' },
        { source_column: 'Name', target_path: 'title' },
      ],
      rows: [{ Id: 'P1', Name: 'Patient One' }],
    });
    assert.equal(patients.job.imported_rows, 1);

    const appts = await runImport({
      is_dry_run: false,
      target_record_type: 'appointment',
      mappings: [
        { source_column: 'Id', target_path: 'external_id' },
        { source_column: 'PatientId', target_path: 'link:attends:patient' },
      ],
      rows: [{ Id: 'A1', PatientId: 'P1' }],
    });

    assert.equal(appts.job.imported_rows, 1);
    assert.equal(appts.job.error_rows, 0);

    const links = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query(`SELECT link_type FROM record_links
                WHERE from_record_id IN (SELECT record_id FROM records WHERE import_job_id = $1)`,
        [appts.job.import_job_id]));
    assert.deepEqual(links.rows.map((r) => r.link_type), ['attends']);
  });

  test('an unresolvable target is a row error and the batch still lands', async () => {
    await declareType(t.id, 'patient');
    await declareType(t.id, 'appointment');
    await declareLinkRule(t.id, 'appointment', 'patient', 'attends');

    const { job } = await runImport({
      is_dry_run: false,
      target_record_type: 'appointment',
      mappings: [
        { source_column: 'Id', target_path: 'external_id' },
        { source_column: 'PatientId', target_path: 'link:attends:patient' },
      ],
      rows: [{ Id: 'A9', PatientId: 'DOES-NOT-EXIST' }],
    });

    assert.equal(job.imported_rows, 1, 'the record itself still imported');
    assert.equal(job.error_rows, 1);
    const errors = await call('GET', `/v1/imports/${job.import_job_id}/errors`);
    assert.equal(errors.body.data[0].error_code, 'link_unresolved');
  });

  test('a link the rules forbid is a row error, not a failed batch', async () => {
    await declareType(t.id, 'patient');
    await declareType(t.id, 'invoice');
    // No rule permits invoice -> patient via 'attends', so the trigger refuses it.

    const patients = await runImport({
      is_dry_run: false,
      target_record_type: 'patient',
      mappings: [
        { source_column: 'Id', target_path: 'external_id' },
        { source_column: 'Name', target_path: 'title' },
      ],
      rows: [{ Id: 'P7', Name: 'Seven' }],
    });
    assert.equal(patients.job.imported_rows, 1);

    const { job } = await runImport({
      is_dry_run: false,
      target_record_type: 'invoice',
      mappings: [
        { source_column: 'Id', target_path: 'external_id' },
        { source_column: 'PatientId', target_path: 'link:attends:patient' },
      ],
      rows: [{ Id: 'I1', PatientId: 'P7' }],
    });

    // The savepoint is what makes this possible: without it the refused link would abort
    // the transaction carrying the whole batch.
    assert.equal(job.imported_rows, 1);
    assert.equal(job.error_rows, 1);
    const errors = await call('GET', `/v1/imports/${job.import_job_id}/errors`);
    assert.equal(errors.body.data[0].error_code, 'link_rule_violation');
  });
});

describe('reversal', () => {
  test('reverses a committed batch and its links', async () => {
    const { job } = await runImport({
      is_dry_run: false,
      rows: [{ Title: 'A' }, { Title: 'B' }],
    });
    assert.equal(job.imported_rows, 2);

    const res = await call('POST', `/v1/imports/${job.import_job_id}/reverse`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'skipped');
    assert.ok(res.body.data.reversed_at);

    const left = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query('SELECT COUNT(*)::int AS n FROM records WHERE import_job_id = $1',
        [job.import_job_id]));
    assert.equal(left.rows[0].n, 0);
  });

  test('REFUSES once an imported record has been edited', async () => {
    const { job } = await runImport({
      is_dry_run: false,
      rows: [{ Title: 'A' }, { Title: 'B' }],
    });

    const target = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query('SELECT record_id FROM records WHERE import_job_id = $1 LIMIT 1',
        [job.import_job_id]));

    const patched = await call('PATCH', `/v1/records/${target.rows[0].record_id}`, {
      headers: { 'content-type': 'application/merge-patch+json', 'if-match': '"1"' },
      body: { title: 'the tenant edited this' },
    });
    assert.equal(patched.status, 200);

    const res = await call('POST', `/v1/imports/${job.import_job_id}/reverse`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'IMPORT_NOT_REVERSIBLE');
    assert.equal(res.body.error.details.edited_records, 1);

    // And nothing was deleted on the way to refusing.
    const left = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query('SELECT COUNT(*)::int AS n FROM records WHERE import_job_id = $1',
        [job.import_job_id]));
    assert.equal(left.rows[0].n, 2);
  });

  test('an untouched imported record has updated_at exactly equal to created_at', async () => {
    // The guard above rests on this. bump_record_version is BEFORE UPDATE only, and on
    // insert both columns take DEFAULT NOW() — which is transaction time, so they are equal
    // to the microsecond. If a future migration added a BEFORE INSERT trigger touching
    // updated_at, the guard would start refusing every reversal and this test would say so.
    const { job } = await runImport({ is_dry_run: false, rows: [{ Title: 'A' }] });

    const row = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query(`SELECT (updated_at = created_at) AS untouched FROM records
                WHERE import_job_id = $1`, [job.import_job_id]));
    assert.equal(row.rows[0].untouched, true);
  });

  test('a dry run has nothing to reverse', async () => {
    const { job } = await runImport({ rows: [{ Title: 'A' }] });
    const res = await call('POST', `/v1/imports/${job.import_job_id}/reverse`);
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /dry run/i);
  });

  test('reversing twice is refused', async () => {
    const { job } = await runImport({ is_dry_run: false, rows: [{ Title: 'A' }] });
    assert.equal((await call('POST', `/v1/imports/${job.import_job_id}/reverse`)).status, 200);
    const second = await call('POST', `/v1/imports/${job.import_job_id}/reverse`);
    assert.equal(second.status, 409);
    assert.match(second.body.error.message, /already been reversed/i);
  });
});

describe('tenant isolation', () => {
  test("another tenant's job is 404, never 403", async () => {
    const { job } = await runImport({ rows: [{ Title: 'A' }] });
    const res = await call('GET', `/v1/imports/${job.import_job_id}`, { tok: otherToken });
    assert.equal(res.status, 404);
  });

  test("another tenant cannot read the row errors, which carry raw customer data", async () => {
    const { job } = await runImport({
      mappings: [{ source_column: 'MRN', target_path: 'data.mrn', is_required: true }],
      rows: [{ Nothing: 'here' }],
    });
    const res = await call('GET', `/v1/imports/${job.import_job_id}/errors`, { tok: otherToken });
    assert.equal(res.status, 404);
  });

  test("another tenant cannot reverse someone else's import", async () => {
    const { job } = await runImport({ is_dry_run: false, rows: [{ Title: 'A' }] });
    const res = await call('POST', `/v1/imports/${job.import_job_id}/reverse`, {
      tok: otherToken,
    });
    assert.equal(res.status, 404);

    const left = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query('SELECT COUNT(*)::int AS n FROM records WHERE import_job_id = $1',
        [job.import_job_id]));
    assert.equal(left.rows[0].n, 1);
  });

  test('a malformed job id is 404, not a database error', async () => {
    const res = await call('GET', '/v1/imports/not-a-uuid');
    assert.equal(res.status, 404);
  });
});

describe('the queue is a signal, not the source of truth', () => {
  test('a job whose signal was lost is still picked up by the sweep', async () => {
    await clearImportLimit(t.id);
    const posted = await call('POST', '/v1/imports', {
      body: {
        target_record_type: 'note',
        is_dry_run: false,
        mappings: [{ source_column: 'Title', target_path: 'title' }],
        rows: [{ Title: 'Survivor' }],
      },
    });
    assert.equal(posted.status, 202);

    // Exactly the failure the design is arranged around: Redis dropped the signal. The
    // durable row is untouched, so the job is late rather than lost.
    await resetQueueForTest();

    // The sweep leaves a grace period so it does not race normal delivery; age the row
    // past it rather than sleeping through it.
    await asOwner(pool, (c) => c.query(
      `UPDATE import_jobs SET created_at = NOW() - INTERVAL '5 minutes'
        WHERE import_job_id = $1`, [posted.body.data.import_job_id]));

    const requeued = await sweepPendingJobs();
    assert.ok(requeued >= 1, 'the sweep re-enqueued the orphaned job');

    await drainImportsForTest();
    const job = await call('GET', `/v1/imports/${posted.body.data.import_job_id}`);
    assert.equal(job.body.data.status, 'succeeded');
    assert.equal(job.body.data.imported_rows, 1);
  });

  test('a job delivered twice is imported once', async () => {
    await clearImportLimit(t.id);
    const posted = await call('POST', '/v1/imports', {
      body: {
        target_record_type: 'note',
        is_dry_run: false,
        mappings: [
          { source_column: 'Id', target_path: 'external_id' },
          { source_column: 'Title', target_path: 'title' },
        ],
        rows: [{ Id: 'ONCE', Title: 'Only once' }],
      },
    });

    const jobId = posted.body.data.import_job_id;
    const { enqueueJob } = await import('../dist/imports/queue.js');
    // A duplicate signal, which at-least-once delivery makes normal rather than exotic.
    await enqueueJob(jobId, t.id, t.userId);
    await enqueueJob(jobId, t.id, t.userId);

    await drainImportsForTest();
    await drainImportsForTest();

    const rows = await withTenantContext(pool, { tenantId: t.id, userId: t.userId }, (c) =>
      c.query('SELECT COUNT(*)::int AS n FROM records WHERE import_job_id = $1', [jobId]));

    // The conditional UPDATE in claimJob is the mutual exclusion, not the queue.
    assert.equal(rows.rows[0].n, 1);
  });
});
