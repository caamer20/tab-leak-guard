import { describe, expect, it } from "vitest";
import { countNodesBounded } from "../../src/collector/dom-counter";

function options(overrides: Partial<Parameters<typeof countNodesBounded>[0]> = {}) {
  return {
    nextNode: () => null,
    now: () => 0,
    yieldControl: async () => undefined,
    signal: new AbortController().signal,
    sliceBudgetMs: 8,
    totalBudgetMs: 40,
    maxNodesPerSlice: 1_024,
    maxSlices: 64,
    maxNodes: 100_000,
    clockCheckEvery: 32,
    ...overrides
  };
}

describe("cooperative DOM counting", () => {
  it("returns an exact count for a traversal completed within budget", async () => {
    let remaining = 2_500;
    let yields = 0;
    const result = await countNodesBounded(options({
      nextNode: () => remaining-- > 0 ? ({} as Node) : null,
      yieldControl: async () => { yields += 1; }
    }));

    expect(result).toMatchObject({ count: 2_500, visitedNodes: 2_500, complete: true });
    expect(yields).toBeGreaterThan(0);
  });

  it("censors a pathological traversal and never exceeds configured work bounds", async () => {
    let clock = 0;
    let yields = 0;
    const result = await countNodesBounded(options({
      nextNode: () => ({} as Node),
      now: () => clock++,
      yieldControl: async () => { yields += 1; },
      sliceBudgetMs: 4,
      totalBudgetMs: 12,
      maxNodesPerSlice: 100,
      maxSlices: 10,
      maxNodes: 1_000_000,
      clockCheckEvery: 2
    }));

    expect(result.count).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.activeDurationMs).toBeGreaterThanOrEqual(12);
    expect(result.visitedNodes).toBeLessThanOrEqual(30);
    expect(yields).toBeLessThanOrEqual(2);
  });

  it("censors a DOM larger than the 100,000-node hard limit without probing past it", async () => {
    let remaining = 100_001;
    let nextNodeCalls = 0;
    const result = await countNodesBounded(options({
      nextNode: () => {
        nextNodeCalls += 1;
        return remaining-- > 0 ? ({} as Node) : null;
      },
      totalBudgetMs: Number.MAX_SAFE_INTEGER,
      maxSlices: 200
    }));

    expect(result).toEqual({
      count: null,
      visitedNodes: 100_000,
      activeDurationMs: 0,
      complete: false
    });
    expect(nextNodeCalls).toBe(100_000);
    expect(remaining).toBe(1);
  });

  it("returns an incomplete result immediately after cancellation", async () => {
    const controller = new AbortController();
    let yields = 0;
    const result = await countNodesBounded(options({
      nextNode: () => ({} as Node),
      signal: controller.signal,
      maxNodesPerSlice: 2,
      yieldControl: async () => {
        yields += 1;
        controller.abort();
      }
    }));

    expect(result).toMatchObject({ count: null, complete: false, visitedNodes: 2 });
    expect(yields).toBe(1);
  });
});
