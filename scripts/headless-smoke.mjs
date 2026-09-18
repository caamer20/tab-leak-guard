import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FirefoxDesktopExtensionRunner } from "../node_modules/web-ext/lib/extension-runners/firefox-desktop.js";
import * as firefoxApp from "../node_modules/web-ext/lib/firefox/index.js";
import { connectWithMaxRetries } from "../node_modules/web-ext/lib/firefox/remote.js";
import { root } from "./release-utils.mjs";
import { checkFirefoxPopup } from "./firefox-popup-check.mjs";

const firefoxBinary = process.env.FIREFOX_BINARY ?? (
  process.platform === "darwin"
    ? "/Applications/Firefox.app/Contents/MacOS/firefox"
    : "firefox"
);
const manifest = JSON.parse(await readFile(resolve(root, "dist/manifest.json"), "utf8"));
const expectedId = manifest.browser_specific_settings?.gecko?.id;
if (typeof expectedId !== "string" || !expectedId) throw new Error("Built manifest has no Firefox extension ID");

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a fixture port");
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForFixture(url, processOutput) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}fixture-ping.json`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json()).ok === true) return;
    } catch {
      // The child may not have reached listen() yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Fixture server did not become ready. Output: ${processOutput()}`);
}

const versionProbe = spawnSync(firefoxBinary, ["--version"], { encoding: "utf8" });
if (versionProbe.status !== 0) {
  throw new Error(`Firefox version probe failed: ${(versionProbe.stderr || versionProbe.stdout).trim()}`);
}
const firefoxVersion = `${versionProbe.stdout}${versionProbe.stderr}`.trim();
const fixturePort = await freePort();
const marionettePort = await freePort();
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
let fixtureOutput = "";
const fixture = spawn(process.execPath, [resolve(root, "scripts/serve-fixtures.mjs")], {
  cwd: root,
  env: { ...process.env, FIXTURE_PORT: String(fixturePort) },
  stdio: ["ignore", "pipe", "pipe"]
});
fixture.stdout.on("data", (chunk) => { fixtureOutput += chunk.toString(); });
fixture.stderr.on("data", (chunk) => { fixtureOutput += chunk.toString(); });

let runner;
try {
  await waitForFixture(fixtureUrl, () => fixtureOutput.trim());
  runner = new FirefoxDesktopExtensionRunner({
    args: ["-headless", "--marionette", "--remote-allow-system-access"],
    browserConsole: false,
    customPrefs: { "marionette.port": marionettePort },
    devtools: false,
    extensions: [{ sourceDir: resolve(root, "dist"), manifestData: manifest }],
    firefoxApp,
    firefoxBinary,
    firefoxClient: connectWithMaxRetries,
    keepProfileChanges: false,
    preInstall: false,
    startUrl: [fixtureUrl],
    profilePath: undefined
  });
  await withTimeout(runner.run(), 45_000, "Firefox launch and temporary add-on installation");

  const remote = runner.remoteFirefox;
  if (!remote) throw new Error("web-ext did not expose a connected Firefox runner");

  const installed = await withTimeout(remote.getInstalledAddon(expectedId), 5_000, "Installed add-on lookup");
  if (installed.id !== expectedId) throw new Error(`Unexpected installed ID: ${installed.id}`);
  if (installed.version !== undefined && installed.version !== manifest.version) {
    throw new Error(`Installed version ${installed.version ?? "unknown"} does not match ${manifest.version}`);
  }
  if (installed.temporarilyInstalled !== true) throw new Error("Firefox did not report a temporary installation");

  const fixtureTab = await withTimeout((async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await remote.client.request("listTabs");
      const tab = response.tabs?.find((candidate) => candidate.url === fixtureUrl || candidate.url?.startsWith(fixtureUrl));
      if (tab) return tab;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Firefox did not expose the fixture tab at ${fixtureUrl}`);
  })(), 12_000, "Fixture tab lookup");

  const popup = await withTimeout(checkFirefoxPopup(marionettePort, expectedId), 35_000, "Toolbar popup layout");

  await withTimeout(remote.reloadAddon(expectedId), 10_000, "Temporary add-on reload");
  const reloaded = await withTimeout(remote.getInstalledAddon(expectedId), 5_000, "Reloaded add-on lookup");
  if (reloaded.id !== expectedId || reloaded.temporarilyInstalled !== true) {
    throw new Error("Temporary add-on disappeared or changed identity after reload");
  }
  if (reloaded.version !== undefined && reloaded.version !== manifest.version) {
    throw new Error("Temporary add-on changed version after reload");
  }

  console.log(JSON.stringify({
    result: "pass",
    firefoxVersion,
    extensionId: expectedId,
    extensionVersion: manifest.version,
    fixtureUrl: fixtureTab.url,
    popup,
    assertions: [
      "disposable Firefox profile launched headlessly",
      "built manifest has expected version and Firefox installed its expected ID temporarily",
      "local fixture tab loaded",
      "actual Firefox toolbar popup opens at a usable width and height",
      "temporary add-on reloaded and remained installed"
    ]
  }, null, 2));
} finally {
  if (runner?.runningInfo?.firefox) {
    const exited = new Promise((resolveExit) => runner.registerCleanup(resolveExit));
    await runner.exit().catch(() => undefined);
    await withTimeout(exited, 10_000, "Firefox shutdown").catch(() => undefined);
  }
  fixture.kill("SIGTERM");
  await withTimeout(new Promise((resolveExit) => {
    if (fixture.exitCode !== null || fixture.signalCode !== null) resolveExit();
    else fixture.once("close", resolveExit);
  }), 5_000, "Fixture shutdown").catch(() => undefined);
}
