#!/usr/bin/env node
// Creates (or drops and recreates) the development database and the login role that
// owns it, then hands off to `prisma migrate deploy`.
//
// Separate from the migrations because CREATE DATABASE cannot run inside a transaction,
// and Prisma wraps every migration file in one (database/07).
//
// Usage:
//   node scripts/db-create.mjs           create if absent
//   node scripts/db-create.mjs --drop    drop and recreate  (development only)

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';

const drop = process.argv.includes('--drop');

// Minimal .env reader: no dependency, and the file is developer-local by .gitignore.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const host = process.env.PGHOST || 'localhost';
const port = Number(process.env.PGPORT || 5432);
const superUser = process.env.PGSUPERUSER || 'postgres';
const superPass = process.env.PGSUPERPASS;

if (!superPass) {
  console.error('PGSUPERPASS is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL ?? '');
const dbName = url.pathname.replace(/^\//, '');
const owner = decodeURIComponent(url.username);
const ownerPass = decodeURIComponent(url.password);

if (!dbName || !owner) {
  console.error('DATABASE_URL must include a database name and a username.');
  process.exit(1);
}

// Guard: --drop is destructive and must never be aimed at anything but a dev database.
if (drop && !/dev|test/.test(dbName)) {
  console.error(`Refusing to drop "${dbName}" — the name does not look like a dev or test database.`);
  process.exit(1);
}

const client = new pg.Client({ host, port, user: superUser, password: superPass, database: 'postgres' });
await client.connect();

const q = (s) => s.replace(/"/g, '""');       // quote an identifier
const l = (s) => s.replace(/'/g, "''");       // quote a literal

if (drop) {
  console.log(`Dropping database ${dbName} ...`);
  // Terminate other sessions first, or DROP DATABASE fails with "being accessed by other users".
  await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName],
  );
  await client.query(`DROP DATABASE IF EXISTS "${q(dbName)}"`);
}

const { rows: roleRows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [owner]);
if (roleRows.length === 0) {
  console.log(`Creating login role ${owner} ...`);
  await client.query(`CREATE ROLE "${q(owner)}" LOGIN PASSWORD '${l(ownerPass)}'`);
} else {
  // Keep the password in step with .env so a rotated secret does not lock migrations out.
  await client.query(`ALTER ROLE "${q(owner)}" WITH LOGIN PASSWORD '${l(ownerPass)}'`);
}

const { rows: dbRows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (dbRows.length === 0) {
  console.log(`Creating database ${dbName} owned by ${owner} ...`);
  await client.query(`CREATE DATABASE "${q(dbName)}" OWNER "${q(owner)}"`);
} else {
  console.log(`Database ${dbName} already exists.`);
}

await client.end();

// The owner needs CREATEROLE to run migration 0001, which creates app_user,
// app_platform and partner_portal_user. Cluster-wide, so it is granted on the role.
const admin = new pg.Client({ host, port, user: superUser, password: superPass, database: dbName });
await admin.connect();
await admin.query(`ALTER ROLE "${q(owner)}" CREATEROLE`);
await admin.query(`GRANT ALL ON SCHEMA public TO "${q(owner)}"`);
await admin.end();

console.log(`Ready. Run: npm run db:migrate`);
