import { describe, expect, it } from "vitest";
import { evaluateSamples, isAutomaticEligible, type DetectorEvaluation } from "../../src/detector/score";
import type { DetectorResult } from "../../src/shared/types";
import { sample } from "../helpers";

const options = { confirmationScore: 75, minimumSamples: 6, minimumDurationMs: 5 * 60_000 };

function growingSamples(length = 10) {
  return Array.from({ length }, (_, index) => sample({
    sampleSequence: index,
    documentAgeMs: index * 60_000,
    liveDomNodes: 10_000 + index * 5_000,
    addedNodesSinceLast: index === 0 ? 0 : 6_000,
    removedNodesSinceLast: index === 0 ? 0 : 1_000,
    resourceEntriesSeen: 10 + index * 40,
    resourceActivityCount: 10 + index * 40,
    timerDriftMs: index * 80,
    collectorHealth: "healthy"
  }));
}

describe("detector scoring", () => {
  it("keeps a stable large page healthy", () => {
    const samples = Array.from({ length: 8 }, (_, index) => sample({
      sampleSequence: index,
      documentAgeMs: index * 60_000,
      liveDomNodes: 500_000 + (index % 2) * 20,
      addedNodesSinceLast: 1_000,
      removedNodesSinceLast: 1_000,
      resourceEntriesSeen: 100
    }));
    const result = evaluateSamples(samples, undefined, options);
    expect(result.status).toBe("healthy");
    expect(result.score).toBeLessThan(20);
  });

  it("requires a warmup window", () => {
    const result = evaluateSamples(growingSamples().slice(0, 3), undefined, options);
    expect(result.status).toBe("warmup");
    expect(result.score).toBe(0);
  });

  it("does not settle a baseline without three live-DOM observations", () => {
    const sparse = growingSamples(8).map((entry, index) => ({
      ...entry,
      liveDomNodes: index < 6 ? null : entry.liveDomNodes
    }));
    const result = evaluateSamples(sparse, undefined, options);
    expect(result.status).toBe("warmup");
    expect(result.settledBaseline).toBeNull();
    expect(result.automaticEligible).toBe(false);
  });

  it("confirms high-confidence growth only after distinct samples and elapsed time", () => {
    let previous: DetectorEvaluation | undefined = evaluateSamples(growingSamples(8), undefined, options);
    previous = evaluateSamples(growingSamples(9), previous, options);
    previous = evaluateSamples(growingSamples(10), previous, options);
    expect(previous?.status).toBe("confirmed");
    expect(previous?.score).toBeGreaterThanOrEqual(75);
    expect(previous?.reasonCodes).toContain("DOM_GROWTH");
    expect(previous?.reasonCodes).toContain("SUSTAINED_RETENTION");
    expect(previous?.highEvidenceDistinctSamples).toBe(3);
    expect(previous?.automaticEligible).toBe(true);
    expect(previous && isAutomaticEligible(previous)).toBe(true);
  });

  it("does not advance confirmation by re-evaluating the same latest sample", () => {
    const samples = growingSamples(8);
    const first = evaluateSamples(samples, undefined, options);
    const second = evaluateSamples(samples, first, options);
    const third = evaluateSamples(samples, second, options);
    expect(first.status).toBe("suspected");
    expect(third.status).toBe("suspected");
    expect(third.highEvidenceDistinctSamples).toBe(1);
    expect(third.highEvidenceSinceDocumentAgeMs).toBe(first.highEvidenceSinceDocumentAgeMs);
  });

  it("uses elapsed evidence time rather than evaluation count", () => {
    const fastOptions = { ...options, minimumDurationMs: 0, minimumSamples: 6 };
    let previous = evaluateSamples(growingSamples(6), undefined, fastOptions);
    previous = evaluateSamples(growingSamples(7), previous, fastOptions);
    previous = evaluateSamples(growingSamples(8), previous, fastOptions);
    expect(previous.status).toBe("confirmed");

    const rapid = (length: number) => Array.from({ length }, (_, index) => sample({
      sampleSequence: index,
      documentAgeMs: index * 10_000,
      liveDomNodes: 10_000 + index * 5_000,
      addedNodesSinceLast: index === 0 ? 0 : 6_000,
      removedNodesSinceLast: index === 0 ? 0 : 1_000,
      collectorHealth: "healthy"
    }));
    let rapidPrevious = evaluateSamples(rapid(6), undefined, fastOptions);
    for (let length = 7; length <= 12; length += 1) {
      rapidPrevious = evaluateSamples(rapid(length), rapidPrevious, fastOptions);
    }
    expect(rapidPrevious.highEvidenceDistinctSamples).toBeGreaterThan(3);
    expect(rapidPrevious.status).toBe("suspected");
  });

  it("does not confirm a burst that releases", () => {
    const values = [10_000, 11_000, 100_000, 12_000, 11_500, 11_000, 10_800, 10_700];
    const samples = values.map((value, index) => sample({
      sampleSequence: index,
      documentAgeMs: index * 60_000,
      liveDomNodes: value,
      addedNodesSinceLast: index === 2 ? 90_000 : 1_000,
      removedNodesSinceLast: index === 3 ? 89_000 : 1_000,
      resourceEntriesSeen: 20
    }));
    const result = evaluateSamples(samples, undefined, options);
    expect(result.status).not.toBe("confirmed");
    expect(result.score).toBeLessThan(60);
    expect(result.reasonCodes).toContain("DOM_RELEASE");
  });

  it("clears high evidence when recent growth plateaus", () => {
    const values = [10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 35_000, 35_000];
    const make = (length: number) => values.slice(0, length).map((value, index) => sample({
      sampleSequence: index,
      documentAgeMs: index * 60_000,
      liveDomNodes: value,
      addedNodesSinceLast: index === 0 ? 0 : Math.max(0, value - (values[index - 1] ?? value)),
      removedNodesSinceLast: 0,
      collectorHealth: "healthy"
    }));
    const high = evaluateSamples(make(6), undefined, options);
    const slowing = evaluateSamples(make(7), high, options);
    const plateau = evaluateSamples(make(8), slowing, options);
    expect(high.evidenceState).toBe("high");
    expect(plateau.evidenceState).toBe("clear");
    expect(plateau.reasonCodes).toContain("DOM_PLATEAU");
    expect(plateau.automaticEligible).toBe(false);
  });

  it("keeps the settled baseline when the original samples leave the recent window", () => {
    const initial = evaluateSamples(growingSamples(8), undefined, options);
    expect(initial.settledBaseline?.nodeCount).toBe(15_000);
    const later = Array.from({ length: 24 }, (_, offset) => {
      const sequence = offset + 8;
      return sample({
        sampleSequence: sequence,
        documentAgeMs: sequence * 60_000,
        liveDomNodes: 50_000 + offset * 2_000,
        addedNodesSinceLast: 2_500,
        removedNodesSinceLast: 500,
        collectorHealth: "healthy"
      });
    });
    const result = evaluateSamples(later, initial, options);
    expect(result.features.baselineNodes).toBe(15_000);
    expect(result.settledBaseline).toEqual(initial.settledBaseline);
    expect(result.features.nodeGrowthAbsolute).toBeGreaterThan(70_000);
  });

  it("never confirms resource activity or responsiveness without retained DOM growth", () => {
    const samples = Array.from({ length: 10 }, (_, index) => sample({
      sampleSequence: index,
      documentAgeMs: index * 60_000,
      liveDomNodes: 20_000,
      addedNodesSinceLast: 2_000,
      removedNodesSinceLast: 2_000,
      resourceEntriesSeen: index * 100_000,
      resourceActivityCount: index * 100_000,
      timerDriftMs: 10_000,
      collectorHealth: "healthy"
    }));
    let previous: DetectorEvaluation | undefined;
    for (let length = 6; length <= samples.length; length += 1) {
      previous = evaluateSamples(samples.slice(0, length), previous, options);
    }
    expect(previous?.signalFamilies).toContain("context-resource-activity");
    expect(previous?.automaticEligible).toBe(false);
    expect(previous?.status).not.toBe("confirmed");
  });

  it("does not let contextual signals push marginal DOM evidence over the automatic threshold", () => {
    const contextual = Array.from({ length: 10 }, (_, index) => sample({
      sampleSequence: index,
      documentAgeMs: index * 60_000,
      liveDomNodes: 10_000 + index * 2_000,
      addedNodesSinceLast: index === 0 ? 0 : 2_000,
      removedNodesSinceLast: index === 0 ? 0 : 1_000,
      resourceEntriesSeen: index * 100_000,
      resourceActivityCount: index * 100_000,
      timerDriftMs: 10_000,
      collectorHealth: "healthy"
    }));
    const contextualOptions = { ...options, confirmationScore: 85 };
    let previous: DetectorEvaluation | undefined;
    for (let length = 8; length <= contextual.length; length += 1) {
      previous = evaluateSamples(contextual.slice(0, length), previous, contextualOptions);
    }
    expect(previous?.score).toBeGreaterThanOrEqual(contextualOptions.confirmationScore);
    expect(previous?.automaticEvidenceScore).toBeLessThan(contextualOptions.confirmationScore);
    expect(previous?.automaticEligible).toBe(false);
    expect(previous?.status).not.toBe("confirmed");
  });

  it("lets quality reduce confidence and veto automatic eligibility", () => {
    const samples = growingSamples(10).map((entry, index) => ({
      ...entry,
      overflowed: index === 8,
      droppedPerformanceEntries: index === 9 ? 2 : 0
    }));
    let previous: DetectorEvaluation | undefined;
    for (let length = 8; length <= samples.length; length += 1) {
      previous = evaluateSamples(samples.slice(0, length), previous, options);
    }
    expect(previous?.quality.level).toBe("low");
    expect(previous?.quality.reasonCodes).toContain("QUALITY_OVERFLOW");
    expect(previous?.quality.reasonCodes).toContain("QUALITY_DROPPED_PERFORMANCE_ENTRIES");
    expect(previous?.quality.droppedEntryRate).toBeGreaterThan(0);
    expect(previous?.automaticEligible).toBe(false);
    expect(previous?.status).not.toBe("confirmed");
  });

  it("uses a lower clear threshold to avoid threshold oscillation", () => {
    const hysteresisOptions = { ...options, confirmationScore: 95, clearScore: 75 };
    const entered = evaluateSamples(growingSamples(8), undefined, hysteresisOptions);
    expect(entered.evidenceState).toBe("high");

    const lowerConfidence = growingSamples(9).map((entry, index) => ({
      ...entry,
      addedNodesSinceLast: index === 0 ? 0 : 1_000,
      removedNodesSinceLast: index === 0 ? 0 : 500,
      resourceEntriesSeen: 10,
      resourceActivityCount: 10,
      timerDriftMs: 0
    }));
    const held = evaluateSamples(lowerConfidence, entered, hysteresisOptions);
    expect(held.score).toBeLessThan(hysteresisOptions.confirmationScore);
    expect(held.score).toBeGreaterThanOrEqual(hysteresisOptions.clearScore);
    expect(held.evidenceState).toBe("high");

    const released = lowerConfidence.map((entry, index) => ({
      ...entry,
      liveDomNodes: index === lowerConfidence.length - 1 ? 16_000 : entry.liveDomNodes
    }));
    const cleared = evaluateSamples(released, held, hysteresisOptions);
    expect(cleared.evidenceState).toBe("clear");
  });

  it("does not carry confirmation state across a configuration change", () => {
    const first = evaluateSamples(growingSamples(8), undefined, options);
    const changed = evaluateSamples(growingSamples(9), first, { ...options, confirmationScore: 80 });
    expect(changed.configurationVersion).not.toBe(first.configurationVersion);
    expect(changed.highEvidenceDistinctSamples).toBe(1);
    expect(changed.highEvidenceSinceDocumentAgeMs).toBe(8 * 60_000);
  });

  it("fails closed when persisted confirmation metadata is malformed", () => {
    const first = evaluateSamples(growingSamples(8), undefined, options);
    const malformed = {
      ...first,
      highEvidenceSinceDocumentAgeMs: -1,
      highEvidenceDistinctSamples: 999
    } as unknown as DetectorResult;
    const recovered = evaluateSamples(growingSamples(9), malformed, options);
    expect(recovered.highEvidenceDistinctSamples).toBe(1);
    expect(recovered.status).toBe("suspected");
    expect(recovered.automaticEligible).toBe(false);
  });

  it("rejects persisted evidence that is ahead of the current sample buffer", () => {
    const first = evaluateSamples(growingSamples(8), undefined, options);
    const future = {
      ...first,
      lastEvaluatedSampleSequence: 999,
      lastEvaluatedDocumentAgeMs: 999 * 60_000
    } as DetectorEvaluation;
    const recovered = evaluateSamples(growingSamples(9), future, options);
    expect(recovered.highEvidenceDistinctSamples).toBe(1);
    expect(recovered.settledBaseline?.settledAtSampleSequence).toBe(8);
    expect(recovered.automaticEligible).toBe(false);
  });
});
