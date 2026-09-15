import { describe, expect, it } from "vitest";
import {
  CollectorBudgetController,
  countMutationBatch,
  saturatingAdd,
  type MutationBatchRecord
} from "../../src/collector/budget-controller";

type FakeRoot = { elements: number };

function walkFakeRoot(root: FakeRoot, visit: () => boolean): void {
  for (let index = 0; index < root.elements; index += 1) {
    if (!visit()) return;
  }
}

describe("collector callback-wide budgets", () => {
  it("shares one hard node cap across every root and record", () => {
    const records: MutationBatchRecord<FakeRoot>[] = [
      {
        addedNodes: [{ elements: 4 }, { elements: 100_000 }],
        removedNodes: [{ elements: 100_000 }]
      },
      { addedNodes: [{ elements: 100_000 }], removedNodes: [] }
    ];
    const result = countMutationBatch<FakeRoot>(
      records,
      walkFakeRoot,
      { maxNodes: 10, maxDurationMs: 1_000, maximumReportedNodes: 1_000 },
      () => 0
    );

    expect(result).toMatchObject({
      addedNodes: 10,
      removedNodes: 0,
      processedNodes: 10,
      overflowed: true,
      exhaustedBy: "nodes"
    });
  });

  it("stops traversal when the callback-wide elapsed-time cap is reached", () => {
    let time = 0;
    const result = countMutationBatch<FakeRoot>(
      [{ addedNodes: [{ elements: 100 }], removedNodes: [] }],
      (root, visit) => {
        for (let index = 0; index < root.elements; index += 1) {
          time += 1;
          if (!visit()) return;
        }
      },
      { maxNodes: 1_000, maxDurationMs: 5, maximumReportedNodes: 1_000 },
      () => time
    );

    expect(result.processedNodes).toBe(4);
    expect(result.exhaustedBy).toBe("time");
    expect(result.overflowed).toBe(true);
  });

  it("returns numeric summaries only and saturates accumulated counters", () => {
    const result = countMutationBatch<FakeRoot>(
      [{ addedNodes: [{ elements: 8 }], removedNodes: [{ elements: 8 }] }],
      walkFakeRoot,
      { maxNodes: 20, maxDurationMs: 100, maximumReportedNodes: 5 },
      () => 0
    );

    expect(result.addedNodes).toBe(5);
    expect(result.removedNodes).toBe(5);
    expect(Object.values(result).some((value) => typeof value === "object" && value !== null)).toBe(false);
    expect(saturatingAdd(95, 20, 100)).toBe(100);
  });
});

describe("collector budget pressure", () => {
  it("backs off and requests suspension after repeated mutation breaches", () => {
    const controller = new CollectorBudgetController({
      mutationBreachesBeforeSuspension: 3,
      mutationDurationBudgetMs: 4
    });

    expect(controller.recordMutation(5, false)).toBe(false);
    expect(controller.recordMutation(1, true)).toBe(false);
    expect(controller.recordMutation(5, true)).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      health: "degraded",
      cadenceMultiplier: 4,
      mutationCallbacks: 3,
      mutationOverflows: 2
    });
  });

  it("decays transient pressure after healthy work", () => {
    const controller = new CollectorBudgetController();
    controller.recordRecount(30);
    expect(controller.snapshot().health).toBe("degraded");
    controller.recordSample(1);
    controller.recordSample(1);
    expect(controller.snapshot().health).toBe("healthy");
    expect(controller.snapshot().cadenceMultiplier).toBe(1);
  });
});
