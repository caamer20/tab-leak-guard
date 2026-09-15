import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalJson,
  describeFiles,
  filesUnder,
  isRegularFile,
  root,
  sha256,
  writeDeterministicZip,
  zipEntriesFromDirectory
} from "./release-utils.mjs";

const args = process.argv.slice(2);
const skipVerify = args.includes("--skip-verify");
const outputIndex = args.indexOf("--output");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const config = JSON.parse(await readFile(resolve(root, "release.config.json"), "utf8"));
const version = packageJson.version;
const defaultOutput = resolve(root, config.releaseDirectory, version);
const output = resolve(outputIndex === -1 ? defaultOutput : args[outputIndex + 1]);
const allowedRoots = [resolve(root, config.releaseDirectory), resolve(tmpdir())];
if (!allowedRoots.some((allowed) => {
  const candidate = relative(allowed, output);
  return candidate && !candidate.startsWith("..") && !candidate.startsWith("/");
})) throw new Error(`Refusing to replace unsafe release directory: ${output}`);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed with status ${result.status}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
run(process.execPath, [resolve(root, "scripts/check-version.mjs")]);
if (!skipVerify) run(npm, ["run", "verify"]);
run(npm, ["run", "build:production"]);
run(process.execPath, [resolve(root, "scripts/audit-package.mjs"), "dist"]);
run(npm, ["run", "build:review"]);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const productionDirectory = resolve(root, config.productionDirectory);
const reviewDirectory = resolve(root, config.reviewDirectory);
const productionFiles = await describeFiles(productionDirectory);
const reviewFiles = await describeFiles(reviewDirectory);
const packageLock = await readFile(resolve(root, "package-lock.json"));
const manifest = {
  schemaVersion: 1,
  product: packageJson.name,
  version,
  extensionId: config.extensionId,
  distributionChannel: config.distributionChannel,
  automaticRecoveryQuarantined: config.automaticRecoveryQuarantined,
  packageLockSha256: sha256(packageLock),
  builds: {
    production: { sourceMaps: false, files: productionFiles },
    review: { sourceMaps: true, files: reviewFiles }
  }
};
const contentManifestName = `tab-leak-guard-${version}-content-manifest.json`;
await writeFile(resolve(output, contentManifestName), canonicalJson(manifest));

const extensionName = `tab-leak-guard-${version}-unsigned.zip`;
const reviewName = `tab-leak-guard-${version}-review.zip`;
const sourceName = `tab-leak-guard-${version}-source.zip`;
await writeDeterministicZip(resolve(output, extensionName), await zipEntriesFromDirectory(productionDirectory));
await writeDeterministicZip(resolve(output, reviewName), await zipEntriesFromDirectory(reviewDirectory));

const sourcePrefix = `tab-leak-guard-${version}-source/`;
const sourceEntries = [];
for (const directory of config.sourceRoots) {
  const absolute = resolve(root, directory);
  for (const entry of await zipEntriesFromDirectory(absolute, `${sourcePrefix}${directory}/`)) sourceEntries.push(entry);
}
for (const file of config.sourceFiles) {
  const absolute = resolve(root, file);
  if (!(await isRegularFile(absolute))) throw new Error(`Configured source file is missing: ${file}`);
  sourceEntries.push({ path: `${sourcePrefix}${file}`, data: await readFile(absolute) });
}
await writeDeterministicZip(resolve(output, sourceName), sourceEntries);

const components = [];
const componentRefs = new Set();
for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path || !metadata.version) continue;
  const match = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  if (!match) continue;
  const name = metadata.name ?? match[1];
  const encoded = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  const ref = `pkg:npm/${encoded}@${metadata.version}`;
  if (componentRefs.has(ref)) continue;
  componentRefs.add(ref);
  components.push({
    type: "library",
    "bom-ref": ref,
    name,
    version: metadata.version,
    scope: "excluded",
    purl: ref,
    ...(metadata.license ? { licenses: [{ license: { name: metadata.license } }] } : {})
  });
}
components.sort((a, b) => a["bom-ref"] < b["bom-ref"] ? -1 : a["bom-ref"] > b["bom-ref"] ? 1 : 0);
const sbom = {
  "$schema": "http://cyclonedx.org/schema/bom-1.5.schema.json",
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: {
      type: "application",
      "bom-ref": `pkg:generic/${packageJson.name}@${version}`,
      name: packageJson.name,
      version,
      properties: [
        { name: "tab-leak-guard:extension-id", value: config.extensionId },
        { name: "tab-leak-guard:shipped-runtime-dependencies", value: "0" },
        { name: "tab-leak-guard:package-lock-sha256", value: sha256(packageLock) }
      ]
    },
    tools: { components: [{ type: "application", name: "release.mjs", version: "1" }] }
  },
  components
};
const sbomName = `tab-leak-guard-${version}.cdx.json`;
await writeFile(resolve(output, sbomName), canonicalJson(sbom));

const releaseNotesName = `tab-leak-guard-${version}-release-notes.md`;
await writeFile(resolve(output, releaseNotesName), await readFile(resolve(root, `release-notes/${version}.md`)));

const hashTargets = (await filesUnder(output)).filter((file) => file.path !== "SHA256SUMS");
const checksums = [];
for (const file of hashTargets) checksums.push(`${sha256(await readFile(file.absolute))}  ${file.path}`);
await writeFile(resolve(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);
console.log(`Created deterministic unsigned release ${version} in ${output}`);
