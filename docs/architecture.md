# Architecture

Version described: 0.1.1

## Safety invariant and trust boundary

Tab Leak Guard has three privilege layers:

1. An isolated content collector observes bounded page-level signals. It cannot act on a tab.
2. The Firefox MV3 background event page validates identity/state, scores evidence, manages permissions and notifications, and owns all tab-action authority.
3. Extension UI pages render snapshots and send a closed, runtime-validated set of commands.

Web pages, messages, and persisted state are untrusted. The background derives tab, frame, window, URL, hostname, and native document identity from Firefox. It rejects subframe telemetry. No collector-provided target is privileged.

Automatic recovery is quarantined in 0.1.1 by `AUTOMATIC_RECOVERY_AVAILABLE = false`. An alarm is a wake-up signal, never authority. Manual recovery uses an action-bound, expiring operation and fresh preflight.

## Data flow

```text
ordinary HTTP(S) document
  -> bounded SampleSummary (protocol/version/sequence + delivery deadline)
  -> sender + deadline + lifecycle + permission-revision validation
  -> 16-sample per-document ring
  -> detector v2 features + quality + hysteresis
  -> advisory finding / generic aggregate notification
  -> explicit user prepare
  -> fresh document-bound tri-state preflight
  -> user execute with nonce
  -> per-tab mutex -> revalidate -> discard/reload -> verify -> receipt
```

Pause, permission/site removal, navigation, tab replacement, manual-session expiry, update, storage reset, collector-budget failure, or evidence expiry invalidates operations and the monitoring epoch. Asynchronous reads never retain authority across one of those invalidations: the relevant epoch, document/navigation generation, and permission revision are captured and rechecked before state is accepted or an action is issued.

## Monitoring scope and lifecycle

The default is manual. A user may start a private 15-minute session for the active eligible tab or opt into selected-site/all-site continuous access. Optional HTTP(S) host permissions are reconciled with registered content scripts at startup and on permission/policy changes. Firefox-restricted documents fail closed with an explanation.

`webNavigation` events, tab loading/replacement/removal, collector instance identity, message sequence, URL, and Firefox `documentId` where available define document lifecycle. A top-level `tabs.onUpdated` loading event establishes an action-authority fence immediately. Commit and history events may clear only the matching generation after correlating URL, frame, record creation time, and native document identity; bounded completion reconciliation keeps the fence closed when Firefox state cannot be proven. Recently retired collector document IDs are retained in a bounded deny-list so late messages from an old page instance cannot revive it. Firefox versions without native document identity remain useful for notify/manual operation but cannot satisfy a future automatic-action gate.

Permission changes use a separate monotonic revision fence. `permissions.onAdded` and `permissions.onRemoved` advance the revision and mark reconciliation pending before any asynchronous Firefox permission query. Snapshot reads, collector bootstrap/sample acceptance, prepared recovery, and recovery execution capture and recheck that revision. Stale work cannot clear a newer pending state, and reconciliation retries with bounded backoff. While permission authority is changing, collection and recovery fail closed rather than relying on a stale grant.

## Collector and performance controller

The collector uses primitive counters and releases DOM references before returning. It observes child-list mutations, resource timing activity, visibility-aware timer drift, page age, signal availability, dropped performance entries, and a tri-state edited-input signal. Resource timing is network/resource activity, not retained memory.

Mutation processing has node and wall-time budgets with saturating counters. Full DOM recount is cooperative: it processes at most 1,024 nodes in an 8 ms slice, yields between slices, and stops after 40 ms of active work, 64 slices, or 100,000 nodes. The traversal does not retain visited nodes. If any bound is reached, the result is censored as unavailable (`null`), mutation evidence is marked overflow/degraded, and the detector is never given a partial lower bound as an exact count. A failed recount is retried less frequently. The `pathological-dom` fixture creates 120,000 retained elements to exercise this behavior in Firefox.

Overflows, observer failures, dropped entries, costly recounts, or slow samples reduce evidence quality and trigger adaptive cadence/backoff. A persistently over-budget collector stops and cancels pending operations. Visible and hidden sample intervals are preferences bounded by runtime schemas. Each document retains at most 16 samples.

### Collector delivery and takeover

Every HELLO and sample carries a short background-delivery deadline, and both bootstrap and message delivery have bounded client-side timeouts. A timeout, transport exception, or explicit retryable rejection may restart the collector at most three times with 500 ms, 1 s, and 2 s delays. A transient restart preserves the same document instance, sequence, route segment, segment start, and the most conservative observed edit state. It recreates observers and forces an overflow/degraded gap, so transport loss can never improve evidence quality. The retry counter resets only after an accepted HELLO; definitive rejection stops collection.

The collector claims its page sentinel synchronously before awaiting background work, making duplicate injection idempotent. A matching current sentinel is left alone. A legacy, version-mismatched, or malformed sentinel is stopped when possible and replaced, so an already-open document can adopt a newly installed collector build without running two collectors. Background deadline checks run before and after asynchronous hydration, permission, session-binding, persistence, and evaluation boundaries. Expired or implausibly distant deadlines are rejected fail closed.

## Detector v2

Detector model `retained-dom-v2.0.0` is a pure deterministic module. It combines short/medium/long evidence windows, robust baselines/slopes, mutation retention, current DOM size, persistence, release/plateau negative evidence, resource activity, signal availability, overflow/performance quality, and timer drift context.

The score is not a memory measurement. A retained-DOM prerequisite prevents timer or resource activity alone from confirming a leak. Quality and confidence affect eligibility, and hysteresis prevents oscillation. Model/configuration versions are stored with findings. JSON traces can be validated and replayed byte-for-byte for calibration and regression tests.

## State and migrations

- `storage.local`: strict preferences/site policies, bounded age-pruned receipts, schema markers, and the bounded recovery journal. Recovery intent is durable so a full browser restart cannot silently forget or replay a possibly issued action.
- `storage.session`: validated tab records, 16-sample windows, manual-session bindings, and the monitoring epoch.
- `alarms`: session expiry and legacy/recovery wake-ups; startup reconciliation treats unknown alarms as untrusted.

Schema v3 sanitizes all restored values, discards corrupt/oversized state, migrates legacy settings to safe defaults, quarantines automatic recovery, and serializes writes. A version mismatch advances the monitoring epoch and never restores document records, tab policy, or manual-session runtime authority. Issued durable operation journals may be retained only as reconciliation evidence, never as authority to reissue an action. Migration writes that durable journal first, invalidates session authority second, and commits the local v3 marker last; a crash before the marker causes migration to run again without making stale session data authoritative.

A terminal receipt and operation removal commit in one local-storage write; startup converts any issued journal without that commit into one conservative unknown outcome and cooldown. History retention is user-selectable (off, 24 hours, or 7 days), count-capped, and clearable with a delete-all command. Firefox website permissions are managed separately.

## Recovery transaction

Manual recovery follows `prepare -> awaiting-consent -> requested -> verified terminal outcome`. The operation binds tab, window, hostname, native and collector document identity, record revision, evidence deadline, epoch, exact action, initiator, nonce, and expiry. Current URL and safety are re-derived from Firefox immediately before the action. Per-tab serialization, a durable pre-request journal, atomic terminal commit, and startup reconciliation prevent duplicate action or contradictory receipts.

Immediately before execution the background rechecks current permission/policy/epoch/evidence plus active, pinned, audible, attention, sharing state, auto-discardability, loading, recent use, snooze/cooldown, edited state, document identity, and collector freshness. Unknown mandatory state fails closed. Inactive tabs use `tabs.discard`; an active manual action may use normal `tabs.reload`. Outcome wording distinguishes a request from verified completion.

## Notification and UI behavior

One stable aggregate notification ID prevents bursts. Generic content is the default; site disclosure is opt-in. Notification operations use one rejection-tolerant serialized queue. This flow does not rely on `notifications.update`; replacement is performed as ordered inspect/create/clear work. Authority is checked before and after asynchronous calls. If a create loses authority while pending, a compensating clear completes before later notification work may run. Permission revocation immediately queues a clear, and delete-all waits for serialized browser cleanup before reporting success.

Badge mutations use an independent serialized queue. A display signature is committed only after the related icon/text/title calls settle, so rejection remains retryable and an older late update cannot overwrite a newer clear. These browser UI calls are deliberately not given local timeouts: timing out a mutation would allow that still-running mutation to complete out of order. Therefore notification/badge correctness has one explicit trusted dependency—Firefox must eventually settle its own mutation promises. A rejected promise is recoverable; a never-settling promise can stall the corresponding queue and permission reconciliation. The system remains fail closed, but real-Firefox liveness/fault-injection evidence is still required.

Clicking a notification opens the extension finding view rather than focusing a possibly problematic page. Toolbar badge, popup sorting, and status are derived from the same finding summary. The popup refreshes while open and exposes stop, snooze, site-scope, history, and accessible confirmation controls.

## Event-page constraints

Listeners are registered synchronously. Hydration/migration completes before commands act. Durable work uses alarms and storage, not background timers. Startup and update reconcile permissions, registrations, live tabs, operations, notifications, receipts, and alarms. No UI port is kept permanently open solely to prevent event-page suspension.
