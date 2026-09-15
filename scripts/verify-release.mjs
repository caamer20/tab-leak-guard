import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeFiles, filesUnder, root, sha256 } from "./release-utils.mjs";

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const directory = resolve(root, process.argv[2] ?? `artifacts/releases/${packageJson.version}`);
const lines = (await readFile(resolve(directory, "SHA256SUMS"), "utf8")).trim().split("\n");
const expected = new Map(lines.map((line) => {
  const match = line.match(/^([a-f0-9]{64})  ([^/].*)$/);
  if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
  return [match[2], match[1]];
}));
for (const file of await filesUnder(directory)) {
  if (file.path === "SHA256SUMS") continue;
  if (expected.get(file.path) !== sha256(await readFile(file.absolute))) throw new Error(`Checksum mismatch: ${file.path}`);
  if (file.path.endsWith(".zip")) {
    const bytes = await readFile(file.absolute);
    if (bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt32LE(bytes.length - 22) !== 0x06054b50) throw new Error(`Malformed ZIP envelope: ${file.path}`);
    const result = spawnSync("unzip", ["-tqq", file.absolute], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`ZIP integrity check failed for ${file.path}: ${result.stderr || result.stdout}`);
  }
  expected.delete(file.path);
}
if (expected.size) throw new Error(`Missing release files: ${[...expected.keys()].join(", ")}`);
const contentManifest = JSON.parse(await readFile(resolve(directory, `tab-leak-guard-${packageJson.version}-content-manifest.json`), "utf8"));
const current = await describeFiles(resolve(root, "dist"));
if (JSON.stringify(current) !== JSON.stringify(contentManifest.builds.production.files)) throw new Error("dist/ does not match the recorded production content manifest");
console.log(`Verified ${lines.length} release checksums, ZIP envelopes, and the production content manifest.`);
