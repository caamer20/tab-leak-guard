import { describe, expect, it } from "vitest";
import { permissionGrantCoversOrigin } from "../../src/shared/permission-pattern";

describe("permission grant coverage", () => {
  it.each([
    ["https://example.test/*", "https://example.test/*", true],
    ["https://example.test/*", "http://example.test/*", false],
    ["https://*/*", "https://example.test:8443/*", true],
    ["*://*/*", "http://example.test/*", true],
    ["<all_urls>", "https://example.test/*", true],
    ["https://*.example.test/*", "https://example.test/*", true],
    ["https://*.example.test/*", "https://child.example.test/*", true],
    ["https://*.example.test/*", "https://not-example.test/*", false],
    ["https://example.test/path/*", "https://example.test/*", false],
    ["not-a-pattern", "https://example.test/*", false],
    ["*://example.test/*", "*://example.test/*", true]
  ])("maps grant %s to desired origin %s", (grant, desired, expected) => {
    expect(permissionGrantCoversOrigin(grant, desired)).toBe(expected);
  });
});
