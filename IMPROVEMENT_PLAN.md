# Tab Leak Guard vNext improvement and implementation plan

Document status: implementation-ready roadmap  
Prepared: 2026-08-30  
Baseline: signed Firefox extension 0.1.0, approved for unlisted distribution  
Target: a trustworthy, measurable, production-grade 1.0 release  
Companion document: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

## 1. Executive decision

Tab Leak Guard has a strong prototype foundation: it is local-only, asks for website access at runtime, defaults to notifications, uses bounded primitive samples, explains its findings, and keeps tab-changing authority in the background process. The current build also passes TypeScript, all 27 tests, and Mozilla extension linting with no errors or warnings.

It is not ready to market automatic recovery as production-safe. Several races can act after monitoring is paused, act on a different document or action than the user approved, or repeatedly retry a blocked operation. The current coverage number also excludes the background controller, collector, permissions, storage, notifications, and UI—the highest-risk parts of the product.

The implementation order is therefore:

1. Ship a safety-only 0.1.1 update that removes automatic recovery from normal use and closes every known action race.
2. Replace the prototype state model with explicit detection, monitoring, and recovery state machines.
3. Reduce website access from an all-or-nothing choice to manual, selected-site, and all-site scopes.
4. Make collection budget-aware and detection replayable, calibrated, and honest about signal quality.
5. Redesign the user experience around evidence, freshness, countdown cancellation, site policy, privacy, and accessibility.
6. Run a closed notify-only beta, followed by a separate opt-in automatic-recovery beta.
7. Publish a listed AMO release only after every safety, false-positive, performance, privacy, accessibility, and update gate passes.

Automatic recovery must remain off by default in every release. It must remain unavailable or visibly experimental until the beta exit gates in this document pass.

## 2. Product north star

The product should answer four questions without overstating what Firefox exposes:

- Which eligible tabs show sustained, abnormal resource-growth patterns?
- What evidence produced that conclusion, how fresh is it, and how reliable were the signals?
- What can the user safely do now?
- If the user opts into automation, can the extension prove that every action was current, intended, reversible where possible, and protected by hard fail-closed rules?

The wording should consistently say possible resource leak, sustained resource growth, or high likelihood of runaway growth. It must never imply that the extension knows exact per-tab memory, reclaimed megabytes, or the root cause of a page problem.

## 3. Current baseline

| Area | What is already good | Material gap |
|---|---|---|
| Architecture | Firefox MV3 background event page; content scripts only report bounded primitives | Background lifecycle and action races have no integration harness |
| Privacy | No runtime service, telemetry, remote code, private browsing, form values, or page text | System notifications expose titles; retention and delete-all controls are incomplete |
| Permissions | Active-tab manual entry point and optional HTTP/HTTPS access | Continuous access is all-or-nothing; intent and actual permission can disagree |
| Detection | Deterministic feature functions, warmup, multi-signal scoring, explainable reasons | Fixed uncalibrated thresholds, weak signal-quality treatment, and no replay corpus |
| Collection | Bounded sample history, visibility-aware cadence, mutation and timing signals | Main-thread subtree walks and full DOM recounts can create overhead on the pages being protected |
| Recovery | Notify-only default, grace period, safety predicates, discard verification, receipts | Kill-switch, consent, dirty-state, retry, document, and cooldown invariants are incomplete |
| UX | Popup, onboarding, settings, badges, notifications, exclusions, snooze | Snapshot-only UI, blocking browser dialogs, mixed states, limited accessibility and localization |
| Testing | 27 passing unit tests and deterministic starter fixtures | Coverage excludes background, collector, storage, permissions, and UI; real-browser matrix is pending |
| Release | Signed 0.1.0 XPI and AMO automatic validation | Installed unlisted build has no update URL, so the next self-distributed version is not automatically delivered |

Verification on 2026-08-30:

- npm run verify: passed.
- Test files: 6 passed.
- Tests: 27 passed.
- web-ext validation: 0 errors, 0 notices, 0 warnings.
- Reported statement coverage: 90.98%, but only detector, recovery, and shared modules are included by vitest.config.ts.

## 4. Non-negotiable product principles

### 4.1 User state outranks memory recovery

False negatives are acceptable when the alternative could lose work, interrupt capture, change an active page, or surprise the user. Unknown safety state is unsafe for automatic action.

### 4.2 The master switch is authoritative

Pausing monitoring, removing permission, selecting notify-only, ignoring a site, disabling the extension, or installing an update must synchronously invalidate all automatic-action authority. An alarm is only a wake-up signal; it is never authorization.

### 4.3 Consent binds the exact operation

A confirmation is valid only for one tab, one Firefox document, one intended action, one safety snapshot, and a short expiry. If any of those change, no action occurs and the user is asked again.

### 4.4 Detection and recovery are independent

A high-likelihood finding may be snoozed, protected, blocked, pending, or recently recovered. Those are separate dimensions and must not overwrite one another.

### 4.5 Missing signals reduce confidence

Overflow, dropped performance entries, late injection, unknown dirty state, inaccessible frames, stale samples, and collector errors must be represented explicitly and must lower confidence or block automatic action.

### 4.6 The extension must not become the performance problem

Every observer callback, sample, recount, persisted record, UI update, and background wake-up needs a measurable budget and an adaptive fallback.

### 4.7 Local-only remains the default architecture

No analytics, remote configuration, cloud model, browsing-history upload, or hidden feedback channel is required for 1.0. Diagnostic export is explicit, redacted by default, and initiated by the user.

## 5. Explicit non-goals

- Exact per-tab heap, resident, GPU, media, or browser-process memory.
- Claiming that a heuristic finding proves a memory leak.
- Reading page text, HTML, field values, cookies, request bodies, or screenshots.
- Automatically reloading the active tab.
- Automatically overriding dirty or unknown user-state protection.
- Monitoring privileged Firefox pages, restricted Mozilla domains, extension pages, reader view, or other non-injectable documents.
- Page-world monkey-patching in the default product.
- Native messaging, privileged experiments, debugger attachment, or a companion process for 1.0.
- Remote telemetry as a prerequisite for detector calibration.

## 6. Prioritized audit findings

### 6.1 P0: action-safety and data-loss blockers

| ID | Finding and evidence | Required disposition |
|---|---|---|
| P0-01 | UPDATE_PREFERENCES and permission revocation update registration but do not cancel pending reset alarms. evaluateSafety does not require monitoringEnabled or current permission. See src/background/index.ts:334-338 and 413-420; src/recovery/policy.ts:18-46. | Master-off transaction that cancels alarms, clears pending state, invalidates action epochs, and is rechecked at execution |
| P0-02 | The popup confirms an action from an old snapshot, while the background later decides reload versus discard from newer tab state. Manual reset has no expected document or action. See src/ui/popup/index.ts:104-117 and src/background/index.ts:304-317. | Two-phase PREPARE_RECOVERY and EXECUTE_RECOVERY protocol with short-lived nonce, document ID, state revision, exact action, warnings, and expiry |
| P0-03 | Dirty state starts false, is sticky once true, covers only the top frame, can miss pre-injection or just-in-time edits, and is read from the last periodic sample. | Replace boolean with no-edits-observed, edits-observed, or unknown; install the guard at document_start where possible; probe immediately before action; timeout or inaccessible frames mean unknown |
| P0-04 | autoDiscardable and Firefox sharingState are not protected. A tab sharing camera, microphone, or screen can currently pass policy. | Add hard safety predicates and visible reasons; evaluate fullscreen and picture-in-picture conservatively |
| P0-05 | A blocked or failed discard can be reconfirmed by the next sample and retried indefinitely. Circuit breakers count only successful receipts. | Suppress further automatic action for that document after one blocked/failed attempt; require explicit manual retry; count attempts in breaker policy |
| P0-06 | Snooze and cooldown are stored on the document record, which is deleted on loading. The extension's own reload/restore can erase its cooldown. | Separate document evidence from tab/session/site recovery policy; persist cooldown across same-tab navigation and discard restore |
| P0-07 | An overdue alarm after sleep can act on stale evidence. Notifications can be disabled while auto mode remains enabled, and pending notifications do not describe the countdown. | Evidence freshness deadline, sleep/wake reconciliation, new-sample reconfirmation, explicit auto-mode acknowledgment, and always-visible pending/cancel state |
| P0-08 | Alarm, manual command, sample confirmation, and background restart paths have no per-tab mutex or idempotency token. | Serialize recovery per tab; use operation IDs and compare-and-set state transitions; at most one receipt and one tab API call per operation |
| P0-09 | tabs.reload acceptance is recorded immediately as completed even though navigation completion is not verified. | Record requested, completed, timed-out, blocked, and failed outcomes separately; verify document replacement/navigation completion |
| P0-10 | storage.session records and receipts are largely trusted during hydration; schema version is written but migrations are not performed. Preference booleans are not type-checked. | Strict runtime schemas, versioned migrations, quarantine-and-reset corruption behavior, bounded normalized hostnames, and migration tests |

### 6.2 P1: correctness, trust, and production-readiness gaps

| ID | Finding | Planned release |
|---|---|---|
| P1-01 | DetectorStatus mixes evidence severity with recovery state, causing badge, sort, and summary inconsistencies | 0.2 |
| P1-02 | Notification IDs use only tab ID; they survive navigation and click through to the replacement page instead of a finding detail view | 0.2 |
| P1-03 | Notification throttling is per record only, so many confirmations can produce an OS-notification burst | 0.2 |
| P1-04 | Monitoring preference can say enabled while permission is absent; popup conflates paused and missing-permission states | 0.2 |
| P1-05 | Manual scan injects an indefinite collector even though the UI describes a one-off scan | 0.2 |
| P1-06 | Resource timing entries represent network/resource activity, not retained memory; current names and reason codes can be misread | 0.1.1 wording, 0.3 model |
| P1-07 | A mutation callback can walk up to 20,000 descendants per added or removed root, and a full DOM recount runs on the page main thread | 0.3 |
| P1-08 | PerformanceObserver construction is not guarded, droppedEntriesCount is ignored, and capability flags do not affect confidence | 0.3 |
| P1-09 | Fixed scalar thresholds lack model versioning, confidence uncertainty, negative evidence, hysteresis, or calibrated fixture metrics | 0.3 |
| P1-10 | Random collector UUID plus tab loading invalidation does not use Firefox documentId, leaving avoidable document races | 0.2 |
| P1-11 | Page titles appear in OS notifications by default and may be visible on a lock screen | 0.2 |
| P1-12 | Receipt retention is count-bounded but not age-bounded; there is no comprehensive delete-all control | 0.2 |
| P1-13 | Popup uses blocking window.confirm dialogs, is snapshot-only, and can lose focus on rerender | 0.4 |
| P1-14 | Most user-visible strings are hard-coded outside browser.i18n; zoom, forced colors, screen readers, and reduced motion are unverified | 0.4 |
| P1-15 | Current CI coverage omits the highest-risk modules and no real Firefox E2E suite is automated | Start in 0.1.1; complete by 0.5 |
| P1-16 | Installed unlisted 0.1.0 has no update_url, so another unlisted AMO signing does not automatically update existing installs | Release decision before 0.1.1 distribution |
| P1-17 | The permanent extension ID ends in local.invalid. Changing it later creates a different add-on and loses seamless continuity | Freeze or deliberately migrate before wider distribution |

### 6.3 P2: high-value improvements

- Per-site permission and policy: manual only, monitor, notify, allow automatic recovery, or ignore.
- Time-scoped pause and snooze: one hour, until browser restart, or indefinitely.
- Evidence timeline with sample freshness, confidence band, quality warnings, and plain-language explanations.
- Local Not a leak, Reset helped, and Problem returned feedback.
- Post-recovery effectiveness checks without claiming reclaimed bytes.
- Aggregate dashboard grouped by severity, window, and site.
- Privacy-preserving diagnostic export with titles and hostnames redacted by default.
- Context-menu commands for monitor, stop, snooze, and never auto-reset this site.
- Adaptive sampling based on visibility, suspicion, callback cost, and global extension budget.
- SPA history-navigation boundary handling.
- Optional all-frame primitive aggregation after privacy, performance, and safety review.

### 6.4 Research only; do not put on the 1.0 critical path

- Optional main-world diagnostic instrumentation for worker, WebSocket, EventSource, or Blob URL lifecycle counts.
- userScripts-based advanced diagnostics, which requires an additional optional permission and exposes instrumentation to the page in MAIN world.
- Cross-browser ports.
- Native or privileged exact-memory integration.
- Remote model updates or telemetry.

These may become separate experiments only after a threat model, AMO policy review, user consent design, and performance study. Page-derived advanced counters must remain advisory and must never be sufficient for automatic recovery.

## 7. Target domain model

The current single status field should be replaced with orthogonal state.

### 7.1 Monitoring state

| Field | Values | Meaning |
|---|---|---|
| intent | paused, manual, continuous | What the user selected |
| permissionScope | none, active-tab, selected-sites, all-sites | Website access Firefox currently grants |
| effective | inactive, partial, active, restricted | Derived runtime state; never stored as user intent |
| session | none or temporary session record | Per-tab manual monitoring with start, expiry, and stop token |

### 7.2 Detection state

| Field | Values |
|---|---|
| severity | learning, stable, elevated, likely-runaway, unsupported |
| score | 0–100 evidence score, labeled advanced |
| quality | high, medium, low, insufficient |
| freshness | sampledAt, expiresAt, stale boolean |
| model | modelVersion and configurationVersion |
| evidence | typed reasons, feature values, signal availability, overflows, dropped entries |

The score describes confidence in a sustained runaway resource-growth pattern, not memory quantity and not certainty of a leak.

### 7.3 Recovery state

| State | Meaning | Permitted next states |
|---|---|---|
| idle | No recovery workflow | prepared, suppressed |
| prepared | Exact action and warnings calculated; no authority to act | awaiting-consent, cancelled, expired |
| awaiting-consent | Manual prompt or automatic grace countdown is visible | executing, cancelled, expired |
| executing | Per-tab lock held and all predicates revalidated | requested, blocked, failed |
| requested | Firefox accepted the tab API request | completed, timed-out, failed |
| completed | Navigation or discarded state verified | cooldown |
| cooldown | Automatic action is not eligible | idle |
| blocked | A safety predicate or Firefox blocked the action | suppressed or manual prepare |
| failed | An unexpected error occurred | suppressed or manual prepare |
| suppressed | No more automatic attempts for the current scope | idle after navigation/expiry/user override |

### 7.4 Policy scope

Keep these separate from document evidence:

- document: evidence, dirty state, sample sequence, notification binding, automatic-attempt suppression;
- tab session: snooze, cooldown, temporary-monitoring session, operation lock;
- site: monitor policy, notification policy, automatic-recovery allowlist;
- global: monitoring intent, safety defaults, global circuit breaker, retention;
- installation: schema version, extension ID, safety acknowledgment version.

### 7.5 Recovery authorization token

Every prepared operation must contain:

- operationId;
- tabId;
- windowId;
- Firefox documentId; a compatibility fallback may support manual monitoring, but automatic recovery is unavailable when native identity is absent;
- internal document revision;
- intended action: discard or reload;
- initiator: manual or automatic;
- preparedAt and expiresAt;
- evidence revision and freshness deadline;
- safety snapshot digest;
- monitoring epoch;
- warnings requiring acknowledgment;
- single-use nonce.

Execution rejects the token if any field is missing, expired, used, or no longer matches fresh browser and collector state.

## 8. Target component architecture

| Component | Responsibility | Key rule |
|---|---|---|
| Runtime controller | Event listeners, startup, shutdown, and orchestration | No business rules inline |
| Monitoring coordinator | Intent, permission scopes, script registration, temporary sessions | Effective monitoring is derived |
| Document registry | Bind tab, frame, and Firefox documentId; reject stale messages | Browser sender identity is authoritative |
| Collector budget controller | Cadence, callback budgets, quality flags, stop/expiry | Never retain page nodes between callbacks |
| Detector engine | Pure features, evidence quality, model version, hysteresis | Deterministic and replayable |
| Recovery coordinator | Prepare/execute protocol, mutex, alarm reconciliation, receipts | Fail closed at every transition |
| Safety policy | Pure predicate evaluation over fresh state | Unknown equals unsafe for auto |
| Notification coordinator | Aggregate, bind, clear, and route notifications | Lock-screen-safe by default |
| State repository | Runtime validation, migrations, serialized writes, retention | Corrupt data cannot gain authority |
| View-model builder | One derivation for popup, badge, dashboard, and notifications | UI channels cannot disagree |
| Dashboard and popup | Evidence, status, actions, consent, and settings entry | Live, keyboard-safe, and localized |
| Replay and fixture lab | Deterministic traces, corpus evaluation, performance fixtures | Required for model changes |

Recommended source layout:

- src/domain for schemas, state machines, invariants, and view models;
- src/background/runtime-controller.ts;
- src/background/monitoring-coordinator.ts;
- src/background/document-registry.ts;
- src/background/recovery-coordinator.ts;
- src/background/notification-coordinator.ts;
- src/background/state-repository.ts;
- src/collector/edit-guard.ts;
- src/collector/budget-controller.ts;
- src/collector/signals.ts;
- src/detector/model.ts;
- src/detector/quality.ts;
- src/detector/replay.ts;
- src/ui/dashboard;
- tests/unit, tests/integration, tests/e2e, tests/replay, tests/performance, and tests/fixtures.

The existing files can be refactored incrementally; a big-bang rewrite is not required.

## 9. Release train and dependency order

Effort is expressed as engineering size rather than a calendar promise. A release advances only when its exit gates pass.

| Release | Purpose | Principal scope | Exit condition |
|---|---|---|---|
| 0.1.1 | Safety quarantine | Force notify-only, cancel pending authority, suppress retries, fix wording, add action-path integration harness | No automatic tab action is reachable; update path is chosen and tested |
| 0.2 | State and permission foundation | Orthogonal states, migrations, document identity, scoped permission, manual-session lifecycle, notification lifecycle | All lifecycle/permission/storage races pass in fake-browser and Firefox smoke tests |
| 0.3 | Collector and detector v2 | Work budgets, quality, fixed plus rolling baselines, time-based confirmation, trace replay, corpus calibration | Accuracy and performance gates pass on the versioned corpus |
| 0.4 | Trustworthy product UX | Dashboard, live popup, recovery preparation, site policies, privacy controls, i18n, accessibility | Usability, WCAG, notification privacy, and consent-action tests pass |
| 0.5 | Closed beta | Notify-only beta first; opt-in automatic recovery only on supported Firefox after safety review | Multi-week beta gates pass with zero unintended recovery |
| 1.0 | Listed production release | AMO listing, automatic update channel, support process, final assets and documentation | Full release checklist and rollback drill pass |

Recommended staffing order:

1. One engineer owns the recovery invariants and integration harness end-to-end.
2. Detector changes begin only after trace replay and sample-quality schemas exist.
3. UX design works in parallel against the target state model, not the prototype status field.
4. Release engineering starts during 0.1.1 because the installed unlisted build cannot be assumed to auto-update.

## 10. Workstream A — immediate 0.1.1 safety release

### TLG-SAF-001: quarantine automatic recovery

Priority: P0  
Effort: S  
Dependencies: none

Implementation:

- Add a v2 preference migration that converts every stored auto-safe value to notify.
- Remove or disable the auto-safe option in the production UI and label the code path experimental.
- Clear all reset alarms, pendingResetAt fields, prepared operations, and action nonces during update.
- Change onboarding and README claims so they describe automatic recovery as under validation.
- Preserve manual unload/reload only after the two-phase protocol in TLG-SAF-003 is complete. If that cannot fit 0.1.1, temporarily remove manual recovery too.

Acceptance criteria:

- Updating any valid or corrupt 0.1.0 state produces notify-only mode.
- No alarm, message, or stale stored record can call tabs.discard or tabs.reload automatically.
- A source-level test fails if a production UI exposes auto-safe before the feature flag is enabled.
- The release notes plainly say that automatic recovery was temporarily disabled for safety hardening.

### TLG-SAF-002: one authoritative master-off transaction

Priority: P0  
Effort: M  
Dependencies: TLG-SAF-001

Implementation:

- Replace scattered preference and permission reactions with setMonitoringIntent and reconcileMonitoringState.
- Add a monotonically increasing monitoringEpoch.
- On pause, notify-only selection, permission removal, ignore-site, extension update, or policy reset:
  - increment the epoch;
  - clear matching or all recovery alarms;
  - invalidate prepared operations and nonces;
  - clear pending recovery fields;
  - stop or reconfigure collectors;
  - clear bound notifications as appropriate;
  - persist before returning success to the UI.
- Require current monitoring intent, effective permission, site policy, epoch, and recovery feature availability in the pure safety policy and final executor.

Acceptance criteria:

- Pause, permission removal, notify-only selection, ignore-site, and update each produce zero tab API action after fake time advances beyond every former deadline.
- Races at every await boundary produce the same result.
- The UI does not report paused until cancellation and persistence finish.
- Startup treats any epoch mismatch as cancelled.

### TLG-SAF-003: bind consent to one exact action

Priority: P0  
Effort: M  
Dependencies: TLG-SAF-002

Implementation:

- Replace RESET_TAB with PREPARE_RECOVERY and EXECUTE_RECOVERY.
- Preparation fetches fresh tab state and collector preflight, chooses exactly discard or reload, creates warnings, and returns a short-lived operation token.
- Execution is single-use and rejects changed active state, navigation, safety revision, action, document identity, or expiry.
- Never convert discard to reload or reload to discard.
- Replace window.confirm with a local accessible dialog in 0.4; until then, ensure the prototype confirmation displays the prepared action and passes the exact token back.

Acceptance criteria:

- Inactive-to-active, active-to-inactive, and navigation races execute no action.
- The action recorded in the receipt always equals the action displayed.
- A stale, duplicated, forged, or already-used nonce is rejected.
- Property tests cover all state-change combinations between prepare and execute.

### TLG-SAF-004: tri-state, fresh user-state protection

Priority: P0  
Effort: L  
Dependencies: TLG-SAF-003, TLG-LIF-002

Implementation:

- Replace dirty boolean with userEditState: no-edits-observed, edits-observed, or unknown plus observedAt.
- Register a minimal guard at document_start for continuously monitored sites.
- Do not inspect field values. If the collector was injected late, frame coverage is incomplete, or an editor cannot be observed, use unknown.
- Keep edits-observed sticky for the document unless a separately validated reset/submit/save signal is introduced later.
- Aggregate all frames when safely available; any unobserved frame makes automatic preflight unknown.
- Add targeted GET_RECOVERY_PREFLIGHT messaging bound to documentId.
- Preflight must be at most two seconds old at execution. Missing collector, timeout, late injection, inaccessible frame, or identity mismatch means unknown.
- Manual recovery may override edits-observed or unknown only through an explicit second acknowledgment in the prepared operation.
- Rename UI copy from Unsaved input to Edited input observed until actual unsaved state is knowable.

Acceptance criteria:

- Input immediately before an alarm or manual execution prevents automatic action.
- A manually injected collector starts unknown, never no-edits-observed.
- No implementation path reads or transmits form values to infer prior edits.
- Input in an iframe prevents automatic recovery.
- Ten thousand randomized input, visibility, navigation, and alarm schedules produce zero automatic action while edits are observed or state is unknown.

### TLG-SAF-005: add missing hard protections

Priority: P0  
Effort: S  
Dependencies: TLG-SAF-004

Implementation:

- Protect active, highlighted where relevant, pinned, audible, attention-requesting, loading, discarded, recently accessed, edited/unknown, and ignored tabs.
- Protect autoDiscardable equal to false.
- Protect any camera, microphone, or screen sharingState.
- Protect a fullscreen browser window; feature-detect page fullscreen and picture-in-picture signals and default unknown to protected.
- Display every active protection in the details view.
- Do not treat optional Firefox properties missing from a response as false; require safetyComplete for automation.

Acceptance criteria:

- Dedicated fixtures or browser mocks cover every predicate.
- Camera, microphone, screen sharing, non-auto-discardable, attention, fullscreen, and unknown-property cases never auto-recover.
- The popup never says Safe background tab while attention, loading, sharing, or another block is active.

### TLG-SAF-006: one automatic attempt per document

Priority: P0  
Effort: S  
Dependencies: TLG-LIF-001

Implementation:

- Store an automaticAttempt state independently of detector results.
- After blocked, failed, or timed-out automatic action, set suppressed for that native document.
- Samples may update detection but cannot clear suppression.
- Clear document suppression only on a confirmed new document; let explicit user retry create a manual operation.
- If transient automatic retries are ever introduced, use a small capped exponential backoff and a separate reviewed feature flag.
- Count blocked, failed, timed-out, and successful automatic attempts in host and global breakers. Manual attempts are recorded separately.

Acceptance criteria:

- A beforeunload or discard no-op fixture causes exactly one automatic attempt across eight hours of samples and restarts.
- At most one blocked or failed automatic receipt exists per document.
- Manual retry is clearly labeled and cannot silently re-enable automation.

### TLG-SAF-007: serialize and make actions idempotent

Priority: P0  
Effort: M  
Dependencies: TLG-SAF-003

Implementation:

- Add a per-tab asynchronous operation queue or mutex.
- Use compare-and-set state revisions for prepare, execute, cancel, and complete.
- Store operationId in alarms and receipts.
- Check a completed-operation index before every tab API call and receipt write.
- Keep the lock through verification and final persistence.

Acceptance criteria:

- Simultaneous alarm, manual click, and sample confirmation produce at most one tab API call.
- Replayed events after background restart produce no duplicate call or receipt.
- All exit paths release the mutex.

### TLG-SAF-008: evidence freshness and sleep/wake behavior

Priority: P0  
Effort: M  
Dependencies: TLG-SAF-002, TLG-SAF-004

Implementation:

- Add sampledAt, evidenceExpiresAt, maximumSampleGap, and collectorHealth.
- Detect long wall-clock versus monotonic gaps and segment the evidence window.
- When an overdue alarm fires, cancel it; do not immediately reschedule.
- Require new distinct samples and a fresh safety preflight before becoming eligible again.
- Make a pending automatic countdown visible in the badge, popup, and dashboard with Cancel and Snooze.

Acceptance criteria:

- Simulated eight-hour sleep causes no action after wake.
- Stale evidence, unhealthy collector, or large gap always blocks automation.
- Pending UI shows exact intended action, time remaining, and cancellation result.

### TLG-SAF-009: truthful action receipts

Priority: P0  
Effort: S  
Dependencies: TLG-SAF-003, TLG-SAF-007

Implementation:

- Replace action plus outcome with initiator, requestedAction, phase, outcome, operationId, requestedAt, completedAt, and reason codes.
- Use precise outcomes: cancelled, expired, blocked, request-failed, requested, completed, verification-timed-out.
- After reload request, wait for the expected document lifecycle transition and completion or timeout.
- After discard request, verify the discarded property as today.
- Never render Unloaded · blocked or Reloaded · failed.

Acceptance criteria:

- UI says Unload blocked, Reload requested, Reload completed, or Verification timed out as appropriate.
- A receipt cannot claim completion before verification.
- Manual actions do not consume automatic circuit-breaker capacity.

### TLG-SAF-010: startup and alarm reconciliation

Priority: P0  
Effort: M  
Dependencies: TLG-SAF-002, TLG-SAF-007, TLG-STA-001

Implementation:

- On startup, update, and event-page activation, compare stored operations with browser.alarms.getAll.
- Cancel orphan alarms, orphan operations, epoch mismatches, stale evidence, expired tokens, and unknown states.
- Recreate a pending alarm only when every stored field validates and the countdown is still in the future; the conservative default is cancellation.
- Expire cooldowns, snoozes, temporary sessions, receipts, and stale records during the same bounded housekeeping pass.

Acceptance criteria:

- Every combination of missing alarm, missing record, corrupt token, stale epoch, and clock jump is table-tested.
- Ambiguous state never results in action.
- Reconciliation is idempotent across repeated background starts.

## 11. Workstream B — state, lifecycle, and persistence

### TLG-STA-001: versioned runtime schemas and migrations

Priority: P0  
Effort: M

Implementation:

- Introduce one runtime-schema module for preferences, site policy, document records, tab policy, operations, receipts, collector messages, and UI commands.
- Strictly validate booleans, finite numbers, enums, timestamps, IDs, list lengths, string lengths, and normalized hostnames.
- Add explicit v1-to-v2 migration and a migration journal.
- Drop an invalid record without failing the extension; invalid data never enables action.
- Preserve a bounded local diagnostic stating that corrupt state was discarded, without retaining corrupt content.
- Add downgrade behavior: an older build must ignore unknown new state rather than interpret it as authority.

Acceptance criteria:

- Mutation fuzzing of every stored and messaged type cannot crash startup or make recovery eligible.
- All supported schema versions have golden migration tests.
- Hostnames are normalized, deduplicated, length-bounded, and rejected if invalid.
- Preference controls and storage sanitizer use the same schema and bounds.

### TLG-STA-002: split state dimensions

Priority: P1  
Effort: L  
Dependencies: TLG-STA-001

Implementation:

- Create MonitoringState, DetectionState, RecoveryState, SafetyState, DocumentRecord, TabPolicyState, SitePolicy, and RecoveryReceipt.
- Remove protected, reset-pending, resetting, reset-blocked, and cooldown from DetectorStatus.
- Centralize transitions in pure reducer functions.
- Derive popup, badge, dashboard, notifications, and sorting from one tested view model.

Acceptance criteria:

- A likely-runaway snoozed tab renders Likely runaway · Snoozed, not Stable.
- Every legal transition and every rejected transition has a unit test.
- Recovery state changes never modify evidence severity.
- Badge, summary, sort order, notification, and detail labels agree for every state combination.

### TLG-LIF-001: separate document and tab lifetimes

Priority: P0  
Effort: M  
Dependencies: TLG-STA-002

Implementation:

- Keep samples, dirty state, evidence, and automatic suppression on the document.
- Keep manual-session metadata, snooze, and recovery mutex on the tab.
- Keep cooldown and breakers at deliberately chosen tab/site/global scopes.
- Transfer only allowed tab policy into a newly committed document.
- Delete tab-scoped state on close and reconcile tab replacement explicitly.

Acceptance criteria:

- A one-hour cooldown survives reload, discard/restore, and background restart.
- Tab snooze survives same-tab navigation and ends on tab close.
- New-document evidence never inherits old-document confirmation.
- Scope and remaining duration are visible to the user.

### TLG-LIF-002: native Firefox document identity

Priority: P0 for automatic recovery  
Effort: M  
Dependencies: TLG-STA-002

Implementation:

- Use runtime.MessageSender.documentId and document-targeted messaging when available.
- Current compatibility data places MessageSender.documentId in Firefox 153. Keep notify/manual monitoring compatible with the current minimum, but make automatic recovery unavailable when native identity is absent.
- Add webNavigation lifecycle handling for committed navigation, errors, history updates, BFCache behavior, and tab replacement.
- Retain the collector UUID only as a secondary instance marker, never the sole automatic-action identity.
- Decide before 1.0 whether to raise strict_min_version to 153 or retain a feature-gated compatibility tier.

Acceptance criteria:

- A message or preflight aimed at an old document fails rather than reaching its replacement.
- Navigation at every await boundary before recovery produces zero stale-document calls.
- Reload, redirect, BFCache restore, same-document history navigation, and tab replacement each have documented expected behavior and E2E coverage.

### TLG-STA-003: bounded, ordered persistence

Priority: P1  
Effort: M  
Dependencies: TLG-STA-001

Implementation:

- Serialize preference, receipt, and state writes through explicit queues.
- Debounce routine session checkpoints globally to a target of no more than six per minute.
- Flush immediately on meaningful transitions and before any tab action.
- Avoid rewriting the entire tab map for every sample; use per-tab keys or compact normalized checkpoints.
- Bound tab records, samples, receipt age/count, total serialized bytes, and diagnostic events.
- Evict oldest healthy/stale records first; never evict an executing operation.
- Cache badge output and avoid identical browser API calls.

Acceptance criteria:

- Concurrent receipt writes preserve order and never lose the newest item.
- Routine 100-tab sampling produces at most six state checkpoints per minute.
- State remains below 5 MB with 500 synthetic tabs.
- Crash/restart tests preserve required transition state without reviving stale authority.

### TLG-LIF-003: registration and context reconciliation

Priority: P1  
Effort: M  
Dependencies: TLG-PER-001, TLG-LIF-002

Implementation:

- Reconcile registered scripts and currently eligible documents on every startup, update, permission change, and policy change—not only when first registering.
- Limit concurrent injections.
- Use context/document identity and the collector sentinel to make injection idempotent.
- Treat restricted or failed injection as a distinct coverage state with helpful copy.
- Restore userScripts only on update if the future advanced experiment is ever enabled.

Acceptance criteria:

- Loaded eligible tabs become monitored after update or background recovery without duplicate collectors.
- Revoked or narrowed permission stops collectors outside scope.
- Restricted-page failures produce no retry storm.

## 12. Workstream C — permissions, privacy, and monitoring sessions

### TLG-PER-001: replace the permission boolean with scopes

Priority: P1  
Effort: L  
Dependencies: TLG-STA-001

User choices:

1. Manual only: activeTab, temporary per-document monitoring.
2. This site or selected sites: request exact HTTP/HTTPS origin patterns.
3. All regular websites: request the existing broad optional host patterns.

Implementation:

- Store monitoring intent separately from actual granted origins.
- Derive effective state from permissions.getAll and listen to permissions.onAdded/onRemoved.
- Register content scripts only for granted origins and selected policy.
- Add current-site grant, manage-sites, upgrade-to-all, and revoke actions.
- Never show Monitoring active when permission or an eligible context is absent.

Acceptance criteria:

- Paused, permission required, partial access, restricted page, temporary session, and active continuous monitoring have distinct states and copy.
- Grant, deny, partial grant, external revoke, and scope narrowing are E2E-tested.
- A site outside granted scope receives no collector.

### TLG-PER-002: explicit temporary monitoring

Priority: P1  
Effort: M  
Dependencies: TLG-PER-001

Implementation:

- Rename Scan this tab to Monitor this tab temporarily.
- Create a manual collector mode with start time, baseline progress, expiry, and stop token.
- Default the session to 15 minutes or end when enough evidence is gathered; make the exact duration a reviewed product constant.
- Manual mode survives unrelated continuous-monitor preference changes but ends on navigation, explicit Stop, expiry, permission loss, or extension shutdown/update.
- Let the user promote the current site to continuous access.

Acceptance criteria:

- UI shows time remaining, last sample, baseline progress, and Stop.
- Stop disconnects observers within one second.
- Expiry stops all timers and observers and leaves only the documented bounded result.
- README and onboarding no longer call it a one-off scan.

### TLG-PRI-001: notification privacy and lifecycle

Priority: P1  
Effort: M  
Dependencies: TLG-LIF-002, TLG-STA-002

Implementation:

- Default system notification text to a generic lock-screen-safe message.
- Add an explicit Show site names in system notifications preference.
- Bind notifications to operation/finding ID plus native documentId.
- Clear on navigation, close, stabilization, ignore, cancellation, recovery, and expiry.
- Route a click to the exact extension details view, not directly to the tab.
- Aggregate bursts globally; twenty simultaneous findings should produce one summary notification.

Acceptance criteria:

- Default notifications reveal no title or hostname.
- A stale notification never focuses or represents a replacement document.
- Twenty confirmations within one minute produce at most one OS notification while the dashboard retains all findings.

### TLG-PRI-002: retention and delete-all controls

Priority: P1  
Effort: S  
Dependencies: TLG-STA-003

Implementation:

- Offer no history, current session, 24 hours, and 7 days, with a conservative default.
- Purge expired receipts and diagnostics at startup and before rendering.
- Add Delete all local extension data with explicit confirmation.
- Delete preferences, site policies, records, receipts, temporary sessions, alarms, notifications, tokens, and diagnostic events, then restore safe defaults.
- Document what remains in Firefox-managed permission state and offer a separate revoke action.

Acceptance criteria:

- Storage inspection after delete-all matches an allowlist of default fields.
- Purge behavior is deterministic under clock changes.
- Delete-all cancels every pending action before clearing state.

## 13. Workstream D — collector hardening

### TLG-COL-001: callback-wide work budgets

Priority: P1  
Effort: M

Implementation:

- Replace the per-root 20,000-node mutation limit with one callback-wide node and elapsed-time budget.
- Saturate counts and mark overflow when the budget is exhausted; release all Node references before returning.
- Schedule a ground-truth recount during an idle opportunity with a timeout fallback.
- Measure callbackDurationMs and recountDurationMs locally.
- Back off or suspend a collector that repeatedly exceeds budget.

Initial benchmark gates:

- Mutation callback below 5 ms at p95 and 10 ms at p99 on the reference benchmark.
- Normal sample below 5 ms at p95.
- Full recount below 20 ms at p95 or automatic cadence backoff activates.
- A callback containing 100,000 sibling additions never exceeds the configured hard work cap.

### TLG-COL-002: signal health and truthful names

Priority: P1  
Effort: M  
Dependencies: TLG-COL-001

Implementation:

- Rename resourceEntriesSeen and RESOURCE_GROWTH to resourceActivityCount and RESOURCE_ACTIVITY.
- Record PerformanceObserver droppedEntriesCount.
- Wrap observer construction and observe calls; report unavailable or failed rather than throwing.
- Remove longTasks and exactMemory capability flags until an actual collected field exists.
- Track per-signal status: collected, unavailable, failed, overflowed, or stale.
- Record sample cost and expected-versus-actual interval.
- Segment timer drift around visibility changes, long gaps, sleep, and expensive collector work.

Acceptance criteria:

- Resource activity is never described as retained memory.
- Dropped or overflowed observations lower data quality.
- Capability means successfully collected, not merely property-present.
- Firefox memory APIs remain explicitly unavailable; no fake byte measurement appears.

### TLG-COL-003: adaptive global budget

Priority: P1  
Effort: L  
Dependencies: TLG-COL-001, TLG-STA-003

Implementation:

- Add per-tab cadence states: warmup, stable, elevated, suspected, paused, and over-budget.
- Sample hidden stable tabs less often; temporarily increase cadence only for rising evidence.
- Apply random jitter to avoid synchronized work.
- Enforce a global samples-per-minute and serialization budget.
- Use runtime.onPerformanceWarning only to detect the extension's own overhead; never use it as evidence that a page leaks.
- Expose local collector health in diagnostics.

Acceptance criteria:

- 100-tab and 500-tab synthetic runs stay inside the configured global wake-up and write budgets.
- A runtime performance warning backs off the implicated collector and records a local diagnostic.
- No self-performance warning increases leak confidence.

### TLG-COL-004: lifecycle boundaries and coverage

Priority: P1  
Effort: M  
Dependencies: TLG-LIF-002

Implementation:

- Define behavior for load, document_idle, visibility, pagehide, pageshow, BFCache, SPA history updates, and long suspension.
- Use a settling period before creating the fixed baseline.
- Reset or segment evidence after route transitions and large gaps rather than joining unrelated workloads.
- Report coverage labels for top frame, frames observed, shadow DOM coverage, and unavailable heap/GPU/media signals.
- Keep all-frame aggregation behind a measured feature flag until its overhead and cross-origin semantics pass review.

Acceptance criteria:

- Lifecycle behavior is documented and replay-tested.
- Route changes do not inherit an unrelated high-confidence window.
- The details view plainly lists important blind spots.

## 14. Workstream E — detector v2 and calibration

### TLG-DET-001: versioned trace and replay format

Priority: P1  
Effort: M

Implementation:

- Define a JSON trace schema containing primitive samples, signal health, lifecycle markers, expected class, and redaction metadata.
- Add deterministic replay that produces features, transitions, reasons, and eligibility decisions.
- Store modelVersion and configurationVersion with every finding.
- Reject incompatible traces with a helpful migration message.
- Add a redacted local export that omits titles/hosts by default.

Acceptance criteria:

- Replaying the same trace is byte-for-byte deterministic for model output.
- Every detector pull request reports corpus deltas.
- Model changes cannot silently reinterpret stored findings from another version.

### TLG-DET-002: robust time-based evidence

Priority: P1  
Effort: L  
Dependencies: TLG-DET-001, TLG-COL-002

Implementation:

- Keep a compact settled baseline outside the rolling recent window.
- Use short, medium, and long windows for slope, persistence, plateau, and release.
- Advance confirmation only on a distinct sample sequence.
- Require a minimum high-evidence duration, initially 120 seconds after warmup, independent of sample cadence.
- Add enter and clear thresholds for hysteresis.
- Add negative evidence for plateau, release, virtualization, and recovery.
- Use robust statistics such as median/MAD and a robust slope estimator where validated.
- Create separate outputs for notification severity and automatic-action eligibility.

Acceptance criteria:

- Re-evaluating identical samples never advances confirmation.
- Sample cadence does not change required evidence duration.
- A burst that releases or plateaus clears without oscillation.
- A rolling window cannot erase the settled baseline needed to recognize long-lived growth.

### TLG-DET-003: quality-aware evidence policy

Priority: P1  
Effort: M  
Dependencies: TLG-DET-002

Add:

- expected/received sample ratio;
- maximum gap and recent-sample age;
- overflow and dropped-entry rate;
- signal availability and failure state;
- settling completeness;
- distinct evaluation count;
- last-three and last-five recent trends;
- data-quality reason codes.

Policy:

- Quality can reduce or veto confidence but never add points.
- Resource activity and timer drift are contextual corroboration, not independent automatic-recovery evidence.
- DOM level, DOM slope, and mutation retention are correlated manifestations and do not count as three independent sensor families.
- Automatic eligibility requires a strong retained-DOM pattern, high quality, minimum current size, sustained recent slope, no release/plateau, fresh evidence, and an allowed site policy.

Acceptance criteria:

- Resource-only and drift-only traces never become automatically eligible.
- Overflow, missing mandatory signals, or stale evidence prevent automatic eligibility.
- UI can explain both positive evidence and quality limitations.

### TLG-DET-004: representative corpus

Priority: P1  
Effort: L  
Dependencies: TLG-DET-001

Positive supported fixtures:

- retained live-DOM leak at multiple rates;
- intermittent DOM leak;
- slow leak over a long session;
- leak with ordinary resource activity;
- recurrence after recovery.

Benign or ambiguous fixtures:

- stable large DOM;
- high mutation churn with release;
- burst and release;
- intentional infinite feed;
- virtualized grid;
- maps;
- chat and mail;
- media playback and conferencing;
- polling dashboard;
- slow SPA hydration;
- editor with dirty state;
- background sleep/wake;
- BFCache and SPA route changes;
- ad/resource churn;
- shadow DOM and iframe applications.

Known unsupported fixtures:

- pure JavaScript heap;
- detached DOM;
- worker/ArrayBuffer;
- GPU/canvas/media cache;
- privileged or restricted pages.

Acceptance criteria:

- Supported positive fixture detection recall at or above 95%.
- False confirmation below 1% on the maintained benign corpus.
- Positive fixtures confirm within 10 minutes under default cadence.
- Unsupported cases show coverage limitations rather than false assurance.
- Fixture descriptions and actual generation rates are verified from one shared configuration.

### TLG-DET-005: local feedback and effectiveness

Priority: P2  
Effort: M  
Dependencies: TLG-DET-004, TLG-UX-002

Implementation:

- Add Not a leak, Reset helped, and Problem returned.
- Keep feedback local and associated with model version and site policy.
- Not a leak suppresses the current document and can suggest a site-specific notify-only policy; it must not silently retrain global behavior.
- After recovery and restore, compare the new document's baseline and recurrence without claiming bytes reclaimed.
- Include redacted feedback in diagnostic export only with explicit selection.

Acceptance criteria:

- Feedback causes no network request.
- Users can undo a site-policy change.
- Effectiveness copy says the growth pattern stopped or returned, never memory recovered.

## 15. Workstream F — product UX, accessibility, and localization

### TLG-UX-001: redesign onboarding around scope and limitations

Priority: P1  
Effort: M  
Dependencies: TLG-PER-001

Flow:

1. Explain that the extension recognizes sustained resource-growth patterns, not exact memory.
2. Explain the normal five-minute-or-longer learning period.
3. Let the user choose Manual only, Selected sites, or All regular websites.
4. Keep recovery at notify-only.
5. Show a success state with Open dashboard, toolbar guidance, privacy/limitations, and a safe local demo fixture.
6. Introduce automatic recovery later through a separate safety walkthrough, only when the feature is enabled.

Acceptance criteria:

- A usability check confirms users can correctly answer: Does this show exact memory? Is automatic recovery on? Which sites can it access?
- Denying website permission leaves a useful manual-only product.
- Every scope choice maps to actual Firefox permissions, not just a preference.

### TLG-UX-002: live popup and dashboard

Priority: P1  
Effort: L  
Dependencies: TLG-STA-002, TLG-PER-002, TLG-DET-003

Popup:

- Show a concise global state: Paused, Permission needed, Monitoring selected sites, or Monitoring all sites.
- Default to concerning and pending tabs; collapse stable tabs.
- Show confidence band, evidence freshness, learning progress, and top reason.
- Demote the numeric score to advanced details.
- Hide recovery actions for stable/learning tabs.
- Add Stop, Cancel recovery, Snooze with duration, Ignore site, Site policy, and Details.
- Subscribe to a runtime port or storage/view-model changes while open.
- Preserve focus and announce only concise deltas.

Dashboard:

- Group by pending action, likely runaway, elevated, learning, stable, stale, and unsupported.
- Filter by window, site, state, and monitoring scope.
- Show a small evidence timeline, sample quality, signal availability, protections, and blind spots.
- Show local action history with precise outcomes and retention.
- Include local feedback and redacted export.

Acceptance criteria:

- New data appears without manual refresh.
- A likely-runaway protected tab remains prominent.
- Large sessions remain usable with at least 500 synthetic records.
- Keyboard focus remains on the logical control after each update.

### TLG-UX-003: accessible recovery dialog and pending countdown

Priority: P0 for manual safety, P1 for polish  
Effort: M  
Dependencies: TLG-SAF-003, TLG-SAF-008

Implementation:

- Replace window.confirm with an accessible extension-owned dialog.
- Display exact action, target, likely effect, edited/unknown warning, and token expiry.
- Require a separate explicit acknowledgment to override edited or unknown state.
- For automatic grace, display countdown, Cancel, Snooze, and Never auto-recover this site.
- On state change, close the dialog without action and explain why preparation expired.

Acceptance criteria:

- Focus is trapped and restored correctly.
- Escape cancels; Enter never bypasses a required warning acknowledgment.
- An inactive-to-active change closes the old consent flow and performs no action.
- Screen-reader output identifies action, target, warning, and remaining time.

### TLG-UX-004: site policy and reversible controls

Priority: P1  
Effort: M  
Dependencies: TLG-PER-001, TLG-LIF-001

Site policies:

- do not monitor;
- monitor and show in dashboard only;
- monitor and notify;
- allow automatic recovery after the global feature is enabled;
- temporary pause;
- default/global policy.

Controls:

- one-hour, until-restart, and indefinite pauses;
- document, tab, and site snooze with scope stated;
- confirmation plus Undo for Ignore site and receipt clearing;
- restore defaults;
- Recommended, Conservative, and Custom detector presets;
- one coherent save model: safe auto-save or one sticky global Save bar.

Acceptance criteria:

- New sites are never automatically allowlisted.
- Undo restores the exact previous policy.
- UI and runtime schema share bounds and presets.
- Scope and expiry are visible wherever a policy affects action.

### TLG-A11Y-001: WCAG and resilient popup layout

Priority: P1  
Effort: M  
Dependencies: TLG-UX-002

Implementation:

- Add role alert for errors and role status for noncritical success.
- Track and cancel message timers per target; never auto-hide critical errors.
- Avoid one large frequently changing aria-live list.
- Add forced-colors and prefers-reduced-motion rules.
- Make popup width responsive and support 200–400% zoom.
- Raise small action/footer text to readable sizes.
- Provide contextual accessible names and range aria-valuetext.
- Validate focus order, modal behavior, focus restoration, and keyboard-only operation.

Release gate:

- Zero serious or critical automated accessibility violations.
- Complete keyboard-only onboarding, monitoring, review, cancel, and settings flows.
- No clipping or horizontal scrolling at 200% zoom.
- WCAG AA contrast in default and forced-colors/high-contrast modes.
- VoiceOver on macOS and NVDA on Windows smoke tests.

### TLG-I18N-001: localize every user-visible string

Priority: P1  
Effort: M  
Dependencies: target copy approval

Implementation:

- Move HTML, TypeScript, notification, badge, error, reason, receipt, and accessibility strings to browser.i18n.
- Use parameterized messages and plural forms rather than string concatenation.
- Add a pseudo-locale in CI.
- Keep reason codes stable and translate their presentation separately.

Acceptance criteria:

- Static analysis finds no unapproved hard-coded user-facing string.
- Pseudo-locale detects clipping and concatenation errors.
- Sorting and state logic never depend on translated text.

## 16. Workstream G — privacy and security hardening

### TLG-SEC-001: written threat model

Priority: P1  
Effort: S

Cover:

- malicious page messages and oversized numeric payloads;
- stale or replaced documents;
- UI-command impersonation;
- corrupt or downgraded storage;
- alarm replay and clock manipulation;
- notification information exposure;
- page-derived title/hostname injection;
- optional-permission escalation;
- denial of service through mutation storms;
- build and dependency compromise;
- diagnostic export leakage;
- recovery logic as the principal destructive authority.

Acceptance criteria:

- Every threat has prevention, detection, test, and residual-risk entries.
- A security reviewer signs off before automatic recovery beta.
- SECURITY.md has a real private contact before public listing.

### TLG-SEC-002: message and authority boundaries

Priority: P0  
Effort: M  
Dependencies: TLG-STA-001, TLG-LIF-002

Implementation:

- Validate every message through strict discriminated schemas and reject extra authority-bearing fields.
- Derive tab, frame, origin, extension page, and document identity from Firefox sender metadata.
- Bind collector preflight to the exact document.
- Use narrow background-to-collector configuration rather than letting every collector read the full ignored-host list and preferences.
- Keep tab APIs in the recovery coordinator only.
- Add explicit maximum message size, sample values, sequences, and rate limits.

Acceptance criteria:

- Fuzzed collector and UI messages cannot create records outside their sender or call a tab API.
- A content script cannot invoke UI-only commands.
- A page cannot supply its own tab ID, hostname authority, document ID, or action token.

### TLG-SEC-003: local-only and privacy contract tests

Priority: P1  
Effort: M

Implementation:

- Run E2E with an outbound-request monitor and assert zero extension-origin network requests.
- Snapshot the exact storage field allowlist for each retention mode.
- Assert that no page text, HTML, form value, cookie, request body, account ID, or screenshot reaches messages or storage.
- Keep all DOM rendering through textContent or safe attribute APIs.
- Add an explicit extension-page content security policy if it improves on the MV3 default without breaking Firefox compatibility.
- Update docs/privacy.md and the AMO data declaration from actual code before each release.

Acceptance criteria:

- Network and storage privacy tests pass in CI.
- Diagnostic export is redacted by default and previews every field before save.
- The AMO data-collection declaration and store description match the shipped bundle.

### TLG-SEC-004: advanced diagnostics gate

Priority: research  
Effort: M

Before any userScripts or page-world experiment:

- write a separate data-flow and page-compatibility threat model;
- make the permission optional and separately requested;
- default the feature off;
- prove no values, URLs, payloads, or page content are collected;
- run compatibility fixtures for frameworks and CSPs;
- confirm AMO policy acceptability;
- prevent advanced counters from authorizing automatic recovery.

## 17. Workstream H — test strategy

### 17.1 Unit tests

Required targets:

- every schema decoder and migration;
- monitoring, detection, recovery, and safety reducers;
- all safety predicates including unknown values;
- action-token creation, expiry, single use, and revision checks;
- receipt formatting and circuit accounting;
- detector statistics, quality, hysteresis, and baseline segmentation;
- view model, sorting, aggregation, and badge derivation;
- retention and eviction.

Coverage gates:

- 100% branch coverage for destructive recovery authorization and execution code.
- At least 95% statements and 90% branches for state schemas, migrations, permission coordinator, recovery coordinator, and safety policy.
- At least 90% statements and 85% branches across runtime TypeScript.
- Coverage configuration includes background, collector-testable modules, storage, permissions, notifications, and UI view-model logic.

Coverage is evidence, not the only gate; browser races still require integration and E2E tests.

### 17.2 Fake-browser integration harness

Create a deterministic WebExtension harness with:

- tabs and windows;
- permissions and registered scripts;
- alarms and fake time;
- storage.local and storage.session;
- runtime messages, ports, install/startup, and event-page restart;
- notifications and badge APIs;
- webNavigation and native document IDs;
- controlled tab API success, block, timeout, and failure.

Mandatory scenarios:

- disable or revoke at every point in a pending recovery;
- notify-only change and ignore-site during countdown;
- inactive-to-active action change;
- navigation at every await boundary;
- dirty input after last sample;
- preflight timeout or wrong document;
- camera, microphone, screen, fullscreen, attention, audible, pinned, loading, and non-auto-discardable blocks;
- duplicate alarm, message, and restart delivery;
- blocked discard across unlimited later samples;
- cooldown across reload and discard restore;
- sleep/wake and clock changes;
- corrupt storage and partial migrations;
- concurrent receipt and state writes;
- notification aggregation, navigation, and click routing;
- registration reconciliation after update.

Property-based invariant:

An automatic tab API call occurs only when every required predicate is true in the same serialized execution transaction, the operation token is current and single-use, and the native document identity matches.

Run at least 10,000 randomized lifecycle schedules for this property before beta.

### 17.3 Collector tests

Extract collector algorithms behind DOM adapters so Node-based tests can cover:

- callback-wide node/time cap;
- saturation and overflow;
- observer failure and dropped entries;
- dirty-state transitions and freshness;
- timer scheduling, jitter, stop, and expiry;
- lifecycle segmentation;
- signal-health serialization;
- no retained Node references after callback.

Use real page fixtures for behavior that a DOM emulator cannot faithfully reproduce.

### 17.4 Real Firefox E2E

Automate with WebDriver BiDi or the supported Firefox extension-testing stack:

- install signed/unsigned test build into a fresh profile;
- onboarding and permission choices;
- per-site and all-site content registration;
- manual session start, progress, stop, and expiry;
- restricted page explanations;
- finding notification and detail routing;
- discard, restore, reload verification, and beforeunload block;
- active, pinned, audible, attention, edited, iframe, camera/mic/screen, and autoDiscardable protections;
- navigation, redirect, BFCache, SPA history, and tab replacement;
- event-page restart with operations and cooldowns;
- extension update and storage migration;
- delete-all and permission revoke;
- keyboard and focus flows.

Platform matrix:

| Browser | macOS | Windows | Linux |
|---|---:|---:|---:|
| Current Firefox Release | required | required | required |
| Firefox Beta | required smoke | required smoke | required smoke |
| Supported Firefox ESR | required or explicitly unsupported | required or explicitly unsupported | required or explicitly unsupported |
| Firefox 142–152 compatibility tier | notify/manual only test if retained | notify/manual only test if retained | notify/manual only test if retained |
| Firefox 153+ native documentId tier | full recovery suite | full recovery suite | full recovery suite |

### 17.5 Replay, performance, and soak

For every model change:

- replay the full versioned corpus;
- report confusion matrix, time to finding, quality failures, and state-transition deltas;
- benchmark mutation callbacks, samples, recounts, background work, state writes, and UI rendering;
- profile representative large pages;
- run 100-tab/eight-hour soak;
- run a 500-tab synthetic state/storage stress test;
- listen for runtime.onPerformanceWarning and treat medium/high extension warnings as failures.

### 17.6 Privacy, security, and accessibility automation

- zero extension-origin runtime network requests;
- exact stored-field and retention snapshots;
- malformed-message and corrupt-storage fuzzing;
- static checks for dynamic evaluation, remote code, and unsafe HTML sinks;
- dependency audit including documented development-only advisories;
- axe or equivalent automation on onboarding, popup, dashboard, details, and options;
- pseudo-locale, forced-colors, reduced-motion, and zoom tests.

## 18. Workstream I — production, distribution, and operations

### TLG-REL-001: decide the update channel before distributing 0.1.1

Priority: P0 operational  
Effort: S

Current fact:

- 0.1.0 was signed as unlisted/self-distributed.
- Its manifest has no update_url.
- Firefox can discover a higher listed AMO version for this ID, but another unlisted version will otherwise need manual installation unless a reachable update mechanism is established.

Recommendation:

- Use the current unlisted build only for internal dogfood.
- Move to a listed AMO channel for the consumer product and let AMO deliver signed updates.
- If self-hosting remains a requirement, manually install a signed build containing a stable HTTPS update_url and operate a tested update manifest/XPI host. Do not use both strategies casually.

Acceptance criteria:

- A clean 0.1.0 profile successfully reaches the chosen next version in an update rehearsal.
- Update failure, signature failure, downgrade, and rollback behavior are documented.
- User-facing instructions do not imply that the current unlisted install updates automatically.

### TLG-REL-002: freeze or migrate the extension ID

Priority: P0 operational  
Effort: S

Decision:

- Keeping tab-leak-guard@local.invalid preserves continuity with the signed and installed add-on.
- Changing it creates a distinct add-on identity and requires a deliberate reinstall/migration path.

Recommendation:

- If only the developer has installed 0.1.0, decide now whether a permanent public ID is worth a clean break.
- Once beta users exist, freeze the ID permanently.

Acceptance criteria:

- The decision is written in the release decision log.
- AMO listing, update manifest, tests, and docs all use exactly one ID.

### TLG-REL-003: deterministic release artifacts

Priority: P1  
Effort: M

Implementation:

- Align esbuild target, TypeScript libraries, manifest strict_min_version, and tested Firefox tiers.
- Produce development and production builds; decide whether production source maps ship.
- Generate extension archive, human-readable AMO source archive, content manifest, dependency lock hash, SBOM, SHA-256 file, and release notes in one command.
- Normalize archive order and timestamps where tooling permits and compare clean-checkout outputs.
- Verify no node_modules, fixtures, secrets, local profiles, build configuration, or unintended maps enter the XPI.
- Record Node, npm, esbuild, TypeScript, web-ext, and OS versions.

Acceptance criteria:

- Two clean builds produce identical unpacked file hashes; archive-level reproducibility is documented if ZIP metadata prevents identity.
- Manifest and package versions cannot diverge.
- CI uploads unsigned review artifacts only; signing credentials never enter the repository.

### TLG-REL-004: CI and dependency policy

Priority: P1  
Effort: M

Implementation:

- Split fast unit, integration, E2E, performance, accessibility, package, and security jobs.
- Pin actions to reviewed versions or commit SHAs according to project policy.
- Keep package-lock committed and use npm ci.
- Run production and development dependency audits separately; document accepted development-only findings with expiry/review dates.
- Add Dependabot or equivalent updates with tests.
- Validate the submitted source archive can reproduce the extension bundle.

Acceptance criteria:

- Required branch protection checks cover every release gate.
- No unresolved production dependency vulnerability ships.
- The documented web-ext/image-size advisory is re-evaluated on every dependency update.

### TLG-REL-005: release assets and support

Priority: P1  
Effort: M

Deliver:

- final PNG icons at 16, 32, 48, 96, and 128 pixels plus reviewed theme variants;
- AMO screenshots, summary, detailed description, category, support URL, privacy notice, and release notes;
- real security and support contacts;
- known limitations and supported Firefox versions;
- bug-report template and redacted diagnostic instructions;
- public changelog and version support policy.

Acceptance criteria:

- All assets are checked at 1x/2x and light/dark/high-contrast contexts.
- Store copy uses the same detection language and permission explanation as the extension.
- AMO automatic and human review materials are reproducible from the tagged source.

### TLG-REL-006: rollback without remote configuration

Priority: P0 before auto beta  
Effort: M

Implementation:

- Keep a safe-mode migration that can force notify-only and cancel all operations in an emergency signed update.
- Maintain a last-known-good tag and source/artifact hashes.
- Practice producing, signing, installing, and verifying an emergency update.
- Do not add a hidden remote kill switch; it would contradict the local-only architecture and add a new trust dependency.

Acceptance criteria:

- Rollback drill completes from detection to an installed safe build using the chosen update channel.
- The safe update cancels pending recovery before any other initialization.
- Support instructions cover manual update for users still on unlisted builds.

## 19. Measurable product and release gates

### 19.1 Safety gates

All are hard blockers:

- Zero tabs.discard or tabs.reload calls after pause, permission revoke, notify-only change, ignore-site, extension update, stale evidence, missing collector, unknown mandatory safety state, or document mismatch.
- Zero implicit changes between the action shown to the user and the action executed.
- Zero automatic reloads of active tabs.
- Zero automatic actions on edited, unknown, sharing, non-auto-discardable, pinned, audible, attention-requesting, loading, recently accessed, fullscreen, snoozed, ignored, or cooldown tabs.
- Exactly one automatic attempt per blocked/failed document.
- At most one tab API call and one terminal receipt per operation ID.
- Ten thousand randomized lifecycle and safety schedules with no invariant violation.
- One successful emergency safe-mode/rollback drill.

### 19.2 Detection gates

- At least 95% detection recall on versioned, supported retained-DOM positive fixtures.
- Below 1% false confirmations on the maintained benign corpus.
- Zero automatic eligibility from resource activity or timer drift alone.
- At least 120 seconds of high evidence from distinct samples after warmup before automatic eligibility.
- Supported positive fixtures reach a finding within 10 minutes under default settings.
- Every finding includes model version, quality, freshness, evidence reasons, and coverage limitations.
- Unsupported leak classes are labeled as blind spots and are not counted as false assurances.

These are corpus gates, not claims about every website on the internet. Real-world copy must remain probabilistic.

### 19.3 Performance and boundedness gates

- Mutation callback below 5 ms p95 and 10 ms p99 on the reference stress fixture.
- Normal collection sample below 5 ms p95.
- Full DOM recount below 20 ms p95 or adaptive backoff engages.
- Background work below 2 ms p95 per sample on the reference machine.
- No more than six routine session checkpoints per minute globally.
- Less than 5 MB of session state at the 500-tab synthetic cap.
- No unbounded record, sample, receipt, diagnostic, alarm, listener, or timer growth.
- 100-tab/eight-hour soak completes with zero medium/high extension performance warnings.

Record the reference hardware, Firefox version, page fixtures, and percentile method with every benchmark result.

### 19.4 Reliability gates

- Every v1 state shape migrates to v2 or is safely dropped.
- Corrupt storage never prevents startup or enables action.
- Event-page restart, extension update, tab replacement, BFCache, redirect, sleep/wake, and clock changes are deterministic.
- Notification, badge, popup, and dashboard derive from the same view model.
- Current Release, Beta, and the declared ESR policy pass on macOS, Windows, and Linux.
- Update rehearsal from installed 0.1.0 to the selected release channel succeeds.

### 19.5 Privacy and security gates

- Zero runtime extension-origin network requests.
- Zero remote code or dynamic evaluation.
- Exact storage-field allowlist and retention tests pass.
- System notifications reveal no site/title by default.
- Delete-all cancels authority before deleting state.
- Diagnostic export is redacted by default and previewed before save.
- Threat model and AMO data declaration match the shipped bundle.
- No unresolved production dependency vulnerability.
- Real private security contact is published.

### 19.6 UX and accessibility gates

- At least 8 of 10 representative usability participants correctly understand exact-memory limitations, recovery default, and their granted site scope.
- Zero serious or critical automated accessibility violations.
- Full keyboard flow, visible focus, and focus restoration.
- No clipping/horizontal scrolling at 200% zoom.
- WCAG AA contrast in default and forced-colors/high-contrast modes.
- VoiceOver and NVDA smoke tests pass.
- Pseudo-localization finds no hard-coded or clipped critical string.

### 19.7 Automatic-recovery beta gate

Automatic recovery can be made generally visible only after:

- every safety gate above passes;
- all destructive paths have 100% branch coverage;
- full native-document-ID Firefox E2E matrix passes;
- notify-only closed beta has run for at least two weeks without a critical safety defect;
- automatic mode has run for at least two weeks on an explicit per-site allowlist;
- at least 1,000 privacy-preserving monitored tab-hours are represented by opt-in local summaries;
- zero unintended automatic action is reported or reproduced;
- every blocked/failed action is understood and no retry loop occurs;
- a security/safety reviewer signs the release record.

Any unintended automatic action resets the beta clock, disables the feature in the next safe build, and requires a root-cause test before resumption.

## 20. Rollout plan

### Stage 0: 0.1.1 internal safety update

- Choose listed AMO versus self-hosted updates.
- Decide extension ID.
- Force notify-only and remove action authority.
- Install the signed update in the existing regular Firefox profile manually if the chosen channel cannot reach 0.1.0.
- Verify migration, cancellation, permissions, and core monitoring.

### Stage 1: notify-only dogfood

- Use selected-site access by default.
- Run daily browsing plus the automated fixture corpus.
- Collect no remote telemetry.
- Use redacted export only when a tester deliberately files a report.
- Fix all P0/P1 monitoring, lifecycle, or privacy defects before expanding.

### Stage 2: closed notify-only beta

- Recruit a small cross-platform cohort.
- Run at least two weeks.
- Review false confirmations, missed supported fixtures, collector overhead, permissions comprehension, notification privacy, and accessibility.
- Freeze detector model version during the latter half so evidence is comparable.

### Stage 3: automatic-recovery safety beta

- Require Firefox with native documentId.
- Require a separate safety walkthrough and explicit per-site allowlist.
- Keep global default notify-only.
- Always present a grace countdown with Cancel and Snooze.
- Locally record precise receipts and allow immediate export.
- Stop the stage on any unintended action.

### Stage 4: listed 1.0

- Notify-only remains the default.
- Automatic recovery is opt-in and per-site, and ships only if the beta gate passed.
- AMO provides the update channel unless the release decision explicitly documents self-hosting.
- Publish limitations, privacy, supported versions, changelog, and support contacts.

### Emergency response

1. Reproduce and classify the issue.
2. If recovery safety is implicated, prepare a signed safe-mode update that cancels all operations and forces notify-only.
3. Verify the update against a profile with a pending alarm.
4. Publish concise release notes and support guidance.
5. Add a deterministic regression test.
6. Resume the feature only after the full affected gate passes again.

## 21. Recommended implementation phases and estimates

These are planning ranges for one experienced extension engineer with design/test support, not delivery promises.

| Phase | Work | Estimate | Blocking evidence |
|---|---|---:|---|
| 0 | Update/ID decision, 0.1.1 quarantine design, threat-model delta | 1–2 engineer days | Written decisions |
| 1 | 0.1.1 migration, master-off, retry suppression, integration harness skeleton, signed update rehearsal | 4–7 engineer days | Safety quarantine tests |
| 2 | State split, schemas/migrations, persistence queues, document identity, recovery transaction | 2–3 engineer weeks | Lifecycle and property tests |
| 3 | Permission scopes, temporary sessions, notification lifecycle/privacy, retention | 1–2 engineer weeks | Permission/privacy E2E |
| 4 | Collector budgets, health, adaptive cadence, lifecycle segmentation | 2 engineer weeks | Performance suite and soak |
| 5 | Trace/replay, detector v2, corpus and calibration | 2–4 engineer weeks | Accuracy report |
| 6 | Dashboard, popup, site policy, consent UX, i18n, accessibility | 2–3 engineer weeks | UX/a11y gates |
| 7 | Cross-platform E2E, packaging, AMO assets, notify-only beta | 2–4 calendar weeks plus fixes | Beta report |
| 8 | Automatic-recovery allowlist beta | At least 2 calendar weeks plus fixes | Automatic beta gate |

Parallelism:

- UI design and i18n extraction can begin while the state reducer is built, using agreed view-model fixtures.
- Corpus fixture authoring can run beside state work.
- Release channel and artifact automation should not wait for feature completion.
- Detector scoring should not change before trace/replay exists.
- Automatic recovery must not be reconnected before the state model, native identity gate, action transaction, and property tests are complete.

## 22. First 15 implementation issues to open

| Order | Issue | Release | Depends on |
|---:|---|---|---|
| 1 | TLG-REL-001 Decide AMO listed versus self-host update path | 0.1.1 | none |
| 2 | TLG-REL-002 Freeze or deliberately replace extension ID | 0.1.1 | none |
| 3 | TLG-SAF-001 Force notify-only and cancel old automatic authority on update | 0.1.1 | none |
| 4 | Build fake-browser harness for tabs, permissions, alarms, storage, and time | 0.1.1 | none |
| 5 | TLG-SAF-002 Master-off transaction and monitoring epoch | 0.1.1 | issues 3–4 |
| 6 | TLG-SAF-006 Suppress repeated automatic attempts | 0.1.1 | issue 4 |
| 7 | TLG-STA-001 Runtime schemas plus v1-to-v2 migration | 0.2 | issue 3 |
| 8 | TLG-STA-002 Split monitoring, detection, recovery, and safety state | 0.2 | issue 7 |
| 9 | TLG-LIF-002 Native documentId gate and lifecycle registry | 0.2 | issue 8 |
| 10 | TLG-SAF-003 Two-phase recovery prepare/execute protocol | 0.2 | issues 5, 8, 9 |
| 11 | TLG-SAF-004 Fresh tri-state edited-input preflight | 0.2 | issues 9–10 |
| 12 | TLG-SAF-005 Sharing, autoDiscardable, fullscreen, and complete safety guards | 0.2 | issue 11 |
| 13 | TLG-SAF-007 Per-tab mutex and operation idempotency | 0.2 | issue 10 |
| 14 | TLG-LIF-001 Durable scoped cooldown/snooze and startup reconciliation | 0.2 | issues 7–8 |
| 15 | TLG-PER-001 Manual, selected-site, and all-site permission scopes | 0.2 | issues 7–9 |

Next queue after those:

- collector callback-wide budgets and health;
- state write debouncing and total-size caps;
- notification privacy/lifecycle;
- explicit temporary monitoring;
- trace/replay and corpus;
- detector v2;
- dashboard and accessible recovery UX;
- cross-platform E2E and release automation.

## 23. Per-ticket definition of done

Every implementation ticket must include:

- user-visible behavior and non-goals;
- threat/safety impact;
- data and permission impact;
- state transition or migration impact;
- unit and integration tests;
- Firefox E2E scenario when browser behavior is involved;
- accessibility and localization impact;
- performance budget when collector/background/UI work changes;
- updated privacy, architecture, limitation, and release documentation;
- before/after screenshots for UI;
- clean npm run verify;
- relevant coverage and corpus delta;
- no unexplained web-ext warning;
- reviewer sign-off from the owner of the affected safety boundary.

No ticket that changes action authority is done with unit tests alone.

## 24. Decision log to close before implementation

| Decision | Recommendation | Deadline |
|---|---|---|
| Distribution | Listed AMO for consumer automatic updates; unlisted only for internal dogfood | Before 0.1.1 distribution |
| Extension ID | Decide now; preserve current ID if continuity matters, otherwise migrate before adding testers | Before 0.1.1 signing |
| Firefox minimum | Keep 142 for notify/manual only if useful; require/document feature-gated 153+ for automatic recovery, or raise minimum | During 0.2 design |
| Default permission | Manual or selected-site, not all sites | During 0.2 design |
| Default notification content | Generic, no site/title | During 0.2 design |
| Auto recovery | Hidden/disabled in 0.1.1; later opt-in and per-site only | Fixed policy |
| Retention | Current session or 24 hours as default; confirm in usability/privacy review | During 0.2 design |
| Source maps | Keep in review artifact or omit from production XPI based on debugging/reproducibility tradeoff | Before 0.5 |
| Advanced page-world instrumentation | Not in 1.0 | Fixed scope |
| Anonymous telemetry | None for 1.0 | Fixed scope |

## 25. Documentation work

Update as implementation lands:

- README.md: link this roadmap, correct one-off scan wording, automatic-retry claim, and automatic-recovery status.
- IMPLEMENTATION_PLAN.md: mark the original prototype milestones complete and point to this vNext plan.
- docs/architecture.md: target state machines, recovery transaction, document identity, permission scopes, budgets, and persistence.
- docs/privacy.md: notification display, retention choices, delete-all, exports, and exact stored-field table.
- docs/platform-spike.md: documentId compatibility, sharingState, autoDiscardable, restricted sites, discard/reload verification, BFCache, and all target browser results.
- docs/release-checklist.md: every gate in Sections 19 and 20.
- SECURITY.md: real contact, threat model link, dependency exception review dates, and safe-update procedure.
- AMO_SOURCE_SUBMISSION.md: deterministic build command, tool versions, source archive contents, and dependency/install explanation.
- CHANGELOG.md: user-visible changes, migrations, fixed safety defects, known limitations, and update instructions.

Until the fixes ship, remove or qualify claims that:

- a manual scan is one-off;
- pending action always cancels when monitoring is paused or permission is revoked;
- failed discards cannot retry;
- cooldown necessarily survives recovery;
- every automatic action is based on fresh complete safety state.

## 26. Authoritative platform references

- [Mozilla: optional permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_permissions)
- [Mozilla: permissions and optional host access](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions)
- [Mozilla: content scripts, permissions, and restricted domains](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)
- [Mozilla: Work with documentId](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Work_with_documentId)
- [MDN browser compatibility data: runtime.MessageSender.documentId](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/runtime.json)
- [Mozilla: tabs.Tab](https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/tabs/Tab)
- [Mozilla: runtime.onPerformanceWarning](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onPerformanceWarning)
- [Mozilla: PerformanceObserver data and dropped entries](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Performance_data)
- [Mozilla: performance.measureUserAgentSpecificMemory](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory)
- [MDN browser compatibility data: Firefox memory APIs](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Performance.json)
- [Mozilla: userScripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts)
- [Firefox Extension Workshop: self-distribution and updates](https://extensionworkshop.com/documentation/publish/self-distribution/)
- [Firefox Extension Workshop: updating an extension](https://extensionworkshop.com/documentation/manage/updating-your-extension/)
- [Firefox Extension Workshop: distributing MV3 versions](https://extensionworkshop.com/documentation/publish/distribute-manifest-versions/)
- [Firefox Extension Workshop: add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)

Verified platform conclusions as of 2026-08-30:

- Standard Firefox WebExtensions do not receive performance.memory or measureUserAgentSpecificMemory, so exact per-tab memory remains unavailable.
- runtime.MessageSender.documentId is supported from Firefox 153 according to current compatibility data and exists specifically to avoid frame/document replacement races.
- optional_host_permissions supports runtime site access; permissions events must be used to reconcile external revocation.
- PerformanceObserver resource entries describe activity; droppedEntriesCount reports loss from a full observation buffer.
- runtime.onPerformanceWarning reports problems caused by the extension, not evidence that a web page leaks.
- An unlisted/self-distributed extension needs a working update_url for self-hosted automatic updates; without one, a higher listed AMO version can be discovered, otherwise updates must be distributed to users.

Recheck compatibility data and AMO guidance at each release because Firefox and publishing requirements change.

## 27. Final go/no-go checklist for 1.0

### Product

- [ ] Scope and non-goals match UI and store copy.
- [ ] Notify-only is the default.
- [ ] Automatic recovery is either gated off or has passed the complete beta gate.
- [ ] Per-site permission and recovery policy are understandable and reversible.

### Safety

- [ ] Every Section 19.1 gate has attached CI or beta evidence.
- [ ] Native document identity is required for automatic recovery.
- [ ] Master-off and safe-mode update drills pass.
- [ ] Action shown always equals action executed.
- [ ] Unknown safety state always blocks automation.

### Detection and performance

- [ ] Versioned corpus report passes.
- [ ] Resource activity and timer drift cannot independently authorize recovery.
- [ ] Sample quality and coverage limitations are visible.
- [ ] Performance and soak budgets pass on documented hardware.

### Privacy, security, and accessibility

- [ ] Zero-network and stored-field tests pass.
- [ ] Notification privacy and delete-all pass.
- [ ] Threat model reviewed.
- [ ] Security contact active.
- [ ] Accessibility, zoom, forced colors, VoiceOver, NVDA, and pseudo-locale gates pass.

### Distribution and operations

- [ ] Extension ID and update channel frozen.
- [ ] Installed 0.1.0-to-current update rehearsal passes.
- [ ] Clean source reproduction and artifact hashes recorded.
- [ ] AMO source, privacy declaration, assets, and release notes complete.
- [ ] Rollback update produced and rehearsed.
- [ ] Full Firefox/OS matrix completed or exclusions clearly documented.

## 28. Recommended next move

Do not start with a new detector signal or dashboard. Open Issues 1–6 from Section 22, choose the update path and extension ID, then build the fake-browser harness and ship the notify-only 0.1.1 safety update. That sequence reduces real user risk immediately and creates the test foundation needed for every ambitious improvement that follows.
