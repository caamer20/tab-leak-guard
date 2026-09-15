# Contributing to Tab Leak Guard

Focused contributions that improve detection, user control, privacy, or reliability are welcome.

## Before starting

Read the [architecture](docs/architecture.md) and [implementation status](docs/implementation-status.md). For a large feature, open an issue describing the user problem, proposed behavior, and validation approach.

Use private reporting in [SECURITY.md](SECURITY.md) for vulnerabilities or exploitable unintended tab actions. Ordinary reports should include extension/Firefox/OS versions, monitoring scope, expected behavior, and minimal reproduction steps. Use synthetic pages whenever possible.

## Local workflow

1. Fork the repository and create a descriptive branch.
2. Use Node.js 24.2+ and npm 11.4.2; run `npm ci`.
3. Make a focused change. Add regression tests for behavior changes and bug fixes.
4. Run `npm run verify`. For collector, permission, or recovery changes, also follow the relevant [Firefox smoke scenarios](docs/firefox-smoke-test.md).
5. Open a pull request explaining the problem, resulting behavior, and tests actually run. Disclose outstanding checks.

## Project invariants

- Findings describe observable resource growth, never exact memory or guaranteed leak detection.
- Automatic recovery stays disabled until the documented release gates pass.
- Every manual action binds consent to the current tab, document, and exact action.
- Missing or stale safety information blocks recovery.
- Collection, stored state, retries, and notifications remain bounded.
- Sensitive page content and form values must not enter messages, storage, diagnostics, or fixtures.
- No runtime service, telemetry, remote code, or new permission without design review.
- Preserve the existing extension ID and migration compatibility.

## Pull request hygiene

Keep unrelated refactors separate. Do not commit generated archives, `dist`, dependencies, credentials, personal browser profiles, or raw browsing diagnostics. Update the changelog and documentation when behavior changes. Do not lower coverage thresholds to make a change pass.

Contributions are provided under the [MIT license](LICENSE). There is no promised response time; maintainers review contributions as capacity permits.
