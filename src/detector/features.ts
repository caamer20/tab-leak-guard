import type { DetectorFeatures, SampleSummary } from "../shared/types";
import { median, medianAbsoluteDeviation, percentile, robustSlopePerMinute } from "./statistics";

export type FeatureContext = {
  settledBaselineNodes?: number | null;
  peakNodesObserved?: number | null;
};

export type DetectorV2Features = DetectorFeatures & {
  distinctSamples: number;
  firstSampleSequence: number | null;
  lastSampleSequence: number | null;
  firstDocumentAgeMs: number | null;
  lastDocumentAgeMs: number | null;
  baselineKind: "none" | "candidate" | "settled";
  shortNodeSlopePerMinute: number;
  mediumNodeSlopePerMinute: number;
  recentNodeGrowthAbsolute: number;
  recentNodeMonotonicity: number;
  recentNodeMad: number;
  peakNodesObserved: number | null;
  releaseFraction: number;
  plateau: boolean;
  release: boolean;
  virtualizedChurn: boolean;
  domSignalCoverage: number;
  resourceSignalCoverage: number;
  visibleDriftSignalCoverage: number;
  droppedPerformanceEntries: number;
  degradedCollectorSamples: number;
  nonMonotonicTimeCount: number;
};

export function orderedDistinctSamples(samples: readonly SampleSummary[]): SampleSummary[] {
  const ordered = [...samples].sort((left, right) => {
    if (left.sampleSequence !== right.sampleSequence) return left.sampleSequence - right.sampleSequence;
    return left.documentAgeMs - right.documentAgeMs;
  });
  const distinct: SampleSummary[] = [];
  let previousSequence: number | undefined;
  for (const sample of ordered) {
    if (sample.sampleSequence === previousSequence) continue;
    distinct.push(sample);
    previousSequence = sample.sampleSequence;
  }
  return distinct;
}

function slope(samples: readonly (SampleSummary & { liveDomNodes: number })[]): number {
  return robustSlopePerMinute(
    samples.map((sample) => ({ timeMs: sample.documentAgeMs, value: sample.liveDomNodes }))
  );
}

function monotonicity(samples: readonly (SampleSummary & { liveDomNodes: number })[]): number {
  let meaningfulIntervals = 0;
  let positiveIntervals = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    const previous = samples[index - 1];
    if (!current || !previous) continue;
    const delta = current.liveDomNodes - previous.liveDomNodes;
    const meaningfulThreshold = Math.max(25, previous.liveDomNodes * 0.001);
    if (Math.abs(delta) < meaningfulThreshold) continue;
    meaningfulIntervals += 1;
    if (delta > 0) positiveIntervals += 1;
  }
  return meaningfulIntervals > 0 ? positiveIntervals / meaningfulIntervals : 0;
}

export function calculateFeatures(
  samples: readonly SampleSummary[],
  context: FeatureContext = {}
): DetectorV2Features {
  const ordered = orderedDistinctSamples(samples);
  const first = ordered[0];
  const last = ordered.at(-1);
  const nodeSamples = ordered.filter(
    (sample): sample is SampleSummary & { liveDomNodes: number } => sample.liveDomNodes !== null
  );
  const resourceSamples = ordered
    .map((sample) => ({
      sample,
      value: sample.resourceActivityCount !== undefined
        ? sample.resourceActivityCount
        : sample.resourceEntriesSeen
    }))
    .filter((entry): entry is { sample: SampleSummary; value: number } => entry.value !== null);
  const candidateBaselineWindow = nodeSamples
    .slice(0, Math.min(3, nodeSamples.length))
    .map((sample) => sample.liveDomNodes);
  const candidateBaseline = candidateBaselineWindow.length > 0 ? median(candidateBaselineWindow) : null;
  const baselineNodes = context.settledBaselineNodes ?? candidateBaseline;
  const baselineKind =
    baselineNodes === null
      ? "none"
      : context.settledBaselineNodes === null || context.settledBaselineNodes === undefined
        ? "candidate"
        : "settled";
  const currentNodes = nodeSamples.at(-1)?.liveDomNodes ?? null;
  const nodeGrowthAbsolute = Math.max(0, (currentNodes ?? 0) - (baselineNodes ?? currentNodes ?? 0));
  const nodeGrowthRatio = baselineNodes && currentNodes ? currentNodes / Math.max(1, baselineNodes) : 1;
  const shortNodeSamples = nodeSamples.slice(-3);
  const mediumNodeSamples = nodeSamples.slice(-5);
  const shortNodeSlopePerMinute = slope(shortNodeSamples);
  const mediumNodeSlopePerMinute = slope(mediumNodeSamples);
  const recentStartNodes = mediumNodeSamples[0]?.liveDomNodes ?? currentNodes;
  const recentNodeGrowthAbsolute = Math.max(0, (currentNodes ?? 0) - (recentStartNodes ?? currentNodes ?? 0));

  const grossAddedNodes = ordered.reduce((sum, sample) => sum + sample.addedNodesSinceLast, 0);
  const grossRemovedNodes = ordered.reduce((sum, sample) => sum + sample.removedNodesSinceLast, 0);
  const netMutatedNodes = Math.max(0, grossAddedNodes - grossRemovedNodes);
  const retentionRatio = grossAddedNodes > 0 ? netMutatedNodes / grossAddedNodes : 0;
  const initialResourceCount = resourceSamples[0]?.value ?? 0;
  const finalResourceCount = resourceSamples.at(-1)?.value ?? initialResourceCount;
  const observedPeak = nodeSamples.reduce<number | null>(
    (peak, sample) => peak === null ? sample.liveDomNodes : Math.max(peak, sample.liveDomNodes),
    context.peakNodesObserved ?? null
  );
  const peakGrowth = Math.max(0, (observedPeak ?? 0) - (baselineNodes ?? observedPeak ?? 0));
  const currentGrowth = Math.max(0, (currentNodes ?? 0) - (baselineNodes ?? currentNodes ?? 0));
  const releaseFraction = peakGrowth > 0 ? Math.max(0, Math.min(1, 1 - currentGrowth / peakGrowth)) : 0;
  const recentValues = shortNodeSamples.map((sample) => sample.liveDomNodes);
  const recentRange = recentValues.length > 0 ? Math.max(...recentValues) - Math.min(...recentValues) : 0;
  const plateauTolerance = Math.max(200, (currentNodes ?? 0) * 0.01);
  const plateau =
    nodeGrowthAbsolute >= 5_000 &&
    shortNodeSamples.length >= 3 &&
    Math.abs(shortNodeSlopePerMinute) < 100 &&
    recentRange <= plateauTolerance;
  const release = peakGrowth >= 5_000 && releaseFraction >= 0.65;
  const virtualizedChurn =
    grossAddedNodes >= Math.max(10_000, (currentNodes ?? 0) * 0.5) &&
    retentionRatio <= 0.2 &&
    nodeGrowthAbsolute <= Math.max(2_000, (baselineNodes ?? 0) * 0.1);
  const visibleSamples = ordered.filter((sample) => sample.visibility === "visible");
  const visibleDriftSamples = visibleSamples.filter((sample) => sample.timerDriftMs !== null);
  let nonMonotonicTimeCount = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous && current && current.documentAgeMs <= previous.documentAgeMs) nonMonotonicTimeCount += 1;
  }

  return {
    durationMs: Math.max(0, (last?.documentAgeMs ?? 0) - (first?.documentAgeMs ?? 0)),
    validSamples: ordered.length,
    distinctSamples: ordered.length,
    firstSampleSequence: first?.sampleSequence ?? null,
    lastSampleSequence: last?.sampleSequence ?? null,
    firstDocumentAgeMs: first?.documentAgeMs ?? null,
    lastDocumentAgeMs: last?.documentAgeMs ?? null,
    baselineNodes,
    baselineKind,
    currentNodes,
    nodeGrowthAbsolute,
    nodeGrowthRatio,
    nodeSlopePerMinute: slope(nodeSamples),
    shortNodeSlopePerMinute,
    mediumNodeSlopePerMinute,
    recentNodeGrowthAbsolute,
    nodeMonotonicity: monotonicity(nodeSamples),
    recentNodeMonotonicity: monotonicity(mediumNodeSamples),
    recentNodeMad: medianAbsoluteDeviation(recentValues),
    grossAddedNodes,
    grossRemovedNodes,
    retentionRatio,
    peakNodesObserved: observedPeak,
    releaseFraction,
    plateau,
    release,
    virtualizedChurn,
    resourceGrowth: Math.max(0, finalResourceCount - initialResourceCount),
    resourceSlopePerMinute: robustSlopePerMinute(
      resourceSamples.map((sample) => ({
        timeMs: sample.sample.documentAgeMs,
        value: sample.value
      }))
    ),
    visibleTimerDriftP95: percentile(
      visibleDriftSamples.map((sample) => sample.timerDriftMs as number),
      0.95
    ),
    overflowCount: ordered.filter((sample) => sample.overflowed).length,
    domSignalCoverage: ordered.length > 0 ? nodeSamples.length / ordered.length : 0,
    resourceSignalCoverage: ordered.length > 0 ? resourceSamples.length / ordered.length : 0,
    visibleDriftSignalCoverage:
      visibleSamples.length > 0 ? visibleDriftSamples.length / visibleSamples.length : 1,
    droppedPerformanceEntries: ordered.reduce(
      (sum, sample) => sum + (sample.droppedPerformanceEntries ?? 0),
      0
    ),
    degradedCollectorSamples: ordered.filter((sample) => sample.collectorHealth === "degraded").length,
    nonMonotonicTimeCount
  };
}
