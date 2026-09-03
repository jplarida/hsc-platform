// /v1/records/{id}/links
//
// The first endpoint whose rules live in the database. enforce_record_link_rule checks every
// link against a declared record_link_rules row and enforces its cardinality, because a plain
// foreign key cannot express "an appointment links to exactly one patient" when both live in
// the same table.
//
// So most of these tests are about translation: api/02 requires that an impermissible link
// returns 422 LINK_RULE_VIOLATION "rather than a database error". A 500 carrying a plpgsql
// message tells the client nothing actionable and leaks the schema on the way past.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, asOwner, seedTenant, cleanup } from './helpers/db.mjs';

process.env.JWT_SECRET ??= 'test-secret-at-least-32-bytes-long!!';
process.env.REDIS_CACHE_URL ??= 'redis://localhost:6379';
process.env.REDIS_STATE_URL ??= 'redis://localhost:6381';

const { createApp } = await import('../dist/app.js');
const { signAccessToken } = await import('../dist/auth/token.js');
const { closePool } = await import('../dist/db/context.js');
const { closeRedis, waitForReady } = await import('../dist/redis/client.js');
const { responseValidator } = await import('../dist/openapi/spec.js');

let pool, server, base, t, other, token, otherToken;
const created = [];
const ALL = ['records:read', 'records:write', 'records:delete'];

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

async function call(method, path, { body, tok } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tok ?? token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** Declare a record type and a link rule for it. */
async function declare(tenantId, { types, rule }) {
  await asOwner(pool, async (c) => {
    for (const [code, isPhi] of types) {
      await c.query(
        `INSERT INTO record_type_definitions (tenant_id, code, display_name, plural_name, is_phi)
         VALUES ($1, $2, $2, $2, $3) ON CONFLICT (tenant_id, code) DO NOTHING`,
        [tenantId, code, isPhi]);
    }
    if (rule) {
      await c.query(
        `INSERT INTO record_link_rules
           (tenant_id, from_type_code, to_type_code, link_type, cardinality)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, from_type_code, to_type_code, link_type) DO NOTHING`,
        [tenantId, rule.from, rule.to, rule.linkType, rule.cardinality]);
    }
  });
}

async function makeRecord(tenantId, tok, type, title) {
  const res = await fetch(`${base}/v1/records`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ record_type: type, title }),
  });
  const json = await res.json();
  assert.equal(res.status, 201, `record create failed: ${JSON.stringify(json)}`);
  return json.data;
}

before(async () => {
  pool = createPool();
  await Promise.all([waitForReady('cache'), waitForReady('state')]);
  t = await seedTenant(pool);
  other = await seedTenant(pool);
  created.push(t.id, other.id);

  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
  token = await signAccessToken({ tenantId: t.id, userId: t.userId, permissions: ALL });
  otherToken = await signAccessToken({
    tenantId: other.id, userId: other.userId, permissions: ALL,
  });

  await declare(t.id, {
    types: [['patient', true], ['appointment', false], ['invoice', false]],
    rule: { from: 'appointment', to: 'patient', linkType: 'attends', cardinality: 'one_to_one' },
  });
  await asOwner(pool, (c) => c.query(
    `INSERT INTO record_link_rules
       (tenant_id, from_type_code, to_type_code, link_type, cardinality)
     VALUES ($1, 'patient', 'invoice', 'billed_to', 'many_to_many')
     ON CONFLICT DO NOTHING`, [t.id]));
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await closeRedis();
  await closePool();
  await cleanup(pool, created);
  await pool.end();
});

describe('creating links', () => {
  test('a permitted link is created and matches the contract', async () => {
    const appt = await makeRecord(t.id, token, 'appointment', 'appt-1');
    const patient = await makeRecord(t.id, token, 'patient', 'patient-1');

    const res = await call('POST', `/v1/records/${appt.record_id}/links`, {
      body: { to_record_id: patient.record_id, link_type: 'attends' },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.from_record_id, appt.record_id);
    assert.equal(res.body.data.to_record_id, patient.record_id);

    const validate = responseValidator('/records/{record_id}/links', 'post', '201');
    assert.ok(validate(res.body), JSON.stringify(validate.errors));
  });

  test('metadata round-trips', async () => {
    const appt = await makeRecord(t.id, token, 'appointment', 'appt-meta');
    const patient = await makeRecord(t.id, token, 'patient', 'patient-meta');

    const res = await call('POST', `/v1/records/${appt.record_id}/links`, {
      body: {
        to_record_id: patient.record_id, link_type: 'attends',
        metadata: { reason: 'referral' },
      },
    });
    assert.equal(res.body.data.metadata.reason, 'referral');
  });
});

describe('link rules enforced by the database', () => {
  test('an undeclared combination is 422 LINK_RULE_VIOLATION, not a 500', async () => {
    // The core requirement from api/02. The trigger raises check_violation; the client
    // must see a semantic error rather than a database one.
    const patient = await makeRecord(t.id, token, 'patient', 'p-norule');
    const appt = await makeRecord(t.id, token, 'appointment', 'a-norule');

    // patient -> appointment via 'attends' has no rule; only appointment -> patient does.
    const res = await call('POST', `/v1/records/${patient.record_id}/links`, {
      body: { to_record_id: appt.record_id, link_type: 'attends' },
    });

    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'LINK_RULE_VIOLATION');
  });

  test('an unknown link_type on a valid pair is refused', async () => {
    const appt = await makeRecord(t.id, token, 'appointment', 'a-badtype');
    const patient = await makeRecord(t.id, token, 'patient', 'p-badtype');

    const res = await call('POST', `/v1/records/${appt.record_id}/links`, {
      body: { to_record_id: patient.record_id, link_type: 'invented' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'LINK_RULE_VIOLATION');
  });

  test('one_to_one cardinality is enforced on the second link', async () => {
    // The branch a plain foreign key cannot express, and which nothing had exercised.
    const appt = await makeRecord(t.id, token, 'appointment', 'a-card');
    const first = await makeRecord(t.id, token, 'patient', 'p-card-1');
    const second = await makeRecord(t.id, token, 'patient', 'p-card-2');

    const ok = await call('POST', `/v1/records/${appt.record_id}/links`, {
      body: { to_record_id: first.record_id, link_type: 'attends' },
    });
    assert.equal(ok.status, 201);

    const violation = await call('POST', `/v1/records/${appt.record_id}/links`, {
      body: { to_record_id: second.record_id, link_type: 'attends' },
    });
    assert.equal(violation.status, 422);
    assert.equal(violation.body.error.code, 'LINK_RULE_VIOLATION');
  });

  test('many_to_many permits several links', async () => {
    const patient = await makeRecord(t.id, token, 'patient', 'p-many');
    const inv1 = await makeRecord(t.id, token, 'invoice', 'i-1');
    const inv2 = await makeRecord(t.id, token, 'invoice', 'i-2');

    for (const inv of [inv1, inv2]) {
      const res = await call('POST', `/v1/records/${patient.record_id}/links`, {
        body: { to_record_id: inv.record_id, link_type: 'billed_to' },
      });
      assert.equal(res.status, 201, 'many_to_many must not be capped at one');
    }
  });

  test('the same link twice is refused, not silently duplicated', async () => {
    const patient = await makeRecord(t.id, token, 'patient', 'p-dup');
    const inv = await makeRecord(t.id, token, 'invoice', 'i-dup');
    const body = { to_record_id: inv.record_id, link_type: 'billed_to' };

    assert.equal((await call('POST', `/v1/records/${patient.record_id}/links`, { body })).status, 201);
    const again = await call('POST', `/v1/records/${patient.record_id}/links`, { body });

    assert.equal(again.status, 422);
    assert.equal(again.body.error.code, 'LINK_RULE_VIOLATION');
  });

  test('a self-link is a validation error, not a rule violation', async () => {
    // No rule could ever permit it, so reporting it as a rule violation would send the
    // caller looking for a record_link_rules row to add.
    const patient = await makeRecord(t.id, token, 'patient', 'p-self');
    const res = await call('POST', `/v1/records/${patient.record_id}/links`, {
      body: { to_record_id: patient.record_id, link_type: 'attends' },
    });

    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  test('a missing required field is caught by the spec validator', async () => {
    const appt = await makeRecord(t.id, token, 'appointment', 'a-missing');
    const res = await call('POST', `/v1/records/${appt.record_id}/links`, {
      body: { link_type: 'attends' },
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.field_errors.some((f) => f.field === 'to_record_id'));
  });
});

describe('tenant isolation on links', () => {
  test("linking to another tenant's record is 404, not a rule violation", async () => {
    // RLS makes the target invisible, so the trigger sees a record that does not exist.
    // The answer must not confirm that something is there.
    const mine = await makeRecord(t.id, token, 'appointment', 'a-cross');
    const theirs = await makeRecord(other.id, otherToken, 'note', 'their-record');

    const res = await call('POST', `/v1/records/${mine.record_id}/links`, {
      body: { to_record_id: theirs.record_id, link_type: 'attends' },
    });
    assert.equal(res.status, 404);
  });

  test("listing links on another tenant's record is 404", async () => {
    const mine = await makeRecord(t.id, token, 'appointment', 'a-list-cross');
    const res = await call('GET', `/v1/records/${mine.record_id}/links`, { tok: otherToken });
    assert.equal(res.status, 404);
  });
});

describe('listing links', () => {
  test('direction=both returns links in either direction', async () => {
    const patient = await makeRecord(t.id, token, 'patient', 'p-dir');
    const appt = await makeRecord(t.id, token, 'appointment', 'a-dir');
    const inv = await makeRecord(t.id, token, 'invoice', 'i-dir');

    await call('POST', `/v1/records/${appt.record_id}/links`, {
      body: { to_record_id: patient.record_id, link_type: 'attends' },
    });
    await call('POST', `/v1/records/${patient.record_id}/links`, {
      body: { to_record_id: inv.record_id, link_type: 'billed_to' },
    });

    const res = await call('GET', `/v1/records/${patient.record_id}/links`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 2, 'one inbound and one outbound');

    const validate = responseValidator('/records/{record_id}/links', 'get', '200');
    assert.ok(validate(res.body), JSON.stringify(validate.errors));
  });

  test('direction=from returns only outbound links', async () => {
    const patient = await makeRecord(t.id, token, 'patient', 'p-from');
    const appt = await makeRecord(t.id, token, 'appointment', 'a-from');
    const inv = await makeRecord(t.id, token, 'invoice', 'i-from');

    await call('POST', `/v1/records/${appt.record_id}/links`, {
      body: { to_record_id: patient.record_id, link_type: 'attends' },
    });
    await call('POST', `/v1/records/${patient.record_id}/links`, {
      body: { to_record_id: inv.record_id, link_type: 'billed_to' },
    });

    const res = await call('GET', `/v1/records/${patient.record_id}/links?direction=from`);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].link_type, 'billed_to');
  });

  test('an invalid direction is refused', async () => {
    const patient = await makeRecord(t.id, token, 'patient', 'p-baddir');
    const res = await call('GET', `/v1/records/${patient.record_id}/links?direction=sideways`);
    assert.equal(res.status, 422);
  });
});

describe('unlinking', () => {
  test('a link is removed and returns 204', async () => {
    const patient = await makeRecord(t.id, token, 'patient', 'p-unlink');
    const inv = await makeRecord(t.id, token, 'invoice', 'i-unlink');

    const made = await call('POST', `/v1/records/${patient.record_id}/links`, {
      body: { to_record_id: inv.record_id, link_type: 'billed_to' },
    });

    const del = await call(
      'DELETE', `/v1/records/${patient.record_id}/links/${made.body.data.link_id}`);
    assert.equal(del.status, 204);

    const after = await call('GET', `/v1/records/${patient.record_id}/links`);
    assert.ok(!after.body.data.some((l) => l.link_id === made.body.data.link_id));
  });

  test('unlinking is a hard delete, and the audit row survives it', async () => {
    // A link is a relationship assertion rather than a record: no retention obligation of
    // its own, and the data_audit_log trigger preserves what was removed.
    const patient = await makeRecord(t.id, token, 'patient', 'p-hard');
    const inv = await makeRecord(t.id, token, 'invoice', 'i-hard');

    const made = await call('POST', `/v1/records/${patient.record_id}/links`, {
      body: { to_record_id: inv.record_id, link_type: 'billed_to' },
    });
    await call('DELETE', `/v1/records/${patient.record_id}/links/${made.body.data.link_id}`);

    const rows = await asOwner(pool, async (c) => {
      const { rows } = await c.query(
        `SELECT operation FROM data_audit_log
          WHERE tenant_id = $1 AND table_name = 'record_links' AND record_id = $2
          ORDER BY timestamp`, [t.id, made.body.data.link_id]);
      return rows.map((r) => r.operation);
    });

    assert.ok(rows.includes('INSERT'), 'the creation must be in the audit log');
    assert.ok(rows.includes('DELETE'), 'the removal must be too');
  });

  test('a link id belonging to a different record is 404', async () => {
    // Without the from_record_id predicate, a link id alone would let a caller delete a
    // link hanging off a different record in the same tenant.
    const a = await makeRecord(t.id, token, 'patient', 'p-wrong');
    const b = await makeRecord(t.id, token, 'patient', 'p-wrong-2');
    const inv = await makeRecord(t.id, token, 'invoice', 'i-wrong');

    const made = await call('POST', `/v1/records/${a.record_id}/links`, {
      body: { to_record_id: inv.record_id, link_type: 'billed_to' },
    });

    const res = await call('DELETE', `/v1/records/${b.record_id}/links/${made.body.data.link_id}`);
    assert.equal(res.status, 404);
  });

  test('an unknown link id is 404', async () => {
    const patient = await makeRecord(t.id, token, 'patient', 'p-nolink');
    const res = await call('DELETE', `/v1/records/${patient.record_id}/links/${randomUUID()}`);
    assert.equal(res.status, 404);
  });
});
