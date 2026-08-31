# Phase 4 — Infrastructure & DevOps

Implementation-ready specifications for the section of `../NEXT_STAGE_NOTES.md` titled
"Phase 4: Infrastructure & DevOps Breakdowns". Docs 01–04 cover §4.1 (CI/CD pipeline); 05–07
cover §4.2 (security implementation).

| Doc | Covers | Checklist item |
|---|---|---|
| [01_BUILD_PIPELINE.md](01_BUILD_PIPELINE.md) | Corrected CI workflow, Dockerfile, artifacts and versioning | Build Pipeline Specifications |
| [02_TESTING_AUTOMATION.md](02_TESTING_AUTOMATION.md) | Test pyramid, isolation/audit/sync suites, environments, gates | Testing Automation Framework |
| [03_DEPLOYMENT_STRATEGIES.md](03_DEPLOYMENT_STRATEGIES.md) | Blue-green, canary with metric gates, migrations, rollback | Deployment Strategies |
| [04_INFRASTRUCTURE_AS_CODE.md](04_INFRASTRUCTURE_AS_CODE.md) | Terraform structure and state, secrets and rotation, alarms as code | Infrastructure as Code |
| [05_AUTHENTICATION_SEQUENCES.md](05_AUTHENTICATION_SEQUENCES.md) | Login/MFA, password reset, lockout, SAML and OIDC, step-up | Authentication Sequence Diagrams |
| [06_ENCRYPTION_IMPLEMENTATION.md](06_ENCRYPTION_IMPLEMENTATION.md) | At rest, in transit, per-tenant keys, field encryption, masking | Data Encryption Implementation |
| [07_COMPLIANCE_AUDIT_PROCEDURES.md](07_COMPLIANCE_AUDIT_PROCEDURES.md) | HIPAA validation, breach notification, SOC 2, vulnerability management | Compliance Audit Procedures |

## Open decision: ECS or Kubernetes

**Doc 03 documents both paths rather than choosing, at your direction — and this blocks the
`compute/` module in doc 04.**

`CICD_PIPELINE.md` specifies both, in the same file: the deploy job at lines 435-455 uses
`kubectl set image deployment/allguds-api --namespace=…`, while the Terraform component list at
line 522 says "ECS Fargate clusters". `ARCHITECTURE_DESIGN.md` and `TECH_STACK_PLAN.md` both say
ECS/Fargate.

Doc 03 specifies deployment behaviour platform-independently, then gives concrete ECS and
Kubernetes paths, so the decision can be made without redesigning. On the documented constraints —
small team, `$50–100/month` starting point, AWS-committed for the BAA — ECS is the better fit and
is what three of the four references already assume.

## Findings worth reading first

1. **Breach notification is entirely absent** (doc 07). The incident response workflow ends at
   "Post-Incident Review". As a Business Associate the platform owes covered entities notice
   within 60 days of *discovery*, with HHS and media obligations above 500 individuals — and
   individual BAAs often impose 24 or 72 hours, which governs. Evidence preservation is also
   missing: containment as the first action destroys forensics and can be spoliation.
2. **Encrypted MRN and the MRN index cannot both exist as designed** (doc 06).
   `SECURITY_ARCHITECTURE.md` specifies AES-GCM with a unique IV for medical record numbers, which
   is non-deterministic; `database/03` defines a unique index on `gc_mrn` and `database/06` lists
   MRN lookup as a hot query path. Resolved with a per-tenant HMAC blind index alongside the
   ciphertext.
3. **Static AWS credentials and four runtime bugs in the workflows** (docs 01, 03). Long-lived
   access keys and a base64 kubeconfig in repository secrets; `export KUBECONFIG` that does not
   survive to the next step; `env` referenced across a `workflow_call` boundary that does not
   inherit it; Trivy scanning a tag that was never pushed; and smoke tests run without `npm ci`.
4. **PostgreSQL has no TDE** (doc 06). "TDE Enabled" describes a control that does not exist —
   RDS provides KMS-backed storage encryption, which protects media and snapshots but nothing
   against a valid database connection.
5. **Certificate pinning plus ACM auto-renewal** (doc 06) breaks the app on rotation, and a
   pinned app that cannot reach the API cannot receive a live update to fix itself.
6. **No tenant-isolation, pooling-leak or audit-completeness tests** (doc 02) — the three failure
   classes that are invisible in ordinary testing and are exactly where this platform's
   guarantees live.

## Decisions taken

- **Document both deployment platforms**, ECS recommended, decision deferred.
- **Per-tenant keys by derivation**, as `SECURITY_ARCHITECTURE.md` specifies — implemented via KMS
  `GenerateDataKey` with `tenant_id` as encryption context, so the master never leaves KMS and a
  wrong-tenant decrypt is refused by the key service rather than by application logic.
- **Doc 05 is a complete standalone set**, restating login and MFA alongside the new flows. To
  stop it drifting from `api/01`: that document is normative for request/response shapes and error
  codes, this one for security decisions and control points; contract tests assert the former.

## Conventions

- Diagrams are Mermaid, matching `../database/`, `../api/` and `../frontend/`.
- Each doc carries: specification → corrections → open questions.
- Several open questions are organizational rather than technical and need owners: the named
  HIPAA Security Officer (07), the breach-notice term offered to tenants (07), escrow custody
  (06), and break-glass access (04).
