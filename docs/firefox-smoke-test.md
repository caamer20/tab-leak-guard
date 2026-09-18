# Local Firefox Release smoke test

This procedure is a reproducible manual smoke pass for an **unsigned local release candidate**. It does not replace Beta/compatibility-tier, Windows/Linux, accessibility, soak, signed-update, AMO, or multi-week beta gates. Record evidence; do not check a release gate merely because installation succeeds.

## Safety and isolation

- Use a new disposable Firefox profile with no real accounts, saved forms, sensitive history, or production browsing.
- Never replace the installed regular-profile 0.1.0 with an unsigned build.
- Use only repository fixtures or disposable pages. Assume a manual reload/unload can lose page state.
- Automatic recovery must remain unavailable throughout the pass.
- Record Firefox build/version, operating system, commit, artifact SHA-256, locale, date/time zone, and tester before starting.

## Prepare the exact candidate

From the repository root:

```sh
npm ci
npm run release
npm run release:verify
npm run release:reproducible
shasum -a 256 artifacts/releases/0.1.1/tab-leak-guard-0.1.1-unsigned.zip
```

Expected repository gates: all tests and coverage thresholds pass; Mozilla lint has zero errors/warnings/notices; production content audit passes; three ZIPs validate; and two independent release runs are byte-identical. A `web-ext` update-check/config warning is not a manifest lint warning, but record it if present.

These are expected outcomes, not pre-checked evidence. Leave the release checklist and evidence disposition pending until the exact commands above have been recorded for the candidate under test.

Start the deterministic fixture lab in another terminal:

```sh
npm run fixtures
```

Use `http://127.0.0.1:4173/` only. Record the terminal output and exact URL.

## Automated headless smoke evidence (separate gate)

The repository's automated headless Firefox run verifies candidate identity/loading, fixture reachability, actual toolbar popup dimensions and rendered heading/status/settings control, temporary add-on reload, and clean child-process shutdown. Popup checks use Marionette system access only in the newly created disposable profile. It does **not** inspect collector/background communication or browser-console output, pass any interactive row below, or substitute for permission prompts, OS notifications, keyboard/focus behavior, discard/restore, Browser Toolbox inspection, profile migration, signed update, or real user-gesture checks.

Run only the repository command selected for the frozen candidate, against the same built artifact and a new disposable profile. Do not invent or reconstruct the invocation in the release record: paste the command and result verbatim from the final run. Until that evidence exists, leave the corresponding release-checklist box unchecked.

```text
Automated headless smoke
  Commit/tag:
  Artifact path / SHA-256:
  Command (verbatim):
  Firefox executable:
  Firefox channel/build:
  OS/build/architecture:
  Disposable profile path or runner identifier:
  Fixture URL:
  Start/end UTC:
  Exit code:
  Assertions executed:
  Assertions passed/failed:
  Unexpected extension/page console output:
  Full log/artifact link:
  Result: PASS / FAIL / BLOCKED

Interactive/manual rows credited by this run: NONE
```

## Create a disposable profile

Preferred interactive route:

1. Quit disposable Firefox instances.
2. Run Firefox Profile Manager (`firefox -P` on PATH, or the platform-specific Firefox binary with `-P`).
3. Create a profile named `TLG-0.1.1-smoke-<date>` in a new temporary directory.
4. Start Firefox with that profile and verify it contains no existing extensions or personal data.
5. Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `dist/manifest.json` produced by the release command.

Alternative automation-assisted launch:

```sh
npx web-ext run --source-dir dist --url http://127.0.0.1:4173/
```

`web-ext run` uses a temporary profile by default. Record the command, Firefox binary/version, and console output. Temporary installation proves only local loading; Release/Beta user distribution still requires Mozilla signing.

For the repeatable repository gate, build the exact candidate and run:

```sh
npm run build:production
FIREFOX_BINARY=/path/to/firefox npm run smoke:headless
```

The script allocates its own localhost fixture/debugger ports and disposable Firefox profile, validates the built manifest version, verifies Firefox's temporary installation under the exact extension ID, verifies the fixture tab, opens the real toolbar popup and checks its layout/content, reloads the add-on once, and shuts down both child processes. A pass credits only the automated headless-smoke row; it does not exercise or credit the interactive scenarios below. Some Firefox remote-debugging versions omit the add-on version field; when present, the script also requires it to match the built manifest. The popup harness uses Firefox-internal test interfaces and may need maintenance for future Firefox changes.

## Smoke sequence

Perform in order and capture expected/actual outcome for every row.

### 1. Identity, onboarding, and safe defaults

1. In `about:debugging`, verify name Tab Leak Guard, version 0.1.1, ID `tab-leak-guard@local.invalid`, and no startup errors.
2. Open onboarding. Confirm it explains heuristic—not exact-memory—detection, local-only processing, and the three monitoring scopes.
3. Choose manual-only. Confirm no broad HTTP(S) permission is stored.
4. Open popup/settings. Confirm recovery says notify/manual only and there is no automatic-recovery control.
5. Inspect extension debugging console for uncaught errors.

### 2. Finite manual monitoring

1. Open the stable fixture, start a 15-minute session, and confirm the popup identifies manual mode and expiry.
2. Start it again; confirm the session is idempotent rather than creating duplicate collectors.
3. Use **Stop monitoring** and confirm the record/indicator clears and no finding notification remains.
4. Start a new session, navigate the tab, and confirm old-document evidence does not appear on the replacement document.
5. On `about:config`, `about:addons`, the built-in PDF viewer, and another restricted target, confirm the extension explains unsupported access and does not claim monitoring started.
6. Keep a monitored fixture open and reload the temporary extension from `about:debugging`, then re-establish monitoring without reloading the page. Confirm reinjection leaves one effective collector and samples come from the current runtime. For a legacy or malformed sentinel, use only the deterministic fixture/harness supplied for that purpose; confirm the previous sentinel is stopped where possible and takeover does not create two sample streams.
7. With approved transport fault injection (not by modifying the release artifact), force a collector delivery timeout/retryable rejection and then recovery. Confirm no more than three restarts occur at the bounded delays; document instance, sample sequence, route segment, segment start, and the most conservative edit state survive; observers are recreated; and the first accepted post-gap evidence is degraded. If such instrumentation is unavailable, record this row as **BLOCKED**, not passed.

### 3. Selected-site and all-site permissions

1. Add the exact fixture origin as selected-site access. Confirm Firefox prompts only for the intended supported origin pattern and the collector starts in eligible existing tabs once granted.
2. Try malformed, credential-bearing, path-bearing, and explicit-port input. Confirm it is rejected without a misleading success message.
3. Remove the site. Confirm permission state is re-read from Firefox, registration/evidence clears, and no stale action remains.
4. Grant all-site access after a user gesture; confirm regular HTTP(S) fixtures monitor continuously and restricted pages do not.
5. Revoke access first in extension settings, then repeat using Firefox Add-ons Manager. Confirm UI state, registration, findings, notifications, and action authority reconcile after each route.
6. If Firefox refuses removal, confirm the UI reports failure instead of announcing success.
7. With approved delayed-permission instrumentation, begin a snapshot, collector bootstrap/sample, or prepared recovery and revoke/change the relevant grant before the Firefox permission promise resolves. Confirm the permission revision changes immediately, old async work cannot clear the newer pending state, and collection/recovery remains blocked until reconciliation for the latest revision completes. Exercise a transient reconciliation failure and confirm bounded retry rather than stale authorization. Record **BLOCKED** if this race cannot be instrumented in the candidate environment.

### 4. Detector truthfulness and lifecycle

1. Run stable-large, high-churn-with-release, and burst-release controls through the full warmup. They must not become confirmed runaway findings solely from size/activity.
2. Run retained-growth long enough for the normal five-minute/six-sample warmup and consecutive confirmation rule. Confirm the finding explains DOM retention/evidence quality without invented MB values.
3. Open `pathological-dom`, wait until its 120,000-element construction settles, and then start monitoring. Confirm the full recount is censored/unavailable at the 100,000-node ceiling, quality becomes degraded/overflow rather than reporting a partial exact DOM count, retry is not tight-looped, and Firefox performance tooling shows cooperative yielding without repeated long blocking tasks.
4. Background/foreground, hide/show, redirect, history navigation, SPA route changes, and duplicate/close fixture tabs. Include rapid back/forward and a slow navigation: while a loading/commit fence is unresolved, attempt to prepare/execute recovery and confirm it fails closed. Confirm only the matching/newer navigation generation clears the fence, old collector IDs remain rejected, and removed records do not reappear.
5. Restart the extension background from `about:debugging`. Confirm hydrated state is bounded and no old operation becomes actionable.
6. Using an approved migration fixture/profile, start with pre-v3 or corrupt session/local state and load 0.1.1. Confirm the monitoring epoch advances, document records/tab runtime policy/manual-session authority are not restored, an issued journal is retained only for conservative reconciliation, and the v3 marker is written only after session invalidation. A real installed-version update remains a separate signed-update gate.
7. Confirm only one generic aggregate OS notification exists during a burst. It must not expose page title; hostname appears only after explicitly selecting that preference.
8. Clear the finding/stop monitoring and confirm badge/notification lifecycle is consistent.

### 5. Manual recovery and protections

Use disposable fixture data only.

1. From a confirmed retained-growth finding, choose recovery. Confirm the modal states the exact reload or unload effect, target, expiry/countdown, and edit-risk acknowledgement.
2. Cancel with the button and Escape. Confirm focus returns logically and no tab API effect occurs.
3. Let authorization expire. Confirm execution is rejected and no action runs.
4. Change/navigation/close the target between prepare and execute. Confirm stale document/tab authority is rejected.
5. Verify protections independently for edited/unknown input, pinned, audible, attention/modal, active media sharing, loading, recently accessed, and Firefox-declared non-discardable state where reproducible.
6. On an inactive safe fixture, explicitly authorize unload. Confirm the tab remains in the strip, reaches Firefox discarded state, and restores normally when activated. Receipt must distinguish verified success, blocked, timeout, and unknown outcome accurately.
7. On an active safe disposable fixture, explicitly authorize reload. Confirm normal reload is requested and no duplicate action occurs.
8. Trigger cancel/close while an action is queued or completing. Confirm UI never says “no action ran” after execution actually completed.

### 6. Pause, delete, restart, and privacy

1. Prepare but do not execute an action, then pause monitoring. Advance beyond its expiry and restart the background. Confirm no action runs and pending operation/notification clears.
2. Repeat for permission revoke, selected-site removal, ignore-site, navigation, and extension reload/update simulation.
3. Exercise snooze/cooldown, restart, and clock/sleep-wake if practical. Confirm future policies survive and expired policies do not.
4. Export redacted diagnostics. Inspect the file before saving evidence: no page text, form values, full private URL/path/query, cookies, tokens, or title should appear.
5. Choose **Delete all local data** while tabs are navigating/sampling. Confirm new work is blocked until erasure finishes, all extension-managed state/alarms/notifications clears, and late work does not recreate receipts. Website permissions remain separately visible in Firefox as documented.
6. With Firefox Browser Toolbox or an approved local network observer, confirm no extension-origin runtime HTTP/WebSocket/beacon traffic during onboarding, monitoring, notifications, recovery, export, and deletion. Do not count fixture-page traffic as extension traffic.
7. With approved browser-API fault injection, reject a badge or notification mutation and confirm later serialized work still runs and the state remains retryable. Separately, hold a mutation promise open: confirm the corresponding queue does not run a newer mutation out of order and permission reconciliation/action authority remains fail closed. A never-settling Firefox promise is an explicit trusted liveness limitation; record the held-promise case as an observed limitation, not as proof that cleanup completed. If instrumentation is unavailable, record **BLOCKED**.

## Completion and cleanup

1. Export only redacted evidence needed for the release record.
2. Remove the temporary add-on and delete the disposable profile directory through Profile Manager.
3. Stop the fixture server.
4. Confirm the regular Firefox profile and signed 0.1.0 artifact/install were never modified.
5. File every unexpected result with a minimal reproduction; a safety, permission-truthfulness, privacy, data-loss, duplicate-action, or lifecycle failure blocks release.

## Evidence template

```text
Candidate
  Commit/tag:
  Version / extension ID:
  Unsigned ZIP SHA-256:
  Source ZIP SHA-256:
  Firefox channel/build:
  Native documentId available (yes/no/unknown):
  OS/build/architecture:
  Locale / time zone:
  Tester / UTC timestamp:

Repository gates
  npm ci:
  npm run release:
  npm run release:verify:
  npm run release:reproducible:
  Production dependency audit:
  Development advisory policy:

Automated headless smoke
  Exact command / result:
  Firefox build / artifact hash:
  Evidence link:
  Disposition: PASS / FAIL / BLOCKED (does not credit interactive rows)

Scenario | Expected | Actual | Pass/Fail/Blocked | Evidence link | Issue
1.1 Identity/version
1.2 Onboarding/defaults
2.1 Manual session
2.3 Stop
2.4 Navigation invalidation
2.6 Collector sentinel takeover
2.7 Bounded transport retry/state preservation
3.1 Selected-site grant
3.2 Invalid origin/port
3.3 Removal verification
3.4 All-site grant
3.5 External revoke
3.7 Permission-revision race
4.1 Benign controls
4.2 Retained-growth fixture
4.3 Pathological DOM recount
4.4 Navigation/document fences
4.5 Event-page restart
4.6 Schema-v3 migration
4.7 Notification privacy/burst
5.2 Cancel/Escape/focus
5.3 Expiry
5.4 Stale target
5.5 Safety protections
5.6 Discard verification/receipt
5.7 Reload/idempotency
5.8 Completion/cancel race
6.1 Pause with pending authority
6.2 Other authority invalidation
6.4 Diagnostic redaction
6.5 Delete-all race
6.6 Zero runtime network
6.7 Serialized browser-UI mutation/liveness

Unexpected console output:
Known limitations observed:
Open blocking issues:
Final disposition: PASS / FAIL / BLOCKED (never infer PASS for unrun rows)
```

Attach this record to the release evidence. Passing this local Release smoke still leaves every unchecked external/manual item in `docs/release-checklist.md` pending.
