# Phase 6.1 — Data Analytics & Business Intelligence

Implementation-ready specifications for section 6.1 of `../NEXT_STAGE_NOTES.md`. This is new
documentation — unlike Phases 1–5, there is no prior source document to correct against.

| Doc | Covers | Checklist item |
|---|---|---|
| [01_DATA_WAREHOUSE_ARCHITECTURE.md](01_DATA_WAREHOUSE_ARCHITECTURE.md) | Analytics data model, ETL, tenant-facing analytics, de-identification | Data Warehouse Architecture |
| [02_ML_INTEGRATION.md](02_ML_INTEGRATION.md) | Training and deployment, feature engineering, monitoring, A/B testing | Machine Learning Integration |

## Roadmap position

`BUSINESS_PRODUCT_PLANNING.md:704-726` places AI/ML and the "multi-tenant data lake" in **Scale
Features, months 13–24**. These documents are therefore design-ahead rather than immediate build
work — which is why doc 01 extends the existing Postgres `metrics` schema rather than standing up
a warehouse, and documents the migration triggers instead.

Section 6.2 (`../experience/`) is a different matter: it sits at months 10–12 and is near-term.

## The constraint that shapes both documents

Pooling PHI from multiple covered entities into a shared analytical store, and using it for the
platform's own purposes, is **not something a Business Associate may do by default**. It requires
BAA permission, patient authorization, or de-identification to HHS standards first. Access control
is not de-identification.

So the split is:

| Scope | Data | Permitted use |
|---|---|---|
| Tenant-scoped analytics | Real, RLS-protected aggregates | Serving that tenant |
| Cross-tenant benchmarks, ML training | Safe Harbor de-identified | Anything |

De-identification on a generic JSONB record store would normally be impossible — you cannot strip
identifiers from a blob without knowing which keys hold them. Here the Phase 1 type registry
already describes the shape, so de-identification is **schema-driven** via `phi_class` annotations
on `form_versions.schema`. Those annotations do not exist yet and are a prerequisite for anything
cross-tenant.

## Findings worth reading first

1. **Late-arriving data breaks naive rollups** (doc 01). The platform is offline-first: a
   clinician offline for three days syncs records dated three days ago, after those days' rollups
   were computed. Without a reprocessing window and provisional-day marking, the numbers are
   permanently and silently understated.
2. **Predictive analytics may be FDA-regulated Clinical Decision Support** (doc 02). Document
   extraction and workflow suggestions are almost certainly not; patient outcome prediction and
   clinical risk scoring almost certainly are. This needs a regulatory owner before it is scoped.
3. **Models memorise their training data** (doc 02). A model trained on one covered entity's PHI
   and served to another is a disclosure channel inside the weights that no access control closes.
   Training only on de-identified data removes it rather than guarding it.
4. **Free text cannot be de-identified mechanically** (doc 01). Safe Harbor's "no actual
   knowledge" clause is not satisfied by pattern-stripping a clinical note, so free text is
   excluded from cross-tenant export entirely — which is precisely what document extraction needs,
   and is the open question in doc 02.
5. **Small-cell suppression is mandatory** (doc 01). A count of one in a small clinic identifies a
   person; cells below five report null, and benchmarks require a 20-tenant cohort.

## Decisions taken

- **Extend the Postgres `metrics` schema** from `observability/03` with an `analytics` schema of
  rollups and materialized views on the read replica. No new infrastructure, no second copy of
  PHI. Warehouse migration triggers documented, not built.
- **ML trains on de-identified data only**, which makes cross-tenant models permissible and
  removes the memorisation risk. Per-tenant PHI models were not chosen.
