// A tenant's import mapping must not be able to reach outside its own row.
//
// `target_path` is customer-supplied and openapi.yaml puts no pattern on it, so whatever
// the customer writes arrives at `parseTarget` verbatim. `assignPath` then walks that path
// creating objects as it descends — and a descent through `__proto__` lands on
// Object.prototype, where a write is visible to every object in the process. In a platform
// that serves many tenants from one process, that is one tenant's mapping altering
// requests being served for another, which RULE-HSC-02 treats as an isolation defect
// rather than a hardening nicety.
//
// These run without a database: mapping is pure, and a pure test that needs postgres to
// start is a test nobody runs while they are editing the thing it covers.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { parseTarget, mapRow } = await import('../dist/imports/mapping.js');

/** A mapping as `import_field_mappings` stores one. */
function mapping(source_column, target_path, extra = {}) {
  return {
    source_column,
    target_path,
    transform: null,
    is_required: false,
    default_value: null,
    ...extra,
  };
}

describe('parseTarget refuses paths that walk the prototype chain', () => {
  for (const path of [
    'data.__proto__',
    'data.__proto__.isAdmin',
    'data.nested.__proto__.isAdmin',
    'data.constructor',
    'data.constructor.prototype.isAdmin',
    'data.prototype.isAdmin',
  ]) {
    test(`"${path}" is not a destination`, () => {
      assert.equal(parseTarget(path), null);
    });
  }
});

describe('parseTarget still accepts what it always did', () => {
  test('first-class columns', () => {
    assert.deepEqual(parseTarget('external_id'), { kind: 'scalar', column: 'external_id' });
  });

  test('nested data paths', () => {
    assert.deepEqual(parseTarget('data.contact.phone'), {
      kind: 'data',
      path: ['contact', 'phone'],
    });
  });

  test('a field whose name merely contains a blocked word', () => {
    // The check is on whole segments. `data.constructor_name` is an ordinary column and
    // refusing it would be a regression dressed up as a fix.
    assert.deepEqual(parseTarget('data.constructor_name'), {
      kind: 'data',
      path: ['constructor_name'],
    });
  });

  test('link targets', () => {
    assert.deepEqual(parseTarget('link:attends:patient'), {
      kind: 'link',
      linkType: 'attends',
      toTypeCode: 'patient',
    });
  });
});

describe('mapRow does not pollute the prototype', () => {
  test('a __proto__ mapping is a row error, and nothing leaks', () => {
    const result = mapRow(
      { evil: 'yes' },
      [mapping('evil', 'data.__proto__.isAdmin')],
    );

    assert.equal(result.ok, false);
    assert.equal(result.failures[0].code, 'unknown_column');

    // The actual assertion this file exists for.
    assert.equal({}.isAdmin, undefined, 'Object.prototype was written to');
    assert.equal({ unrelated: 1 }.isAdmin, undefined, 'pollution reached an unrelated object');
  });

  test('the data object it builds has no prototype to reach', () => {
    const result = mapRow({ mrn: 'X1' }, [mapping('mrn', 'data.mrn')]);

    assert.equal(result.ok, true);
    assert.equal(Object.getPrototypeOf(result.row.data), null);
    // Still an ordinary JSON payload as far as the rest of the pipeline is concerned:
    // pipeline.ts stringifies this straight into jsonb.
    assert.equal(JSON.stringify(result.row.data), '{"mrn":"X1"}');
  });

  test('nested objects it creates have no prototype either', () => {
    const result = mapRow(
      { phone: '+441234567890' },
      [mapping('phone', 'data.contact.phone')],
    );

    assert.equal(result.ok, true);
    assert.equal(Object.getPrototypeOf(result.row.data.contact), null);
    assert.equal(result.row.data.contact.phone, '+441234567890');
  });
});
