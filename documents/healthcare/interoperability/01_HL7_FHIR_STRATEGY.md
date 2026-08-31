# 01 — HL7 / FHIR Interoperability Strategy

**Phase 6.3 · Direction record** · Sources: `database/03`, `api/01`, `api/02`, `database/05`, `analytics/01`
**Status:** **Recommended direction — not yet approved, and gated on an unresolved question (below)**

This is a decision record, not an implementation specification. It captures the analysis of
whether to make the data model natively HL7/FHIR-compatible or to build a mapping layer, states a
recommendation, and lists what a full specification would still need to cover.

---

## Gate: is the vertical clinical, or health & safety?

Open question 5 in `database/03_BUSINESS_ENTITY_ERD.md`, still unresolved, and it determines
whether any of this is needed.

The repository is `hsc-platform` and the project is described as "Health, Safety & Compliance",
but `NEXT_STAGE_NOTES.md` specifies patients, appointments, procedures and insurance claims, and
the healthcare catalogue in `database/03` was written to match.

| If the vertical is | Then |
|---|---|
| **Workplace health & safety** (incidents, inspections, corrective actions, SDS) | HL7 and FHIR are irrelevant. The healthcare catalogue should be reconciled instead, and this document is closed |
| **Clinical healthcare** | Interoperability is a real requirement, and qualification 2 below should be applied at the next Phase 1 revision regardless of when a FHIR API ships |

Nothing below should be built before that is settled.

---

## Current state

There is no interoperability capability of any kind. Across every document in
`documents/healthcare/`, the only occurrence of "HL7" is `FILE_UPLOAD_STORAGE.md:34`, listing it
among permitted upload MIME types. There are zero mentions of FHIR, ICD-10, SNOMED CT, LOINC, or
X12.

The data model is proprietary in three layers:

| Layer | What it is |
|---|---|
| Storage | One generic `records` table; everything domain-specific lives in a `data` JSONB column |
| Shape | Defined per tenant by `form_versions.schema` (JSON Schema). No platform-wide field dictionary — two tenants both running `patient` may have entirely different field sets |
| Query surface | Hot fields promoted to generated columns (`gc_mrn`, `gc_dob`) for indexing and uniqueness |

The healthcare catalogue names fields that *gesture* at real code systems without being bound to
them:

```jsonc
// database/03, record_type 'procedure'
{ "cpt_code": "99213", "performed_at": "…", "notes": "…", "outcome": "…" }
//  ^^^^^^^^ a bare string. Nothing validates it, and nothing records
//           which code system it belongs to.
```

---

## Recommendation: a FHIR façade, not native FHIR storage

Translate at the boundary. Keep the internal model as the single substrate.

### Why not native

| Reason | Detail |
|---|---|
| **It breaks the industry-agnostic architecture** | There is no FHIR resource for a workplace safety inspection, a legal matter or a time entry. Native FHIR would mean the healthcare pack storing FHIR while every other pack stores something else — two storage models, and the hybrid substrate in `database/03` stops being one thing |
| **Version churn becomes a data migration** | FHIR R4 → R5 with native storage rewrites every clinical record in every tenant. With a façade it is a change in one translator, deployable behind a flag |
| **FHIR's authorization model is a different shape** | SMART on FHIR scopes and the Patient compartment do not map onto the platform's RBAC plus RLS. Native storage invites a second authorization surface, and per `api/01` a second authorization surface is a second place to get tenant isolation wrong |
| **FHIR resources are PHI-dense and deeply nested** | A `Patient` carries names, identifiers, telecom and addresses inline, plus extensions and contained resources. Every generated column, index and de-identification rule in `analytics/01` would have to navigate that nesting |

### Why a façade is also the better security position

A mapping layer is a **narrow, auditable chokepoint**: one component that emits PHI in an external
format, one place to log it, one place to review. Native FHIR handling spreads that surface
across the application.

---

## Three qualifications that make a façade work

A naive mapping layer is lossy in both directions and degrades. These prevent that, and the second
is the one that costs least now and most later.

### 1. Shape the healthcare pack to FHIR where it is free

Align internal field names, cardinality, value sets and conceptual boundaries with the
corresponding FHIR elements, so translation is mechanical rather than creative.

This is nearly free while the catalogue is still a table in a markdown file. It is expensive once
tenants have captured records under divergent schemas, because the mapping then has to be authored
per tenant.

### 2. Bind coded fields to terminologies now

The single highest-return change available, and it is worth doing whether or not FHIR ever ships.

```jsonc
// instead of
"cpt_code": "99213"

// store
"code": {
  "system":  "http://www.ama-assn.org/go/cpt",
  "code":    "99213",
  "display": "Office visit, established patient"
}
```

Without the system URI, a bare `"99213"` does not say which code system it belongs to, so no
mapping is possible later without a data cleanup across every tenant that has captured records.

Applies to: `procedure.code` (CPT/HCPCS), diagnoses (ICD-10-CM), observations and lab results
(LOINC), clinical findings (SNOMED CT), `provider.npi` (NPI registry), `insurance_policy.payer`
(payer identifier).

This requires a **terminology service** — validation, display lookup, version handling as code
sets are revised annually — which is a larger piece of work than the format translation itself and
is often underestimated.

### 3. Keep the original inbound payload

Store the source HL7 v2 message or FHIR bundle as a file (`database/05`), associated with the
record it produced.

Translation stays lossy and nothing is lost: there is provenance for audit, and a re-translation
path when the mapper improves. `file_associations` already supports this with an
`association_type` of `source_message`.

---

## Security architecture

### Outbound — the FHIR façade

```
/fhir/R4/*    a distinct route namespace, one component
```

| Control | Requirement |
|---|---|
| Authentication | Reuses `api/01`. SMART on FHIR scopes **map onto existing permissions** — never a parallel authorization model |
| Tenant context | The JWT `tenant_id` claim remains the only authoritative source (`api/01`, correction 1) |
| Audit | Every FHIR read is a PHI access and writes `user_audit_log` with `is_phi_access` (`database/04`) |
| Emission | The façade is the only component permitted to produce FHIR output |
| Bulk export | FHIR Bulk Data (`$export`) is an asynchronous, rate-limited, separately-permissioned operation — it is a mass PHI egress path and must not inherit ordinary read permissions |

### Inbound — HL7 v2 ingestion

This is the highest-risk element in the whole design.

HL7 v2 over MLLP is typically **unauthenticated TCP on a hospital's private network**. There is no
identity attached to the message.

```
MLLP listener  →  isolated ingestion service  →  platform API  →  database
                  (no direct database access)     (RLS, audit,
                                                   tenant context)
```

**The listener must never write directly to the database.** A direct write bypasses row-level
security, the audit triggers and the tenant context in a single step — every control the platform
has. The ingestion service holds its own API credentials, is rate-limited, is network-isolated
from everything else, and its messages are validated before they become records.

---

## What a full specification would still need to cover

Not written. This document records direction only.

- [ ] FHIR resource mapping tables — `patient` → `Patient`, `appointment` → `Appointment`,
      `procedure` → `Procedure`, `insurance_policy` → `Coverage`, `claim` → `Claim`, including
      cardinality and unmapped-element handling in both directions
- [ ] Which FHIR version and profiles (R4 with US Core is the conventional target)
- [ ] SMART on FHIR scope → platform permission mapping
- [ ] Terminology service design: storage, versioning, annual code set updates, validation on write
- [ ] HL7 v2 message types in scope (ADT, ORU, ORM, SIU) and segment mappings
- [ ] X12 837/835 for claims, if claims are in scope
- [ ] Conformance testing — Inferno or Touchstone
- [ ] `CapabilityStatement` generation
- [ ] Reconciliation and duplicate patient matching on inbound
- [ ] Error handling for messages that cannot be mapped

---

## Open questions

1. **The vertical question above gates everything.** It should be answered before any of this is
   scoped.
2. **Is FHIR support legally required, or a sales requirement?** The ONC Cures Act and CMS
   interoperability rules bind certified health IT and payers, not every healthcare SaaS. This is
   a question for counsel, not engineering, and it changes the timeline rather than the design.
3. **Terminology licensing.** CPT is licensed from the AMA and SNOMED CT requires an affiliate
   licence in some jurisdictions. Both carry cost and contractual terms that need checking before
   they are designed in.
4. **Patient matching.** Inbound feeds identify patients by the sending system's MRN, which will
   not match the platform's. Duplicate detection and merge is a substantial feature in its own
   right, and it interacts with the blind-index design in `infrastructure/06`.
5. **Does qualification 2 proceed independently?** Terminology binding is worth doing on its own
   merits. It could be applied at the next Phase 1 revision without committing to a FHIR API at
   all — recommended, if the vertical turns out to be clinical.
