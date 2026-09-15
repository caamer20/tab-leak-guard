import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./release-utils.mjs";

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "src/manifest.json"), "utf8"));
const config = JSON.parse(await readFile(resolve(root, "release.config.json"), "utf8"));
const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", lock.version],
  ["package-lock root package", lock.packages?.[""]?.version],
  ["src/manifest.json", manifest.version]
]);
const expected = packageJson.version;
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(expected)) throw new Error(`Firefox-incompatible version: ${expected}`);
for (const [file, version] of versions) {
  if (version !== expected) throw new Error(`Version mismatch: ${file} is ${String(version)}, expected ${expected}`);
}
if (manifest.browser_specific_settings?.gecko?.id !== "tab-leak-guard@local.invalid" || config.extensionId !== "tab-leak-guard@local.invalid") {
  throw new Error("The signed extension ID changed; migration must be an explicit release decision");
}
if (!manifest.permissions?.includes("webNavigation")) throw new Error("webNavigation permission is required by lifecycle reconciliation");
if (manifest.browser_specific_settings?.gecko?.strict_min_version !== "142.0") throw new Error("Firefox minimum changed without updating the release decision");
if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'none';") {
  throw new Error("The explicit extension-page CSP is missing or changed");
}
const constants = await readFile(resolve(root, "src/shared/constants.ts"), "utf8");
const recoveryDeclarations = [...constants.matchAll(/export const AUTOMATIC_RECOVERY_AVAILABLE = (true|false);/g)];
if (recoveryDeclarations.length !== 1 || recoveryDeclarations[0][1] !== "false") {
  throw new Error("Automatic recovery quarantine is not compile-time disabled");
}
if (config.automaticRecoveryQuarantined !== true || config.distributionChannel !== "listed-amo") {
  throw new Error("Recovery quarantine or distribution channel changed without an explicit release decision");
}
console.log(`Version ${expected}, extension ID, Firefox tier, CSP, lifecycle permission, update channel, and recovery quarantine are consistent.`);
