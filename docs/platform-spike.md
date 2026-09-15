# Firefox platform validation

Last updated: 2026-08-30

## Implemented platform decisions

- Firefox MV3 background event page, optional HTTP(S) host permissions, `activeTab`, alarms, notifications, scripting, storage, and `webNavigation` are used.
- Minimum Firefox remains 142 for notify/manual compatibility. Native WebExtension `documentId` is feature-detected and used for targeted messages and lifecycle binding when available; lack of it is represented explicitly.
- Automatic recovery is compile-time quarantined. A future automatic tier must require native document identity and all safety gates.
- Manual monitoring has a finite 15-minute lifecycle. Continuous monitoring supports selected-site and all-site scopes.
- Each document holds at most 16 samples. Collector duration/overflow/dropped-entry health affects quality and adaptive cadence.
- `tabs.discard()` remains inactive-tab-only. Manual active-tab recovery uses normal reload and fresh confirmation.
- `performance.memory` and `measureUserAgentSpecificMemory()` are unavailable for this Firefox extension. The product reports heuristic retained-DOM/resource-growth evidence, never exact per-tab memory.
- Resource timing entries are activity, not retained resources. Firefox-restricted pages, built-in PDF, reader view, extension pages, and restricted Mozilla domains remain unsupported injection targets.
- One generic aggregate notification is used; toolbar/popup state remains authoritative.

## Automated repository evidence

The release pipeline checks exact version/extension ID, explicit CSP and lifecycle permission, compile-time recovery quarantine, strict TypeScript, unit/integration/property/schema tests, coverage thresholds, Mozilla lint, a production file allowlist, absence of source maps/remote scripts/dynamic evaluation in production, deterministic production/review/source ZIPs, content hashes, and SBOM generation.

These automated checks are necessary but do not prove real Firefox behavior across platforms. CI-generated ZIPs are unsigned review artifacts.

## Manual and real-browser matrix

| Scenario | Release | Beta | compatibility tier | macOS | Windows | Linux |
|---|---:|---:|---:|---:|---:|---:|
| Manual/selected/all-site grant, reconciliation, revoke | pending | pending | pending | pending | pending | pending |
| Existing-tab injection and 15-minute expiry/Stop | pending | pending | pending | pending | pending | pending |
| Native/fallback document lifecycle, redirect, SPA, BFCache | pending | pending | pending | pending | pending | pending |
| Notification aggregation, privacy, click/clear lifecycle | pending | pending | pending | pending | pending | pending |
| Manual discard/reload consent and verification | pending | pending | pending | pending | pending | pending |
| Pinned/audible/attention/edit/sharing/loading/recent protection | pending | pending | pending | pending | pending | pending |
| Event-page restart, sleep/wake, tab replace, clock change | pending | pending | pending | pending | pending | pending |
| Restricted page explanations | pending | pending | pending | pending | pending | pending |
| Accessibility/keyboard/reduced-motion/pseudo-locale | pending | pending | pending | pending | pending | pending |
| 100-tab/8-hour performance and state soak | pending | pending | pending | pending | pending | pending |
| Signed 0.1.0 -> listed 0.1.1 update with pending alarm | pending | pending | n/a | pending | pending | pending |

Do not infer a passed row from successful build, lint, temporary installation, or unit tests. Store browser version, OS, profile setup, expected/actual outcome, screenshots/logs, and reviewer in the release record.
