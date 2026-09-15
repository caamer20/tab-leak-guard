import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "src");
const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const mode = valueAfter("--mode", "production");
if (mode !== "production" && mode !== "review") {
  throw new Error(`Unsupported build mode: ${mode}`);
}
const outputName = valueAfter("--out-dir", mode === "production" ? "dist" : "dist-review");
const expectedOutputName = mode === "production" ? "dist" : "dist-review";
if (outputName !== expectedOutputName) {
  throw new Error(`The ${mode} build may write only to ${expectedOutputName}`);
}
const output = resolve(root, outputName);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    "background/index": "src/background/index.ts",
    "collector/index": "src/collector/index.ts",
    "ui/popup/index": "src/ui/popup/index.ts",
    "ui/options/index": "src/ui/options/index.ts",
    "ui/onboarding/index": "src/ui/onboarding/index.ts"
  },
  outdir: output,
  bundle: true,
  format: "iife",
  target: ["firefox128"],
  sourcemap: mode === "review" ? "linked" : false,
  minify: false,
  treeShaking: true,
  legalComments: "none",
  charset: "utf8",
  logLevel: "info"
});

for (const relative of [
  "manifest.json",
  "_locales",
  "icons",
  "ui/popup/index.html",
  "ui/popup/styles.css",
  "ui/options/index.html",
  "ui/options/styles.css",
  "ui/onboarding/index.html",
  "ui/onboarding/styles.css",
  "ui/common.css"
]) {
  const from = resolve(source, relative);
  const to = resolve(output, relative);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

const manifestPath = resolve(output, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
manifest.version = packageJson.version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built Tab Leak Guard ${packageJson.version} (${mode}) into ${output}`);
