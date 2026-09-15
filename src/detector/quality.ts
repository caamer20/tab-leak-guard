import type { SampleSummary } from "../shared/types";
import type { DetectorV2Features } from "./features";
import { orderedDistinctSamples } from "./features";
import type { EvidenceQuality, ResolvedDetectorConfiguration } from "./model";
import { median } from "./statistics";

type QualityFinding = { code: string; reason: string };

export function assessEvidenceQuality(
  samples: readonly SampleSummary[],
  features: DetectorV2Features,
  configuration: ResolvedDetectorConfiguration
): EvidenceQuality {
  const ordered = orderedDistinctSamples(samples);
  const gaps: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    const gap = current.documentAgeMs - previous.documentAgeMs;
    if (gap > 0) gaps.push(gap);
  }
  const maximumGapMs = gaps.length > 0 ? Math.max(...gaps) : 0;
  const inferredIntervalMs = gaps.length > 0 ? Math.max(1, median(gaps)) : null;
  const expectedIntervalMs = configuration.expectedSampleIntervalMs ?? inferredIntervalMs;
  const firstSequence = features.firstSampleSequence;
  const lastSequence = features.lastSampleSequence;
  const expectedFromSequences =
    firstSequence === null || lastSequence === null
      ? features.distinctSamples
      : Math.max(features.distinctSamples, lastSequence - firstSequence + 1);
  // Only turn elapsed time into an expected count when the caller supplies a
  // cadence. An inferred median cannot distinguish a legitimate visible-to-
  // hidden cadence change from missed samples; sequence gaps remain reliable.
  const expectedFromTime =
    configuration.expectedSampleIntervalMs === null || features.durationMs <= 0
      ? features.distinctSamples
      : Math.floor(features.durationMs / configuration.expectedSampleIntervalMs) + 1;
  const expectedSamples = Math.max(1, expectedFromSequences, expectedFromTime);
  const receivedSampleRatio = Math.min(1, features.distinctSamples / expectedSamples);
  const latestSampledAtEpochMs = ordered.at(-1)?.sampledAtEpochMs;
  const recentSampleAgeMs =
    configuration.evaluatedAtEpochMs !== null && latestSampledAtEpochMs !== undefined
      ? Math.max(0, configuration.evaluatedAtEpochMs - latestSampledAtEpochMs)
      : Math.max(
          0,
          (configuration.evaluatedAtDocumentAgeMs ?? features.lastDocumentAgeMs ?? 0) -
            (features.lastDocumentAgeMs ?? configuration.evaluatedAtDocumentAgeMs ?? 0)
        );
  const overflowRate = features.distinctSamples > 0 ? features.overflowCount / features.distinctSamples : 0;
  const droppedEntryRate =
    features.droppedPerformanceEntries + features.resourceGrowth > 0
      ? features.droppedPerformanceEntries / (features.droppedPerformanceEntries + features.resourceGrowth)
      : 0;
  const degradedSampleRatio =
    features.distinctSamples > 0 ? features.degradedCollectorSamples / features.distinctSamples : 0;
  const findings: QualityFinding[] = [];

  if (features.domSignalCoverage < 1) {
    findings.push({
      code: features.domSignalCoverage < 0.5 ? "QUALITY_DOM_MISSING" : "QUALITY_DOM_PARTIAL",
      reason: "Live DOM observations were unavailable for part of this evidence window"
    });
  }
  if (receivedSampleRatio < 0.95) {
    findings.push({
      code: "QUALITY_SAMPLE_GAPS",
      reason: `Received ${Math.round(receivedSampleRatio * 100)}% of expected distinct samples`
    });
  }
  if (expectedIntervalMs !== null && maximumGapMs > expectedIntervalMs * 3) {
    findings.push({
      code: "QUALITY_LARGE_GAP",
      reason: `The largest gap between samples was ${Math.round(maximumGapMs / 1_000)} seconds`
    });
  }
  if (overflowRate > 0) {
    findings.push({
      code: "QUALITY_OVERFLOW",
      reason: `${features.overflowCount} sample${features.overflowCount === 1 ? "" : "s"} exceeded a collection budget`
    });
  }
  if (features.droppedPerformanceEntries > 0) {
    findings.push({
      code: "QUALITY_DROPPED_PERFORMANCE_ENTRIES",
      reason: `${features.droppedPerformanceEntries} performance observation${features.droppedPerformanceEntries === 1 ? " was" : "s were"} dropped`
    });
  }
  if (features.degradedCollectorSamples > 0) {
    findings.push({
      code: "QUALITY_COLLECTOR_DEGRADED",
      reason: "The collector exceeded its work budget during this evidence window"
    });
  }
  if (features.nonMonotonicTimeCount > 0) {
    findings.push({
      code: "QUALITY_NON_MONOTONIC_TIME",
      reason: "Sample time moved backward or did not advance"
    });
  }
  if (recentSampleAgeMs > configuration.maximumFreshnessMs) {
    findings.push({
      code: "QUALITY_STALE",
      reason: "The most recent evidence is stale"
    });
  }
  if (features.resourceSignalCoverage === 0) {
    findings.push({
      code: "QUALITY_RESOURCE_CONTEXT_UNAVAILABLE",
      reason: "Resource-activity context was unavailable"
    });
  }
  if (features.visibleDriftSignalCoverage < 0.5) {
    findings.push({
      code: "QUALITY_RESPONSIVENESS_CONTEXT_PARTIAL",
      reason: "Visible-page responsiveness context was incomplete"
    });
  }

  const severeGap = expectedIntervalMs !== null && maximumGapMs > expectedIntervalMs * 6;
  let level: EvidenceQuality["level"];
  let multiplier: number;
  if (features.distinctSamples < 2 || features.domSignalCoverage < 0.5) {
    level = "insufficient";
    multiplier = 0;
  } else if (
    overflowRate > 0 ||
    features.droppedPerformanceEntries > 0 ||
    features.degradedCollectorSamples > 0 ||
    features.nonMonotonicTimeCount > 0 ||
    receivedSampleRatio < 0.75 ||
    severeGap ||
    recentSampleAgeMs > configuration.maximumFreshnessMs
  ) {
    level = "low";
    multiplier = 0.65;
  } else if (
    features.domSignalCoverage < 1 ||
    receivedSampleRatio < 0.95 ||
    (expectedIntervalMs !== null && maximumGapMs > expectedIntervalMs * 3)
  ) {
    level = "medium";
    multiplier = 0.85;
  } else {
    level = "high";
    multiplier = 1;
  }

  return {
    level,
    multiplier,
    automaticEligible:
      level === "high" &&
      overflowRate === 0 &&
      features.droppedPerformanceEntries === 0 &&
      features.degradedCollectorSamples === 0 &&
      features.nonMonotonicTimeCount === 0 &&
      recentSampleAgeMs <= configuration.maximumFreshnessMs &&
      features.domSignalCoverage === 1,
    distinctSamples: features.distinctSamples,
    expectedSamples,
    receivedSampleRatio,
    domCoverage: features.domSignalCoverage,
    maximumGapMs,
    recentSampleAgeMs,
    overflowRate,
    droppedEntryRate,
    degradedSampleRatio,
    reasonCodes: findings.map((finding) => finding.code),
    reasons: findings.map((finding) => finding.reason)
  };
}
