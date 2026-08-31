# Phase 6.2 — Customer Experience

Implementation-ready specifications for section 6.2 of `../NEXT_STAGE_NOTES.md`. New
documentation — no prior source document to correct against.

| Doc | Covers | Checklist item |
|---|---|---|
| [01_USER_JOURNEY.md](01_USER_JOURNEY.md) | Onboarding, task workflows, error states, WCAG 2.1 AA | User Journey Implementation |
| [02_SUPPORT_INTEGRATION.md](02_SUPPORT_INTEGRATION.md) | In-app help, knowledge base, tickets, impersonation, feedback | Customer Support Integration |

## Roadmap position

`BUSINESS_PRODUCT_PLANNING.md:695-702` places in-app help and guided onboarding in **Launch,
months 10–12** — near-term, unlike section 6.1 (`../analytics/`) which sits at months 13–24. The
two halves of Phase 6 are a year apart, which is why they are in separate folders.

## What makes this unusually well-grounded

`TENANT_ONBOARDING_FLOW.md:438-479` already contains measured onboarding and support data: 1.3
support tickets per new tenant, 45% of them setup help, 4.2-hour resolution, time-to-first-value
of 1.8 days, and five named abandonment points with percentages. Doc 01 is organised around those
five findings rather than a generic funnel.

The largest single opportunity is **data import** — simultaneously the top support topic, 35% of
onboarding effort, and the thing standing between signup and first value.

## Findings worth reading first

1. **Tenant branding can break WCAG conformance through configuration** (doc 01). Tenants supply
   brand colours; a pale primary produces unreadable text with no code change involved. Contrast
   is computed in `derivePalette` and validated at the config API (`frontend/01`).
2. **Generated forms are the highest-leverage accessibility surface** (doc 01). `DynamicForm`
   renders every form on the platform from `form_versions.schema`, so one generator fix corrects
   every tenant and every record type — and one defect breaks all of them.
3. **Support tickets are the easiest accidental PHI disclosure path** (doc 02). A helpful user
   attaches a screenshot of a patient record to a vendor system outside the audit trail.
   Screenshot upload is disabled; context is auto-attached as `request_id`, tenant, route pattern
   and record *type*; agents click through to the platform for the record itself.
4. **Impersonation must be a distinct session type** (doc 02). Implemented as a role swap, every
   audit row from an impersonated session attributes to the user — the trail then states something
   false, which is worse than a gap. `sessions.impersonated_by` keeps both parties recoverable.
5. **Error codes map to help articles** (doc 02). The system knows exactly why the user is stuck,
   so the `api/02` error catalogue doubles as the knowledge base backlog.

## Decisions taken

- **Support via a vendor under a BAA, with PHI actively kept out of tickets** — rather than
  building a helpdesk on the record model. In-app help, guided onboarding and the knowledge base
  are built in-product, where they need product context.
