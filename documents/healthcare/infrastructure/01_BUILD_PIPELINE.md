# 01 — Build Pipeline Specifications

**Phase 4.1 deliverable** · Sources: `CICD_PIPELINE.md`, `TECH_STACK_PLAN.md`, `frontend/README.md`
**Status:** Draft for review

Covers the CI workflow, containerization, build optimization, and artifact storage and
versioning.

---

## Corrections to the documented workflow

`CICD_PIPELINE.md:147-390` gives a `ci.yml`. Several things in it do not work as written.

| # | Issue | Effect |
|---|---|---|
| 1 | ASCII box-art banners (`┌──┐`, `│ SETUP JOB │`) sit inside the `jobs:` mapping | The file does not parse as YAML |
| 2 | No `permissions:` block | CodeQL needs `security-events: write`, GHCR push needs `packages: write`; relies on repo-wide defaults |
| 3 | No `concurrency:` group | Superseded pushes keep running, wasting minutes and racing on deploys |
| 4 | `PYTHON_VERSION: '3.9'`, CodeQL `languages: javascript, python` | No Python in the stack; the Python analysis finds nothing and adds minutes |
| 5 | Trivy scans `IMAGE_NAME:${{ github.sha }}` | `metadata-action` emits `type=sha,prefix={{branch}}-`, so the pushed tag is `main-abc1234`. The scanned reference was never pushed |
| 6 | `build-args: BUILD_DATE=${{ steps.meta.outputs.created }}` | `metadata-action` has no `created` output; the arg is empty |
| 7 | "Upload security scan results" expects `snyk-results.json`, `codeql-results.sarif`, `semgrep-results.json` | None of those actions write those files as configured; the upload finds nothing |
| 8 | `matrix: [unit, integration, e2e]` shares one job definition | E2E needs the app running and a browser, not just Postgres and Redis |
| 9 | Long-lived `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Permanent credentials held by a third party, with no rotation (doc 04) |

Point 9 is the one that matters most. Everything else is a bug; that one is a standing risk for a
HIPAA workload.

---

## Corrected CI workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
  workflow_dispatch:

# Least privilege by default; jobs widen only what they need.
permissions:
  contents: read

# A newer push to the same ref cancels the older run — except on main, where
# every commit must produce an artifact.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

env:
  NODE_VERSION: '20.x'
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      api: ${{ steps.filter.outputs.api }}
      web: ${{ steps.filter.outputs.web }}
      mobile: ${{ steps.filter.outputs.mobile }}
      infra: ${{ steps.filter.outputs.infra }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            api:    ['apps/api/**', 'packages/**', 'prisma/**']
            web:    ['apps/web/**', 'packages/**']
            mobile: ['apps/mobile/**', 'packages/**']
            infra:  ['infra/**']

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run type-check          # tsc -b, matching the Jenkins gate
      - run: npx spectral lint documents/healthcare/api/openapi.yaml

  security:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write             # required to upload SARIF
    steps:
      - uses: actions/checkout@v4

      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript

      - uses: github/codeql-action/analyze@v3

      - name: Dependency review
        if: github.event_name == 'pull_request'
        uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: high

      - name: Semgrep
        run: semgrep ci --sarif --output semgrep.sarif
        env:
          SEMGREP_RULES: p/security-audit p/secrets p/owasp-top-ten
        continue-on-error: true          # upload the findings even on failure

      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: semgrep.sarif

      - name: Secret scan (full history)
        uses: gitleaks/gitleaks-action@v2

  test:
    needs: changes
    if: needs.changes.outputs.api == 'true' || needs.changes.outputs.web == 'true'
    uses: ./.github/workflows/test.yml    # doc 02
    secrets: inherit

  build:
    needs: [lint, security, test]
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write                     # GHCR push
      id-token: write                     # cosign keyless signing
    outputs:
      image: ${{ steps.meta.outputs.tags }}
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,format=long
            type=ref,event=branch
            type=raw,value=latest,enable={{is_default_branch}}

      - id: push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile
          target: production
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: true
          sbom: true
          build-args: |
            BUILD_DATE=${{ fromJSON(steps.meta.outputs.json).labels['org.opencontainers.image.created'] }}
            VCS_REF=${{ github.sha }}

      # Scan by digest — immutable and guaranteed to be what was pushed.
      - name: Trivy
        uses: aquasecurity/trivy-action@0.24.0
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.push.outputs.digest }}
          format: sarif
          output: trivy.sarif
          severity: CRITICAL,HIGH
          exit-code: '1'

      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy.sarif

      - name: Sign image
        run: cosign sign --yes ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.push.outputs.digest }}
```

Four changes worth calling out:

**Scan and deploy by digest, never by tag.** A tag is mutable; a digest is the image that was
built. Correction 5 exists because the scan referenced a tag that was never pushed — scanning by
`${{ steps.push.outputs.digest }}` makes that class of mistake impossible, and the digest is what
gets deployed in doc 03.

**`exit-code: '1'` on Trivy.** As documented, Trivy uploads results and passes regardless, so a
critical CVE in the base image ships. The gate has to fail.

**`paths-filter` for a monorepo.** Phase 3 established `apps/*` and `packages/*`; running the full
matrix for a change to `apps/mobile` alone wastes most of the run. A change under `packages/**`
correctly triggers everything.

**Signing and provenance.** `cosign sign` plus `provenance: true` and `sbom: true` produce a
signed, attested artifact. Deployment verifies the signature (doc 03), which is what stops a
registry compromise turning into a production compromise.

---

## Containerization

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
WORKDIR /app

# ---- deps: cached on lockfile alone, so source edits don't reinstall ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/*/package.json packages/
RUN --mount=type=cache,target=/root/.npm npm ci

# ---- build ----
FROM deps AS build
COPY . .
RUN npm run build --workspace=apps/api
RUN npx prisma generate
# Drop dev dependencies from what will be copied forward.
RUN npm prune --omit=dev

# ---- production ----
FROM node:20-bookworm-slim AS production
ENV NODE_ENV=production
# Unprivileged, and no shell for the app user.
RUN groupadd -r app && useradd -r -g app -s /usr/sbin/nologin app
WORKDIR /app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/apps/api/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma

USER app
EXPOSE 3000

# Distinct from readiness: liveness must not fail because a dependency is slow,
# or Kubernetes/ECS will restart a healthy container during a database blip.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
```

| Decision | Reason |
|---|---|
| `-slim`, not Alpine | musl vs glibc differences bite with native modules and cause timezone and DNS surprises |
| Non-root with `nologin` | Container escape via the app user gets no shell |
| `npm prune --omit=dev` before copy | Dev dependencies are most of the CVE surface in a Node image |
| Cache mount on `/root/.npm` | Rebuilds skip the registry entirely |
| Separate `/health/live` and `/health/ready` | Liveness checks the process; readiness checks dependencies. Conflating them causes restart loops during a database failover |
| No secrets in build args | Build args are visible in image history |

Three endpoints, three meanings: `/health/live` (process is up), `/health/ready` (database, Redis
and migrations are good — the load balancer target), `/health/startup` (long first-boot work).

---

## Artifacts and versioning

| Artifact | Store | Retention | Immutable |
|---|---|---|---|
| Container images | GHCR, by digest | 90 days untagged; releases forever | Yes |
| SBOM (CycloneDX) | Attached to image | With the image | Yes |
| Provenance attestation | Attached to image | With the image | Yes |
| Test results, coverage | Actions artifacts | 30 days | No |
| SARIF findings | GitHub Security tab | 90 days | No |
| Terraform plans | S3, versioned | 1 year | Yes |
| Mobile builds | TestFlight / Play internal | Per store policy | Yes |

Version numbering is `MAJOR.MINOR.PATCH` from Conventional Commits, with the git SHA as the
build identity. The **digest** is the deployment identity — a rollback targets a digest, so it
cannot be ambiguous about which build it means.

Release tags stay forever because a HIPAA audit can ask what was running on a given date, and
"the image was garbage-collected" is not an answer. Untagged intermediate images expire at 90
days.

## Mobile build lane

Separate workflow, different constraints (`frontend/07_CROSS_PLATFORM.md`): macOS runners for
iOS, signing certificates in a secure store rather than repository secrets, and version codes
that increment monotonically. It runs on release branches only — a macOS runner costs ten times
a Linux one, and running it per PR is the fastest way to exhaust an Actions budget.

---

## Open questions

1. **Runner choice.** GitHub-hosted runners are simplest. A HIPAA review may require self-hosted
   runners in a controlled network, since build logs and source touch third-party infrastructure.
   That decision changes cost and maintenance substantially, and should be made before the
   pipeline is depended on.
2. **Registry.** GHCR is used above, following `CICD_PIPELINE.md`. Deploying to AWS argues for ECR
   — same trust boundary as the workload, no cross-cloud pull credentials, and image scanning
   included. Worth revisiting alongside doc 04.
3. **Monorepo tooling.** `paths-filter` handles change detection. Turborepo or Nx would give
   proper task graphs and remote caching, which matters once CI exceeds ~10 minutes.
4. **Signature verification enforcement.** Images are signed. Whether deployment *refuses*
   unsigned images is an admission-control decision that belongs with doc 03, and is only a real
   control once enforced.
5. **Base image update cadence.** `node:20-bookworm-slim` accumulates CVEs. A weekly automated
   rebuild-and-redeploy of unchanged code keeps the base current, but means deployments with no
   code change — which needs to be acceptable to the release process.
