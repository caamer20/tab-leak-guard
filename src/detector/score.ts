import type { DetectorResult, SampleSummary } from "../shared/types";
import { calculateFeatures, orderedDistinctSamples, type DetectorV2Features } from "./features";
import {
  DETECTOR_MODEL_VERSION,
  isCompatibleDetectorEvaluation,
  resolveDetectorConfiguration,
  type DetectorEvaluation,
  type DetectorSeverity,
  type EvidenceDetectorStatus,
  type EvaluationOptions,
  type ResolvedDetectorConfiguration,
  type SettledBaseline
} from "./model";
import { assessEvidenceQuality } from "./quality";
import { clamp } from "./statistics";

export type { DetectorEvaluation, EvaluationOptions } from "./model";
export {
  isAutomaticEligible,
  isCompatibleDetectorEvaluation,
  resolveDetectorConfiguration
} from "./model";

const DEFAULT_CONFIGURATION = resolveDetectorConfiguration({ confirmationScore: 75 });
const EMPTY_FEATURES = calculateFeatures([]);

function emptyQuality() {
  return {
    level: "insufficient" as const,
    multiplier: 0,
    automaticEligible: false,
    distinctSamples: 0,
    expectedSamples: 1,
    receivedSampleRatio: 0,
    domCoverage: 0,
    maximumGapMs: 0,
    recentSampleAgeMs: 0,
    overflowRate: 0,
    droppedEntryRate: 0,
    degradedSampleRatio: 0,
    reasonCodes: ["QUALITY_NOT_ENOUGH_SAMPLES"],
    reasons: ["Not enough distinct samples are available yet"]
  };
}

function severityForStatus(status: EvidenceDetectorStatus): DetectorSeverity {
  if (status === "unsupported") return "unsupported";
  if (status === "warmup") return "learning";
  if (status === "healthy") return "stable";
  if (status === "watching") return "elevated";
  return "likely-runaway";
}

export function emptyDetectorResult(status: EvidenceDetectorStatus = "warmup"): DetectorEvaluation {
  return {
    status,
    severity: severityForStatus(status),
    score: 0,
    consecutiveConfirmations: 0,
    signalFamilies: [],
    reasonCodes: [],
    reasons: status === "unsupported" ? ["This page cannot be monitored"] : ["Collecting a baseline"],
    features: EMPTY_FEATURES,
    modelVersion: DETECTOR_MODEL_VERSION,
    configurationVersion: DEFAULT_CONFIGURATION.configurationVersion,
    quality: emptyQuality(),
    automaticEligible: false,
    automaticEvidenceScore: 0,
    evidenceState: "clear",
    highEvidenceSinceDocumentAgeMs: null,
    highEvidenceDistinctSamples: 0,
    lastEvaluatedSampleSequence: null,
    lastEvaluatedDocumentAgeMs: null,
    settledBaseline: null,
    peakNodesObserved: null
  };
}

function createSettledBaseline(
  samples: readonly SampleSummary[],
  features: DetectorV2Features
): SettledBaseline | null {
  if (features.baselineNodes === null || features.lastSampleSequence === null || features.lastDocumentAgeMs === null) {
    return null;
  }
  const nodeSampleCount = orderedDistinctSamples(samples)
    .filter((sample) => sample.liveDomNodes !== null)
    .slice(0, 3).length;
  if (nodeSampleCount < 3) return null;
  return {
    nodeCount: features.baselineNodes,
    nodeSampleCount,
    settledAtSampleSequence: features.lastSampleSequence,
    settledAtDocumentAgeMs: features.lastDocumentAgeMs
  };
}

function warmupResult(
  features: DetectorV2Features,
  configuration: ResolvedDetectorConfiguration,
  previous: DetectorEvaluation | undefined
): DetectorEvaluation {
  return {
    ...emptyDetectorResult("warmup"),
    configurationVersion: configuration.configurationVersion,
    reasons: [
      `Building a ${Math.ceil(configuration.minimumDurationMs / 60_000)} minute baseline (${features.validSamples}/${configuration.minimumSamples} samples)`
    ],
    features,
    lastEvaluatedSampleSequence: features.lastSampleSequence,
    lastEvaluatedDocumentAgeMs: features.lastDocumentAgeMs,
    peakNodesObserved: features.peakNodesObserved,
    // Never settle or inherit evidence across an incompatible configuration.
    settledBaseline: previous?.settledBaseline ?? null
  };
}

function evaluationMatchesCurrentSamples(
  evaluation: DetectorEvaluation,
  samples: readonly SampleSummary[]
): boolean {
  const latest = orderedDistinctSamples(samples).at(-1);
  if (!latest) {
    return evaluation.lastEvaluatedSampleSequence === null && evaluation.lastEvaluatedDocumentAgeMs === null;
  }
  if (evaluation.lastEvaluatedSampleSequence === null || evaluation.lastEvaluatedDocumentAgeMs === null) {
    return evaluation.settledBaseline === null && evaluation.evidenceState === "clear";
  }
  return (
    evaluation.lastEvaluatedSampleSequence <= latest.sampleSequence &&
    evaluation.lastEvaluatedDocumentAgeMs <= latest.documentAgeMs &&
    (evaluation.settledBaseline === null ||
      evaluation.settledBaseline.settledAtSampleSequence <= latest.sampleSequence)
  );
}

type ScoreEvidence = {
  score: number;
  reasons: string[];
  reasonCodes: string[];
  signalFamilies: string[];
  strongRetainedDom: boolean;
  automaticEvidenceScore: number;
};

function scoreEvidence(
  features: DetectorV2Features,
  configuration: ResolvedDetectorConfiguration
): ScoreEvidence {
  let rawScore = 0;
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  const signalFamilies = new Set<string>();

  const absoluteGrowthFactor = clamp(features.nodeGrowthAbsolute / 20_000);
  const relativeGrowthFactor = clamp((features.nodeGrowthRatio - 1) / 1.5);
  const growthPoints = 35 * Math.max(absoluteGrowthFactor, relativeGrowthFactor * 0.8);
  if (growthPoints >= 5) {
    rawScore += growthPoints;
    signalFamilies.add("retained-dom");
    reasonCodes.push("DOM_GROWTH");
    reasons.push(
      `Live DOM grew by ${Math.round(features.nodeGrowthAbsolute)} nodes (${features.nodeGrowthRatio.toFixed(1)}× settled baseline)`
    );
  }

  const slopePoints = 20 * clamp(features.nodeSlopePerMinute / 1_500);
  if (slopePoints >= 4) {
    rawScore += slopePoints;
    signalFamilies.add("retained-dom");
    reasonCodes.push("DOM_SLOPE");
    reasons.push(`Long-window DOM trend is about ${Math.round(features.nodeSlopePerMinute)} nodes per minute`);
  }

  const recentSlopePoints = 15 * clamp(features.mediumNodeSlopePerMinute / 1_000);
  if (recentSlopePoints >= 3) {
    rawScore += recentSlopePoints;
    signalFamilies.add("retained-dom");
    reasonCodes.push("RECENT_DOM_SLOPE");
    reasons.push(`Recent DOM trend remains positive at about ${Math.round(features.mediumNodeSlopePerMinute)} nodes per minute`);
  }

  const retentionStrength = clamp(features.retentionRatio / 0.7) * clamp(features.nodeMonotonicity / 0.8);
  const retentionPoints = 20 * retentionStrength;
  if (retentionPoints >= 4) {
    rawScore += retentionPoints;
    signalFamilies.add("retained-dom");
    reasonCodes.push("SUSTAINED_RETENTION");
    reasons.push(`${Math.round(features.nodeMonotonicity * 100)}% of meaningful DOM intervals kept growing`);
  }

  const severeDom =
    features.nodeGrowthAbsolute >= 20_000 &&
    features.nodeSlopePerMinute >= 1_500 &&
    features.recentNodeMonotonicity >= 0.75;
  if (severeDom) {
    rawScore += 10;
    reasonCodes.push("SEVERE_DOM_PATTERN");
  }

  let automaticRawScore = rawScore;

  // Resource timing and timer drift are page-activity context. They can refine
  // notification ranking, but never satisfy the retained-DOM prerequisite.
  const resourceContextPoints = 5 * Math.max(
    clamp(features.resourceGrowth / 500),
    clamp(features.resourceSlopePerMinute / 40)
  );
  if (resourceContextPoints >= 2) {
    rawScore += resourceContextPoints;
    signalFamilies.add("context-resource-activity");
    reasonCodes.push("RESOURCE_ACTIVITY");
    reasons.push(`Observed ${Math.round(features.resourceGrowth)} additional resource-timing events`);
  }

  const drift = features.visibleTimerDriftP95 ?? 0;
  const responsivenessContextPoints = 5 * clamp((drift - 100) / 1_000);
  if (responsivenessContextPoints >= 2) {
    rawScore += responsivenessContextPoints;
    signalFamilies.add("context-responsiveness");
    reasonCodes.push("RESPONSIVENESS_CONTEXT");
    reasons.push(`Visible-page responsiveness delay reached ${Math.round(drift)} ms`);
  }

  if (features.release) {
    rawScore *= 0.15;
    automaticRawScore *= 0.15;
    reasonCodes.push("DOM_RELEASE");
    reasons.push(`The DOM released ${Math.round(features.releaseFraction * 100)}% of its observed peak growth`);
  } else if (features.plateau) {
    rawScore *= 0.45;
    automaticRawScore *= 0.45;
    reasonCodes.push("DOM_PLATEAU");
    reasons.push("Recent DOM size plateaued instead of continuing to grow");
  }
  if (features.virtualizedChurn) {
    rawScore *= 0.35;
    automaticRawScore *= 0.35;
    reasonCodes.push("VIRTUALIZED_CHURN");
    reasons.push("High DOM churn released most added nodes, which resembles virtualization rather than retention");
  }

  const strongRetainedDom =
    features.currentNodes !== null &&
    features.currentNodes >= configuration.minimumCurrentNodes &&
    features.nodeGrowthAbsolute >= configuration.minimumAbsoluteGrowth &&
    features.nodeGrowthRatio >= configuration.minimumGrowthRatio &&
    features.nodeSlopePerMinute >= configuration.minimumLongSlopePerMinute &&
    features.mediumNodeSlopePerMinute >= configuration.minimumRecentSlopePerMinute &&
    features.retentionRatio >= configuration.minimumRetentionRatio &&
    features.recentNodeMonotonicity >= 0.6 &&
    !features.plateau &&
    !features.release &&
    !features.virtualizedChurn;

  return {
    score: Math.round(clamp(rawScore, 0, 100)),
    reasons,
    reasonCodes,
    signalFamilies: [...signalFamilies],
    strongRetainedDom,
    automaticEvidenceScore: Math.round(clamp(automaticRawScore, 0, 100))
  };
}

export function evaluateSamples(
  samples: readonly SampleSummary[],
  previousResult: DetectorResult | undefined,
  options: EvaluationOptions
): DetectorEvaluation {
  const configuration = resolveDetectorConfiguration(options);
  const compatiblePrevious = isCompatibleDetectorEvaluation(previousResult, configuration.configurationVersion)
    ? previousResult
    : undefined;
  const previous = compatiblePrevious && evaluationMatchesCurrentSamples(compatiblePrevious, samples)
    ? compatiblePrevious
    : undefined;
  let features = calculateFeatures(samples, {
    settledBaselineNodes: previous?.settledBaseline?.nodeCount,
    peakNodesObserved: previous?.peakNodesObserved
  });
  const hasCompleteBaselineWindow = orderedDistinctSamples(samples)
    .filter((sample) => sample.liveDomNodes !== null)
    .length >= 3;
  const warmupComplete =
    (previous?.settledBaseline !== null && previous?.settledBaseline !== undefined) ||
    (hasCompleteBaselineWindow &&
      features.validSamples >= configuration.minimumSamples &&
      features.durationMs >= configuration.minimumDurationMs);

  if (!warmupComplete) return warmupResult(features, configuration, previous);

  const settledBaseline = previous?.settledBaseline ?? createSettledBaseline(samples, features);
  if (settledBaseline) {
    features = calculateFeatures(samples, {
      settledBaselineNodes: settledBaseline.nodeCount,
      peakNodesObserved: previous?.peakNodesObserved
    });
  }

  const quality = assessEvidenceQuality(samples, features, configuration);
  const evidence = scoreEvidence(features, configuration);
  const score = Math.round(clamp(evidence.score * quality.multiplier, 0, 100));
  const automaticEvidenceScore = Math.round(
    clamp(evidence.automaticEvidenceScore * quality.multiplier, 0, 100)
  );
  const enterHigh =
    evidence.strongRetainedDom &&
    quality.level === "high" &&
    automaticEvidenceScore >= configuration.confirmationScore;
  const holdHigh =
    previous?.evidenceState === "high" &&
    evidence.strongRetainedDom &&
    quality.level === "high" &&
    automaticEvidenceScore >= configuration.clearScore;
  const evidenceState = enterHigh || holdHigh ? "high" : "clear";
  const latestSequence = features.lastSampleSequence;
  const latestDocumentAgeMs = features.lastDocumentAgeMs;
  const isDistinctEvaluation =
    latestSequence !== null && latestSequence !== previous?.lastEvaluatedSampleSequence;

  let highEvidenceSinceDocumentAgeMs: number | null = null;
  let highEvidenceDistinctSamples = 0;
  if (evidenceState === "high") {
    if (previous?.evidenceState === "high") {
      highEvidenceSinceDocumentAgeMs = previous.highEvidenceSinceDocumentAgeMs;
      highEvidenceDistinctSamples = previous.highEvidenceDistinctSamples;
      if (isDistinctEvaluation) highEvidenceDistinctSamples += 1;
    } else if (isDistinctEvaluation && latestDocumentAgeMs !== null) {
      highEvidenceSinceDocumentAgeMs = latestDocumentAgeMs;
      highEvidenceDistinctSamples = 1;
    }
  }

  const highEvidenceDurationMs =
    highEvidenceSinceDocumentAgeMs === null || latestDocumentAgeMs === null
      ? 0
      : Math.max(0, latestDocumentAgeMs - highEvidenceSinceDocumentAgeMs);
  const confirmationMature =
    evidenceState === "high" &&
    highEvidenceDistinctSamples >= configuration.minimumHighEvidenceSamples &&
    highEvidenceDurationMs >= configuration.highEvidenceDurationMs;
  const automaticEligible =
    confirmationMature &&
    evidence.strongRetainedDom &&
    quality.automaticEligible &&
    automaticEvidenceScore >= configuration.clearScore;

  let status: EvidenceDetectorStatus;
  if (automaticEligible) status = "confirmed";
  else if (evidenceState === "high" || score >= 60) status = "suspected";
  else if (score >= 40) status = "watching";
  else status = "healthy";

  const reasons = [...evidence.reasons, ...quality.reasons];
  const reasonCodes = [...evidence.reasonCodes, ...quality.reasonCodes];
  if (reasons.length === 0) reasons.push("Retained DOM growth is stable within the settled baseline");
  if (evidenceState === "high" && !confirmationMature) {
    const secondsRemaining = Math.max(
      0,
      Math.ceil((configuration.highEvidenceDurationMs - highEvidenceDurationMs) / 1_000)
    );
    reasonCodes.push("CONFIRMATION_IN_PROGRESS");
    reasons.push(`High evidence must persist for ${secondsRemaining} more seconds on distinct samples`);
  }

  return {
    status,
    severity: confirmationMature ? "likely-runaway" : status === "healthy" ? "stable" : "elevated",
    score,
    consecutiveConfirmations: highEvidenceDistinctSamples,
    signalFamilies: evidence.signalFamilies,
    reasonCodes,
    reasons,
    features,
    modelVersion: DETECTOR_MODEL_VERSION,
    configurationVersion: configuration.configurationVersion,
    quality,
    automaticEligible,
    automaticEvidenceScore,
    evidenceState,
    highEvidenceSinceDocumentAgeMs,
    highEvidenceDistinctSamples,
    lastEvaluatedSampleSequence: latestSequence,
    lastEvaluatedDocumentAgeMs: latestDocumentAgeMs,
    settledBaseline,
    peakNodesObserved: features.peakNodesObserved
  };
}
