# Phase 5 — Monitoring & Observability

Implementation-ready specifications for the section of `../NEXT_STAGE_NOTES.md` titled
"Phase 5: Monitoring & Observability Breakdowns". Docs 01–03 cover §5.1 (monitoring
implementation); 04–05 cover §5.2 (alerting and incident response).

| Doc | Covers | Checklist item |
|---|---|---|
| [01_APM_INSTRUMENTATION.md](01_APM_INSTRUMENTATION.md) | OpenTelemetry setup, custom metrics, tracing, error tracking | Application Performance Monitoring |
| [02_INFRASTRUCTURE_MONITORING.md](02_INFRASTRUCTURE_MONITORING.md) | Compute, database, PgBouncer, network, synthetics, logs, cost | Infrastructure Monitoring |
| [03_BUSINESS_METRICS_DASHBOARDS.md](03_BUSINESS_METRICS_DASHBOARDS.md) | Metric definitions, SLIs/SLOs, revenue and churn, four dashboards | Business Metrics Dashboards |
| [04_ALERT_CONFIGURATION.md](04_ALERT_CONFIGURATION.md) | Severity, per-tenant alerting, burn rates, routing, fatigue | Alert Configuration Specifications |
| [05_INCIDENT_RESPONSE_OPERATIONS.md](05_INCIDENT_RESPONSE_OPERATIONS.md) | On-call, roles, communications, post-incident review | Incident Response Workflows |

## Findings worth reading first

1. **The monitoring stack as described would send PHI to observability vendors** (doc 01).
   Application logs carry "Context", error logs carry "Context • User info", and destinations
   include ELK and Datadog. On this platform a record title is a patient name and a URL path is a
   patient identifier. Resolved with an allowlist at the collector — never a denylist — plus a CI
   canary test. Session replay is not deployed at all: it records the rendered clinical screen.
2. **ALB access logs record full request URIs** (doc 02), which for `/v1/records/patient/6f1c…`
   is a patient identifier in a 90-day log group.
3. **Every alert threshold in the source is platform-wide** (doc 04). One tenant can be entirely
   broken while the aggregate error rate sits at 0.5% and nothing fires. Resolved with two-tier
   alerting: aggregate thresholds for infrastructure, per-tenant SLO burn for customer impact.
4. **"Audit log gaps" is classified Low priority** in `ENHANCEMENT_OPPORTUNITIES.md:358`. Per
   `RULE-HSC-02` a write that skips the audit trail is a compliance defect; it is SEV2 here and
   the runbook stops writes.
5. **No SLOs or error budgets exist** (doc 03), though "SLA compliance status" is a listed
   dashboard element and no SLA is defined anywhere in the project.
6. **A tenant dimension on CloudWatch metrics costs roughly $3,000/month at 500 tenants** (doc 01)
   and is the obvious implementation. Split into low-cardinality metrics for alerting and Embedded
   Metric Format logs for per-tenant queries.
7. **PgBouncer is unmonitored** (doc 02) despite sitting on the request path, so pool exhaustion
   and database slowness are indistinguishable from the application's point of view.

## Decisions taken

- **AWS-native stack** — ADOT Collector into CloudWatch Logs and Metrics and X-Ray, with Managed
  Grafana for dashboards. One BAA, one boundary, no PHI leaving the account. `ELK`, `Datadog`,
  `Prometheus`, `Jaeger` and `Zipkin` from the source are not used.
- **SEV1–SEV4 is the single severity scheme**, adopted from `infrastructure/07` because it is
  already tied to breach notification, evidence preservation and the deployment gates. The
  source's P1–P4 is retained as an alias table only.
- **Doc 05 covers operational depth and cross-references** `infrastructure/07` for severity,
  notification deadlines, evidence preservation and technical runbooks — so the notification
  clock has exactly one documented home.

## Relationship to Phase 4

There is deliberate overlap and a clear split:

| Concern | Home |
|---|---|
| Severity definitions, breach notification, evidence preservation | `infrastructure/07` |
| Technical runbooks | `infrastructure/07` |
| Alarms as Terraform, thresholds encoded | `infrastructure/04` |
| Database signal catalogue | `database/08` |
| What to instrument and how; PHI redaction | `observability/01` |
| Which alerts exist, at what threshold, routed where | `observability/04` |
| On-call, roles, comms, post-incident review | `observability/05` |

## Conventions

- Diagrams are Mermaid, matching the other folders.
- Each doc carries: specification → corrections → open questions.
- Several open questions are organizational: on-call rotation viability (04, 05), what SLA to
  offer (03), and per-tenant cost allocation model (02).
