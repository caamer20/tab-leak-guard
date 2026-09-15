import type { DetectorResult } from "../shared/types";
import type { DetectorV2Features } from "./features";

/** Increment when detector semantics change in a way that reinterprets evidence. */
export const DETECTOR_MODEL_VERSION = "retained-dom-v2.0.0";

/** Increment when the built-in preset changes without changing feature semantics. */
export const DETECTOR_CONFIGURATION_VERSION = "balanced-v2.0.0";

export type DetectorSeverity = "learning" | "stable" | "elevated" | "likely-runaway" | "unsupported";
export type EvidenceDetectorStatus = "unsupported" | "warmup" | "healthy" | "watching" | "suspected" | "confirmed";
export type EvidenceState = "clear" | "high";
export type EvidenceQualityLevel = "high" | "medium" | "low" | "insufficient";

export type EvidenceQuality = {
  level: EvidenceQualityLevel;
  multiplier: number;
  automaticEligible: boolean;
  distinctSamples: number;
  expectedSamples: number;
  receivedSampleRatio: number;
  domCoverage: number;
  maximumGapMs: number;
  recentSampleAgeMs: number;
  overflowRate: number;
  droppedEntryRate: number;
  degradedSampleRatio: number;
  reasonCodes: string[];
  reasons: string[];
};

/**
 * A baseline is deliberately carried outside the bounded recent sample window.
 * This prevents a long-running leak from teaching a rolling window that its
 * already-grown DOM is normal.
 */
export type SettledBaseline = {
  nodeCount: number;
  nodeSampleCount: number;
  settledAtSampleSequence: number;
  settledAtDocumentAgeMs: number;
};

export type DetectorEvaluation = Omit<DetectorResult, "status" | "features"> & {
  status: EvidenceDetectorStatus;
  features: DetectorV2Features;
  modelVersion: typeof DETECTOR_MODEL_VERSION;
  configurationVersion: string;
  severity: DetectorSeverity;
  quality: EvidenceQuality;
  automaticEligible: boolean;
  automaticEvidenceScore: number;
  evidenceState: EvidenceState;
  highEvidenceSinceDocumentAgeMs: number | null;
  highEvidenceDistinctSamples: number;
  lastEvaluatedSampleSequence: number | null;
  lastEvaluatedDocumentAgeMs: number | null;
  settledBaseline: SettledBaseline | null;
  peakNodesObserved: number | null;
};

export type EvaluationOptions = {
  confirmationScore: number;
  minimumSamples?: number;
  minimumDurationMs?: number;
  highEvidenceDurationMs?: number;
  minimumHighEvidenceSamples?: number;
  clearScore?: number;
  minimumCurrentNodes?: number;
  minimumAbsoluteGrowth?: number;
  minimumGrowthRatio?: number;
  minimumLongSlopePerMinute?: number;
  minimumRecentSlopePerMinute?: number;
  minimumRetentionRatio?: number;
  expectedSampleIntervalMs?: number;
  maximumFreshnessMs?: number;
  evaluatedAtDocumentAgeMs?: number;
  evaluatedAtEpochMs?: number;
  configurationVersion?: string;
};

export type ResolvedDetectorConfiguration = {
  confirmationScore: number;
  minimumSamples: number;
  minimumDurationMs: number;
  highEvidenceDurationMs: number;
  minimumHighEvidenceSamples: number;
  clearScore: number;
  minimumCurrentNodes: number;
  minimumAbsoluteGrowth: number;
  minimumGrowthRatio: number;
  minimumLongSlopePerMinute: number;
  minimumRecentSlopePerMinute: number;
  minimumRetentionRatio: number;
  expectedSampleIntervalMs: number | null;
  maximumFreshnessMs: number;
  evaluatedAtDocumentAgeMs: number | null;
  evaluatedAtEpochMs: number | null;
  configurationVersion: string;
};

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function atLeast(value: number | undefined, fallback: number, minimum: number): number {
  return Math.max(minimum, finiteOr(value, fallback));
}

export function resolveDetectorConfiguration(options: EvaluationOptions): ResolvedDetectorConfiguration {
  const confirmationScore = Math.min(100, Math.max(1, finiteOr(options.confirmationScore, 75)));
  const minimumSamples = Math.floor(atLeast(options.minimumSamples, 6, 2));
  const minimumDurationMs = atLeast(options.minimumDurationMs, 5 * 60_000, 0);
  const highEvidenceDurationMs = atLeast(options.highEvidenceDurationMs, 120_000, 0);
  const minimumHighEvidenceSamples = Math.floor(atLeast(options.minimumHighEvidenceSamples, 3, 2));
  const clearScore = Math.min(
    confirmationScore,
    Math.max(0, finiteOr(options.clearScore, confirmationScore - 15))
  );
  const minimumCurrentNodes = atLeast(options.minimumCurrentNodes, 15_000, 1);
  const minimumAbsoluteGrowth = atLeast(options.minimumAbsoluteGrowth, 5_000, 1);
  const minimumGrowthRatio = atLeast(options.minimumGrowthRatio, 1.25, 1);
  const minimumLongSlopePerMinute = atLeast(options.minimumLongSlopePerMinute, 250, 0);
  const minimumRecentSlopePerMinute = atLeast(options.minimumRecentSlopePerMinute, 250, 0);
  const minimumRetentionRatio = Math.min(1, Math.max(0, finiteOr(options.minimumRetentionRatio, 0.45)));
  const expectedSampleIntervalMs =
    options.expectedSampleIntervalMs === undefined
      ? null
      : atLeast(options.expectedSampleIntervalMs, 30_000, 1);
  const maximumFreshnessMs = atLeast(options.maximumFreshnessMs, 3 * 60_000, 1);
  const evaluatedAtDocumentAgeMs =
    options.evaluatedAtDocumentAgeMs === undefined
      ? null
      : atLeast(options.evaluatedAtDocumentAgeMs, 0, 0);
  const evaluatedAtEpochMs =
    options.evaluatedAtEpochMs === undefined
      ? null
      : atLeast(options.evaluatedAtEpochMs, 0, 0);

  // Include every behavior-affecting value so persisted evidence cannot cross a
  // preference/preset boundary unnoticed. The string is intentionally readable.
  const configurationVersion = [
    options.configurationVersion ?? DETECTOR_CONFIGURATION_VERSION,
    confirmationScore,
    clearScore,
    minimumSamples,
    minimumDurationMs,
    highEvidenceDurationMs,
    minimumHighEvidenceSamples,
    minimumCurrentNodes,
    minimumAbsoluteGrowth,
    minimumGrowthRatio,
    minimumLongSlopePerMinute,
    minimumRecentSlopePerMinute,
    minimumRetentionRatio,
    expectedSampleIntervalMs ?? "adaptive",
    maximumFreshnessMs
  ].join(":");

  return {
    confirmationScore,
    minimumSamples,
    minimumDurationMs,
    highEvidenceDurationMs,
    minimumHighEvidenceSamples,
    clearScore,
    minimumCurrentNodes,
    minimumAbsoluteGrowth,
    minimumGrowthRatio,
    minimumLongSlopePerMinute,
    minimumRecentSlopePerMinute,
    minimumRetentionRatio,
    expectedSampleIntervalMs,
    maximumFreshnessMs,
    evaluatedAtDocumentAgeMs,
    evaluatedAtEpochMs,
    configurationVersion
  };
}

export function isCompatibleDetectorEvaluation(
  value: unknown,
  configurationVersion: string
): value is DetectorEvaluation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DetectorEvaluation>;
  const finiteNonnegative = (input: unknown): input is number =>
    typeof input === "number" && Number.isFinite(input) && input >= 0;
  const safeInteger = (input: unknown): input is number =>
    finiteNonnegative(input) && Number.isSafeInteger(input);
  if (
    candidate.modelVersion !== DETECTOR_MODEL_VERSION ||
    candidate.configurationVersion !== configurationVersion ||
    (candidate.evidenceState !== "clear" && candidate.evidenceState !== "high") ||
    (candidate.lastEvaluatedSampleSequence !== null && !safeInteger(candidate.lastEvaluatedSampleSequence)) ||
    (candidate.lastEvaluatedDocumentAgeMs !== null && !finiteNonnegative(candidate.lastEvaluatedDocumentAgeMs)) ||
    (candidate.peakNodesObserved !== null && !finiteNonnegative(candidate.peakNodesObserved)) ||
    !safeInteger(candidate.highEvidenceDistinctSamples)
  ) return false;

  const pairedEvaluationIdentity =
    (candidate.lastEvaluatedSampleSequence === null && candidate.lastEvaluatedDocumentAgeMs === null) ||
    (safeInteger(candidate.lastEvaluatedSampleSequence) && finiteNonnegative(candidate.lastEvaluatedDocumentAgeMs));
  if (!pairedEvaluationIdentity) return false;

  if (candidate.settledBaseline !== null) {
    const baseline = candidate.settledBaseline;
    if (
      typeof baseline !== "object" ||
      !finiteNonnegative(baseline.nodeCount) ||
      !safeInteger(baseline.nodeSampleCount) ||
      baseline.nodeSampleCount < 1 ||
      !safeInteger(baseline.settledAtSampleSequence) ||
      !finiteNonnegative(baseline.settledAtDocumentAgeMs)
    ) return false;
  }

  if (candidate.evidenceState === "clear") {
    return candidate.highEvidenceSinceDocumentAgeMs === null && candidate.highEvidenceDistinctSamples === 0;
  }
  return (
    finiteNonnegative(candidate.highEvidenceSinceDocumentAgeMs) &&
    candidate.highEvidenceDistinctSamples >= 1 &&
    candidate.settledBaseline !== null &&
    finiteNonnegative(candidate.lastEvaluatedDocumentAgeMs) &&
    candidate.highEvidenceSinceDocumentAgeMs <= candidate.lastEvaluatedDocumentAgeMs
  );
}

export function isAutomaticEligible(result: DetectorResult): boolean {
  const candidate = result as Partial<DetectorEvaluation>;
  return candidate.modelVersion === DETECTOR_MODEL_VERSION && candidate.automaticEligible === true;
}
