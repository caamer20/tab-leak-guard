# Security policy

## Supported versions

Version 0.1.1 is a pre-release safety candidate. Signed 0.1.0 remains installed only for dogfood and should be upgraded manually once a signed 0.1.1 is available. There is not yet a public support commitment.

## Private reporting

Do not open a public issue for a vulnerability or unintended-tab-action report that could expose users. Use [GitHub private vulnerability reporting](https://github.com/caamer20/tab-leak-guard/security/advisories/new). Include affected version, Firefox/OS version, reproducible steps, expected/actual impact, and a minimal proof of concept that excludes sensitive page data.

Private reporting was enabled on September 14, 2026. Reports go to the repository's maintainers. A maintainer must confirm notification monitoring and response ownership before listed AMO distribution; no response-time commitment is currently offered.

## Security posture

- The shipped extension has zero runtime package dependencies and makes no application network requests.
- It includes no telemetry, analytics, remote code, remote configuration, native messaging, or hidden kill switch.
- Page-derived messages are versioned, size-bounded, schema-validated, and bound to Firefox sender/frame/document metadata.
- Privileged recovery is isolated to the background and uses expiring, idempotent, document-bound transactions plus fresh safety checks.
- Automatic recovery is compile-time quarantined in 0.1.1; each recovery action requires a user decision.
- Monitoring defaults to a finite manual session; persistent HTTP(S) access is optional and scope-selectable.
- Storage is versioned/sanitized, retention is bounded/age-based, and delete-all invalidates operations before clearing data.
- Production packages are allowlisted/audited; deterministic artifacts include content hashes and a CycloneDX SBOM.

See `docs/threat-model.md` for assumptions, controls, residual risks, and review triggers.

## Dependency policy

No unresolved production advisory may ship. Run `npm run audit:production` in a network-enabled environment for every release. Development advisories also block unless they exactly match an unexpired, reasoned entry in `security-advisories.json`; `npm run audit:development` enforces this policy and fails if the advisory service is unavailable.

As reviewed 2026-08-30, Mozilla `web-ext`/`addons-linter` transitively uses `image-size` affected by GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq. These denial-of-service parser issues do not enter the extension ZIP. The temporary exception expires 2026-11-30 and is limited to repository-owned reviewed images, unprivileged CI, and time-bounded jobs. Re-evaluate on every dependency update; do not use npm's unrelated forced breaking downgrade as a substitute for review.

## Safe-update response

For a safety incident, stop rollout, preserve redacted evidence, keep automatic recovery false, and prepare a signed update whose startup migration invalidates all existing action authority before normal initialization. Verify it against a profile containing a pending legacy alarm, run the deterministic release workflow, then distribute through AMO. Users on unlisted 0.1.0 require explicit manual-update guidance. Full procedure: `docs/release-runbook.md`.
