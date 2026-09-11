# Implementation Gaps

**Status:** Living register · Last reviewed 2026-09-11 against commit `6f8a94c`
**Purpose:** What is not built, what is not specified, and which of those two a thing is.

The distinction in that last line is the whole point of this document. This repository holds
71 design documents and a partial implementation, so "we don't have X" is ambiguous — it can
mean *specified and not yet written*, which is a scheduling matter, or *never specified at
all*, which is a design matter and costs an order of magnitude more. They are listed
separately below.

---

## Part A — Specified and built

The foundations, the safety systems and the core record-keeping are done, and proven by 175
automated tests that run from an empty database. In non-technical terms:

- Many organisations share one system and none can reach another's data — enforced by the
  database rather than by application code remembering to check.
- Records of any shape, for any industry, created/listed/read/edited/removed.
- Paging through long lists without repeats or gaps.
- Records linked to each other under rules each organisation declares.
- Two people editing the same record cannot silently overwrite each other.
- Every *read* of protected health information is logged, not just every change.
- A change history nobody — including an administrator — can alter or delete.
- Traffic floods refused cheaply; per-customer allowances driven by their paid plan.
- Retried requests do not create duplicates.
- Sensitive values kept out of server logs.
- Outside software vendors can exist without seeing each other or customer data.

---

## Part B — Specified but not built

These have written specifications in this corpus. Building them is scheduling, not design.

| Gap | In plain terms | Specified in | Note |
|---|---|---|---|
| `/auth/login`, `/refresh`, `/logout` | Logging in | `api/01` | **Blocked** — see Open question 1 |
| `/files`, `/files/{id}/download` | Attachments, photos, documents | `FILE_UPLOAD_STORAGE.md`, `database/05` | Tables exist in the migrations |
| `/sync/pull`, `/sync/push` | Works in a basement, catches up later | `OFFLINE_SYNC_PROCESS.md`, `frontend/05` | `frontend/05` carries an unresolved data-loss defect |
| `/records/{id}/advance` | Draft to submitted to approved | `api/02` | |
| `/webhooks` | Telling other systems something happened | `api/04` | |
| `/audit-logs` | Letting a compliance officer *read* the history | `api/02`, `database/04` | Recording works; reading it back does not exist |
| Any user interface | There are no screens at all | `frontend/01`–`07`, `UI_WIREFRAMES.md` | Everything above is the engine |
| Tenant data import | Customer uploads their existing records | `database/07` Part B, `TENANT_ONBOARDING_FLOW.md`, `experience/01` | See the caveat below |

**Import caveat.** `database/07` Part B specifies the flow, the legacy field mapping, the
validation and cleansing pass, throughput, and reversal by `import_job_id` — but its three
tables (`import_jobs`, `import_field_mappings`, `import_row_errors`) were **not carried into
the eight migrations**. So import is specified, is commercially load-bearing
(`TENANT_ONBOARDING_FLOW.md` puts it at 35% of onboarding time and names import confusion as
a top support topic), and has no schema behind it yet.

---

## Part C — Not specified: the proposed additions

Raised 2026-09-11. Triaged against the corpus rather than assumed to be new.

### C1 · Export — controls specified, feature not

Export is unusual here: the *restrictions* on it are specified in four places while the
feature itself is specified nowhere.

- `SECURITY_ARCHITECTURE.md` — JSON/CSV/XML for data-subject requests
- `interoperability/01` — FHIR bulk export is asynchronous, rate-limited and
  **separately permissioned**, explicitly "must not inherit ordinary read permissions"
- `observability/04` — more than 10,000 records exported by one user in an hour is a **SEV2
  page**, named as the insider-threat signal
- `partners/02` — per-app export scope is a tenant-adjustable setting

Consequence: export cannot be added as a convenience feature later without contradicting
four existing documents. It is a mass-egress path with its own permission, its own rate
limit and its own alert. Cheapest to design that way from the start.

### C2 · PDF generation — genuinely new

Four incidental mentions, none of them a specification:

- `database/01` — a `pdf_url` column
- `database/05` — `preview_pdf` as a *variant of an uploaded file* (viewing, not generating)
- `DATA_FLOW_DIAGRAMS.md` — a box labelled "PDF gen" inside a background-jobs cluster
- `frontend/04` — a PDF *viewer* flagged as a heavy dependency

Nothing describes templates, rendering, storage, versioning, or what a generated document is
in the record model. Worth deciding early: a generated compliance report is arguably a record
in its own right, and if it is, it inherits audit logging and retention for free.

### C3 · Email — new, and already on the critical path

No specification exists. What exists is two diagram boxes (`BUSINESS_PRODUCT_PLANNING.md`,
"SMTP/SendGrid") and a fallback chain in `ENHANCEMENT_OPPORTUNITIES.md`, which is an ideas
document rather than an approved one. There is no `notifications`, `email`, `messages` or
`templates` table among the 83 created by the migrations.

**This is not a later problem.** `api/01` logs a user in by email address, which implies
verification and password reset, which implies sending mail. Email is therefore a dependency
of the *next* thing scheduled to be built, not only of the marketing features below.

Two constraints that will not bend:

1. A mail vendor handling PHI needs a **BAA**. That is a procurement lead time, not a
   configuration flag.
2. The safer design is that PHI never enters an email body at all — mail carries a
   notification and a link, and the data stays behind authentication. This follows the
   existing posture in `observability/01`, which already refuses to let PHI reach monitoring
   vendors.

### C4 · Batch email, batch PDF, newsletters, announcements — new, and a different product

`newsletter` appears once in the corpus, in `BUSINESS_PRODUCT_PLANNING.md`, describing the
*marketing website* — prospects subscribing before they are customers. `announcement` appears
twice, meaning screen-reader route announcements (`experience/01`) and press releases
(`REMAINING_PLANNING_AREAS.md`). Neither is the in-product feature being proposed.

This group is worth separating from C1–C3 because it is a different kind of thing: outbound
communications and marketing, where everything else in this platform is compliance
record-keeping. It brings consequences the current architecture has never had to hold —
unsubscribe handling and CAN-SPAM, bounce and complaint processing, send reputation,
recipient lists that are themselves personal data, and the question of whether a newsletter
is even a per-tenant feature or a platform-to-customer one. Those are answerable, but they
should be answered deliberately rather than absorbed into the record platform by default.

---

## Part D — The substrate all of them share

Batch PDF, batch email, bulk export and tenant import are the same shape: **long-running work
that outlives a request**. That substrate does not exist.

The API today is request/response, plus exactly one asynchronous mechanism — the bounded,
backpressuring queue behind PHI access logging. Deliberately narrow, and not a general job
runner. The migrations contain `file_processing_jobs` and `purge_jobs`, but those are tables
for two specific features, not a scheduler.

Ten documents reference background work as though it exists. None specifies it. The open
questions are ordinary — retries, idempotency, visibility, per-tenant fairness so one
customer's 50,000-row import does not starve everyone else, and what happens to running work
when `performance/02`'s scale-in kills a worker — but they need answering once, in one place,
before four features answer them four different ways.

**Recommendation:** specify the job runner before any of C1–C4. It is the cheapest of the
group and the other four are all easier once it exists.

---

## Part E — What these features have in common, and why it matters

Everything in Part C moves data **out** of the system: a PDF to a printer, a CSV to a laptop,
a record into an inbox. The architecture built so far rests on the opposite assumption — PHI
does not leave casually, RLS bounds every read, every read is logged, error text is filtered
before it reaches a log line.

So each of these is an egress path, and each needs the same four things rather than each
inventing its own:

1. Audit logging, on the same footing as a read — an exported record has been accessed.
2. The `record_type_definitions.is_phi` switch consulted. It already drives four separate
   consumers; these would be the fifth and sixth, and the value of one definition with many
   consumers is lost the moment a feature decides for itself what counts as PHI.
3. A destination inside the BAA boundary, or no PHI in what is sent.
4. Its own permission, distinct from ordinary read — already mandated for export by
   `interoperability/01`.

Handled once as "egress", this is one design. Handled per feature, it is the same argument
four times with four different outcomes, which is the shape of several defects already
recorded in `db/README.md`.

---

## Part F — Phase 1 audit: is the import gap a pattern?

Run 2026-09-11, prompted by the import finding. Every table declared in `database/01`–`08` and
`DATABASE_SCHEMA.md` — both SQL `CREATE TABLE` statements and mermaid ERD entities, 63 distinct
names — was compared against the 82 created by the migrations.

**Result: the import tables are the only genuine gap.** Nine names differ, and six of those are
explained:

| Absent from migrations | Verdict |
|---|---|
| `import_jobs`, `import_field_mappings`, `import_row_errors` | **Real gap.** `database/07` Part B |
| `local_config`, `local_records`, `local_files`, `pending_changes`, `sync_metadata` | Correct — `DATABASE_SCHEMA.md`'s "Mobile Offline Database Schema (SQLite)". Client-side, never Postgres |
| `data_audit_log_2026_09` | Correct — a worked example of a monthly partition, not a table to create. Partitions plus a DEFAULT are created and asserted by `schema-invariants.test.mjs` |

The five column-level additions that the Phase 1–7 session recorded as needed by later phases
were checked too, and **all five are present**: `phi_class` on form schemas, `config_version` on
`tenant_configurations`, `sessions.last_mfa_at`, `sessions.impersonated_by`, and the
`{system, code, display}` shape on coded fields (`20260901120300_business_entity`).

So the extraction from documents to migrations was accurate everywhere except `database/07`,
which is the one Phase 1 document whose tables serve a *workflow* rather than an ERD — plausibly
why it was missed when the ERDs were walked one by one.

**The structural point survives the good result.** Nothing in the test suite could have found
this. `schema-invariants.test.mjs` asserts properties *of the tables that exist* — RLS enabled
and forced, a policy per table, audit partitioning, role grants — and a table that was never
created has no properties to assert. The corpus is never compared against the migrations by
anything but a person. That check is cheap to automate and currently is not.

---

## Design notes

| # | Note |
|---|---|
| 1 | Part B is scheduling; Part C is design. Conflating them makes Part C look far cheaper than it is. |
| 2 | Import was found specified-but-unmigrated, and the rest of Phase 1 was then audited for the same gap — see below. It is an isolated miss, not a pattern. |
| 3 | Export's controls existing without export itself is a genuine hazard: a later developer implements it as a convenience endpoint, four documents are silently contradicted, and no test fails. |
| 4 | C4 is a product-scope question as much as an engineering one, and is the only item here that could reasonably be answered "no". |

## Open questions

1. **The `auth_service` `SECURITY DEFINER` review** (`database/02` OQ4) has never happened and
   gates `/auth/login`, which gates everything user-facing. Longest-standing blocker here.
2. **Is email in scope now or later?** It is a prerequisite of login (C3), so "later" is only
   available if verification and reset are deferred too.
3. **Is a generated PDF a record?** If yes it inherits audit, retention and the PHI switch at
   no extra cost. If no, all three need building separately for it.
4. **Are newsletters and announcements a tenant feature or a platform feature?** Tenant-level
   means per-tenant sender identity, deliverability and consent tracking. Platform-level is
   substantially smaller and may not belong in this codebase at all.
5. **Does the job runner get specified as its own Phase 1 document, or absorbed into
   `performance/`?** It is infrastructure, but it is referenced by ten documents across five
   phases, which argues for a home of its own.
6. **The vertical** (unchanged, and it touches C2 and C4): clinical healthcare or workplace
   health and safety decides what the first document templates and the first announcements
   are actually *for*.
7. **Should the corpus-versus-migrations comparison in Part F be a lint rather than a
   person?** `scripts/lint-migrations.mjs` already exists and already found two of the
   fourteen recorded defects. Extending it to flag a documented `CREATE TABLE` with no
   migration is a small change, and the only reason to hesitate is the false-positive class
   Part F had to reason past by hand — the mobile SQLite schema and the partition examples,
   which would need an explicit exclusion rather than a heuristic.
