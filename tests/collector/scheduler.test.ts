import { describe, expect, it } from "vitest";
import {
  inferCollectorMode,
  initialUserEditState,
  isLongSchedulingGap,
  isManualSessionExpired,
  nextSampleDelayMs,
  visibleTimerDriftMs
} from "../../src/collector/scheduler";

describe("collector mode and edit safety", () => {
  it("distinguishes explicit manual and continuous lifecycles", () => {
    expect(inferCollectorMode(false)).toBe("manual");
    expect(inferCollectorMode(true)).toBe("continuous");
  });

  it("starts manual and late-injected collectors with unknown edit state", () => {
    expect(initialUserEditState("manual", true, false)).toBe("unknown");
    expect(initialUserEditState("manual", false, false)).toBe("unknown");
    expect(initialUserEditState("continuous", false, false)).toBe("unknown");
  });

  it("allows no-edits-observed only for an early continuous collector", () => {
    expect(initialUserEditState("continuous", true, false)).toBe("no-edits-observed");
    expect(initialUserEditState("continuous", true, true)).toBe("edits-observed");
  });

  it("expires only manual sessions", () => {
    expect(isManualSessionExpired("manual", 1_000, 1_000)).toBe(true);
    expect(isManualSessionExpired("manual", 999, 1_000)).toBe(false);
    expect(isManualSessionExpired("continuous", 2_000, 1_000)).toBe(false);
  });
});

describe("collector scheduling", () => {
  it("bounds cadence and applies deterministic jitter", () => {
    expect(
      nextSampleDelayMs({ seconds: 30, immediate: false, cadenceMultiplier: 2, random: () => 0 })
    ).toBe(54_000);
    expect(
      nextSampleDelayMs({ seconds: 30, immediate: false, cadenceMultiplier: 2, random: () => 1 })
    ).toBe(66_000);
    expect(
      nextSampleDelayMs({ seconds: 1, immediate: false, cadenceMultiplier: 1, random: () => 0.5 })
    ).toBe(10_000);
    expect(
      nextSampleDelayMs({ seconds: 30, immediate: true, cadenceMultiplier: 4, random: () => 0 })
    ).toBe(500);
  });

  it("does not turn sleep, long gaps, hidden time, or visibility changes into drift evidence", () => {
    expect(visibleTimerDriftMs(1_100, 1_000, true, false, 500)).toBe(100);
    expect(visibleTimerDriftMs(400_000, 1_000, true, false, 30_000)).toBeNull();
    expect(visibleTimerDriftMs(1_100, 1_000, false, false, 500)).toBeNull();
    expect(visibleTimerDriftMs(1_100, 1_000, true, true, 500)).toBeNull();
    expect(isLongSchedulingGap(400_000, 1_000, 30_000)).toBe(true);
    expect(isLongSchedulingGap(1_100, 1_000, 500)).toBe(false);
  });
});
