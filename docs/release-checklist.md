# Release checklist

Version target: 0.1.1. Check a box only when evidence for the repository candidate is attached; repository implementation or the presence of a test is not equivalent to a recorded run, browser validation, or beta validation. Local automated evidence is recorded in [`docs/evidence/0.1.1-local-validation.md`](./evidence/0.1.1-local-validation.md). Unchecked external/manual rows remain blockers.

## Automated repository gates

- [x] Exact package/lock/source-manifest version, fixed extension ID, CSP, `webNavigation`, and automatic-recovery quarantine are enforced by `npm run check:version`.
- [x] Strict TypeScript and the complete Vitest suite run through `npm run verify`.
- [x] Coverage thresholds run through `npm run test:coverage`.
- [x] Mozilla manifest/package lint runs through `npm run lint:webext`.
- [x] Production content allowlist rejects development files, source maps, remote scripts, and dynamic evaluation.
- [x] Production, review, and source archives use fixed metadata and sorted entries.
- [x] Release generates a content manifest, SHA-256 file, CycloneDX SBOM, and release notes.
- [x] `npm run release:reproducible` compares two independently generated release sets byte-for-byte.
- [x] CI has read-only permissions, locked install, separate verification/security/release jobs, artifact verification, and unsigned-artifact retention.
- [x] Network production dependency audit is clean for the release candidate.
- [x] Development audit contains only the unexpired documented exception.

## Safety and lifecycle gates

- [x] Automatic recovery is compile-time unavailable and notify-only is the sanitized/default recovery state.
- [x] Unit/integration tests cover master-off, permission removal, site removal, update migration, stale alarm/epoch/document, duplicate execution, retry suppression, and storage corruption.
- [x] Unit/integration tests cover schema-v3 ordering: durable reconciliation evidence first, stale session/document authority invalidated next, and the v3 marker committed last.
- [x] Unit/integration tests cover navigation generations, retired collectors, native-document correlation, completion reconciliation, and recovery rejection while a document fence is unresolved.
- [x] Unit/integration tests cover fresh edited-state and media-sharing/non-discardable protection.
- [ ] Signed-update rehearsal proves zero tab action from a legacy pending alarm.
- [ ] Real Firefox proves pause/revoke/navigation/tab replace/BFCache/redirect/sleep-wake fail closed.
- [ ] Real Firefox or approved race instrumentation proves document/navigation fencing remains fail closed under loading/commit/history/completion event reordering.
- [ ] Real Firefox proves every manual action has visible consent, fresh preflight, idempotency, and honest verification outcome.
- [ ] Zero unintended recovery actions during the required notify-only beta.

## Detector and performance gates

- [x] Detector v2 has versioned deterministic replay, multi-window evidence, quality, plateau/release negative evidence, and hysteresis tests.
- [x] A retained-DOM prerequisite prevents resource activity or timer drift alone from confirming.
- [x] Collector work is bounded, health is reported, cadence adapts, and storage caps at 16 samples per document.
- [x] Collector transport tests record the delivery deadline checks, bounded 500 ms/1 s/2 s transient restarts, definitive rejection, preserved document/sequence/segment/edit state, and forced degraded gap.
- [x] Duplicate injection and legacy/malformed sentinel takeover tests prove one current collector owns an already-open document.
- [x] Cooperative recount tests prove slice/work/slice-count bounds, no retained visited-node set, and censorship/degraded quality at the 100,000-node ceiling.
- [ ] Benign/leak corpus meets the documented false-confirmation, recall, and stability thresholds.
- [ ] Collector sample/recount/mutation p95 budgets pass on the hardware/browser matrix.
- [ ] The 120,000-node `pathological-dom` fixture censors recount evidence without repeated long tasks or a tight retry loop in Firefox performance tooling.
- [ ] 100-tab/8-hour soak has bounded extension state and no persistent extension performance warning.

## Permission, privacy, and accessibility gates

- [x] Manual 15-minute, selected-site, and all-site states are represented and runtime validated in the fake-Firefox harness.
- [x] Generic aggregate notification is the default; title is excluded and hostname disclosure is optional.
- [x] Receipts have count/age retention and clear/delete-all controls.
- [x] No runtime dependency, remote code, application network endpoint, telemetry, or remote configuration is present in the audited package.
- [x] Privacy statement, threat model, support warning, and manifest data declaration describe current code.
- [x] Permission-revision race tests prove change events fence authority immediately, stale async work cannot clear a newer pending revision, and reconciliation retries remain fail closed.
- [x] Notification/badge tests prove serialized ordering, rejection recovery, current-authority checks, compensating clear, permission-revoke cleanup, and delete-all cleanup.
- [ ] Firefox permission grant/revoke/reconciliation passes for each scope and restricted-page case.
- [ ] Network inspection confirms zero extension-origin runtime requests.
- [ ] Approved real-Firefox fault injection documents the trusted mutation-promise liveness boundary: rejected notification/badge work is retryable, while a never-settling promise stalls its queue without allowing stale authority or out-of-order cleanup.
- [ ] Keyboard, focus, screen reader, reduced-motion, zoom/high-contrast, and pseudo-locale tests pass.
- [ ] AMO data-use answers and listing text match the final signed bundle.

## Browser matrix

- [x] The exact automated headless-smoke command, Firefox build, candidate fingerprint, assertions, and exit result are recorded; this gate credits no interactive/manual row.
- [ ] The complete local Release procedure and evidence template in `docs/firefox-smoke-test.md` passes in a disposable profile.
- [ ] Current Firefox Release on macOS, Windows, and Linux.
- [ ] Current Firefox Beta on macOS, Windows, and Linux.
- [ ] Firefox 142 compatibility tier is tested or the minimum is raised with documentation.
- [ ] Native document-ID tier is tested and clearly shown in UI/diagnostics.
- [ ] Existing-tab injection, finite manual expiry/Stop, restricted-page handling, notification lifecycle, discard/restore, active reload, and event-page restart pass.

## Distribution and operations

- [x] Extension ID is frozen as `tab-leak-guard@local.invalid` for signed 0.1.0 continuity.
- [x] Listed AMO is the selected future consumer update channel; unlisted builds are dogfood/manual only.
- [x] Production versus review/source artifacts and signing boundaries are documented.
- [x] Changelog, 0.1.1 notes, runbook, rollback procedure, SBOM, and hash workflow exist.
- [ ] Real monitored security contact and support URL are published.
- [ ] Generated PNG icons are present; theme-variant review, screenshots, summary, category, privacy URL, and support materials are approved.
- [ ] Signed 0.1.0-to-listed-0.1.1 update rehearsal passes on a disposable regular profile.
- [ ] AMO automatic validation and any human review are complete.
- [ ] Signed XPI is hash-recorded and smoke-tested without modifying the unsigned/source evidence.
- [ ] Multi-week notify-only beta and release approval are complete.
- [ ] Rollback/safe-update drill completes through the selected channel.

Any unchecked item in the relevant release gate remains a blocker. In particular, generated unsigned 0.1.1 artifacts are not permission to claim public production readiness.
