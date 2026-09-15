import type { CollectorMode } from "./scheduler";

export type CollectorBootstrap = {
  mode: CollectorMode;
  sampleVisibleSeconds: number;
  sampleHiddenSeconds: number;
  manualSessionExpiresAtEpochMs: number | null;
  authorityToken: string | null;
};

/** Decode the background's deliberately narrow, fail-closed collector authority. */
export function decodeCollectorBootstrap(value: unknown): CollectorBootstrap | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["ok", "data"]) ||
    value.ok !== true ||
    !isPlainRecord(value.data) ||
    !hasExactKeys(value.data, [
      "mode",
      "sampleVisibleSeconds",
      "sampleHiddenSeconds",
      "manualSessionExpiresAtEpochMs",
      "authorityToken"
    ])
  ) {
    return null;
  }
  const data = value.data;
  if (
    (data.mode !== "manual" && data.mode !== "continuous") ||
    !isBoundedNumber(data.sampleVisibleSeconds, 10, 300) ||
    !isBoundedNumber(data.sampleHiddenSeconds, 30, 900) ||
    !(
      data.manualSessionExpiresAtEpochMs === null ||
      isBoundedNumber(data.manualSessionExpiresAtEpochMs, 0, Number.MAX_SAFE_INTEGER)
    ) ||
    !(data.authorityToken === null || isBoundedString(data.authorityToken, 16, 128)) ||
    (data.mode === "manual" && data.manualSessionExpiresAtEpochMs === null)
    || (data.mode === "manual" && data.authorityToken === null)
    || (data.mode === "continuous" && data.authorityToken !== null)
  ) {
    return null;
  }
  return {
    mode: data.mode,
    sampleVisibleSeconds: data.sampleVisibleSeconds,
    sampleHiddenSeconds: data.sampleHiddenSeconds,
    manualSessionExpiresAtEpochMs: data.manualSessionExpiresAtEpochMs,
    authorityToken: data.authorityToken
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
