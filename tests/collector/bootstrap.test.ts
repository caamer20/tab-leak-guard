import { describe, expect, it } from "vitest";
import { decodeCollectorBootstrap } from "../../src/collector/bootstrap";

function response(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      mode: "continuous",
      sampleVisibleSeconds: 30,
      sampleHiddenSeconds: 90,
      manualSessionExpiresAtEpochMs: null,
      authorityToken: null,
      ...overrides
    }
  };
}

describe("collector bootstrap authority decoder", () => {
  it("accepts the exact narrow continuous bootstrap", () => {
    expect(decodeCollectorBootstrap(response())).toEqual({
      mode: "continuous",
      sampleVisibleSeconds: 30,
      sampleHiddenSeconds: 90,
      manualSessionExpiresAtEpochMs: null,
      authorityToken: null
    });
  });

  it("accepts manual authority only with an explicit finite expiry", () => {
    const expiresAt = 1_800_000_900_000;
    expect(
      decodeCollectorBootstrap(
        response({
          mode: "manual",
          manualSessionExpiresAtEpochMs: expiresAt,
          authorityToken: "87654321-4321-4321-8321-cba987654321"
        })
      )
    ).toEqual({
      mode: "manual",
      sampleVisibleSeconds: 30,
      sampleHiddenSeconds: 90,
      manualSessionExpiresAtEpochMs: expiresAt,
      authorityToken: "87654321-4321-4321-8321-cba987654321"
    });
    expect(
      decodeCollectorBootstrap(
        response({
          mode: "manual",
          manualSessionExpiresAtEpochMs: null,
          authorityToken: "87654321-4321-4321-8321-cba987654321"
        })
      )
    ).toBeNull();
    expect(
      decodeCollectorBootstrap(
        response({
          mode: "manual",
          manualSessionExpiresAtEpochMs: Number.POSITIVE_INFINITY,
          authorityToken: "87654321-4321-4321-8321-cba987654321"
        })
      )
    ).toBeNull();
  });

  it("enforces exact keys at both envelope and data boundaries", () => {
    expect(decodeCollectorBootstrap({ ...response(), token: "unexpected" })).toBeNull();
    expect(decodeCollectorBootstrap(response({ ignoredHosts: ["private.example"] }))).toBeNull();
    const missing = response();
    delete (missing.data as Partial<typeof missing.data>).sampleHiddenSeconds;
    expect(decodeCollectorBootstrap(missing)).toBeNull();
  });

  it.each([
    null,
    [],
    { ok: false, data: {} },
    { ok: true, data: null },
    response({ mode: "automatic" }),
    response({ sampleVisibleSeconds: 9 }),
    response({ sampleVisibleSeconds: 301 }),
    response({ sampleHiddenSeconds: 29 }),
    response({ sampleHiddenSeconds: 901 }),
    response({ sampleVisibleSeconds: Number.NaN }),
    response({ manualSessionExpiresAtEpochMs: -1 }),
    response({ authorityToken: "unexpected-continuous-token" }),
    response({ mode: "manual", manualSessionExpiresAtEpochMs: 1_800_000_900_000 }),
    response({
      mode: "manual",
      manualSessionExpiresAtEpochMs: 1_800_000_900_000,
      authorityToken: "short"
    })
  ])("rejects malformed or overbroad bootstrap %#", (candidate) => {
    expect(decodeCollectorBootstrap(candidate)).toBeNull();
  });

  it("accepts the documented inclusive sampling bounds", () => {
    expect(
      decodeCollectorBootstrap(response({ sampleVisibleSeconds: 10, sampleHiddenSeconds: 30 }))
    ).not.toBeNull();
    expect(
      decodeCollectorBootstrap(response({ sampleVisibleSeconds: 300, sampleHiddenSeconds: 900 }))
    ).not.toBeNull();
  });
});
