# Implementation and release status

Snapshot: 2026-08-30, local version 0.1.1. Extension ID `tab-leak-guard@local.invalid` is preserved. Automatic recovery is compile-time quarantined; 0.1.1 is notify/manual only. The final local repository, coverage, package, dependency, reproducibility, and headless-load evidence is recorded in [`docs/evidence/0.1.1-local-validation.md`](./evidence/0.1.1-local-validation.md).

Status meanings:

- **Implemented + automated coverage** — repository code and relevant deterministic tests/checks exist. The label does not assert that the final release-gate run has been recorded.
- **Implemented; validation pending** — code exists, but required Firefox, accessibility, performance, beta, or update-channel evidence is external/manual.
- **Partial** — useful foundation exists, but the plan’s complete acceptance criteria are not met.
- **Quarantined/deferred** — intentionally unavailable until explicit gates pass.

No “implemented” label claims AMO approval, signed delivery, cross-platform correctness, beta performance, false-positive targets, or public production readiness.

## A — recovery safety

| Ticket | Status | Evidence / remaining gate |
|---|---|---|
| TLG-SAF-001 quarantine automatic recovery | Implemented + automated coverage | Compile-time false constant, version check, safe migration/default; signed pending-alarm upgrade rehearsal pending |
| TLG-SAF-002 master-off transaction | Implemented + automated coverage | Epoch invalidation/cancellation integration tests; real Firefox pause/revoke timing pending |
| TLG-SAF-003 bind consent to exact action | Implemented + automated coverage | Expiring nonce/document/evidence operation and dialog flow; real-browser consent test pending |
| TLG-SAF-004 fresh tri-state user-state protection | Implemented + automated coverage | Unknown/edited fail-closed preflight tests; representative sites pending |
| TLG-SAF-005 missing hard protections | Implemented + automated coverage | Sharing, discardability, activity/pin/audio/attention/loading/recent guards; OS/browser matrix pending |
| TLG-SAF-006 one automatic attempt per document | Implemented + automated coverage | Suppression/circuit state exists; automatic path remains quarantined |
| TLG-SAF-007 serialization/idempotency | Implemented + automated coverage | Per-tab queue and terminal operation semantics; event-page stress pending |
| TLG-SAF-008 evidence freshness/sleep-wake | Implemented + automated coverage | Wall-clock freshness and invalidation tests; sleep/wake browser validation pending |
| TLG-SAF-009 truthful receipts | Implemented + automated coverage | Requested/verified/blocked outcome model; real discard/reload outcomes pending |
| TLG-SAF-010 startup/alarm reconciliation | Implemented + automated coverage | Stored operation/alarm cleanup tests; signed update and event-page browser tests pending |

## B — state, lifecycle, and permissions

| Ticket | Status | Evidence / remaining gate |
|---|---|---|
| TLG-STA-001 runtime schemas/migrations | Implemented + automated coverage | Schema v3 uses a fail-closed migration: durable operation journals are written first, stale session/document authority is invalidated, and the v3 marker is committed last; corruption/legacy sanitization coverage exists |
| TLG-STA-002 orthogonal states | Implemented + automated coverage | Monitoring intent, permission mode, recovery mode, site policy, and finding state separated |
| TLG-LIF-001 document/tab lifetimes | Implemented + automated coverage | Loading/commit/history events establish generation and native-document fences; old document instances are retired while durable tab policy survives; BFCache/redirect browser gate pending |
| TLG-LIF-002 native document identity | Implemented; validation pending | Firefox `documentId` feature use/fallback represented; compatibility matrix pending |
| TLG-STA-003 bounded ordered persistence | Implemented + automated coverage | 16 samples/document, record/receipt/operation caps, serialized persistence, age pruning |
| TLG-LIF-003 registration/context reconciliation | Implemented; validation pending | Startup/update/policy/permission reconciliation, legacy collector-sentinel takeover, and bounded transport restart coverage exist; real existing-tab and signed-update lifecycle pending |
| TLG-PER-001 permission scopes | Implemented; validation pending | Manual/selected-site/all-site coordinator and UI; Firefox prompt/revoke matrix pending |
| TLG-PER-002 temporary monitoring | Implemented; validation pending | 15-minute token-bound manual sessions, expiry/Stop tests; real timer/suspension pending |
| TLG-PRI-001 notification privacy/lifecycle | Implemented; validation pending | Stable aggregate ID, generic default, optional hostname, and serialized create/clear plus badge cleanup with compensating clears; OS lock-screen behavior and trusted Firefox promise-liveness fault injection pending |
| TLG-PRI-002 retention/delete-all | Partial | No-history, 24-hour, and 7-day policies plus caps, pruning, and transaction-safe delete-all are automated; the planned current-session choice is not implemented |

## C/D — collector and detector

| Ticket | Status | Evidence / remaining gate |
|---|---|---|
| TLG-COL-001 callback-wide budgets | Implemented + automated coverage | Cooperative DOM recount is bounded by slices, active time, and a 100,000-node hard cap; incomplete counts are censored (`null`) and degrade evidence quality rather than becoming false exact values; pathological-DOM Firefox benchmark pending |
| TLG-COL-002 signal health/truthful names | Implemented + automated coverage | Dropped/overflow/availability/health data and resource-activity terminology |
| TLG-COL-003 adaptive global budget | Partial | Per-tab adaptive cadence/backoff and extension performance-warning handling exist; a centralized samples-per-minute/write budget plus 100/500-tab validation remain pending |
| TLG-COL-004 lifecycle boundaries/coverage | Implemented; validation pending | Visibility/page lifecycle and cleanup code/tests, per-delivery deadlines, and up to three bounded transient restarts preserve document/sequence/segment/edit state while forcing a degraded gap; BFCache/iframe/browser coverage pending |
| TLG-DET-001 trace/replay format | Implemented + automated coverage | Versioned bounded trace parser and deterministic replay tests |
| TLG-DET-002 robust time evidence | Implemented + automated coverage | Multi-window slope, baseline, persistence, plateau/release, hysteresis tests |
| TLG-DET-003 quality-aware policy | Implemented + automated coverage | Availability/overflow/budget quality and retained-DOM eligibility prerequisite |
| TLG-DET-004 representative corpus | Partial | Deterministic synthetic/fixture tests exist; broad benign/leak application corpus and metrics report remain pending |
| TLG-DET-005 feedback/effectiveness | Partial | Redacted diagnostics and receipts exist; local helpful/not-helpful feedback and post-recovery recurrence study remain pending |

## E/F — product experience and accessibility

| Ticket | Status | Evidence / remaining gate |
|---|---|---|
| TLG-UX-001 scope/limitations onboarding | Implemented; validation pending | Scope-first onboarding and exact-memory limitation; usability study pending |
| TLG-UX-002 live popup/dashboard | Partial | Popup refresh, evidence details, diagnostics exist; full historical dashboard/sparklines are deferred |
| TLG-UX-003 accessible recovery dialog/countdown | Implemented; validation pending | Modal focus trap, acknowledgement, expiry and cancel; assistive-tech matrix pending |
| TLG-UX-004 site/reversible controls | Implemented; validation pending | Site scopes, ignore, snooze, notification and data controls; browser/usability matrix pending |
| TLG-A11Y-001 WCAG/resilient layout | Partial | Semantic/focus/reduced-motion/high-contrast CSS foundation; audited keyboard/screen-reader/zoom matrix pending |
| TLG-I18N-001 localize strings | Partial | Firefox i18n wiring and English catalog; catalog completeness test, pseudo-locale, RTL and additional locales pending |

## G — privacy and security

| Ticket | Status | Evidence / remaining gate |
|---|---|---|
| TLG-SEC-001 threat model | Implemented | `docs/threat-model.md`; independent security review pending |
| TLG-SEC-002 message/authority boundaries | Implemented + automated coverage | Runtime schemas, sender binding, delivery deadlines, navigation/document fencing, and permission-revision fencing are fail closed across asynchronous work |
| TLG-SEC-003 local-only/privacy contract | Partial | Architecture contains no runtime network service and package audit blocks remote scripts; automated Firefox-origin network/storage privacy test pending |
| TLG-SEC-004 advanced diagnostics gate | Quarantined/deferred | No page-world instrumentation, native companion, or extra permission was added; requires separate review |

## H — testing gates

| Area | Status | Remaining evidence |
|---|---|---|
| Unit/integration/schema/property-style coverage | Implemented + automated coverage | 388 tests / 23 files passed; global coverage was 90.00% statements, 87.46% branches, 91.60% functions, and 93.04% lines; recovery transaction was 100% |
| Fake WebExtension lifecycle harness | Implemented + automated coverage | Final harness run is included in the 388-test result; Firefox behavior still needs interactive E2E confirmation |
| Automated headless Firefox smoke | Passed locally | Firefox 154.0.1 on macOS loaded exact ID/versioned build in a disposable profile, loaded the fixture, reloaded the add-on, and shut down; no interactive row is credited |
| Real Firefox E2E | Partial | Local smoke foundation exists; Release/Beta/compatibility tier and OS matrix pending |
| Performance/soak | Partial | Budget unit tests exist; measured p95 and 100-tab/8-hour soak pending |
| Accessibility/privacy automation | Partial | Code controls exist; assistive-tech, pseudo-locale, and runtime network tests pending |

## I — release and operations

| Ticket | Status | Evidence / remaining gate |
|---|---|---|
| TLG-REL-001 update channel | Decision implemented; rehearsal pending | Listed AMO selected; current unlisted 0.1.0 still needs manual update until listing/update rehearsal |
| TLG-REL-002 extension ID | Implemented + automated coverage | Existing signed ID frozen and checked by the recorded release tooling run |
| TLG-REL-003 deterministic artifacts | Implemented + automated coverage | Production/review/source ZIPs, content manifest, hashes, and SBOM verified; two clean release runs produced seven byte-identical files |
| TLG-REL-004 CI/dependency policy | Implemented; hosted run pending | Split least-privilege jobs, production gate, expiring dev exceptions, Dependabot; branch protection/first hosted run pending |
| TLG-REL-005 assets/support | Partial / release blocker | Final 16/32/48/96/128 PNG icons and notes/docs exist; reviewed theme variants, screenshots/listing, monitored contacts, and support URL remain pending |
| TLG-REL-006 rollback | Implemented procedure; drill pending | Quarantine and runbook exist; signed AMO safe-update drill pending |

## Release status

The local 0.1.1 source and unsigned artifact set are a **validated repository release candidate**. They must not be called signed, AMO-approved, automatically delivered, cross-platform validated, beta-qualified, or production 1.0. The external/manual unchecked gates in `docs/release-checklist.md` remain authoritative blockers.
