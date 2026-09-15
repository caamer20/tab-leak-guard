# Changelog

All notable user-visible and release-engineering changes are recorded here. Versions follow the Firefox extension version rules.

## Unreleased

- Published the public GitHub repository with installation/development documentation, contribution and issue templates, private vulnerability reporting, and a marketplace submission guide.
- Updated the development-only `adm-zip` dependency from 0.6.0 to 0.6.1 so the current dependency audit no longer flags GHSA-vwc7-r8mq-g2x9. The extension runtime is unchanged.

## 0.1.1 — 2026-08-30

### Safety

- Quarantined automatic recovery behind a compile-time fail-safe. Detection and notifications remain available; every tab reset requires a fresh user decision.
- Added action-bound, expiring recovery operations, idempotency, lifecycle cancellation, safety preflights, retry suppression, and persisted circuit-breaker state.
- Made pause, permission removal, site removal, navigation, update, and document mismatch revoke pending authority.
- Added fail-closed navigation-generation/native-document fences and monotonic permission-revision fences so asynchronous Firefox calls cannot continue under changed authority.
- Added protection for edited or unknown input state, media sharing, pinned/audible/attention tabs, loading, recent access, and non-discardable tabs.
- Migrated stored state to schema v3. The migration preserves issued journals only for reconciliation, invalidates stale session/document authority before use, and commits its schema marker last for crash-safe replay.

### Monitoring and detection

- Added manual 15-minute sessions plus manual, selected-site, and all-site permission scopes.
- Added Firefox document identity support where available and conservative compatibility behavior elsewhere.
- Limited each document to 16 samples and added bounded/adaptive collector work.
- Added per-delivery deadlines and up to three bounded transient collector restarts. Restarts retain document/sequence/route/edit state, recreate observers, and force a degraded gap so transport loss cannot improve evidence.
- Added synchronous sentinel ownership and takeover of legacy/malformed collector sentinels for safe reinjection into already-open documents.
- Made full DOM recount cooperative and bounded by slice count, active work, and a 100,000-node ceiling. Incomplete recounts are censored as unavailable and degrade evidence; the fixture lab now includes a 120,000-node pathological case.
- Introduced detector model v2 with signal quality, multi-window evidence, hysteresis, plateau/release evidence, and deterministic trace replay.
- Renamed resource-timing evidence to resource activity; it is not presented as retained memory.

### Privacy and experience

- Added generic aggregate notifications, bounded/age-based history, delete-all controls, clearer mode status, onboarding, and accessible/localized UI.
- Serialized notification and badge mutation/cleanup with authority checks and compensating clear behavior, including permission-revocation and delete-all ordering.
- No telemetry, remote configuration, remote code, or application network service was added.

### Production engineering

- Added deterministic production, review, and source archives; SHA-256 checksums; a CycloneDX SBOM; package-content auditing; version/ID checks; and reproducibility verification.
- Added a disposable-profile headless Firefox smoke gate that verifies the built manifest, exact temporary add-on identity, fixture loading, add-on reload, and clean child-process shutdown without using the regular profile.
- Preserved extension ID `tab-leak-guard@local.invalid` for update continuity with signed 0.1.0.

### Known limitations

- Automatic recovery is unavailable while safety validation and a multi-week notify-only beta remain incomplete.
- Firefox exposes no exact per-tab memory API, so findings are heuristic.
- Notification/badge ordering intentionally depends on Firefox eventually settling trusted browser-API mutation promises. Rejections are recoverable and authority fails closed, but a never-settling promise can stall cleanup or permission reconciliation; real-browser fault injection remains pending.
- Cross-platform Firefox Release/Beta/ESR validation and the installed 0.1.0-to-listed-update rehearsal remain release blockers.

## 0.1.0 — 2026-08-29

- Initial unlisted, signed prototype.
