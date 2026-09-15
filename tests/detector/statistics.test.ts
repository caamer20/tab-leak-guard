import { describe, expect, it } from "vitest";
import {
  clamp,
  median,
  medianAbsoluteDeviation,
  percentile,
  robustSlopePerMinute
} from "../../src/detector/statistics";

describe("statistics", () => {
  it("clamps values", () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(0.5)).toBe(0.5);
    expect(clamp(2)).toBe(1);
    expect(clamp(15, 10, 20)).toBe(15);
    expect(clamp(5, 10, 20)).toBe(10);
    expect(clamp(25, 10, 20)).toBe(20);
  });

  it("calculates medians without mutating input", () => {
    const values = [9, 1, 4, 2];
    expect(median(values)).toBe(3);
    expect(values).toEqual([9, 1, 4, 2]);
    expect(median([7, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
  });

  it("calculates percentiles", () => {
    expect(percentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("clamps nearest-rank percentiles at the requested distribution boundaries", () => {
    const values = [40, 10, 30, 20];
    expect(percentile(values, -1)).toBe(10);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(20);
    expect(percentile(values, 2)).toBe(40);
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it("calculates robust spread with median absolute deviation", () => {
    expect(medianAbsoluteDeviation([10, 10, 11, 11, 10_000])).toBe(1);
    expect(medianAbsoluteDeviation([])).toBe(0);
  });

  it("uses a robust pairwise slope", () => {
    const points = [0, 1, 2, 3, 4].map((minute) => ({ timeMs: minute * 60_000, value: 10 + minute * 5 }));
    points[2]!.value = 1_000;
    expect(robustSlopePerMinute(points)).toBe(5);
  });

  it("ignores zero-length and backward time pairs", () => {
    expect(robustSlopePerMinute([])).toBe(0);
    expect(robustSlopePerMinute([{ timeMs: 0, value: 10 }])).toBe(0);
    expect(robustSlopePerMinute([
      { timeMs: 120_000, value: 30 },
      { timeMs: 60_000, value: 20 },
      { timeMs: 60_000, value: 999 }
    ])).toBe(0);
  });
});
