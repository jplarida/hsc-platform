# Phase 6.3 — Interoperability & Standards

Section 6.3 of `../NEXT_STAGE_NOTES.md`. Added after Phases 6.1 and 6.2 were delivered, in
response to the question of whether the platform should be HL7/FHIR compatible.

| Doc | Covers | Status |
|---|---|---|
| [01_HL7_FHIR_STRATEGY.md](01_HL7_FHIR_STRATEGY.md) | Native FHIR versus a mapping façade; security shape; what a full spec still needs | **Direction record — not approved, not specified** |

## This is not delivered work

Unlike every other folder under `documents/healthcare/`, this one contains a decision record
rather than an implementation specification. The Phase 6.3 checkboxes in `../NEXT_STAGE_NOTES.md`
are deliberately **unticked**.

Two things are true and both need action before anything is built:

1. **The recommendation has not been approved.** A FHIR façade is recommended over native FHIR
   storage; that is a proposal, not a settled decision.
2. **It is gated on an unresolved question.** `database/03` open question 5 — is the vertical
   clinical healthcare, or workplace health & safety? If the latter, HL7 and FHIR are irrelevant
   and this folder should be deleted rather than developed.

## The one thing worth acting on regardless

If the vertical turns out to be clinical, **terminology binding is worth doing at the next Phase 1
revision whether or not a FHIR API is ever built**.

Today `procedure.cpt_code` is a bare string. A bare `"99213"` does not record which code system it
belongs to, so no mapping to any external format is possible later without a data cleanup across
every tenant that has captured records. Storing `{system, code, display}` triples instead costs
almost nothing now.

That is qualification 2 in the strategy document, and it is the only item here with a deadline
attached to it — the cost rises with every record captured.
