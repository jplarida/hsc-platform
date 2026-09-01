# Phase 8 — Integration & Partnership Ecosystem

Implementation-ready specifications for the section of `../NEXT_STAGE_NOTES.md` titled
"Phase 8: Integration & Partnership Ecosystem".

| Doc | Covers | Checklist item |
|---|---|---|
| [01_PARTNER_PROGRAM.md](01_PARTNER_PROGRAM.md) | Partner and app identity, registration and versioning, credentials, partner portal, docs generation, per-app analytics, sandbox | API Partner Program Implementation |
| [02_APP_AUTHORIZATION_AND_ISOLATION.md](02_APP_AUTHORIZATION_AND_ISOLATION.md) | OAuth authorization server, scope catalogue, consent and install lifecycle, tokens, isolation, rate budgets, audit attribution | Marketplace Integration Development — sandboxing and security isolation |
| [03_MARKETPLACE_AND_REVENUE.md](03_MARKETPLACE_AND_REVENUE.md) | Listings, the two install paths, certification tiers and the BAA chain, conformance testing, revenue share and payouts | Marketplace Integration Development · Revenue sharing and billing |

## Scope decisions taken before writing

Three decisions fork this phase, and all three were settled at the outset.

**Tiered PHI access.** Non-PHI apps install self-serve. PHI-capable apps require an executed BAA
between the platform and the vendor, plus a deeper certification review. The `.nonphi` / `.phi`
split in the scope catalogue (doc 02) is what makes that enforceable rather than advisory, and it
reads `record_type_definitions.is_phi` — the same field `api/04` uses for webhook payloads, so
there is one definition of PHI rather than two that drift.

**Apps are API-only, server-to-server.** No third-party code renders inside the platform's clients,
so isolation means scope confinement, tenant confinement, rate budgets and egress accountability
rather than browser sandboxing. Doc 02 closes with what must not be precluded if embedded UI is
added later.

**Both billing models, chosen per listing.** `platform_billed` puts app charges on the tenant's
existing invoice and pays the vendor through Stripe Connect; `vendor_billed` leaves app revenue
alone and takes a referral fee. Only the first involves the platform moving money, and only the
first needs a payout ledger.

## Three documents, and what was already covered

Roughly half of Phase 8's eight sub-bullets had a home already, so the docs point rather than
restate — the approach doc 02 of Phase 7 established.

| Sub-bullet | Already specified | Where |
|---|---|---|
| Partner API documentation generation | Spec-first OpenAPI, codegen, publishing | `api/05` — doc 01 adds the partner filter only |
| API key management | Key format, hashing, scoping, rotation with overlap | `api/01` — doc 01 adds a second credential shape for a non-tenant identity |
| Integration testing automation | Test pyramid, contract tests, mock server, test data | `infrastructure/02` — doc 03 adds the partner conformance suite |
| Billing integration | Plans, subscriptions, invoices, payment methods | `database/01` — doc 03 adds charges and payouts |

Genuinely greenfield: partner and app identity, the authorization server, consent, the isolation
model, listings, certification, and everything to do with money moving outward.

## What did not exist and had to be built

**The platform was never an OAuth authorization server.** It is a resource server (`api/01`) and an
OAuth client (`api/04`), and both of those documents defer the third role to Phase 8 in their own
open questions, independently. That is the substance of the phase: a marketplace without per-app
tokens and per-tenant consent is just tenant API keys with a directory in front.

## Findings worth reading first

1. **An installed app spends the tenant's rate-limit budget** (doc 02). `api/03` derives limits per
   tenant from the plan, so one badly-written app starves the tenant's own users — and the tenant
   blames the platform, correctly, since the platform certified the app. Per-installation windows,
   capped at 25% of the tenant budget.
2. **App-authenticated writes have no actor** (doc 02). `api/01` already notes key writes leave
   `changed_by` null; with twelve installed apps there is also no way to tell which one acted. That
   is an incomplete HIPAA accounting of disclosures — the same defect shape as the
   `sessions.impersonated_by` finding in `experience/02`. `app_id` and `installation_id` on both
   audit tables.
3. **App tokens must be opaque, not JWTs** (doc 02). Uninstall means *stop having my data now*, and
   a self-contained token stays valid until it expires. A JWT design either accepts a window in
   which a revoked app still reads PHI, or adds a per-request revocation check and pays the lookup
   cost anyway.
4. **The vendor breach flow-down must be far shorter than the platform's own obligation** (doc 03).
   `infrastructure/07` puts the platform at 60 days from discovery, often 24–72 hours by contract.
   A vendor BAA that mirrors 60 days back guarantees the platform misses its own deadline in every
   case. Five days, with the clock running from the vendor's discovery.
5. **A partner is not a tenant, and an app is not an API key** (doc 01). Both shortcuts are
   tempting and both fail on RLS: reusing `tenants` requires punching a hole in tenant isolation so
   partner staff can see installs across tenants, and reusing `api_keys` limits an app to one
   tenant because `tenant_id` is `NOT NULL`. Global catalogue tables plus a second database role
   with its own policy.
6. **Isolation stops at the wire** (doc 02). Apps run on the vendor's infrastructure; once data
   arrives there, no scope or budget constrains it. The BAA, certification and audit trail govern
   the far side, and saying so plainly matters more than a "sandboxing" section that implies
   otherwise.
7. **Money idempotency cannot live in Redis** (doc 03). `api/02` OQ5 raised this for billing
   generally; for payouts a flush means a second transfer of real funds. Unique columns, not TTLs.

## Dependencies

Four Phase 1 additions are needed before any of this can be built:

| Addition | Table | Blocks |
|---|---|---|
| `apps:install` permission, granted to admin roles | `permissions` (`database/02`) | Install flow — without it any user can authorize an external disclosure |
| `app_id` / `installation_id` columns | `user_audit_log`, `data_audit_log` (`database/04`) | Disclosure accounting, from the first install |
| Invoice line items | `invoices` (`database/01`) | `platform_billed` listings |
| `partner_sandbox` plan seed row | `plans` (`database/01`) | Partner onboarding |

Two open decisions from earlier phases also reach into Phase 8. The **vertical question** (clinical
healthcare vs workplace health and safety) determines whether the PHI tier is the common case or
the exception. The **named HIPAA Security Officer** decision from `infrastructure/07` is the
counterpart to requiring one from every tier-2 vendor.
