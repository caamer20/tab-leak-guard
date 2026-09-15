# Firefox Tab Leak Guard — Implementation Plan

> This document describes the original prototype plan. The post-prototype audit and production roadmap are maintained in [IMPROVEMENT_PLAN.md](./IMPROVEMENT_PLAN.md).

Status: production-oriented prototype implemented; public-release validation remains gated  
Last platform validation: 2026-08-29  
Initial target: Firefox Desktop, Manifest V3, addons.mozilla.org distribution

Implementation note: the working prototype, automated tests, deterministic fixture lab, privacy/security documentation, build pipeline, Mozilla lint results, and unsigned package now live in this repository. Cross-OS testing, multi-week beta calibration, AMO review/signing, and enabling automatic recovery by default remain release gates rather than tasks that can be completed from a single local build environment.

## 1. Product outcome

Build a Firefox extension that:

1. Monitors ordinary web tabs with low overhead.
2. Identifies tabs showing sustained patterns consistent with a memory leak.
3. Explains why a tab was flagged without claiming more precision than Firefox exposes.
4. Notifies the user without notification spam.
5. Resets only the affected tab, using the least disruptive recovery method available.
6. Avoids resetting tabs that are active, audible, pinned, contain unsaved input, show a modal, or are otherwise unsafe to touch.
7. Runs locally by default and does not transmit browsing activity or page content.

Working product name in this plan: **Tab Leak Guard**.

## 2. Platform reality and the resulting product strategy

### 2.1 What a normal Firefox extension can do

- Inject a content script into web pages for which the user grants host access.
- Observe the live DOM and standard page performance signals.
- Track tab lifecycle, activity, visibility, pinned state, audible state, and discarded state.
- Show a toolbar badge, popup, settings page, and operating-system notification.
- Reload a specific tab with `browser.tabs.reload(tabId)`.
- Discard a specific inactive tab with `browser.tabs.discard(tabId)`. A discarded tab remains in the tab strip and reloads when selected.

### 2.2 What a normal Firefox extension cannot do reliably

- Read exact per-tab heap size or resident memory.
- Read Firefox's internal `about:memory` or `about:processes` data.
- Inject into privileged pages such as `about:*`, the built-in PDF viewer, reader view, and Mozilla-restricted domains.
- Discard the active tab.
- Discard a tab whose page would show a `beforeunload` prompt.
- Reliably identify pure JavaScript heap leaks, detached-DOM leaks, graphics/GPU leaks, or browser-engine leaks from standard WebExtension signals alone.

The current MDN browser compatibility data reports both `performance.memory` and `performance.measureUserAgentSpecificMemory()` as unsupported in Firefox. This is the central design constraint.

### 2.3 Honest product contract

The extension must use language such as **“possible resource leak”**, **“sustained resource growth”**, and **“high-confidence leak pattern.”** It must not display invented megabyte values or say that a leak is proven.

The shippable extension will detect observable leak patterns, especially:

- continuously retained live DOM nodes;
- excessive resource accumulation;
- sustained mutation growth with little release;
- visible-page responsiveness degradation;
- optionally, page-runtime handle growth from advanced instrumentation.

Exact memory telemetry is a future capability gate, not an MVP dependency. If Firefox adds a supported memory API later, it can become another signal behind feature detection.

### 2.4 Recommended recovery model

- **Inactive safe tab:** discard it. This immediately unloads its document while preserving the tab.
- **Active tab:** warn the user and offer a manual reload. Never silently discard it because Firefox will not do so, and a reload may lose unsaved page state.
- **Inactive but protected tab:** notify only. Protected includes pinned, audible, dirty, modal/attention, recently used, or cooldown state.
- **Failed discard:** verify `tab.discarded`; if it is still false, mark the recovery as blocked and do not retry in a loop.
- **Never close and recreate a tab in the MVP.** That approach risks losing history, container identity, opener relationships, form state, and session semantics.

## 3. Scope

### 3.1 MVP scope

- Firefox Desktop only.
- HTTP and HTTPS top-level pages.
- Manual current-tab scan using `activeTab`.
- Optional continuous monitoring after the user grants broad host access.
- Per-document sampling and heuristic scoring.
- Toolbar popup showing all monitored tabs and their state.
- Warning notification plus toolbar badge.
- Manual “reset now,” “snooze,” and “ignore this site” actions.
- Optional automatic discard for confirmed, inactive, safe tabs.
- Local-only preferences, tab summaries, and short reset history.
- English UI, with strings structured for later localization.
- No private browsing support in the first release.

### 3.2 Explicitly out of scope for MVP

- Exact memory values.
- Firefox Android.
- Chromium support.
- Cloud dashboards or remote telemetry.
- Page-content capture, form-value capture, or URL-history collection.
- Privileged/enterprise-only Firefox APIs.
- Native companion applications.
- Automatically resetting active, audible, pinned, dirty, or recently accessed tabs.
- Automatically handling browser-internal or Mozilla-restricted pages.
- Deep per-framework logic for React, Vue, Angular, or other libraries.

### 3.3 Later candidates

- All-frame aggregation for large iframe applications.
- Optional advanced main-world instrumentation for outstanding Workers, Blob URLs, WebSockets, and EventSources.
- Site-specific learned baselines stored locally.
- Firefox Android after API, lifecycle, and UX validation.
- Exportable local diagnostic report with explicit user action and URL redaction.
- Enterprise configuration through managed storage.

## 4. Product modes and defaults

### 4.1 Monitoring modes

1. **Manual scan**
   - Works only after the user invokes the extension for the active tab.
   - Uses `activeTab` permission.
   - Useful before the user grants access to all sites.

2. **Continuous monitoring**
   - Requires an explicit user gesture to request optional host access for HTTP/HTTPS pages.
   - Registers the collector only after permission is granted.
   - Stops monitoring a site promptly if permission is revoked.

### 4.2 Recovery modes

1. **Notify only — release default**
   - Flags the tab and explains the evidence.
   - User chooses whether to discard/reload.

2. **Auto-reset safe background tabs — opt in**
   - Discards only high-confidence, inactive, unprotected tabs after a grace period.
   - Keeps a site-level circuit breaker and per-tab cooldown.

3. **Aggressive mode — post-MVP only**
   - Lower thresholds or broader actions.
   - Must carry clear warnings and is not suitable as an initial release feature.

The beta may expose auto-reset behind a setting but keep notify-only as the default until false-positive and data-loss targets have been met.

## 5. User experience

### 5.1 Onboarding

The first-run page should:

1. Explain that Firefox does not expose exact per-tab memory to extensions.
2. Explain what signals the extension can observe.
3. State that analysis happens locally and no browsing data is transmitted.
4. Offer:
   - “Scan only when I ask”; and
   - “Monitor websites continuously.”
5. Request broad host access only after the user chooses continuous monitoring.
6. Default recovery to notify-only.
7. Explain unsupported pages and private-window behavior.

### 5.2 Toolbar states

- Green/empty badge: no suspected tabs.
- Amber badge with count: tabs under observation.
- Red badge with count: confirmed high-confidence tabs.
- Gray/paused: monitoring permission absent or monitoring paused.

The badge count must be aggregated, not updated on every sample.

### 5.3 Popup

The popup should show:

- monitoring status and site access status;
- suspected/confirmed tabs first;
- tab title and hostname, never a full URL unless the user expands details;
- confidence label: healthy, watching, suspected, confirmed, cooldown, unsupported;
- concise evidence, for example “DOM grew by 38,000 nodes over 8 minutes and did not stabilize”;
- safety state: active, audible, pinned, unsaved input, recently accessed;
- actions:
  - reset now;
  - focus tab;
  - snooze for 30 minutes;
  - ignore this site;
  - resume monitoring;
  - view technical details.

### 5.4 Notifications

Firefox currently documents only basic notification fields as supported, so the design must not depend on notification buttons.

- Use one stable notification per affected tab or one batched notification when several tabs are confirmed together.
- Clicking the notification focuses the relevant tab or opens the extension details view.
- Rate-limit to at most one new leak notification per tab per cooldown and one aggregate burst per five minutes.
- Use the toolbar badge as the durable state; OS notifications are transient and can be disabled by the operating system.
- If auto-reset is enabled, notify at confirmation, wait through a configurable grace period, re-check safety, then discard.

### 5.5 Reset receipts

After a successful discard or reload, show:

- what action occurred;
- when it occurred;
- the reason;
- whether the tab has reloaded yet;
- a local “do not auto-reset this site again” action.

Do not claim an exact amount of memory recovered.

## 6. Architecture

```text
Web page
  |
  | isolated content script: primitive counters and samples
  v
Collector + small in-document ring buffer
  |
  | typed, versioned messages; no page content
  v
Manifest V3 Firefox event page
  |-- validation and document identity
  |-- pure detector/scoring engine
  |-- safety/recovery policy
  |-- tab lifecycle coordinator
  |-- notification and badge coordinator
  |-- session/local state repositories
  |
  +--> browser.tabs.discard / browser.tabs.reload
  +--> popup and options UI
```

### 6.1 Content collector responsibilities

- Run in Firefox's isolated content-script environment.
- Establish a new random `documentInstanceId` for each document load.
- Capture primitive metrics only.
- Keep a fixed-size ring buffer of recent samples.
- Never retain DOM nodes or `MutationRecord` objects after processing.
- Send compact summaries, not large arrays or page content.
- Detect dirty input as a boolean without reading or storing field values.
- Stop observers and timers on unload.

### 6.2 Background event page responsibilities

- Register all WebExtension event listeners synchronously at module top level.
- Validate every content message and bind it to `sender.tab.id`, frame, and document instance rather than trusting a tab ID in the payload.
- Reject messages from subframes in MVP.
- Recompute or validate scores from feature summaries.
- Combine page evidence with tab safety state.
- Maintain alert, grace-period, cooldown, and circuit-breaker state.
- Execute reset actions and verify their outcome.
- Persist preferences in `storage.local` and ephemeral records in `storage.session`.
- Use `alarms`, not event-page `setTimeout`, for wakeups and housekeeping.

### 6.3 Popup/options responsibilities

- Read a snapshot from the coordinator when opened.
- Never hold the background page alive through a permanent port.
- Send explicit, typed commands for reset, snooze, ignore, pause, and permission requests.
- Escape all page-derived strings before display.

### 6.4 Detector as a pure module

The detector must have no direct browser API calls. Input is a typed feature window; output is a score, state transition, reasons, and recommended action. This makes threshold tuning and replay testing possible.

## 7. Proposed repository layout

```text
/
  package.json
  tsconfig.json
  vite.config.ts or build.mjs
  web-ext-config.mjs
  src/
    manifest.json
    background/
      index.ts
      message-router.ts
      tab-coordinator.ts
      state-repository.ts
      notification-coordinator.ts
      badge-coordinator.ts
      permission-coordinator.ts
    collector/
      index.ts
      sampler.ts
      ring-buffer.ts
      dirty-state.ts
      signals/
        dom-growth.ts
        resources.ts
        responsiveness.ts
        capabilities.ts
    detector/
      features.ts
      score.ts
      state-machine.ts
      reasons.ts
      thresholds.ts
    recovery/
      policy.ts
      reset-tab.ts
      cooldown.ts
      circuit-breaker.ts
    shared/
      protocol.ts
      schemas.ts
      types.ts
      constants.ts
      url-policy.ts
      time.ts
    ui/
      popup/
      options/
      onboarding/
      common/
    _locales/
      en/messages.json
    icons/
  tests/
    unit/
    integration/
    e2e/
    fixtures/
      stable-small/
      stable-large/
      dom-leak/
      js-only-leak/
      detached-dom-leak/
      resource-growth/
      mutation-churn/
      dirty-form/
      beforeunload/
      audio/
  docs/
    architecture.md
    detector-model.md
    privacy.md
    release-checklist.md
```

Use TypeScript in strict mode. Keep runtime dependencies small and bundle all executable code locally for AMO review. A lightweight build based on Vite/Rollup or esbuild is sufficient; the deciding criterion is deterministic, unhashed paths for manifest entry points and easily reviewable source maps/source archives.

## 8. Manifest and permissions plan

### 8.1 Proposed Manifest V3 shape

Core permissions:

- `activeTab` — user-invoked scan of the current tab.
- `alarms` — reliable event-page wakeups.
- `notifications` — user warnings.
- `scripting` — dynamic registration/injection after permission is granted.
- `storage` — preferences and ephemeral state.

Optional host permissions:

- `http://*/*`
- `https://*/*`

Do not request `tabs` initially unless implementation testing proves it is needed. Most tab operations do not require it, and granted host access provides title/URL metadata for matching pages. Minimize permissions before adding convenience.

Set:

- `incognito: "not_allowed"` for the first release;
- a fixed Gecko extension ID;
- an explicit `strict_min_version` based on the oldest Firefox version used in CI;
- `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]` as long as no data leaves the browser.

### 8.2 Permission flow

1. Install with core API permissions but no all-sites access.
2. Let the user perform an active-tab scan.
3. On an explicit onboarding button, call `permissions.request()` for HTTP/HTTPS host access.
4. On grant, register the content collector for matching pages.
5. On revocation, unregister collectors where possible, stop accepting samples, and delete affected ephemeral state.
6. Show a clear paused/limited state when host permission is absent.

### 8.3 Unsupported targets

The URL policy must return a reason rather than throwing for:

- `about:*`;
- `moz-extension:*`;
- `file:*` unless a later feature explicitly supports it;
- built-in PDF viewer and reader view;
- Mozilla-restricted origins;
- any enterprise-configured restricted origin;
- private windows.

## 9. Signal collection

### 9.1 Required MVP signals

| Signal | Collection method | Value | Important limitations |
|---|---|---|---|
| Live DOM nodes | Initial/occasional `getElementsByTagName("*").length`, plus mutation deltas | Finds retained DOM growth | Misses detached DOM and non-DOM heap |
| Added/removed nodes | `MutationObserver`, immediately reduced to primitive counts | Measures churn and net retention | Infinite feeds can resemble a leak |
| Resource entry growth | Initial Performance Resource Timing count plus observer | Finds unbounded resource accumulation | Count is not memory size; buffers and browser behavior vary |
| Document age | Monotonic timestamp | Prevents startup spikes from triggering | Long-lived pages need site-aware thresholds |
| Visibility | `document.visibilityState` | Determines sampling and whether drift is meaningful | Hidden timers are throttled |
| Timer drift | Scheduled-versus-actual callback time for visible pages | Indicates responsiveness degradation | CPU load is not proof of memory leakage |
| Dirty state | Boolean set after relevant user input/change | Protects unsaved work | Cannot know every application's save semantics |
| Capability bits | Feature detection | Makes missing signals explicit | Must never be interpreted as zero growth |
| Page navigation identity | Random instance ID plus sender metadata | Prevents stale samples/actions | Must reset on each navigation |

### 9.2 Adaptive sampling

Starting proposal, to be tuned through benchmarks:

- Visible document: sample every 30 seconds.
- Hidden document: sample every 90 seconds.
- Full DOM recount: at startup, after major navigation, and at most once every two minutes unless escalation requires confirmation.
- Immediate lightweight sample on `visibilitychange` and after a large mutation burst.
- Ring buffer: 24 samples maximum per document.
- Warmup: at least six valid samples and at least five minutes before confirmation.

Use randomized jitter of roughly ±10% so many tabs do not sample simultaneously.

### 9.3 Mutation accounting rules

- Observe only `childList` and `subtree`; do not observe attributes or text by default.
- Count added/removed subtree sizes without keeping node references.
- Cap work per callback. If a mutation batch is too large, set an overflow flag and schedule a later ground-truth DOM recount.
- Avoid recursive traversal that can overflow the stack; use an iterative count with a hard work budget.
- Do not call `performance.clearResourceTimings()` because it modifies page-visible state.
- Do not instrument page constructors or prototypes in MVP.

### 9.4 Feature-detected optional signals

- `PerformanceObserver` entry types when supported.
- Long-task timing only if Firefox exposes it in the running version.
- Exact memory only if a future supported API appears and its security requirements are satisfied.
- Main-world handle counts only after a separate compatibility and page-breakage review.

Missing optional signals must be represented as `unavailable`, not as a numeric zero.

## 10. Detection model

### 10.1 Design goals

- Detect trends, not snapshots.
- Require duration and repeated evidence.
- Do not flag a large but stable page.
- Require multiple signal families for automatic action.
- Produce human-readable reasons for every score.
- Keep thresholds configurable and replay-testable.
- Favor false negatives over destructive false positives.

### 10.2 Derived features per document

For a window of valid samples, calculate:

- `baselineNodes`: median of early warmup node counts.
- `nodeGrowthAbsolute`: last live-node count minus baseline.
- `nodeGrowthRatio`: last count divided by a protected nonzero baseline.
- `nodeSlopePerMinute`: robust median slope across sample pairs.
- `nodeMonotonicity`: fraction of meaningful intervals with positive net growth.
- `grossAddedNodes` and `grossRemovedNodes`.
- `retentionRatio`: positive net growth divided by gross added nodes.
- `resourceSlopePerMinute`.
- `visibleTimerDriftP95`.
- `growthDuration`.
- `sampleQuality`: valid samples divided by expected samples.
- `signalAvailability` bitset.

Use robust statistics rather than ordinary least squares so one large page update does not dominate the result.

### 10.3 Initial scoring proposal

Score from 0–100:

- Up to 25: sustained absolute and relative DOM growth.
- Up to 25: positive robust DOM slope over time.
- Up to 20: high net retention compared with mutation churn.
- Up to 10: sustained resource-entry growth.
- Up to 10: worsening visible-page timer drift.
- Up to 10: optional independent handle-growth signal in a later release.

Suggested state thresholds:

- 0–39: healthy.
- 40–59: watching.
- 60–74: suspected.
- 75–100: confirmed only after repeated evaluation.

Confirmation additionally requires:

- warmup complete;
- adequate sample quality;
- the score at or above threshold for three consecutive evaluations or at least two minutes;
- at least two independent signal families, unless an explicitly tested severe condition applies;
- no recent navigation that invalidates the feature window.

These values are hypotheses, not release constants. They must be calibrated against the fixture suite and real-site beta traces.

### 10.4 Example strong DOM pattern for early testing

An initial fixture-oriented candidate:

- document age at least 5 minutes;
- at least 6 samples;
- current live DOM at least 20,000 nodes;
- growth of at least 10,000 nodes from warmup;
- robust slope at least 1,000 nodes/minute;
- monotonicity at least 0.75;
- no plateau during the last three samples.

This is intentionally conservative and should not be exposed as a hard-coded product definition of a leak.

### 10.5 State machine

```text
UNSUPPORTED / UNMONITORED
          |
          v
       WARMUP --> HEALTHY --> WATCHING --> SUSPECTED --> CONFIRMED
          ^          ^           |            |            |
          |          +-----------+------------+            v
          |                                         NOTIFIED/GRACE
          |                                               |
 navigation                                                v
 resets window                                      RESET_PENDING
                                                          |
                                   unsafe ----------------+---- safe
                                     |                           |
                                     v                           v
                                  PROTECTED                  RESETTING
                                                                  |
                                           fail ------------------+-- success
                                            |                         |
                                            v                         v
                                      RESET_BLOCKED               COOLDOWN
                                                                      |
                                                                      v
                                                                   WARMUP
```

Every transition records a machine-readable reason. Navigation creates a new document state even when the Firefox tab ID remains unchanged.

### 10.6 Site baseline strategy

Do not use cross-session learned site baselines in the first version. Begin with document-local baselines and explicit user overrides. If local site learning is added later:

- store hostname-level aggregates, not full URLs;
- cap history and age it out;
- never mix private browsing data;
- expose “clear learned data”;
- protect against a leaking session poisoning the baseline upward.

## 11. Recovery policy

### 11.1 Safety predicate

Automatic discard is allowed only if all are true at action time:

- status is confirmed at the automatic-action threshold;
- auto-reset was explicitly enabled;
- tab still exists and still refers to the same document instance;
- tab is not active;
- tab is not pinned, unless the user later enables pinned-tab resets;
- tab is not audible;
- tab is not drawing attention/showing a modal according to available tab state;
- content collector reports no dirty input;
- tab has not been accessed within the configured quiet period, initially five minutes;
- tab is not already discarded or loading;
- origin is not ignored or snoozed;
- per-tab cooldown and site circuit breaker are clear;
- a fresh sample still meets the action threshold.

Treat unavailable safety information as unsafe for automatic action.

### 11.2 Reset algorithm for an inactive tab

1. Capture a minimal reset record: tab ID, document instance, hostname, reason codes, time, and pre-action state.
2. Re-fetch the tab and re-evaluate the safety predicate.
3. Call `browser.tabs.discard(tabId)`.
4. Re-fetch the tab and verify `discarded === true`.
5. On success:
   - mark cooldown;
   - update badge and popup;
   - clear the old document detector state;
   - retain a short local receipt.
6. On no-op or failure:
   - mark `RESET_BLOCKED`;
   - notify at most once;
   - do not repeatedly retry;
   - offer a manual focus/reload path.

### 11.3 Manual reset for an active tab

1. Show a confirmation explaining that unsaved page state may be lost.
2. If dirty, require an additional explicit confirmation.
3. Call `browser.tabs.reload(tabId, { bypassCache: false })`.
4. Do not bypass cache by default; cache is not the leaked JavaScript context, and bypassing increases network cost.
5. Wait for the next document instance to report warmup.
6. Enter cooldown.

### 11.4 Grace periods and circuit breakers

Starting defaults:

- Confirmation-to-auto-discard grace: 2 minutes.
- Per-document notification cooldown: 30 minutes.
- Per-tab automatic reset cooldown: 60 minutes.
- Per-host circuit breaker: at most 2 automatic resets in 6 hours.
- Global circuit breaker: at most 5 automatic resets in 1 hour.
- After any failed/blocked reset: no automatic retry until the user interacts or the document navigates.

All values should be configuration constants with tests.

## 12. Data model and messaging

### 12.1 Message envelope

Every message should include:

```ts
type MessageEnvelope<TType extends string, TPayload> = {
  protocolVersion: 1;
  type: TType;
  sentAtMonotonicMs: number;
  documentInstanceId: string;
  payload: TPayload;
};
```

Do not accept `tabId`, hostname, or privileged action targets from the page payload. Derive them from the WebExtension sender and `tabs.get()`.

### 12.2 Sample summary

```ts
type SampleSummary = {
  sampleSequence: number;
  documentAgeMs: number;
  visibility: "visible" | "hidden";
  liveDomNodes: number | null;
  addedNodesSinceLast: number;
  removedNodesSinceLast: number;
  resourceEntriesSeen: number | null;
  timerDriftMs: number | null;
  dirty: boolean;
  overflowed: boolean;
  capabilities: {
    resourceObserver: boolean;
    longTasks: boolean;
    exactMemory: boolean;
  };
};
```

Validate ranges and maximum serialized size. Drop malformed, duplicate, out-of-order, oversized, or stale messages.

### 12.3 Ephemeral tab state

Key by tab ID plus document instance for the current browser session:

- latest feature summary;
- detector state and score;
- human-readable reason codes;
- last notification time;
- pending grace alarm;
- safety flags;
- snooze/cooldown times;
- recovery outcome.

Clear on tab removal and replace on navigation. Never assume a tab ID is stable across browser restarts.

### 12.4 Persistent local preferences

- onboarding completed;
- continuous monitoring enabled;
- recovery mode;
- threshold preset;
- sampling preset;
- ignored hostnames;
- user-selected pinned/audible/dirty protections, with safe defaults locked where appropriate;
- notification preference;
- bounded reset receipts;
- schema version.

Implement storage migrations from the first release.

## 13. Privacy and security

### 13.1 Data minimization

- Never read form values; store only a dirty boolean.
- Never collect page text, HTML, screenshots, cookies, request bodies, or user identifiers.
- Use hostname for UI/policy and avoid persisting full URLs.
- Keep raw sample windows in memory/session storage and bounded.
- No network requests from the extension in MVP, other than Firefox/AMO's normal extension update process.
- No analytics SDKs, crash reporters, remote configuration, or remote code.

### 13.2 Web-content trust boundary

- Treat every content-script message as untrusted input.
- Derive tab identity from `sender.tab`.
- Restrict MVP reports to the top frame.
- Use a closed message schema and reject unknown message types.
- Never evaluate page strings as code or HTML.
- Render titles/hostnames using text nodes, not `innerHTML`.
- Keep reset authority only in the background event page.
- Do not expose extension secrets or privileged callbacks to the main page world.

### 13.3 Extension self-leak prevention

The detector must not become the leak:

- fixed-size buffers only;
- primitives instead of node references;
- disconnect observers on unload;
- no unbounded log arrays;
- bound per-tab and global state;
- delete state on `tabs.onRemoved` and document replacement;
- cap reset receipts and ignored-site entries;
- avoid long-lived message ports;
- benchmark with 100+ tabs.

### 13.4 AMO compliance

- Bundle all code locally.
- Provide readable source or a source archive matching the build when required.
- Declare `data_collection_permissions.required: ["none"]` while the product is local-only.
- Publish a plain-language privacy notice even when no data is transmitted.
- Explain broad site access in the listing and onboarding.
- Run `web-ext lint` against the chosen minimum Firefox version before every release.

## 14. Lifecycle and race-condition handling

Handle these cases explicitly:

- navigation while a sample is in flight;
- navigation during grace period;
- tab closes before an action;
- tab ID reused after restart;
- tab becomes active or audible between confirmation and discard;
- permission revoked while collectors are running;
- event page unloaded between detection and alarm;
- duplicate notifications after event-page restart;
- discarded tab reactivated before state write completes;
- tab replaced by Firefox prerendering;
- popup opens while state is being updated;
- notification refers to a closed or navigated tab;
- clock changes; use monotonic time for page trends and wall time only for persistent expiry;
- content script missing because the page is restricted or the permission changed;
- corrupted or old storage schema.

Use idempotent commands and compare a document instance/revision before every destructive action.

## 15. Testing strategy

### 15.1 Unit tests

Test pure modules with deterministic fake time:

- ring-buffer bounds;
- mutation counter overflow behavior;
- robust slope and monotonicity;
- score calculation with missing signals;
- every detector state transition;
- safety predicate combinations;
- cooldown and circuit breakers;
- storage migrations;
- URL policy and restricted schemes;
- message validation and size limits;
- reason generation.

Use table-driven cases and property tests for score invariants, for example: adding unavailable signals must not increase confidence, and a stable high-node page must not become confirmed solely due to its size.

### 15.2 Integration tests with a fake browser API

- content message binds to sender tab, not payload target;
- stale document messages are ignored;
- inactive safe tab is discarded and verified;
- active tab is never auto-discarded;
- audible, pinned, dirty, modal, or recently used tab is protected;
- discard no-op becomes blocked, not an infinite retry;
- permission add/remove registers and unregisters monitoring;
- badge/notification deduplication survives event-page restart;
- tab removal deletes ephemeral state;
- manual reload uses the selected tab ID and leaves cache enabled.

### 15.3 Controlled fixture pages

Create local pages that model:

- stable small DOM;
- stable very large DOM;
- bursty SPA render that returns to baseline;
- infinite scrolling with bounded retention;
- intentional retained DOM growth;
- detached DOM leak, documented as an expected detection gap;
- pure `ArrayBuffer`/JavaScript leak, documented as an expected detection gap;
- continuous resource-entry growth;
- high mutation churn with no net growth;
- visible main-thread stalls;
- background throttling;
- unsaved form input;
- `beforeunload` protection;
- audio playback;
- navigation during a pending reset.

Each fixture should expose an internal test-only control panel and deterministic growth rate so detector expectations can be automated.

### 15.4 Firefox end-to-end tests

- Load the built extension temporarily with `web-ext`/Firefox automation.
- Grant and revoke optional site access.
- Verify collectors do not run before permission.
- Open multiple fixture tabs and validate the popup ordering and badge counts.
- Trigger confirmation, notification, snooze, ignore, manual reload, and safe discard.
- Verify an inactive discarded tab remains in the tab strip and reloads when selected.
- Verify active and `beforeunload` tabs are not silently discarded.
- Restart/reload the extension event page and verify state recovery.
- Test current Firefox release and ESR; add Beta before release candidates.
- Exercise macOS, Windows, and Linux notification behavior.

Do not rely on Playwright's Chromium-only extension mechanisms. Use Firefox-compatible WebDriver/BiDi or a harness launched through `web-ext`.

### 15.5 Manual memory validation

Because the extension cannot see exact memory, release testing should separately validate actual reclamation:

- run controlled leak fixtures in a dedicated Firefox profile;
- observe Firefox's built-in process/task tools or memory reports manually;
- confirm discard/reload destroys the leaking document context;
- compare before/after using repeated, documented runs;
- confirm that the extension's own overhead remains stable during a long soak.

This validation supports product confidence but must not be presented as runtime per-user measurement.

### 15.6 False-positive corpus

Build a repeatable corpus of legitimate high-growth pages:

- long social/infinite feeds;
- webmail;
- video conferencing/media playback;
- dashboards with frequent updates;
- code editors;
- map applications;
- large document viewers;
- chat clients;
- virtualized and non-virtualized data grids.

Record only locally generated/replayed feature traces for automated tuning. Do not put real user URLs or content in the repository.

## 16. Performance budgets

Initial engineering budgets:

- Collector serialized summary: under 2 KB.
- Collector ring: at most 24 primitive samples.
- Full DOM recount: under 20 ms p95 on test fixtures; if over budget, chunk or defer it.
- Normal lightweight sample: under 5 ms p95.
- Background processing per summary: under 2 ms p95.
- No more than one message per monitored hidden tab per 90 seconds in steady state.
- Session state bounded to 100 KB per tab and 5 MB globally, with actual targets far lower.
- 100-tab, 8-hour soak: no unbounded extension-state growth.
- Static 20-tab scenario: no sustained meaningful CPU wakeup beyond scheduled sampling; establish a measured baseline before release.

Budgets should be measured on a representative low/mid-range device, not only a development machine.

## 17. Observability for development

Provide an off-by-default diagnostics mode that remains local:

- detector state transitions and reason codes;
- sampling durations and overflow counts;
- message sizes;
- notification/reset decisions;
- recovery verification;
- current state snapshot export with full URL redaction.

Logs must be bounded and disabled in production by default. Never log page content or field values.

## 18. Delivery milestones

Estimates are engineering effort for one experienced engineer and exclude calendar delays for review or beta recruitment.

### Milestone 0 — Capability spike (2–3 engineer-days)

Deliverables:

- minimal MV3 extension loaded in current Firefox release and ESR;
- prove optional HTTP/HTTPS permission flow;
- verify dynamic content-script registration;
- verify event-page listener and alarm behavior;
- exercise discard on inactive, active, pinned, audible, and `beforeunload` fixture tabs;
- verify reload lifecycle and document-instance replacement;
- verify notification limitations on at least one desktop OS;
- record exact supported/unsupported behavior in `docs/platform-spike.md`.

Exit criteria:

- no assumption in the recovery design remains untested on real Firefox;
- minimum Firefox version is chosen.

### Milestone 1 — Project foundation (3–4 engineer-days)

Deliverables:

- TypeScript/build/lint/test setup;
- manifest and extension ID placeholder;
- event page, popup, options, onboarding shells;
- typed protocol and runtime validation;
- storage repositories and schema versioning;
- CI for typecheck, unit tests, build, and `web-ext lint`.

Exit criteria:

- a clean build loads temporarily and survives event-page unload/restart.

### Milestone 2 — Low-overhead collector (5–7 engineer-days)

Deliverables:

- document identity and lifecycle;
- DOM/mutation/resource/visibility/drift signals;
- dirty boolean;
- adaptive sampling and fixed ring;
- collector diagnostics and performance benchmarks;
- controlled fixture pages.

Exit criteria:

- collector remains bounded in 8-hour fixture soak;
- stable large page does not create increasing collector memory.

### Milestone 3 — Detector and replay harness (5–7 engineer-days)

Deliverables:

- feature calculation;
- robust trend scoring;
- state machine and reason codes;
- missing-signal behavior;
- trace replay/test harness;
- first threshold calibration across fixtures.

Exit criteria:

- detects retained-DOM fixture within the agreed window;
- does not confirm stable-large or burst-and-release fixtures;
- all state transitions covered by tests.

### Milestone 4 — Recovery and safety (4–6 engineer-days)

Deliverables:

- safety predicate;
- discard/reload implementations;
- revalidation and outcome verification;
- grace, cooldown, snooze, and circuit breakers;
- tab/navigation/permission race handling;
- reset receipts.

Exit criteria:

- no automated test can make an unsafe-state tab auto-discard;
- stale document decisions cannot act on a new navigation.

### Milestone 5 — User experience (5–7 engineer-days)

Deliverables:

- onboarding and permission education;
- popup tab list and technical details;
- options and recovery-mode controls;
- badge and notification deduplication;
- ignore/snooze/focus/reset actions;
- accessible keyboard navigation, focus handling, contrast, and screen-reader labels.

Exit criteria:

- user can understand why a tab is flagged and reverse future automatic behavior without reading documentation.

### Milestone 6 — Hardening and beta (7–10 engineer-days)

Deliverables:

- Firefox end-to-end suite;
- OS notification matrix;
- release/ESR/Beta test matrix;
- 100-tab and overnight soak tests;
- false-positive corpus runs;
- security/privacy review;
- source-package reproducibility;
- signed unlisted beta.

Exit criteria:

- all release gates in section 19 pass;
- notify-only beta has enough usage evidence before auto-reset is recommended.

### Milestone 7 — AMO release (5–8 engineer-days)

Deliverables:

- icons, listing copy, screenshots, support page, and privacy notice;
- AMO metadata and data-collection declaration;
- `web-ext lint` and reproducible build output;
- release notes and known-limitations page;
- signed listed submission;
- rollback/disable plan for automatic recovery.

Approximate total: **36–52 engineer-days**, or roughly 8–11 focused weeks for one engineer, with threshold calibration and AMO review as the largest schedule uncertainties.

## 19. Release gates and acceptance criteria

### 19.1 Functional

- Continuous monitoring never begins before host permission is granted.
- Supported tabs produce valid samples and unsupported tabs show a reason.
- A deterministic retained-DOM fixture reaches confirmed state within 10 minutes.
- Stable large DOM, mutation churn, and burst-and-release fixtures do not reach confirmed state.
- Manual reset targets only the selected tab.
- Safe inactive confirmed tab is discarded and verified.
- Active, pinned, audible, dirty, recently accessed, and blocked tabs are never auto-reset with default safety policy.
- Navigation invalidates pending actions.
- Ignore, snooze, pause, and permission revocation take effect promptly.

### 19.2 Safety

- Zero unintended auto-resets in the maintained benign fixture/corpus suite.
- No auto-reset can occur from a stale message or stale tab/document mapping.
- Failed discard does not loop.
- Notification loss does not hide durable warning state in the popup/badge.
- Recovery rate limits survive event-page restart.

### 19.3 Detection quality

Before enabling auto-reset by default in any future version:

- at least 95% recall on the supported deterministic DOM-leak fixture set;
- under 1% false confirmations across the maintained benign replay corpus;
- zero destructive resets during a multi-week opt-in beta;
- evidence that confirmed cases generally improve after reset;
- clear documentation of undetected pure-JS/detached-DOM cases.

These metrics must be defined on versioned internal test datasets; they are not universal claims about every website.

### 19.4 Performance

- Pass all budgets in section 16.
- No unbounded state growth in a 100-tab, 8-hour soak.
- No retained DOM references found in extension collector review.
- Sampling adapts down for hidden tabs.

### 19.5 Privacy and release

- No extension-originated network requests in normal operation.
- AMO manifest explicitly declares no transmitted data.
- Privacy notice and permission explanations match actual behavior.
- `web-ext lint`, typecheck, unit, integration, and end-to-end tests pass.
- Release, ESR, and Beta smoke tests pass on the selected OS matrix.

## 20. Key risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Firefox exposes no exact per-tab memory | Pure JS/engine leaks may be invisible | Honest heuristic positioning; focus on supported patterns; future feature gate |
| Legitimate infinite content resembles a leak | False positives/reset risk | Trend duration, multiple signals, notify-only default, grace, user ignores, conservative thresholds |
| Extension itself adds overhead | Product worsens the problem | Sparse adaptive sampling, bounded primitives, soak tests, no node retention |
| Auto-reset loses user state | Loss of work/trust | Protect active/audible/pinned/dirty/recent tabs, opt-in auto mode, discard inactive tabs, circuit breakers |
| Broad host permission reduces adoption | Lower install/enable rate | Optional runtime request, manual active-tab mode, clear local-only explanation |
| Restricted pages cannot be monitored | Coverage gap | Explicit unsupported state; never repeatedly inject or error |
| Notification UI differs by OS | Missed action or poor UX | Badge/popup as source of truth; basic notifications only; OS test matrix |
| Event page unload loses in-memory state | Duplicate or missed actions | `storage.session`, alarms, idempotent transitions, top-level listeners |
| Page races navigation/reset | Wrong-page action | Document instance and revision revalidation immediately before action |
| AMO review flags broad access or bundled code | Release delay | Minimal permissions, no remote code, readable build, privacy/permission documentation |
| Native process memory cannot map cleanly to tabs | False precision in future helper | Keep native companion out of consumer MVP; require a separate architecture decision |

## 21. Decisions to make after the capability spike

These are deliberately deferred until measured evidence exists:

1. Exact minimum supported Firefox and ESR versions.
2. Vite/Rollup versus esbuild packaging.
3. Whether `tabs` permission is actually needed.
4. Whether all-frame monitoring is affordable and improves detection enough for MVP.
5. Final sample intervals and DOM recount strategy.
6. Final thresholds and severe-condition rules.
7. Whether auto-reset ships in v1 as an opt-in beta feature or waits for v1.1.
8. Whether notification click focuses the tab, opens a details page, or both.
9. How many local reset receipts to retain and for how long.
10. Whether a local redacted diagnostic export is needed for beta support.

## 22. Recommended issue/epic breakdown

Create the following epics in order:

1. **Platform capability spike**
2. **Build, manifest, and CI foundation**
3. **Permission onboarding and dynamic collector registration**
4. **Collector lifecycle and bounded sampling**
5. **DOM/resource/responsiveness signals**
6. **Detector features, score, and state machine**
7. **Fixture and trace replay harness**
8. **Tab safety policy**
9. **Discard/reload recovery and verification**
10. **Cooldowns, snooze, ignores, and circuit breakers**
11. **Popup, badge, notifications, and settings**
12. **Lifecycle/race hardening**
13. **Privacy, security, and AMO review readiness**
14. **Firefox/OS E2E matrix and soak testing**
15. **Unlisted beta, calibration, and release**

Every implementation ticket should include:

- behavior and non-goals;
- relevant permission/API constraints;
- unit/integration/E2E expectations;
- performance impact;
- privacy impact;
- failure behavior;
- definition of done.

## 23. Immediate next implementation steps

1. Scaffold the minimal MV3 extension and test it on current Firefox release and ESR.
2. Build the deterministic stable, DOM-leak, dirty-form, audio, and `beforeunload` fixtures.
3. Produce `docs/platform-spike.md` with actual discard/reload/permission/notification results.
4. Lock the minimum Firefox version and manifest permissions.
5. Implement the typed message envelope and document identity before collecting signals.
6. Add the bounded DOM collector and its soak benchmark.
7. Implement detector replay tests before connecting any automatic reset action.
8. Ship notify-only through internal testing first; add opt-in auto-discard only after safety gates pass.

## 24. Authoritative references

- [MDN: `tabs.discard()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/discard)
- [MDN: `tabs.reload()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/reload)
- [MDN: tabs API and permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs)
- [MDN: content-script permissions and restricted pages](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)
- [MDN: non-persistent background/event pages](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)
- [MDN: optional host permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_host_permissions)
- [MDN: notification options](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/notifications/NotificationOptions)
- [MDN browser compatibility data: Firefox memory API support](https://github.com/mdn/browser-compat-data/blob/main/api/Performance.json)
- [Firefox Extension Workshop: getting started with `web-ext`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)
- [Firefox Extension Workshop: built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [Firefox Extension Workshop: Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
