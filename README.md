<p align="center">
  <img src="src/icons/icon-128.png" alt="Tab Leak Guard" width="96" height="96">
</p>

<h1 align="center">Tab Leak Guard</h1>

<p align="center">Understand sustained tab growth. Review the evidence. Recover on your terms.</p>

<p align="center">
  <a href="https://github.com/caamer20/tab-leak-guard/actions/workflows/ci.yml"><img src="https://github.com/caamer20/tab-leak-guard/actions/workflows/ci.yml/badge.svg" alt="Repository verification"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="src/manifest.json"><img src="https://img.shields.io/badge/Firefox-142%2B-FF7139" alt="Firefox 142 or newer"></a>
</p>

Tab Leak Guard is a Firefox extension that watches for sustained resource-growth patterns, explains concerning tabs, and lets you review an unload or reload before it happens. Analysis stays in your browser. There are no analytics, accounts, or runtime network services.

**Status:** version 0.1.1 is approved and publicly available on Firefox Add-ons. Version 0.1.2 fixes a toolbar popup sizing regression and has been submitted to Mozilla; it is awaiting review. Broader browser validation remains pending. Automatic recovery is disabled; every recovery action requires your confirmation.

[Cameron Amer](https://www.cameronamer.com) · [Getting started](#getting-started) · [How it works](#how-it-works) · [Development](#development) · [Privacy](docs/privacy.md) · [Contributing](CONTRIBUTING.md)

## Why Tab Leak Guard?

- **Understand the warning.** See evidence quality, freshness, learning progress, and why a tab looks concerning.
- **Choose your access scope.** Start a temporary 15-minute session, monitor selected sites, or authorize all regular websites.
- **Stay in control.** Snooze findings, ignore sites, stop monitoring, and review the exact tab action before approving it.
- **Protect ongoing work.** Recovery checks page identity and current activity, including edits, media sharing, loading, and other protections.
- **Keep browsing data local.** Notifications are generic by default. Local history has retention controls, and diagnostics are redacted for deliberate sharing.
- **Inspect the implementation.** TypeScript source, deterministic tests, reproducible archives, and a software bill of materials are included.

## How it works

1. A small collector observes live DOM size, retained element growth, resource activity, and visible-page responsiveness on authorized pages.
2. The detector learns a baseline for about five minutes, then looks for sustained patterns across multiple samples. Large pages and short bursts are not sufficient by themselves.
3. The toolbar shows findings and supporting evidence. Optional notifications alert you to concerning growth.
4. You review an exact action: unload an inactive tab or reload an active tab. The extension checks the current page again before acting.

### Detection limits

Firefox does not expose exact per-tab memory through the APIs used by this extension. Findings estimate possible leak patterns, particularly retained live DOM growth. They are not proof of a memory leak and do not include invented memory readings or “MB saved” claims.

Pure JavaScript heap leaks, detached DOM, workers, GPU/media allocations, and browser-engine leaks can remain invisible. Restricted Firefox pages cannot be monitored. A quiet finding is not proof that a page is leak-free.

## Getting started

Install the signed extension from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tab-leak-guard/). Version 0.1.1 is currently public; the popup-sizing fix in 0.1.2 is awaiting Mozilla review. See the [0.1.2 submission record](docs/evidence/0.1.2-amo-submission.md).

To try the candidate locally:

```sh
git clone https://github.com/caamer20/tab-leak-guard.git
cd tab-leak-guard
npm ci
npm run build
```

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist/manifest.json`. Temporary installations are removed when Firefox restarts. Use a disposable profile and test pages when trying recovery actions.

Open the toolbar popup, start a 15-minute session on a regular website, and allow the detector time to learn. Continuous selected-site or all-site monitoring is available through settings.

## Privacy and permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Start a session on the tab you select |
| Optional HTTP/HTTPS access | Monitor the sites you authorize continuously |
| `scripting` | Install the isolated page collector |
| `storage` | Keep preferences, bounded samples, and recovery history locally |
| `alarms` | Reconcile session expiry and scheduled state |
| `notifications` | Show optional alerts with generic text by default |
| `webNavigation` | Associate evidence and recovery consent with the current document |

The collector does not read page text, form values, cookies, request bodies, screenshots, or keystroke contents. Firefox-provided URLs and tab metadata are used locally for scope, display, and safety. Private browsing is disabled.

Read the [privacy statement](docs/privacy.md) for exact fields, retention, and export behavior, and the [security policy](SECURITY.md) for private reporting.

## Development

Use Node.js 24.2 or newer and npm 11.4.2. The release toolchain is pinned in `.nvmrc` and `package.json`; dependencies are locked in `package-lock.json`.

```sh
npm ci
npm run verify
```

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the production extension into `dist/` |
| `npm test` | Run deterministic unit and integration tests |
| `npm run test:coverage` | Enforce coverage thresholds |
| `npm run verify` | Check identity, types, tests, coverage, Mozilla lint, and package contents |
| `npm run fixtures` | Serve the detector lab at `http://127.0.0.1:4173/` |
| `npm run smoke:headless` | Test installation and reload in a disposable Firefox profile |
| `npm run audit:production` | Check shipped dependency advisories |
| `npm run audit:development` | Enforce the development advisory policy |
| `npm run release` | Verify and create production, review, and source archives |
| `npm run release:reproducible` | Compare two independently generated release sets |

For the headless smoke command, set `FIREFOX_BINARY` if Firefox is not at the default platform location. Build first. The fixture lab includes retained growth, stable large pages, churn, burst/release, edit/media protections, and a 120,000-element stress case.

### Recorded validation

The August 30, 2026 candidate passed **388 tests across 23 files**, with **90.00% statement coverage** and **100% coverage of the recovery transaction module**. Mozilla lint reported zero errors, notices, or warnings. A Firefox 154.0.1 headless installation/reload smoke passed on macOS, and two release builds produced identical artifacts.

These are dated local results. The badge above reports current CI status. See the [validation record](docs/evidence/0.1.1-local-validation.md) and [release checklist](docs/release-checklist.md) for scope and outstanding checks.

## Project structure

```text
src/
  background/   Firefox lifecycle, permissions, state, and tab actions
  collector/    Bounded page observations and collector health
  detector/     Trend features, evidence quality, scoring, and replay
  recovery/     Safety policy and recovery transactions
  shared/       Types, runtime validation, and constants
  ui/           Popup, settings, and onboarding
tests/          Unit/integration tests and deterministic page fixtures
scripts/        Build, audit, packaging, and Firefox smoke tooling
docs/           Architecture, privacy, validation, and release guides
```

The background owns tab-action authority. Collectors send bounded summaries; the background validates Firefox sender identity, document freshness, permission state, and consent. See the [architecture](docs/architecture.md) and [threat model](docs/threat-model.md).

## Releases and roadmap

Mozilla signs the production archive; the review and source archives support inspection and reproduction. Generated output stays out of Git. A GitHub source archive is not an installable Firefox extension.

- [Marketplace submission guide and listing copy](docs/marketplace-submission.md)
- [Mozilla source build instructions](AMO_SOURCE_SUBMISSION.md)
- [Release runbook](docs/release-runbook.md)
- [Changelog](CHANGELOG.md)
- [Implementation status](docs/implementation-status.md)
- [Improvement roadmap](IMPROVEMENT_PLAN.md)

Upcoming work includes representative-site calibration, broader Firefox and accessibility testing, collector performance measurement, and a monitored beta. Automatic recovery remains unavailable until its safety gates are satisfied.

## Contributing and support

Bug reports, reproducible detector cases, accessibility feedback, and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [issue tracker](https://github.com/caamer20/tab-leak-guard/issues). Review diagnostics before sharing them; remove private browsing details.

Report vulnerabilities privately using the process in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Tab Leak Guard contributors.
