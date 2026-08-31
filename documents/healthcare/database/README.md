# Phase 1.1 — Database & Data Architecture

Implementation-ready specifications for the section of `../NEXT_STAGE_NOTES.md` titled
"Phase 1: Database & Data Architecture Breakdowns". Docs 01–05 are the entity diagrams;
06–08 are the implementation specs listed under the same section.

| Doc | Covers | Checklist item |
|---|---|---|
| [01_TENANT_MANAGEMENT_ERD.md](01_TENANT_MANAGEMENT_ERD.md) | Tenants, config, domains, provisioning, plans, subscriptions, invoices, usage | Tenant Management ERD |
| [02_USER_AUTH_ERD.md](02_USER_AUTH_ERD.md) | Users, RBAC, sessions, refresh tokens, devices, MFA, SSO | User & Authentication ERD |
| [03_BUSINESS_ENTITY_ERD.md](03_BUSINESS_ENTITY_ERD.md) | Record substrate, type registry, links, form versioning, industry packs | Core Business Entity ERDs |
| [04_AUDIT_COMPLIANCE_ERD.md](04_AUDIT_COMPLIANCE_ERD.md) | Audit logs, immutability, retention, legal holds, GDPR/CCPA | Audit & Compliance Schema |
| [05_FILE_DOCUMENT_ERD.md](05_FILE_DOCUMENT_ERD.md) | File versioning, variants, chunked upload, permissions, sharing, tagging | File & Document Management Schema |
| [06_INDEXING_STRATEGY.md](06_INDEXING_STRATEGY.md) | Index rules, hot query paths, query patterns, maintenance | Database Indexing Strategy |
| [07_DATA_MIGRATION_WORKFLOWS.md](07_DATA_MIGRATION_WORKFLOWS.md) | Schema migrations (expand/contract) and tenant data import | Data Migration Workflows |
| [08_SCALING_ARCHITECTURE.md](08_SCALING_ARCHITECTURE.md) | Pooling, read replicas, scaling ladder, monitoring, backup | Database Scaling Architecture |

## Relationship to `DATABASE_SCHEMA.md`

`../DATABASE_SCHEMA.md` remains the origin of the core ten tables, but **it is not authoritative
on its own** — it contains DDL that fails on a clean database and omits columns other documents
depend on. Every doc here ends with a *Corrections to `DATABASE_SCHEMA.md`* table listing what
was changed and why.

The two blocking defects, both in doc 04:

1. `create_audit_log()` reads `NEW.record_id` but is attached to `files` (PK `file_id`) and
   `tenant_users` (PK `user_id`) — every write to those two tables raises at runtime.
2. `current_setting('app.current_user_id')` has no `missing_ok` argument, so it raises for every
   background job, migration, and webhook write to an audited table.

Doc 08 adds a third of equal severity that is not a defect in the schema but in how it will be
deployed: with transaction-mode connection pooling, a session-scoped tenant GUC leaks across
tenants. `SET LOCAL` inside an explicit transaction is mandatory.

## Conventions

- Diagrams are Mermaid `erDiagram` / `flowchart`, which GitHub renders natively. This diverges
  from the ASCII box art used by the other documents in `../`.
- Each doc carries: entity diagram → DDL → RLS → indexes → corrections → open questions.
- Per-industry entities use the **hybrid** model (doc 03): a generic `records` table plus a type
  registry and real link edges, not concrete per-vertical tables.
- Open questions are genuine decisions, not placeholders. Several need legal or security sign-off
  rather than an engineering answer — retention periods (04), `auth_service` privileges (02),
  and quarantined-file handling (05) in particular.
