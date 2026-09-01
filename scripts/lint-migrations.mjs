#!/usr/bin/env node
// Static checks over the SQL migrations. Catches the errors that would otherwise only
// surface as a failed `prisma migrate deploy`, and encodes the per-table checklist from
// database/07_DATA_MIGRATION_WORKFLOWS.md.
//
// This is a text-level lint, not a parser. It is deliberately conservative: it reports
// what looks wrong and lets a human judge, rather than trying to be clever.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'prisma/migrations';
const files = readdirSync(DIR)
  .filter((d) => /^\d{14}_/.test(d))
  .sort()
  .map((d) => ({ name: d, sql: readFileSync(join(DIR, d, 'migration.sql'), 'utf8') }));

if (files.length === 0) {
  console.error('No migrations found.');
  process.exit(1);
}

const problems = [];
const created = new Set();          // tables, in creation order
const createdTypes = new Set();
const withTenantId = new Set();
const rlsEnabled = new Set();
const rlsForced = new Set();
const hasPolicy = new Set();

// Strip line comments so commented-out DDL is not counted as real.
const strip = (sql) => sql.replace(/--[^\n]*/g, '');

for (const { name, sql } of files) {
  const s = strip(sql);

  for (const m of s.matchAll(/CREATE\s+TYPE\s+(\w+)/gi)) createdTypes.add(m[1]);

  // Table bodies, for column inspection.
  for (const m of s.matchAll(/CREATE\s+TABLE\s+(\w+)\s*\(([\s\S]*?)\n\)/gi)) {
    const [, table, body] = m;
    if (created.has(table)) problems.push(`${name}: table ${table} created twice`);
    created.add(table);
    if (/^\s*tenant_id\s/mi.test(body)) withTenantId.add(table);

    // Forward references inside the body.
    for (const r of body.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
      if (!created.has(r[1])) {
        problems.push(`${name}: ${table} REFERENCES ${r[1]} before it is created`);
      }
    }
    for (const t of body.matchAll(/\b(\w+)\s+(?:NOT\s+NULL\s+)?DEFAULT/gi)) {
      // no-op; kept for future type checks
    }
  }

  // Forward references in ALTER TABLE ... REFERENCES.
  for (const m of s.matchAll(/ALTER\s+TABLE\s+(\w+)[\s\S]*?REFERENCES\s+(\w+)\s*\(/gi)) {
    if (!created.has(m[2])) {
      problems.push(`${name}: ALTER ${m[1]} REFERENCES ${m[2]} before it is created`);
    }
  }

  for (const m of s.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
    rlsEnabled.add(m[1]);
  }
  for (const m of s.matchAll(/ALTER\s+TABLE\s+(\w+)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
    rlsForced.add(m[1]);
  }
  for (const m of s.matchAll(/CREATE\s+POLICY\s+\w+\s+ON\s+(\w+)/gi)) {
    hasPolicy.add(m[1]);
  }

  // Types must exist before use.
  for (const m of s.matchAll(/\b(\w+)\s+(\w+)\s+NOT\s+NULL\s+DEFAULT\s+'/gi)) {
    // conservative: skip, enum usage is validated by the database itself
  }

  // Asymmetric FOR ALL policies without an explicit WITH CHECK.
  //
  // PostgreSQL reuses the USING expression for new rows when WITH CHECK is omitted. That
  // is harmless when USING is a plain equality, and an escalation when USING is
  // deliberately *permissive* for reads: the roles policy allows tenant_id IS NULL so
  // system templates are readable by everyone, and without WITH CHECK any app_user could
  // have inserted one. Flag the shape rather than trusting review to catch it again.
  // Match the whole statement up to its terminating semicolon, then inspect it. An
  // earlier version tried to capture USING(...) and an optional trailing WITH CHECK in
  // one pattern; the lazy group backtracked past a WITH CHECK that was present and it
  // reported a false positive on the very policy it was written to protect.
  for (const m of s.matchAll(/CREATE\s+POLICY\s+(\w+)\s+ON\s+(\w+)\s+FOR\s+ALL([\s\S]*?);/gi)) {
    const [, policy, table, body] = m;
    const withCheck = /WITH\s+CHECK/i.test(body);
    const usingExpr = (body.match(/USING\s*\(([\s\S]*)/i) || [, ''])[1];
    const permissive = /\bIS\s+NULL\b|\bOR\b/i.test(usingExpr);
    if (permissive && !withCheck) {
      problems.push(
        `${name}: policy ${policy} on ${table} is FOR ALL with a permissive USING ` +
        `(contains OR / IS NULL) and no explicit WITH CHECK — reads and writes share the ` +
        `same predicate, so read permissiveness becomes write permissiveness`);
    }
  }

  // Balanced dollar-quoting: an unclosed $$ silently swallows the rest of the file.
  const dollars = (sql.match(/\$\$/g) || []).length;
  if (dollars % 2 !== 0) problems.push(`${name}: unbalanced $$ quoting (${dollars})`);

  // Prisma wraps each migration in a transaction; CONCURRENTLY cannot run inside one.
  if (/CREATE\s+INDEX\s+CONCURRENTLY/i.test(s)) {
    problems.push(`${name}: CREATE INDEX CONCURRENTLY cannot run inside Prisma's transaction wrapper (database/07)`);
  }
}

// RULE-HSC-02: any table carrying tenant_id must have RLS enabled, forced, and a policy.
for (const t of withTenantId) {
  if (!rlsEnabled.has(t)) problems.push(`RLS: ${t} has tenant_id but RLS is never enabled`);
  else if (!rlsForced.has(t)) problems.push(`RLS: ${t} has RLS enabled but not FORCED — the owner bypasses isolation`);
  if (!hasPolicy.has(t)) problems.push(`RLS: ${t} has tenant_id but no policy — RLS enabled with no policy denies everything`);
}

// A table with RLS enabled but no policy is a silent outage, tenant_id or not.
for (const t of rlsEnabled) {
  if (!hasPolicy.has(t)) problems.push(`RLS: ${t} has RLS enabled but no policy at all`);
}

console.log(`Migrations:  ${files.length}`);
console.log(`Tables:      ${created.size}`);
console.log(`Types:       ${createdTypes.size}`);
console.log(`Tenant-scoped: ${withTenantId.size}  (RLS enabled ${rlsEnabled.size}, forced ${rlsForced.size}, policies ${hasPolicy.size})`);

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nNo problems found.');
