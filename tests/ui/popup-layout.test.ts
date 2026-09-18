import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../src/ui/popup/styles.css", import.meta.url), "utf8");

describe("Firefox popup intrinsic sizing", () => {
  it("provides a stable body width without a viewport-unit sizing cycle", () => {
    const body = css.match(/^body\s*\{([^}]+)\}/m)?.[1]?.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(body).toBeDefined();
    expect(body).toMatch(/(?:^|;)\s*width:\s*430px\s*;/);
    expect(body).toMatch(/max-width:\s*100%\s*;/);
    expect(body).not.toMatch(/\d(?:d|s|l)?vw\b/);
  });
});
