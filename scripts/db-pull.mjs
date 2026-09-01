#!/usr/bin/env node
// `prisma db pull` then restore the header.
//
// Introspection rewrites schema.prisma wholesale, which silently removes the comment
// saying the file is generated. Without it the file looks hand-authored — and the first
// person to edit a model block will have their work erased by the next pull, or worse,
// will reach for `prisma migrate dev` and start generating migrations that drop every
// policy, trigger and grant in the schema. Re-adding it is not cosmetic.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SCHEMA = 'prisma/schema.prisma';

const HEADER = `// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// The model and enum blocks below are produced by \`npm run db:pull\`, which
// introspects the live database. Edits here are erased by the next pull.
//
// The schema is SQL-first: prisma/migrations/*/migration.sql is the source of
// truth. Never run \`prisma migrate dev\` against this project — it regenerates
// migrations from the model blocks, and Prisma's schema language cannot express
// row-level security, FORCE RLS, role grants, plpgsql triggers, partitioning or
// partial indexes. Regenerating would silently drop all of it, which RULE-HSC-02
// classes as a compliance defect rather than a bug.
//
// To change the schema: write a new SQL migration, apply it with
// \`npm run db:migrate\`, then re-run \`npm run db:pull\`. See db/README.md.
// ─────────────────────────────────────────────────────────────────────────────

`;

execFileSync('npx', ['prisma', 'db', 'pull'], { stdio: 'inherit', shell: true });

const body = readFileSync(SCHEMA, 'utf8').replace(/^\/\/ ─+[\s\S]*?─+\n\n/, '');
writeFileSync(SCHEMA, HEADER + body);

console.log('\nHeader restored. schema.prisma is generated output — do not hand-edit.');
