import { describe, expect, it } from "vitest";
import { inspectUrl, normalizeHostname } from "../../src/shared/url-policy";

describe("URL policy", () => {
  it("accepts normal HTTP and HTTPS pages", () => {
    expect(inspectUrl("https://Example.COM/path")).toEqual({ supported: true, hostname: "example.com" });
    expect(inspectUrl("http://127.0.0.1:4173/").supported).toBe(true);
  });

  it("rejects privileged and malformed schemes", () => {
    expect(inspectUrl("about:config").supported).toBe(false);
    expect(inspectUrl("file:///tmp/a.html").supported).toBe(false);
    expect(inspectUrl("not a url").supported).toBe(false);
  });

  it("rejects Firefox-restricted Mozilla sites before attempting injection", () => {
    expect(inspectUrl("https://addons.mozilla.org/en-US/firefox/")).toEqual({
      supported: false,
      reason: "Firefox does not allow extensions to monitor this site"
    });
    expect(inspectUrl("https://accounts.firefox.com/settings").supported).toBe(false);
  });

  it("normalizes hostnames safely", () => {
    expect(normalizeHostname(" Example.COM. ")).toBe("example.com");
    expect(normalizeHostname("bad host/")).toBeNull();
  });
});
