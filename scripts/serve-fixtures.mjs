import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";

const fixtureRoot = resolve(import.meta.dirname, "../tests/fixtures");
const port = Number(process.env.FIXTURE_PORT ?? 4173);
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const requestedPath = normalize(decodeURIComponent(requested)).replace(/^[/\\]+/, "");
    const candidate = join(fixtureRoot, requestedPath);
    const relativeCandidate = relative(fixtureRoot, candidate);
    if (relativeCandidate.startsWith("..") || isAbsolute(relativeCandidate)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(candidate);
    const file = info.isDirectory() ? join(candidate, "index.html") : candidate;
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": contentTypes.get(extname(file)) ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Leak fixture lab: http://127.0.0.1:${port}`);
});
