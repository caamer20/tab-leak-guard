# Release and rollback runbook

## Prepare

1. Start from a reviewed, clean commit. Confirm `package.json`, `package-lock.json`, `src/manifest.json`, changelog, and release notes use the same version.
2. Confirm `AUTOMATIC_RECOVERY_AVAILABLE` is `false` for 0.1.1 and the extension ID is unchanged.
3. Run `npm ci`, then `npm run release:reproducible`.
4. Run `npm run release`. The command performs version checks, type checking, all tests and coverage, Mozilla lint, production package audit, and generates the release set under `artifacts/releases/<version>/`.
5. Run `npm run release:verify`. Review `SHA256SUMS`, the content manifest, CycloneDX SBOM, and unsigned ZIP contents.
6. In a network-enabled environment, run `npm run audit:production` and `npm run audit:development`. Production findings block release. Development findings block unless they exactly match an unexpired entry in `security-advisories.json`.

## Validate

Complete every automated and manual gate in `docs/release-checklist.md`. Use `docs/firefox-smoke-test.md` for the reproducible local Release pass and evidence template. Attach CI links and manual evidence to the release record. Test Firefox Release, Beta, and the supported compatibility tier on macOS, Windows, and Linux. Rehearse an update from signed 0.1.0 using a disposable profile with a pending legacy alarm.

## Submit

1. Submit `tab-leak-guard-<version>-unsigned.zip` for AMO signing/listing.
2. Submit `tab-leak-guard-<version>-source.zip` as source and use `AMO_SOURCE_SUBMISSION.md` as reviewer instructions.
3. Never submit the review ZIP as the production binary and never modify a generated artifact after recording hashes.
4. After AMO returns the signed XPI, store it beside the release set without replacing the unsigned archive. Add its SHA-256 to the signed release record.
5. Install the signed XPI in a disposable profile and repeat core smoke, privacy, permission, and upgrade tests before rollout.

## Roll back or respond to a safety incident

1. Stop rollout and preserve the failing profile, logs, operation receipt, version, and reproduction trace without collecting page content.
2. If recovery safety is implicated, branch from the last-known-good tag. Keep automatic recovery false and add a startup migration that cancels any unsafe persisted authority before normal initialization.
3. Run the full release/reproducibility workflow and the pending-alarm upgrade test.
4. Submit the emergency update through the chosen AMO channel. Do not introduce remote code or a hidden remote kill switch.
5. Publish concise impact and manual-update guidance for users still on unlisted builds.
6. Add a deterministic regression test and update the threat model before closing the incident.

## Release record

Record commit/tag, Node/npm versions, CI run, all artifact hashes, AMO version/link, signed XPI hash, SBOM, advisory exceptions, manual test matrix, rollout approval, rollback owner, and known limitations. Never claim a pending gate passed.
