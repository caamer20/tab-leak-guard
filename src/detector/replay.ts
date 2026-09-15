import type { SampleSummary } from "../shared/types";
import {
  DETECTOR_MODEL_VERSION,
  resolveDetectorConfiguration,
  type EvaluationOptions,
  type EvidenceDetectorStatus
} from "./model";
import { evaluateSamples, type DetectorEvaluation } from "./score";

export const DETECTOR_TRACE_FORMAT_VERSION = 1 as const;

export type TraceExpectedClass = "retained-dom" | "benign" | "ambiguous" | "unsupported";
export type TraceLifecycleType =
  | "navigation"
  | "route-change"
  | "long-gap"
  | "pagehide"
  | "pageshow"
  | "bfcache-restore";

export type DetectorTrace = {
  traceFormatVersion: typeof DETECTOR_TRACE_FORMAT_VERSION;
  traceId: string;
  expectedClass: TraceExpectedClass;
  redaction: {
    containsPageIdentifiers: false;
    notes?: string[];
  };
  events: Array<
    | { kind: "sample"; sample: SampleSummary }
    | { kind: "lifecycle"; type: TraceLifecycleType; documentAgeMs: number }
  >;
};

export type ReplayOptions = EvaluationOptions & {
  maximumRecentSamples?: number;
};

export type SampleReplayStep = {
  kind: "sample";
  eventIndex: number;
  segment: number;
  sampleSequence: number;
  documentAgeMs: number;
  transition: { from: EvidenceDetectorStatus | null; to: EvidenceDetectorStatus };
  evaluation: DetectorEvaluation;
};

export type LifecycleReplayStep = {
  kind: "lifecycle";
  eventIndex: number;
  segment: number;
  lifecycle: TraceLifecycleType;
  documentAgeMs: number;
  evidenceSegmented: boolean;
};

export type DetectorReplay = {
  traceFormatVersion: typeof DETECTOR_TRACE_FORMAT_VERSION;
  traceId: string;
  expectedClass: TraceExpectedClass;
  modelVersion: typeof DETECTOR_MODEL_VERSION;
  configurationVersion: string;
  steps: Array<SampleReplayStep | LifecycleReplayStep>;
  summary: {
    sampleCount: number;
    segmentCount: number;
    finalStatus: EvidenceDetectorStatus | null;
    maximumScore: number;
    everConfirmed: boolean;
    everAutomaticEligible: boolean;
    firstConfirmedDocumentAgeMs: number | null;
  };
};

export type DetectorCorpusReport = {
  modelVersion: typeof DETECTOR_MODEL_VERSION;
  configurationVersion: string;
  traces: Array<{
    traceId: string;
    expectedClass: TraceExpectedClass;
    confirmed: boolean;
    automaticEligible: boolean;
    maximumScore: number;
    firstConfirmedDocumentAgeMs: number | null;
  }>;
  confusion: {
    truePositive: number;
    falseNegative: number;
    trueNegative: number;
    falsePositive: number;
    recall: number | null;
    falsePositiveRate: number | null;
  };
};

export class DetectorTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectorTraceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new DetectorTraceError(`${context} contains unsupported field ${unexpected[0]}`);
  }
}

function finiteNumber(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function nullableFiniteNumber(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number | null {
  return value === null || finiteNumber(value, minimum, maximum);
}

function parseCapabilities(value: unknown): SampleSummary["capabilities"] {
  if (
    !isRecord(value) ||
    typeof value.resourceObserver !== "boolean" ||
    typeof value.longTasks !== "boolean" ||
    typeof value.exactMemory !== "boolean"
  ) {
    throw new DetectorTraceError("A trace sample has invalid capability flags");
  }
  assertOnlyKeys(value, ["resourceObserver", "longTasks", "exactMemory"], "Trace capabilities");
  return {
    resourceObserver: value.resourceObserver,
    longTasks: value.longTasks,
    exactMemory: value.exactMemory
  };
}

function parseSample(value: unknown, eventIndex: number): SampleSummary {
  if (!isRecord(value)) throw new DetectorTraceError(`Trace event ${eventIndex} has no sample object`);
  assertOnlyKeys(value, [
    "sampleSequence",
    "documentAgeMs",
    "visibility",
    "liveDomNodes",
    "addedNodesSinceLast",
    "removedNodesSinceLast",
    "resourceEntriesSeen",
    "timerDriftMs",
    "dirty",
    "overflowed",
    "capabilities",
    "userEditState",
    "collectorMode",
    "collectorHealth",
    "resourceActivityCount",
    "droppedPerformanceEntries",
    "sampleDurationMs",
    "mutationWorkDurationMs",
    "recountDurationMs",
    "sampledAtEpochMs"
  ], `Trace sample ${eventIndex}`);
  if (!finiteNumber(value.sampleSequence, 0, 10_000_000) || !Number.isSafeInteger(value.sampleSequence)) {
    throw new DetectorTraceError(`Trace event ${eventIndex} has an invalid sampleSequence`);
  }
  if (!finiteNumber(value.documentAgeMs, 0, 31_536_000_000)) {
    throw new DetectorTraceError(`Trace event ${eventIndex} has an invalid documentAgeMs`);
  }
  if (value.visibility !== "visible" && value.visibility !== "hidden") {
    throw new DetectorTraceError(`Trace event ${eventIndex} has an invalid visibility`);
  }
  if (
    !nullableFiniteNumber(value.liveDomNodes, 0, 100_000_000) ||
    !finiteNumber(value.addedNodesSinceLast, 0, 100_000_000) ||
    !finiteNumber(value.removedNodesSinceLast, 0, 100_000_000) ||
    !nullableFiniteNumber(value.resourceEntriesSeen, 0, 10_000_000) ||
    !nullableFiniteNumber(value.timerDriftMs, 0, 3_600_000) ||
    typeof value.dirty !== "boolean" ||
    typeof value.overflowed !== "boolean"
  ) {
    throw new DetectorTraceError(`Trace event ${eventIndex} contains invalid primitive measurements`);
  }
  if (
    (value.userEditState !== undefined &&
      value.userEditState !== "no-edits-observed" &&
      value.userEditState !== "edits-observed" &&
      value.userEditState !== "unknown") ||
    (value.collectorMode !== undefined && value.collectorMode !== "manual" && value.collectorMode !== "continuous") ||
    (value.collectorHealth !== undefined &&
      value.collectorHealth !== "healthy" &&
      value.collectorHealth !== "degraded" &&
      value.collectorHealth !== "stopped") ||
    (value.resourceActivityCount !== undefined &&
      !nullableFiniteNumber(value.resourceActivityCount, 0, 10_000_000)) ||
    (value.droppedPerformanceEntries !== undefined &&
      !finiteNumber(value.droppedPerformanceEntries, 0, 10_000_000)) ||
    (value.sampleDurationMs !== undefined && !finiteNumber(value.sampleDurationMs, 0, 60_000)) ||
    (value.mutationWorkDurationMs !== undefined &&
      !finiteNumber(value.mutationWorkDurationMs, 0, 60_000)) ||
    (value.recountDurationMs !== undefined && !nullableFiniteNumber(value.recountDurationMs, 0, 60_000)) ||
    (value.sampledAtEpochMs !== undefined &&
      !finiteNumber(value.sampledAtEpochMs, 0, 31_536_000_000_000))
  ) {
    throw new DetectorTraceError(`Trace event ${eventIndex} contains invalid signal-health metadata`);
  }
  const sample: SampleSummary = {
    sampleSequence: value.sampleSequence,
    documentAgeMs: value.documentAgeMs,
    visibility: value.visibility,
    liveDomNodes: value.liveDomNodes,
    addedNodesSinceLast: value.addedNodesSinceLast,
    removedNodesSinceLast: value.removedNodesSinceLast,
    resourceEntriesSeen: value.resourceEntriesSeen,
    timerDriftMs: value.timerDriftMs,
    dirty: value.dirty,
    overflowed: value.overflowed,
    capabilities: parseCapabilities(value.capabilities)
  };
  if (
    value.userEditState === "no-edits-observed" ||
    value.userEditState === "edits-observed" ||
    value.userEditState === "unknown"
  ) sample.userEditState = value.userEditState;
  if (value.collectorMode === "manual" || value.collectorMode === "continuous") {
    sample.collectorMode = value.collectorMode;
  }
  if (value.collectorHealth === "healthy" || value.collectorHealth === "degraded" || value.collectorHealth === "stopped") {
    sample.collectorHealth = value.collectorHealth;
  }
  if (nullableFiniteNumber(value.resourceActivityCount, 0, 10_000_000)) sample.resourceActivityCount = value.resourceActivityCount;
  if (finiteNumber(value.droppedPerformanceEntries, 0, 10_000_000)) sample.droppedPerformanceEntries = value.droppedPerformanceEntries;
  if (finiteNumber(value.sampleDurationMs, 0, 60_000)) sample.sampleDurationMs = value.sampleDurationMs;
  if (finiteNumber(value.mutationWorkDurationMs, 0, 60_000)) sample.mutationWorkDurationMs = value.mutationWorkDurationMs;
  if (nullableFiniteNumber(value.recountDurationMs, 0, 60_000)) sample.recountDurationMs = value.recountDurationMs;
  if (finiteNumber(value.sampledAtEpochMs, 0, 31_536_000_000_000)) sample.sampledAtEpochMs = value.sampledAtEpochMs;
  return sample;
}

const EXPECTED_CLASSES = new Set<TraceExpectedClass>(["retained-dom", "benign", "ambiguous", "unsupported"]);
const LIFECYCLE_TYPES = new Set<TraceLifecycleType>([
  "navigation",
  "route-change",
  "long-gap",
  "pagehide",
  "pageshow",
  "bfcache-restore"
]);

/** Strictly validates an imported trace and returns a normalized copy. */
export function parseDetectorTrace(value: unknown): DetectorTrace {
  if (!isRecord(value)) throw new DetectorTraceError("Detector trace must be a JSON object");
  assertOnlyKeys(value, ["traceFormatVersion", "traceId", "expectedClass", "redaction", "events"], "Detector trace");
  if (value.traceFormatVersion !== DETECTOR_TRACE_FORMAT_VERSION) {
    throw new DetectorTraceError(
      `Unsupported detector trace format ${String(value.traceFormatVersion)}; migrate it to version ${DETECTOR_TRACE_FORMAT_VERSION}`
    );
  }
  if (typeof value.traceId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.traceId)) {
    throw new DetectorTraceError("Detector trace has an invalid traceId");
  }
  if (!EXPECTED_CLASSES.has(value.expectedClass as TraceExpectedClass)) {
    throw new DetectorTraceError("Detector trace has an invalid expectedClass");
  }
  if (
    !isRecord(value.redaction) ||
    value.redaction.containsPageIdentifiers !== false ||
    (value.redaction.notes !== undefined &&
      (!Array.isArray(value.redaction.notes) ||
        value.redaction.notes.length > 50 ||
        !value.redaction.notes.every((note) => typeof note === "string" && note.length <= 200)))
  ) {
    throw new DetectorTraceError("Detector trace must declare that page identifiers were removed");
  }
  assertOnlyKeys(value.redaction, ["containsPageIdentifiers", "notes"], "Trace redaction metadata");
  if (!Array.isArray(value.events) || value.events.length === 0 || value.events.length > 10_000) {
    throw new DetectorTraceError("Detector trace must contain between 1 and 10,000 events");
  }

  const events: DetectorTrace["events"] = [];
  let lastSequence = -1;
  let lastDocumentAgeMs = -1;
  for (let index = 0; index < value.events.length; index += 1) {
    const event = value.events[index];
    if (!isRecord(event)) throw new DetectorTraceError(`Trace event ${index} must be an object`);
    if (event.kind === "sample") {
      assertOnlyKeys(event, ["kind", "sample"], `Trace event ${index}`);
      const sample = parseSample(event.sample, index);
      if (sample.sampleSequence <= lastSequence || sample.documentAgeMs < lastDocumentAgeMs) {
        throw new DetectorTraceError(`Trace sample ${index} is not strictly ordered within its evidence segment`);
      }
      events.push({ kind: "sample", sample });
      lastSequence = sample.sampleSequence;
      lastDocumentAgeMs = sample.documentAgeMs;
      continue;
    }
    if (
      event.kind === "lifecycle" &&
      LIFECYCLE_TYPES.has(event.type as TraceLifecycleType) &&
      finiteNumber(event.documentAgeMs, 0, 31_536_000_000)
    ) {
      assertOnlyKeys(event, ["kind", "type", "documentAgeMs"], `Trace event ${index}`);
      events.push({
        kind: "lifecycle",
        type: event.type as TraceLifecycleType,
        documentAgeMs: event.documentAgeMs
      });
      if (segmentsEvidence(event.type as TraceLifecycleType)) {
        lastSequence = -1;
        lastDocumentAgeMs = -1;
      }
      continue;
    }
    throw new DetectorTraceError(`Trace event ${index} has an invalid kind or lifecycle marker`);
  }

  return {
    traceFormatVersion: DETECTOR_TRACE_FORMAT_VERSION,
    traceId: value.traceId,
    expectedClass: value.expectedClass as TraceExpectedClass,
    redaction: {
      containsPageIdentifiers: false,
      ...(Array.isArray(value.redaction.notes) ? { notes: [...value.redaction.notes] as string[] } : {})
    },
    events
  };
}

function segmentsEvidence(type: TraceLifecycleType): boolean {
  return type === "navigation" || type === "route-change" || type === "long-gap" || type === "bfcache-restore";
}

export function replayDetectorTrace(traceInput: DetectorTrace | unknown, options: ReplayOptions): DetectorReplay {
  const trace = parseDetectorTrace(traceInput);
  const requestedWindow = options.maximumRecentSamples;
  const maximumRecentSamples = Math.min(
    64,
    Math.max(2, Number.isFinite(requestedWindow) ? Math.floor(requestedWindow as number) : 24)
  );
  const configuration = resolveDetectorConfiguration(options);
  const steps: DetectorReplay["steps"] = [];
  let samples: SampleSummary[] = [];
  let previous: DetectorEvaluation | undefined;
  let previousStatus: EvidenceDetectorStatus | null = null;
  let segment = 0;
  let sampleCount = 0;
  let maximumScore = 0;
  let everConfirmed = false;
  let everAutomaticEligible = false;
  let firstConfirmedDocumentAgeMs: number | null = null;

  trace.events.forEach((event, eventIndex) => {
    if (event.kind === "lifecycle") {
      const evidenceSegmented = segmentsEvidence(event.type);
      if (evidenceSegmented) {
        samples = [];
        previous = undefined;
        previousStatus = null;
        segment += 1;
      }
      steps.push({
        kind: "lifecycle",
        eventIndex,
        segment,
        lifecycle: event.type,
        documentAgeMs: event.documentAgeMs,
        evidenceSegmented
      });
      return;
    }

    sampleCount += 1;
    samples = [...samples, event.sample].slice(-maximumRecentSamples);
    const evaluation = evaluateSamples(samples, previous, {
      ...options,
      evaluatedAtDocumentAgeMs: event.sample.documentAgeMs
    });
    steps.push({
      kind: "sample",
      eventIndex,
      segment,
      sampleSequence: event.sample.sampleSequence,
      documentAgeMs: event.sample.documentAgeMs,
      transition: { from: previousStatus, to: evaluation.status },
      evaluation
    });
    maximumScore = Math.max(maximumScore, evaluation.score);
    everConfirmed ||= evaluation.status === "confirmed";
    everAutomaticEligible ||= evaluation.automaticEligible;
    if (firstConfirmedDocumentAgeMs === null && evaluation.status === "confirmed") {
      firstConfirmedDocumentAgeMs = event.sample.documentAgeMs;
    }
    previous = evaluation;
    previousStatus = evaluation.status;
  });

  const finalSampleStep = [...steps].reverse().find((step): step is SampleReplayStep => step.kind === "sample");
  return {
    traceFormatVersion: DETECTOR_TRACE_FORMAT_VERSION,
    traceId: trace.traceId,
    expectedClass: trace.expectedClass,
    modelVersion: DETECTOR_MODEL_VERSION,
    configurationVersion: configuration.configurationVersion,
    steps,
    summary: {
      sampleCount,
      segmentCount: segment + 1,
      finalStatus: finalSampleStep?.evaluation.status ?? null,
      maximumScore,
      everConfirmed,
      everAutomaticEligible,
      firstConfirmedDocumentAgeMs
    }
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = stableValue(value[key]);
  return sorted;
}

/** Canonical serialization for model-review diffs and reproducibility checks. */
export function serializeDetectorReplay(replay: DetectorReplay): string {
  return `${JSON.stringify(stableValue(replay), null, 2)}\n`;
}

/**
 * Produces stable corpus metrics for pull-request model deltas. Ambiguous and
 * unsupported traces are reported but intentionally excluded from the binary
 * confusion matrix.
 */
export function evaluateDetectorCorpus(
  traceInputs: readonly (DetectorTrace | unknown)[],
  options: ReplayOptions
): DetectorCorpusReport {
  const replays = traceInputs
    .map((trace) => replayDetectorTrace(trace, options))
    .sort((left, right) => left.traceId < right.traceId ? -1 : left.traceId > right.traceId ? 1 : 0);
  const traces = replays.map((replay) => ({
    traceId: replay.traceId,
    expectedClass: replay.expectedClass,
    confirmed: replay.summary.everConfirmed,
    automaticEligible: replay.summary.everAutomaticEligible,
    maximumScore: replay.summary.maximumScore,
    firstConfirmedDocumentAgeMs: replay.summary.firstConfirmedDocumentAgeMs
  }));
  let truePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  for (const trace of traces) {
    if (trace.expectedClass === "retained-dom") {
      if (trace.automaticEligible) truePositive += 1;
      else falseNegative += 1;
    } else if (trace.expectedClass === "benign") {
      if (trace.confirmed || trace.automaticEligible) falsePositive += 1;
      else trueNegative += 1;
    }
  }
  const positiveCount = truePositive + falseNegative;
  const negativeCount = trueNegative + falsePositive;
  const configuration = resolveDetectorConfiguration(options);
  return {
    modelVersion: DETECTOR_MODEL_VERSION,
    configurationVersion: configuration.configurationVersion,
    traces,
    confusion: {
      truePositive,
      falseNegative,
      trueNegative,
      falsePositive,
      recall: positiveCount > 0 ? truePositive / positiveCount : null,
      falsePositiveRate: negativeCount > 0 ? falsePositive / negativeCount : null
    }
  };
}
