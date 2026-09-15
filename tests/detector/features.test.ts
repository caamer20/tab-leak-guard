import { describe, expect, it } from "vitest";
import { calculateFeatures } from "../../src/detector/features";
import { sample } from "../helpers";

describe("feature calculation", () => {
  it("derives growth, retention, resources, and drift", () => {
    const samples = Array.from({ length: 6 }, (_, index) => sample({
      sampleSequence: index,
      documentAgeMs: index * 60_000,
      liveDomNodes: 10_000 + index * 2_000,
      addedNodesSinceLast: index === 0 ? 0 : 2_500,
      removedNodesSinceLast: index === 0 ? 0 : 500,
      resourceEntriesSeen: 10 + index * 20,
      timerDriftMs: index * 50
    }));
    const features = calculateFeatures(samples);
    expect(features.durationMs).toBe(300_000);
    expect(features.nodeGrowthAbsolute).toBe(8_000);
    expect(features.nodeSlopePerMinute).toBe(2_000);
    expect(features.nodeMonotonicity).toBe(1);
    expect(features.retentionRatio).toBe(0.8);
    expect(features.resourceGrowth).toBe(100);
    expect(features.visibleTimerDriftP95).toBe(250);
    expect(features.shortNodeSlopePerMinute).toBe(2_000);
    expect(features.mediumNodeSlopePerMinute).toBe(2_000);
    expect(features.recentNodeMonotonicity).toBe(1);
    expect(features.domSignalCoverage).toBe(1);
  });

  it("represents missing signals without inventing values", () => {
    const features = calculateFeatures([sample({ liveDomNodes: null, resourceEntriesSeen: null, timerDriftMs: null })]);
    expect(features.baselineNodes).toBeNull();
    expect(features.currentNodes).toBeNull();
    expect(features.visibleTimerDriftP95).toBeNull();
    expect(features.domSignalCoverage).toBe(0);
  });

  it("deduplicates sequence numbers and uses an external settled baseline", () => {
    const samples = [
      sample({ sampleSequence: 20, documentAgeMs: 20_000, liveDomNodes: 40_000 }),
      sample({ sampleSequence: 21, documentAgeMs: 30_000, liveDomNodes: 42_000 }),
      sample({ sampleSequence: 21, documentAgeMs: 31_000, liveDomNodes: 999_999 }),
      sample({ sampleSequence: 22, documentAgeMs: 40_000, liveDomNodes: 44_000 })
    ];
    const features = calculateFeatures(samples, { settledBaselineNodes: 10_000, peakNodesObserved: 50_000 });
    expect(features.validSamples).toBe(3);
    expect(features.baselineKind).toBe("settled");
    expect(features.baselineNodes).toBe(10_000);
    expect(features.currentNodes).toBe(44_000);
    expect(features.peakNodesObserved).toBe(50_000);
  });

  it("recognizes plateau, release, and virtualized churn as negative evidence", () => {
    const plateau = calculateFeatures(
      [10_000, 20_000, 30_000, 40_000, 40_000, 40_000].map((nodes, index) => sample({
        sampleSequence: index,
        documentAgeMs: index * 60_000,
        liveDomNodes: nodes,
        addedNodesSinceLast: index === 0 ? 0 : Math.max(0, nodes - (index > 0 ? [10_000, 20_000, 30_000, 40_000, 40_000, 40_000][index - 1]! : nodes)),
        removedNodesSinceLast: 0
      })),
      { settledBaselineNodes: 10_000 }
    );
    expect(plateau.plateau).toBe(true);

    const released = calculateFeatures(
      [10_000, 50_000, 12_000].map((nodes, index) => sample({
        sampleSequence: index,
        documentAgeMs: index * 60_000,
        liveDomNodes: nodes
      })),
      { settledBaselineNodes: 10_000 }
    );
    expect(released.release).toBe(true);
    expect(released.releaseFraction).toBeGreaterThan(0.9);

    const churn = calculateFeatures(Array.from({ length: 6 }, (_, index) => sample({
      sampleSequence: index,
      documentAgeMs: index * 60_000,
      liveDomNodes: 20_000 + (index % 2) * 50,
      addedNodesSinceLast: 10_000,
      removedNodesSinceLast: 9_900
    })));
    expect(churn.virtualizedChurn).toBe(true);
  });
});
