import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { filesUnder, root, sha256 } from "./release-utils.mjs";

const temp = await mkdtemp(resolve(tmpdir(), "tab-leak-guard-repro-"));
const first = resolve(temp, "first");
const second = resolve(temp, "second");
try {
  for (const output of [first, second]) {
    const result = spawnSync(process.execPath, [resolve(root, "scripts/release.mjs"), "--skip-verify", "--output", output], { cwd: root, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Reproduction build failed with status ${result.status}`);
  }
  const digestMap = async (directory) => new Map(await Promise.all((await filesUnder(directory)).map(async (file) => [file.path, sha256(await readFile(file.absolute))])));
  const a = await digestMap(first);
  const b = await digestMap(second);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const differences = names.filter((name) => a.get(name) !== b.get(name));
  if (differences.length) throw new Error(`Non-reproducible release files: ${differences.join(", ")}`);
  console.log(`Two clean release runs produced ${names.length} byte-identical files.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
