import { describe, expect, it } from "vitest";
import { calculateFeatures } from "../../src/detector/features";
import { resolveDetectorConfiguration } from "../../src/detector/model";
import { assessEvidenceQuality } from "../../src/detector/quality";
import { evaluateSamples } from "../../src/detector/score";
import { sample } from "../helpers";

const options = { confirmationScore: 75, minimumSamples: 6, minimumDurationMs: 5 * 60_000 };

function growthWithSequences(sequences: readonly number[]) {
  return sequences.map((sequence, index) => sample({
    sampleSequence: sequence,
    documentAgeMs: sequence * 60_000,
    liveDomNodes: 10_000 + index * 6_000,
    addedNodesSinceLast: index === 0 ? 0 : 7_000,
    removedNodesSinceLast: index === 0 ? 0 : 1_000,
    collectorHealth: "healthy"
  }));
}

describe("detector evidence quality", () => {
  it("reports sequence gaps and prevents automatic eligibility", () => {
    const samples = growthWithSequences([0, 1, 2, 6, 7, 8, 9, 10]);
    const result = evaluateSamples(samples, undefined, options);
    expect(result.quality.receivedSampleRatio).toBeLessThan(0.75);
    expect(result.quality.level).toBe("low");
    expect(result.quality.reasonCodes).toContain("QUALITY_SAMPLE_GAPS");
    expect(result.automaticEligible).toBe(false);
  });

  it("marks evidence stale when evaluated well after the newest sample", () => {
    const samples = growthWithSequences([0, 1, 2, 3, 4, 5, 6, 7]);
    const latestAge = samples.at(-1)?.documentAgeMs ?? 0;
    const result = evaluateSamples(samples, undefined, {
      ...options,
      evaluatedAtDocumentAgeMs: latestAge + 180_001,
      maximumFreshnessMs: 180_000
    });
    expect(result.quality.level).toBe("low");
    expect(result.quality.reasonCodes).toContain("QUALITY_STALE");
    expect(result.automaticEligible).toBe(false);
  });

  it("does not penalize contextual signals that the browser cannot provide", () => {
    const samples = growthWithSequences([0, 1, 2, 3, 4, 5, 6, 7]).map((entry) => ({
      ...entry,
      resourceEntriesSeen: null,
      resourceActivityCount: null,
      timerDriftMs: null,
      capabilities: { ...entry.capabilities, resourceObserver: false }
    }));
    const result = evaluateSamples(samples, undefined, options);
    expect(result.quality.level).toBe("high");
    expect(result.quality.reasonCodes).toContain("QUALITY_RESOURCE_CONTEXT_UNAVAILABLE");
    expect(result.quality.reasonCodes).toContain("QUALITY_RESPONSIVENESS_CONTEXT_PARTIAL");
  });

  it("treats regressing document time as low-quality evidence", () => {
    const samples = growthWithSequences([0, 1, 2, 3, 4, 5]);
    samples[5] = { ...samples[5]!, documentAgeMs: samples[4]!.documentAgeMs };
    const result = evaluateSamples(samples, undefined, { ...options, minimumDurationMs: 0 });
    expect(result.quality.level).toBe("low");
    expect(result.quality.reasonCodes).toContain("QUALITY_NON_MONOTONIC_TIME");
    expect(result.automaticEligible).toBe(false);
  });

  it("reports degraded collection and partial DOM coverage", () => {
    const samples = growthWithSequences([0, 1, 2, 3, 4, 5, 6, 7]).map((entry, index) => ({
      ...entry,
      liveDomNodes: index === 3 ? null : entry.liveDomNodes,
      collectorHealth: index === 6 ? "degraded" as const : "healthy" as const
    }));
    const result = evaluateSamples(samples, undefined, options);
    expect(result.quality.level).toBe("low");
    expect(result.quality.degradedSampleRatio).toBeGreaterThan(0);
    expect(result.quality.reasonCodes).toContain("QUALITY_DOM_PARTIAL");
    expect(result.quality.reasonCodes).toContain("QUALITY_COLLECTOR_DEGRADED");
  });

  it("reports unavailable evidence as insufficient instead of treating empty input as healthy", () => {
    const features = calculateFeatures([]);
    const quality = assessEvidenceQuality([], features, resolveDetectorConfiguration(options));

    expect(quality).toMatchObject({
      level: "insufficient",
      multiplier: 0,
      automaticEligible: false,
      distinctSamples: 0,
      expectedSamples: 1,
      receivedSampleRatio: 0,
      domCoverage: 0
    });
    expect(quality.reasonCodes).toEqual(expect.arrayContaining([
      "QUALITY_DOM_MISSING",
      "QUALITY_SAMPLE_GAPS",
      "QUALITY_RESOURCE_CONTEXT_UNAVAILABLE"
    ]));
  });

  it("classifies a single moderate cadence gap as medium-quality evidence", () => {
    const ages = [0, 60_000, 120_000, 360_001];
    const samples = ages.map((documentAgeMs, index) => sample({
      sampleSequence: index,
      documentAgeMs,
      liveDomNodes: 10_000 + index * 100,
      collectorHealth: "healthy"
    }));
    const features = calculateFeatures(samples);
    const quality = assessEvidenceQuality(samples, features, resolveDetectorConfiguration(options));

    expect(quality.level).toBe("medium");
    expect(quality.multiplier).toBe(0.85);
    expect(quality.maximumGapMs).toBe(240_001);
    expect(quality.receivedSampleRatio).toBe(1);
    expect(quality.reasonCodes).toContain("QUALITY_LARGE_GAP");
    expect(quality.automaticEligible).toBe(false);
  });

  it("uses wall-clock sample timestamps for freshness and clamps future samples to age zero", () => {
    const baseEpochMs = 1_000_000;
    const samples = growthWithSequences([0, 1, 2, 3]).map((entry, index) => ({
      ...entry,
      sampledAtEpochMs: baseEpochMs + index * 60_000
    }));
    const features = calculateFeatures(samples);
    const latestEpochMs = samples.at(-1)?.sampledAtEpochMs ?? 0;
    const fresh = assessEvidenceQuality(
      samples,
      features,
      resolveDetectorConfiguration({
        ...options,
        expectedSampleIntervalMs: 60_000,
        evaluatedAtEpochMs: latestEpochMs - 10_000
      })
    );
    const stale = assessEvidenceQuality(
      samples,
      features,
      resolveDetectorConfiguration({
        ...options,
        evaluatedAtEpochMs: latestEpochMs + 180_001,
        maximumFreshnessMs: 180_000
      })
    );

    expect(fresh.recentSampleAgeMs).toBe(0);
    expect(fresh.expectedSamples).toBe(4);
    expect(fresh.level).toBe("high");
    expect(stale.recentSampleAgeMs).toBe(180_001);
    expect(stale.level).toBe("low");
    expect(stale.reasonCodes).toContain("QUALITY_STALE");
  });

  it("quantifies overflow and dropped-observation degradation", () => {
    const samples = growthWithSequences([0, 1, 2, 3]).map((entry, index) => ({
      ...entry,
      overflowed: index === 2,
      resourceActivityCount: 10 + index,
      droppedPerformanceEntries: index === 2 ? 1 : 0
    }));
    const features = calculateFeatures(samples);
    const quality = assessEvidenceQuality(samples, features, resolveDetectorConfiguration(options));

    expect(quality.level).toBe("low");
    expect(quality.overflowRate).toBe(0.25);
    expect(quality.droppedEntryRate).toBe(0.25);
    expect(quality.reasonCodes).toEqual(expect.arrayContaining([
      "QUALITY_OVERFLOW",
      "QUALITY_DROPPED_PERFORMANCE_ENTRIES"
    ]));
    expect(quality.automaticEligible).toBe(false);
  });
});
