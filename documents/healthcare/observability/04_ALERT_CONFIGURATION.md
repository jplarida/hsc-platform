# 04 — Alert Configuration

**Phase 5.2 deliverable** · Sources: `ENHANCEMENT_OPPORTUNITIES.md`, `infrastructure/07`, `database/08`
**Status:** Draft for review

Covers alert rules and thresholds, anomaly detection, routing and escalation, and alert fatigue
prevention.

---

## One severity scheme

`ENHANCEMENT_OPPORTUNITIES.md:338-360` defines P1–P4 with response times.
`infrastructure/07_COMPLIANCE_AUDIT_PROCEDURES.md` defines SEV1–SEV4 with containment targets,
tied to breach notification and evidence preservation. Two schemes in one organisation is a live
hazard: responders have to translate under pressure, and the translation is where the notification
clock gets missed.

**SEV1–SEV4 is authoritative.** P1–P4 is retained only as an alias for reading the older document.

| SEV | Alias | Definition | Response | Containment |
|---|---|---|---|---|
| SEV1 | P1 | Confirmed PHI exposure, cross-tenant access, total outage | Page, 24/7 | 1 hour |
| SEV2 | P2 | Suspected exposure, auth bypass, **audit logging failure**, major degradation | Page, 24/7 | 4 hours |
| SEV3 | P3 | Single-tenant impact, contained vulnerability, partial degradation | Business hours | 1 business day |
| SEV4 | P4 | Minor, trends, capacity planning | Ticket | Next sprint |

Two placements differ from the source and are deliberate. `ENHANCEMENT_OPPORTUNITIES.md:358` puts
"audit log gaps" under **Low priority**; it is SEV2 here, because per `RULE-HSC-02` a write that
skips the audit trail is a compliance defect and the system cannot be trusted to be recording
while it continues. And cross-tenant access is SEV1 **regardless of record count** — one record
read by the wrong tenant breaches the platform's central guarantee.

---

## Alerts must be per tenant

Every threshold in `ENHANCEMENT_OPPORTUNITIES.md` is platform-wide: "error rate > 5%",
"sync failures > 5%". On a multi-tenant platform those numbers are dominated by the largest
tenants, so:

- One tenant can be **100% broken** while the platform error rate sits at 0.5% and nothing fires.
- A single large tenant's traffic spike can breach a platform threshold while every tenant is fine.

Alerting is therefore two-tier:

```
Platform tier   — aggregate thresholds. Catches infrastructure failures.
Tenant tier     — per-tenant SLO burn. Catches "one customer is down".
```

The tenant tier cannot be CloudWatch metrics with a tenant dimension — doc 01 showed that costs
roughly $3,000/month at 500 tenants. It runs as a scheduled query over Embedded Metric Format
logs, evaluating each tenant's error rate and latency against the SLO, and emits a single
low-cardinality metric: `hsc.slo.tenants_breaching`. That metric is alarmed conventionally, and
the alert payload names the tenants.

```
hsc.slo.tenants_breaching{slo="api_availability"} = 3
  → SEV3 (or SEV2 if any breaching tenant is enterprise-tier)
  → payload lists tenant ids and their measured rates
```

Tier-weighted severity matters commercially: three trial tenants breaching is a Tuesday; one
enterprise tenant breaching is an escalation with a contractual dimension
(`03_BUSINESS_METRICS_DASHBOARDS.md`).

## Burn-rate alerting

Static thresholds over short windows — "error rate > 5% for 2 minutes" — are the source's model,
and they produce the two classic failures together: they fire on brief harmless spikes, and they
miss a slow burn that consumes the whole error budget over a day.

Multi-window, multi-burn-rate against the SLO instead:

| Burn rate | Long window | Short window | Budget consumed | Severity |
|---|---|---|---|---|
| 14.4× | 1 hour | 5 min | 2% in 1 h | SEV2, page |
| 6× | 6 hours | 30 min | 5% in 6 h | SEV2, page |
| 3× | 1 day | 2 hours | 10% in 1 day | SEV3, ticket |
| 1× | 3 days | 6 hours | 10% in 3 days | SEV4, ticket |

Both windows must be breaching for the alert to fire, which is what suppresses the spike: a
30-second outage breaches the 5-minute window but not the 1-hour one, so nobody is woken. A
sustained low-level failure breaches both and pages — which the source's model would never catch.

---

## Threshold catalogue

Consolidating `database/08`, `infrastructure/04` and this document, so there is one list rather
than three.

### Availability and correctness

| Alert | Condition | SEV |
|---|---|---|
| Health check failing | ≥ 2 targets unhealthy, 2 min | SEV1 |
| Error budget burn | 14.4× (see above) | SEV2 |
| Tenants breaching SLO | `tenants_breaching` > 0 for 15 min | SEV3 |
| Enterprise tenant breaching | Any, 5 min | SEV2 |
| **Audit write failures** | **≥ 1** | **SEV2** |
| Cross-tenant access detected | Any | SEV1 |
| Auth failure rate | > 5× baseline, 10 min | SEV2 |
| Sync conflict rate | > 3× baseline, 10 min | SEV3 |
| Sync escalation rate collapse | < 20% of baseline, 1 h | SEV3 |
| Webhook dead-letter | Any, or backlog > 10,000 | SEV3 |
| File scan queue depth | > 500 for 15 min | SEV3 |

**Sync escalation-rate collapse** is unusual and specific to the defects found in `frontend/05`:
if conflicts stop being escalated to users, either conflicts stopped happening or they are being
silently auto-resolved. The second is data loss and looks healthy on every other metric.

### Infrastructure

| Alert | Condition | SEV |
|---|---|---|
| Replication lag | > 30 s | SEV2 |
| DB connections | > 90% of max | SEV2 |
| PgBouncer `maxwait` | > 5 s | SEV2 |
| Idle in transaction | > 5 min | SEV3 |
| Free storage | < 10% | SEV1 |
| CPU | > 85%, 10 min | SEV3 |
| OOM kills | Any | SEV2 |
| Deadlocks | Rising, 15 min | SEV3 |
| Replication slot retention | > 20 GB | SEV2 |
| Certificate expiry | < 14 days | SEV2 |
| Backup failure | Any | SEV1 |
| Restore drill failure | Any | SEV2 |

Backup failure is SEV1 rather than SEV2: it is not affecting anyone right now, and it means the
recovery position is unknown, which is the state in which a second failure becomes unrecoverable.

### Security

| Alert | Condition | SEV |
|---|---|---|
| Refresh token reuse detected | Any (`api/01`) | SEV2 |
| Privilege escalation | Any role grant to admin outside change window | SEV2 |
| API key used from a new region | First occurrence | SEV3 |
| Bulk export | > 10,000 records by one user in 1 h | SEV2 |
| Failed logins, one account | > 20 in 15 min across IPs | SEV3 |
| WAF block spike | > 10× baseline | SEV3 |
| GuardDuty finding | High or Critical | SEV2 |

Bulk export is the insider-threat signal. It is also a legitimate operation, which is why it pages
rather than blocks — a human decides, and the audit trail (`database/04`) has the detail.

---

## Anomaly detection

Useful where a static threshold cannot work, and a noise generator where one can.

| Use it for | Do not use it for |
|---|---|
| Traffic volume (strong daily and weekly seasonality) | Error budget burn — the SLO is the threshold |
| Cost (`AWS Cost Anomaly Detection`) | Audit failures — one is too many |
| Per-tenant usage shifts (churn signal) | Security events with known-bad conditions |
| Latency baselines per route | Anything that already has a meaningful absolute limit |

Anomaly alerts are **SEV3 at most** and never page. They detect "unusual", not "broken", and
unusual is common: a tenant onboarding 50,000 records, a Monday after a holiday, a marketing
campaign. Paging on unusual is the fastest route to alert fatigue.

The models need a seasonality period — at least two weeks, ideally six — before their output means
anything. Enabling them on day one produces noise that teaches people to ignore the channel.

---

## Routing and escalation

| SEV | Primary | Escalation | Also notified |
|---|---|---|---|
| SEV1 | Page on-call | 5 min → secondary → 10 min → engineering lead → 15 min → CTO | Status page, `#incidents`, exec channel |
| SEV2 | Page on-call | 15 min → secondary → 30 min → lead | `#incidents` |
| SEV3 | Slack `#alerts`, ticket | 4 business hours → team lead | — |
| SEV4 | Ticket | Sprint planning | — |

Additional routing rules:

- **Security-classified alerts** also notify the security channel regardless of severity, and
  anything touching PHI notifies the privacy officer (`infrastructure/07`).
- **Tenant-specific SEV1/SEV2** notifies the account owner for enterprise tenants, so the customer
  hears from their contact rather than from a status page.
- **Business hours vs after hours** changes only SEV3: SEV1 and SEV2 page at any time by
  definition.
- **Every alert carries a runbook link.** An alert without one does not ship — enforced in the
  Terraform module (`infrastructure/04`), where the `runbook_url` field is required.

---

## Alert fatigue

`ENHANCEMENT_OPPORTUNITIES.md:395` names "alert fatigue prevention (grouping, suppression)" and
specifies nothing further. It is the difference between a paging system that works and one that
is muted.

| Technique | Implementation |
|---|---|
| **Actionability rule** | Every alert states what the responder should *do*. If the answer is "watch it", it is a dashboard panel, not an alert |
| Deduplication | Same alert, same resource → one incident, counter increments |
| Grouping | Alerts within 5 minutes on the same service group into one notification |
| Inhibition | A SEV1 outage suppresses the dozens of downstream SEV3s it causes |
| Maintenance windows | Deploys and planned work suppress non-security alerts for a bounded period |
| Auto-resolve | Alerts clear themselves when the condition clears; a manual-clear alert is always stale |
| Flapping detection | Three transitions in 15 minutes → one alert flagged flapping, not three pages |
| **Review cadence** | Monthly: every alert that fired, whether it was actionable, whether the runbook worked |

The monthly review is the mechanism that keeps the rest honest. Two numbers are tracked per alert
rule: how often it fired, and how often it resulted in an action. **A rule that fires more than
five times without action in a quarter is deleted or re-tuned** — not left in place "just in case",
because its real effect is to train responders to dismiss pages.

The target is that a page means something is genuinely wrong: fewer than two pages per on-call
shift, and above 90% of pages resulting in an action. If either drifts, the alerting is the
problem, not the responders.

---

## Corrections to `ENHANCEMENT_OPPORTUNITIES.md`

| # | Severity | Issue | Resolution |
|---|---|---|---|
| 1 | **High** | All thresholds are platform-wide; one tenant can be entirely broken while nothing fires | Two-tier alerting with per-tenant SLO burn via EMF queries |
| 2 | **High** | "Audit log gaps" classified as **Low priority**; per `RULE-HSC-02` it is a compliance defect | SEV2, pages, and stops writes per the runbook |
| 3 | **High** | Two severity schemes now exist across Phases 4 and 5 | SEV1–4 authoritative; P1–P4 retained as an alias |
| 4 | Medium | Static short-window thresholds both fire on harmless spikes and miss slow budget burn | Multi-window multi-burn-rate against SLOs |
| 5 | Medium | "Alert fatigue prevention (grouping, suppression)" named but unspecified | Full technique table plus a monthly review with a deletion rule |
| 6 | Medium | No runbook requirement, so a paged responder starts by working out what the alert means | `runbook_url` required in the alarm module |
| 7 | Medium | Anomaly detection listed with no scope; applied broadly it is a noise generator | Bounded to seasonal signals, SEV3 maximum, never pages |
| 8 | Low | No inhibition, so one outage produces dozens of downstream pages | Inhibition rules on dependency |
| 9 | Low | Escalation described as "15 min → manager → director" with no rotation behind it | Explicit routing table; rotation in doc 05 |

---

## Open questions

1. **On-call staffing.** SEV1 and SEV2 page 24/7. `infrastructure/07` already flags that the
   current team size may not support a rotation, and a documented response time nobody can meet
   is worse than an honest one.
2. **Enterprise tier weighting.** Escalating on a single enterprise tenant assumes the tier is
   known at alert time. It comes from `subscriptions`, which means the alerting path needs a way
   to look it up — likely a cached tier map rather than a query per evaluation.
3. **EMF query cost.** Per-tenant SLO evaluation runs Logs Insights on a schedule. Cheaper than
   metrics at high tenant counts, not free, and the cost scales with log volume rather than tenant
   count.
4. **Baseline windows.** Several alerts compare against "baseline" without defining it. A 7-day
   trailing median by hour-of-week is the usual choice and needs stating so the alerts are
   reproducible.
5. **Status page automation.** Whether SEV1 auto-posts to a public status page or waits for a
   human is a communications decision (doc 05) with a compliance edge — an automated post naming
   a symptom could imply a breach before one is confirmed.
