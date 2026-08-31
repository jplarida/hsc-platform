# Phase 3 — Frontend & Mobile App

Implementation-ready specifications for the section of `../NEXT_STAGE_NOTES.md` titled
"Phase 3: Frontend & Mobile App Breakdowns". Docs 01–04 cover §3.1 (web application
architecture); 05–07 cover §3.2 (mobile deep dive).

| Doc | Covers | Checklist item |
|---|---|---|
| [01_COMPONENT_ARCHITECTURE.md](01_COMPONENT_ARCHITECTURE.md) | Monorepo layout, hierarchy, shared library, theming, breakpoints | Component Architecture Diagrams |
| [02_STATE_MANAGEMENT.md](02_STATE_MANAGEMENT.md) | Zustand stores, ownership matrix, middleware, persistence, hydration | State Management Implementation |
| [03_ROUTING_NAVIGATION.md](03_ROUTING_NAVIGATION.md) | Route table, guards, deep linking, mobile navigation | Routing & Navigation Flows |
| [04_PERFORMANCE_OPTIMIZATION.md](04_PERFORMANCE_OPTIMIZATION.md) | Budgets, code splitting, assets, PWA/service worker, list rendering | Performance Optimization |
| [05_OFFLINE_FIRST_ARCHITECTURE.md](05_OFFLINE_FIRST_ARCHITECTURE.md) | Local database and adapter, encryption, sync protocol, conflicts, queue | Offline-First Architecture |
| [06_NATIVE_FEATURE_INTEGRATION.md](06_NATIVE_FEATURE_INTEGRATION.md) | Push, camera, biometrics, background sync, lifecycle privacy | Native Feature Integration |
| [07_CROSS_PLATFORM.md](07_CROSS_PLATFORM.md) | Platform abstraction, store deployment, live updates, testing matrix | Cross-Platform Considerations |

## The framework contradiction

The two mobile source documents describe **different frameworks**, and resolving that shapes most
of this phase.

`MOBILE_STATE_MANAGEMENT.md:77-78` specifies `AsyncStorage (React Native)` and `SecureStore (Expo)`
as persistence layers, referencing AsyncStorage again in both data-flow diagrams.
`MOBILE_UI_FRAMEWORK.md` renders into `IonApp`, and `TECH_STACK_PLAN.md` explicitly selects
**React + Ionic + Capacitor** — as does the recorded invariant `RULE-HSC-01`.

Capacitor has neither API. These documents treat Capacitor as correct and mark the React Native
references as corrections: `@capacitor/preferences` for durable values, Keychain/Keystore for
secrets, both behind interfaces in `packages/platform`.

The knock-on is doc 05. WatermelonDB's SQLite adapter also targets React Native, so the local
database runs through a **custom adapter over `@capacitor-community/sqlite`** — keeping
WatermelonDB's models, observable queries and sync engine while replacing the storage layer. That
adapter is the single largest technical risk in this phase and should be spiked before the rest
of the mobile app assumes it works.

## Findings worth reading first

1. **Sync conflict resolution has three defects that lose data silently** (doc 05).
   Last-write-wins compares a server timestamp against a *device* timestamp, so a device with a
   fast clock wins every conflict forever. Field-level merge reads per-field timestamps that
   neither schema stores, so it cannot run as written — and its loop only assigns fields that
   differ, dropping every unchanged field from the merged record. Separately, "medical data:
   always prefer server" discards a clinician's offline work with no indication.
2. **Navigation state is duplicated in a Zustand store** (docs 02, 03). `currentScreen` and
   `navigationHistory` drift from the router on any navigation the store does not intercept, and
   break browser back, deep links and the PWA — which is a stated reason for choosing Ionic.
3. **Persisted state has no tenant or user scoping** (doc 02). On a shared clinical tablet, the
   next user rehydrates the previous tenant's cached config, drafts and records. Row-level
   security cannot see this, because nothing reaches the database.
4. **The default PWA service-worker recipe caches API responses** (doc 04) into unencrypted Cache
   Storage that survives logout. Offline data belongs in encrypted SQLite; the service worker
   caches the shell only.
5. **Notification payloads and photo EXIF** (doc 06). Lock-screen notifications and GPS
   coordinates embedded in clinical photographs are both PHI leaving the audit trail.

## Decisions taken

- **Monorepo with shared packages** — `apps/web`, `apps/mobile`, `packages/{ui,core,api,config,platform}`.
  Ionic React runs in both targets, so the shared surface is large.
- **WatermelonDB retained**, backed by `@capacitor-community/sqlite` through a custom adapter.
- **Zustand** for client state (settled by `MOBILE_STATE_MANAGEMENT.md:107`), with no
  general-purpose server-query cache — reads come from observable local queries instead. This is
  the largest divergence from the source and is flagged as an open question in doc 02.

## Conventions

- Diagrams are Mermaid, matching `../database/` and `../api/`.
- Each doc carries: architecture → specification → corrections → open questions.
- Open questions are genuine decisions. Several need clinical or compliance input rather than an
  engineering answer — selective sync scope (05), background lock timeout (06), and whether
  offline PHI reads must be audited (03, 05).
