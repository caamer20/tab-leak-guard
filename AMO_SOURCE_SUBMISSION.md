# Mozilla source review instructions

Version: 0.1.1

This source archive contains everything required to reproduce the submitted Tab Leak Guard unsigned extension. The extension has no runtime package dependencies. TypeScript entry points are bundled with locked esbuild tooling; production output is intentionally unminified and excludes source maps. A separate review build includes linked source maps for inspection.

## Required tools

- Node.js 24.2.0
- npm 11.4.2

Exact development dependencies are recorded in `package-lock.json`; no global build tool is required. `npm ci` needs access to the public npm registry. The build itself makes no network requests.

## Reproduce and verify

From the extracted source archive root:

```sh
npm ci
npm run check:version
npm run verify
npm run release
npm run release:verify
```

`npm run release` writes to `artifacts/releases/0.1.1/`:

- `tab-leak-guard-0.1.1-unsigned.zip` — production signing candidate, no source maps;
- `tab-leak-guard-0.1.1-review.zip` — inspection build with linked source maps, not for user distribution;
- `tab-leak-guard-0.1.1-source.zip` — deterministic reviewer source;
- content manifest, CycloneDX SBOM, release notes, and `SHA256SUMS`.

Run `npm run release:reproducible` to generate the complete set twice in independent temporary directories and compare every file byte-for-byte. ZIP entries are sorted and use fixed 1980-01-01 metadata. The content manifest records every unpacked production/review file hash and the package-lock hash.

## Build stages

1. `scripts/check-version.mjs` requires package, lock, and source-manifest versions to match; preserves the signed extension ID; checks lifecycle permission/CSP; and verifies automatic recovery is quarantined.
2. `scripts/build.mjs` bundles background, collector, popup, options, and onboarding entry points and copies static manifest/locales/icons/HTML/CSS.
3. `scripts/audit-package.mjs` enforces the exact production allowlist and rejects source maps, development content, remote script tags, and dynamic evaluation.
4. `scripts/release.mjs` creates deterministic ZIPs, the content manifest, SHA-256 file, release notes, and CycloneDX SBOM using Node built-ins.

The review ZIP differs only by linked source maps and their references; it is not the submitted binary. CI uploads unsigned artifacts only. AMO signing credentials and signed output are never committed or embedded in the source archive.

## Safety state

Version 0.1.1 is notify/manual only. `src/shared/constants.ts` sets `AUTOMATIC_RECOVERY_AVAILABLE` to `false`, and the version check enforces that release invariant. No remote service can change it.
