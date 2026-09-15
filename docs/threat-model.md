# Threat model

Last reviewed: 2026-08-30

## Assets and safety properties

The extension must protect page state, user edits, media sessions, browsing privacy, Firefox permissions, detector/receipt integrity, and the ability to stop monitoring immediately. A notification is advisory. An alarm is only a wake-up signal. No page or stale stored record may authorize a tab action.

For 0.1.1, automatic recovery is compile-time unavailable. A manual action requires a fresh user gesture, operation nonce, matching tab/document/URL identity, unexpired evidence, and a new tri-state safety preflight. Unknown safety state fails closed.

## Trust boundaries

- Web pages and every page-derived value are untrusted.
- The isolated collector has no tab-action authority and reports bounded primitive summaries only.
- Firefox sender/tab/document metadata is authoritative where available.
- The background event page owns permissions, state transitions, notification aggregation, and recovery transactions.
- Extension pages may request only closed, runtime-validated commands.
- Local storage may be stale, malformed, downgraded, or partially written; it must be migrated/validated before use.
- Build dependencies and AMO signing are supply-chain boundaries; dependencies are not shipped at runtime.

## Principal threats and controls

| Threat | Control | Residual risk / gate |
|---|---|---|
| Forged collector message targets another tab | Ignore payload targets; bind sender tab/frame/document; validate size/schema/sequence | Native document identity compatibility matrix pending |
| Navigation or tab replacement reuses stale authority | Lifecycle registry, webNavigation reconciliation, document-bound operation, epoch invalidation | BFCache/redirect cross-platform E2E pending |
| User pauses or revokes permission but alarm later acts | Master-off transaction, persisted monitoring epoch, alarm reconciliation, execution-time policy check | Pending-alarm signed-update rehearsal pending |
| Duplicate events cause multiple actions | Per-tab mutex, idempotent operation nonce, terminal-state checks | Firefox event-page stress test pending |
| Crash between a tab request and outcome write causes replay or contradictory history | Durable requested-operation journal; atomic receipt/removal commit; issued-journal startup reconciliation to one unknown outcome and cooldown | Browser-kill fault injection remains a release gate |
| Edited form or media session is disrupted | Edited state starts unknown when observation is late; fresh collector preflight; sharing/pinned/audible/attention/loading/recent-use guards | Site-specific save semantics cannot be inferred reliably |
| Malicious page causes collector CPU/memory abuse | 16-sample cap, bounded mutation walks, saturating counters, adaptive intervals, global budgets, reference release | 100-tab/8-hour soak pending |
| Page content leaks through notifications/history | Generic aggregate notification; bounded local reason codes/host metadata; no page content/form values; clear-all/retention | Hostname may still be sensitive inside explicitly opened UI |
| Permission overreach | Manual default; selected-site option; optional host access; current-scope UI and revocation | Firefox restricted pages remain unsupported |
| Corrupt, old, or partially committed storage enables unsafe behavior | Runtime schemas, versioned migrations, safe defaults, quarantine migration, non-evictable issued journals, atomic terminal commit | Property/fuzz suite must remain required |
| Detector false positive is treated as fact | Honest “possible resource growth” language, model version/quality, replay corpus, notify-only default | Exact per-tab memory is unavailable |
| Dependency/build compromise | Lockfile, no runtime packages, package allowlist, deterministic builds, content manifest, SHA-256, SBOM, CI least privilege | npm/AMO remain external trust dependencies |
| Private key or signing credential exposure | AMO signs; CI emits unsigned artifacts only; no signing secret in repository | AMO account security is operational responsibility |
| Hidden remote behavior changes safety policy | No telemetry, remote config, remote code, or kill-switch service | Emergency response requires signed update |

## Out of scope

Compromised Firefox/browser APIs, a compromised operating system, malicious AMO signing infrastructure, and exact attribution of a browser process’s memory to one tab are outside the extension’s control. These do not justify collecting more page data or claiming exact leak diagnosis.

## Review triggers

Re-review before enabling any automatic recovery, adding page-world instrumentation, adding telemetry/network services, requesting a new permission, changing the extension ID/update channel, changing retention, adding native messaging, or accepting a new dependency advisory.
