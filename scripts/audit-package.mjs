import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { filesUnder, root } from "./release-utils.mjs";

const directory = resolve(root, process.argv[2] ?? "dist");
const files = await filesUnder(directory);
const allowed = /^(?:manifest\.json|_locales\/[a-zA-Z0-9_-]+\/messages\.json|icons\/[a-zA-Z0-9_.-]+\.(?:svg|png)|background\/index\.js|collector\/index\.js|ui\/(?:popup|options|onboarding)\/(?:index\.(?:html|js)|styles\.css)|ui\/common\.css)$/;
const forbiddenNames = /(?:^|\/)(?:node_modules|tests?|fixtures?|coverage|\.git|\.env|secrets?)(?:\/|$)|\.(?:map|ts|tsx|pem|key|log)$/i;
let total = 0;
for (const file of files) {
  if (!allowed.test(file.path) || forbiddenNames.test(file.path)) throw new Error(`Unexpected production package file: ${file.path}`);
  const data = await readFile(file.absolute);
  total += data.length;
  if (data.length > 2_000_000) throw new Error(`Package file exceeds 2 MB: ${file.path}`);
  if (/\.(?:js|html|css|json)$/.test(file.path)) {
    const text = data.toString("utf8");
    if (/sourceMappingURL=|\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) throw new Error(`Forbidden production construct in ${file.path}`);
    if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+(?:WebSocket|EventSource)\s*\(|\bsendBeacon\s*\(/.test(text)) throw new Error(`Runtime network primitive in ${file.path}`);
    if (/<script\b[^>]*\bsrc=["']https?:/i.test(text)) throw new Error(`Remote script in ${file.path}`);
    if (file.path.endsWith(".html") && (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /<(?:link|img)\b[^>]*(?:href|src)=["']https?:/i.test(text))) {
      throw new Error(`Inline executable handler or remote HTML asset in ${file.path}`);
    }
  }
}
if (!files.some((file) => file.path === "manifest.json")) throw new Error("manifest.json is missing");
if (total > 8_000_000) throw new Error(`Unpacked extension exceeds 8 MB (${total} bytes)`);
const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (manifest.version !== packageJson.version) throw new Error("Built manifest version does not match package.json");
console.log(`Audited ${files.length} production files (${total} bytes); no development content, source maps, runtime network primitives, remote assets, or dynamic evaluation found.`);
