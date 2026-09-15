import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./release-utils.mjs";

const policy = JSON.parse(await readFile(resolve(root, "security-advisories.json"), "utf8"));
if (Date.now() > Date.parse(`${policy.reviewAgainBy}T23:59:59Z`)) throw new Error(`Development advisory review expired on ${policy.reviewAgainBy}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["audit", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 10_000_000 });
let report;
try { report = JSON.parse(result.stdout); } catch { throw new Error(`npm audit did not return JSON: ${result.stderr.trim()}`); }
if (report.error) throw new Error(`npm audit service failed: ${report.error.summary || report.message}`);
const seen = new Set();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via === "object" && via.url) {
      const id = via.url.split("/").at(-1);
      seen.add(id);
      if (!policy.allowedDevelopmentAdvisories.some((allowed) => allowed.id === id && allowed.package === via.name)) {
        throw new Error(`Unreviewed development advisory: ${id} (${via.name}, ${via.severity})`);
      }
    }
  }
}
console.log(seen.size ? `Development audit contains only ${[...seen].sort().join(", ")} under a time-bounded exception.` : "Development dependency audit is clean.");
