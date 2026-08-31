# Phase 2.1 — API & Integration Architecture

Implementation-ready specifications for the section of `../NEXT_STAGE_NOTES.md` titled
"Phase 2: API & Integration Architecture Breakdowns". Docs 01–04 are the granular flow diagrams;
05–06 are the implementation specifications listed under the same section.

| Doc | Covers | Checklist item |
|---|---|---|
| [01_AUTH_AUTHORIZATION_FLOWS.md](01_AUTH_AUTHORIZATION_FLOWS.md) | Login, JWT lifecycle, refresh rotation, RBAC path, API keys | Authentication & Authorization Flows |
| [02_ENDPOINT_SPECIFICATIONS.md](02_ENDPOINT_SPECIFICATIONS.md) | URL structure, endpoint catalogue, pagination, concurrency, errors, versioning | Endpoint Specification Diagrams |
| [03_RATE_LIMITING_THROTTLING.md](03_RATE_LIMITING_THROTTLING.md) | Limiting algorithms, tier quotas, headers, circuit breaking | Rate Limiting & Throttling |
| [04_INTEGRATION_WEBHOOK_FLOWS.md](04_INTEGRATION_WEBHOOK_FLOWS.md) | Webhook delivery and retry, signing, outbound OAuth, SDKs | Third-Party Integration Flows |
| [05_OPENAPI_SPECIFICATION.md](05_OPENAPI_SPECIFICATION.md) + [openapi.yaml](openapi.yaml) | The spec file, plus conventions, codegen, linting, contract tests | OpenAPI/Swagger Documentation |
| [06_MIDDLEWARE_ARCHITECTURE.md](06_MIDDLEWARE_ARCHITECTURE.md) | Request pipeline, tenant context, PHI logging, caching, errors | Middleware Architecture |

`openapi.yaml` is OpenAPI 3.1.0 — 13 paths, 17 schemas, validated to parse with every `$ref`
resolving. It covers the representative surface that pins each cross-cutting convention; roughly
25 further endpoints from doc 02 remain to be added.

## Relationship to `API_ARCHITECTURE.md`

`../API_ARCHITECTURE.md` remains the origin of the endpoint inventory, rate-limit tiers, status
codes and error envelope, all of which are carried forward. Each doc here ends with a
*Corrections to `API_ARCHITECTURE.md`* table.

The three findings worth reading before any implementation starts:

1. **Tenant resolution precedes authentication** (docs 01, 06). The documented pipeline resolves
   the tenant from `X-Tenant-ID` or the subdomain at stage 2 and validates the token at stage 3.
   A user with a valid token for tenant A can then set the header to tenant B, and row-level
   security will faithfully enforce the attacker's choice. The JWT claim must be the only
   authoritative source.
2. **The rate limiter is off by one, records denied requests, and is non-atomic** (doc 03).
   Every tier permits `limit + 1`; a throttled client extends its own block; concurrent API tasks
   both admit requests that should be refused. Corrected Lua scripts are given. Separately, the
   sliding-window-log algorithm needs roughly 90 MB of Redis per enterprise tenant per hour and
   cannot serve the documented tiers.
3. **Webhook payloads and PHI** (doc 04). Webhooks are unauthenticated POSTs to tenant-supplied
   URLs, outside the audit trail and retention policy. Payloads carry identifiers only; receivers
   authenticate back to fetch content. Tenant-supplied URLs also need SSRF egress controls.

## Dependencies on Phase 1

These documents assume the corrected schema in [`../database/`](../database/README.md), and add
four tables that Phase 1 does not define: `api_keys` and `api_key_scopes` (doc 01), `webhooks`,
`webhook_deliveries` and `integration_connections` (doc 04). Each is specified with its RLS
policy in the doc that introduces it.

Two Phase 1 decisions shape the API directly: the hybrid record model produces the canonical
`/records` route plus per-tenant projected aliases (doc 02), and the transaction-scoped tenant
GUC required by connection pooling becomes the single `withTenantContext` wrapper (doc 06).

## Conventions

- Diagrams are Mermaid, matching `../database/`.
- Each doc carries: flows → specification → corrections → open questions.
- Open questions are genuine decisions. Several need security sign-off rather than an
  engineering answer — token signing algorithm (01), fail-open vs fail-closed on a Redis outage
  (03, 06), and PHI opt-in for webhook payloads (04).
