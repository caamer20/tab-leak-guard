# Privacy and data-use statement

Version described: 0.1.1

## Local-only operation

Tab Leak Guard makes no application network requests and includes no analytics, advertising, crash reporting, telemetry, remote configuration, remote model, or remote code. Detection and recovery decisions occur on the user's device. The manifest declares no data collection. Dependency installation and AMO submission are developer release activities, not extension runtime behavior.

## Data observed

On user-authorized ordinary HTTP(S) pages, the isolated collector reports bounded numeric/boolean summaries: live DOM count; added/removed element counts; resource timing activity and dropped-entry indication; visible timer drift; age/visibility; signal availability and collector-budget health; and whether relevant editing was observed, not the edited value.

Firefox supplies tab ID, URL/hostname, optional title for an explicitly opened extension view, activity/pinned/audible/attention/discard/loading/recent-access/sharing metadata, frame and native document identity where supported. These are used locally for scope, UI, lifecycle, and safety.

## Data never read or stored

- Page text, HTML, form values, clipboard data, cookies, authentication tokens, or request/response bodies.
- Screenshots, audio, video, keystroke contents, health/financial/communications data, or an external browsing-history feed.
- Exact per-tab memory; Firefox does not expose it to this extension.

Resource timing activity and DOM growth are heuristic signals. The UI must say “possible resource growth,” not claim proof of a memory leak or invent megabytes.

## Storage and retention

Current document telemetry, temporary manual-session bindings, and the monitoring epoch live in Firefox session storage. Telemetry is capped at 16 samples per document and 300 tab records. Preferences and explicit site policies live in local storage. A bounded local recovery journal temporarily stores operation ID/nonce, tab/window and document identifiers, hostname, exact action, revision/epoch, safety fingerprint, warnings, and timestamps so a browser restart cannot replay or silently forget a possibly issued action. It is removed atomically when the terminal outcome commits. Recovery receipts contain bounded operational metadata such as hostname, reason codes, action/outcome, and time—never page content—and are capped at 50 plus the chosen age policy: off, 24 hours (default), or 7 days.

Users can clear receipts or delete all extension-managed local/session data. Clearing history also removes any already-committed residual journal marker atomically, so it cannot turn into a contradictory outcome after restart. Delete-all fences new work, drains bounded in-flight tab work, clears journal/receipts/telemetry/policies/tokens and process caches, removes alarms/notifications/persistent collector registration, and returns preferences to safe manual/notify defaults. Firefox-granted website permissions are intentionally separate and can be revoked in settings or Add-ons Manager. Private browsing is disabled.

## Permissions and notifications

Manual 15-minute active-tab sessions are the default and do not require stored broad access. Selected-site and all-site continuous monitoring use optional host permissions granted after a user gesture. Removing a site or permission stops its collector and invalidates action authority. Privileged/restricted Firefox and Mozilla pages are unsupported.

OS notifications are aggregate and generic by default to reduce lock-screen disclosure. Showing a hostname is an explicit preference. Page titles are not put in notifications. Notification bursts reuse one stable ID.

## Sharing diagnostics

There is no automatic upload. Any future export remains local until the user deliberately saves or shares it, must exclude page content and full private URLs, and should be reviewed by the user. Support guidance tells users not to submit sensitive browsing details.

## Security controls

Runtime schemas bound message size/types, sender identity is authoritative, page strings use safe text rendering, extension pages have an explicit self-only CSP, recovery belongs only to the background, storage is migrated/sanitized, all buffers/work are bounded, and release artifacts are content-audited and reproducible. See `docs/threat-model.md` for threats and residual gates.

Before each AMO submission, compare this statement, actual bundled code, permissions, notification text, retention behavior, and Mozilla's data-collection declaration. A mismatch blocks release.
