import { describe, expect, it } from "vitest";
import {
  DETECTOR_TRACE_FORMAT_VERSION,
  DetectorTraceError,
  evaluateDetectorCorpus,
  parseDetectorTrace,
  replayDetectorTrace,
  serializeDetectorReplay,
  type DetectorTrace
} from "../../src/detector/replay";
import { sample } from "../helpers";

const options = { confirmationScore: 75, minimumSamples: 6, minimumDurationMs: 5 * 60_000 };

function retainedDomTrace(): DetectorTrace {
  return {
    traceFormatVersion: DETECTOR_TRACE_FORMAT_VERSION,
    traceId: "retained-dom-fast-v1",
    expectedClass: "retained-dom",
    redaction: { containsPageIdentifiers: false, notes: ["Synthetic primitive counters only"] },
    events: Array.from({ length: 10 }, (_, index) => ({
      kind: "sample" as const,
      sample: sample({
        sampleSequence: index,
        documentAgeMs: index * 60_000,
        liveDomNodes: 10_000 + index * 5_000,
        addedNodesSinceLast: index === 0 ? 0 : 6_000,
        removedNodesSinceLast: index === 0 ? 0 : 1_000,
        resourceActivityCount: 20 + index,
        collectorHealth: "healthy"
      })
    }))
  };
}

function stableTrace(expectedClass: DetectorTrace["expectedClass"] = "benign"): DetectorTrace {
  return {
    ...retainedDomTrace(),
    traceId: `stable-${expectedClass}-v1`,
    expectedClass,
    events: Array.from({ length: 10 }, (_, index) => ({
      kind: "sample" as const,
      sample: sample({
        sampleSequence: index,
        documentAgeMs: index * 60_000,
        liveDomNodes: 20_000,
        addedNodesSinceLast: 1_000,
        removedNodesSinceLast: 1_000,
        collectorHealth: "healthy"
      })
    }))
  };
}

function traceWithSample(sampleValue: unknown): unknown {
  return {
    ...retainedDomTrace(),
    events: [{ kind: "sample", sample: sampleValue }]
  };
}

function finalSampleStep(trace: DetectorTrace, maximumRecentSamples: number) {
  const replay = replayDetectorTrace(trace, { ...options, maximumRecentSamples });
  const step = replay.steps.at(-1);
  if (!step || step.kind !== "sample") throw new Error("fixture must end with a sample");
  return step;
}

describe("detector trace replay", () => {
  it("produces byte-for-byte deterministic model output", () => {
    const trace = retainedDomTrace();
    const first = serializeDetectorReplay(replayDetectorTrace(trace, options));
    const second = serializeDetectorReplay(replayDetectorTrace(structuredClone(trace), options));
    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
  });

  it("reports transitions, model metadata, and automatic eligibility", () => {
    const replay = replayDetectorTrace(retainedDomTrace(), options);
    expect(replay.modelVersion).toMatch(/^retained-dom-v2/);
    expect(replay.configurationVersion).toContain("balanced-v2");
    expect(replay.summary.everConfirmed).toBe(true);
    expect(replay.summary.everAutomaticEligible).toBe(true);
    expect(replay.summary.firstConfirmedDocumentAgeMs).toBe(7 * 60_000);
    const final = replay.steps.at(-1);
    expect(final?.kind).toBe("sample");
    if (final?.kind === "sample") {
      expect(final.evaluation.quality.level).toBe("high");
      expect(final.evaluation.reasonCodes).toContain("DOM_GROWTH");
      expect(final.transition.to).toBe("confirmed");
    }
  });

  it("never authorizes a resource-only trace", () => {
    const trace: DetectorTrace = {
      ...retainedDomTrace(),
      traceId: "resource-only-v1",
      expectedClass: "benign",
      events: Array.from({ length: 12 }, (_, index) => ({
        kind: "sample" as const,
        sample: sample({
          sampleSequence: index,
          documentAgeMs: index * 60_000,
          liveDomNodes: 20_000,
          addedNodesSinceLast: 1_000,
          removedNodesSinceLast: 1_000,
          resourceEntriesSeen: index * 100_000,
          resourceActivityCount: index * 100_000,
          timerDriftMs: 5_000,
          collectorHealth: "healthy"
        })
      }))
    };
    const replay = replayDetectorTrace(trace, options);
    expect(replay.summary.everConfirmed).toBe(false);
    expect(replay.summary.everAutomaticEligible).toBe(false);
  });

  it("creates deterministic confusion metrics while excluding ambiguous traces", () => {
    const benign: DetectorTrace = {
      ...retainedDomTrace(),
      traceId: "stable-v1",
      expectedClass: "benign",
      events: Array.from({ length: 10 }, (_, index) => ({
        kind: "sample" as const,
        sample: sample({
          sampleSequence: index,
          documentAgeMs: index * 60_000,
          liveDomNodes: 100_000 + (index % 2) * 10,
          addedNodesSinceLast: 1_000,
          removedNodesSinceLast: 1_000,
          collectorHealth: "healthy"
        })
      }))
    };
    const report = evaluateDetectorCorpus([benign, retainedDomTrace()], options);
    expect(report.traces.map((trace) => trace.traceId)).toEqual(["retained-dom-fast-v1", "stable-v1"]);
    expect(report.confusion).toEqual({
      truePositive: 1,
      falseNegative: 0,
      trueNegative: 1,
      falsePositive: 0,
      recall: 1,
      falsePositiveRate: 0
    });
  });

  it("segments evidence at lifecycle boundaries", () => {
    const trace = retainedDomTrace();
    trace.events = [
      ...trace.events.slice(0, 6),
      { kind: "lifecycle", type: "route-change", documentAgeMs: 360_001 },
      ...Array.from({ length: 3 }, (_, index) => ({
        kind: "sample" as const,
        sample: sample({
          sampleSequence: index,
          documentAgeMs: index * 60_000,
          liveDomNodes: 50_000 + index * 10_000,
          addedNodesSinceLast: 10_000,
          collectorHealth: "healthy"
        })
      }))
    ];
    const replay = replayDetectorTrace(trace, options);
    expect(replay.summary.segmentCount).toBe(2);
    expect(replay.summary.finalStatus).toBe("warmup");
    const lifecycle = replay.steps.find((step) => step.kind === "lifecycle");
    expect(lifecycle).toMatchObject({ evidenceSegmented: true, lifecycle: "route-change" });
  });

  it.each(["navigation", "route-change", "long-gap", "bfcache-restore"] as const)(
    "starts a fresh evidence segment after %s",
    (type) => {
      const trace = retainedDomTrace();
      trace.events = [
        trace.events[0]!,
        { kind: "lifecycle", type, documentAgeMs: 1 },
        {
          kind: "sample",
          sample: sample({ sampleSequence: 0, documentAgeMs: 0, collectorHealth: "healthy" })
        }
      ];

      const replay = replayDetectorTrace(trace, options);
      expect(replay.summary.segmentCount).toBe(2);
      expect(replay.steps[1]).toMatchObject({
        kind: "lifecycle",
        lifecycle: type,
        evidenceSegmented: true,
        segment: 1
      });
    }
  );

  it("preserves evidence across page visibility lifecycle markers", () => {
    const trace = retainedDomTrace();
    trace.events = [
      trace.events[0]!,
      { kind: "lifecycle", type: "pagehide", documentAgeMs: 1 },
      {
        kind: "sample",
        sample: sample({ sampleSequence: 1, documentAgeMs: 60_000, collectorHealth: "healthy" })
      },
      { kind: "lifecycle", type: "pageshow", documentAgeMs: 60_001 },
      {
        kind: "sample",
        sample: sample({ sampleSequence: 2, documentAgeMs: 120_000, collectorHealth: "healthy" })
      }
    ];

    const replay = replayDetectorTrace(trace, options);
    expect(replay.summary.segmentCount).toBe(1);
    expect(replay.steps.filter((step) => step.kind === "lifecycle")).toEqual([
      expect.objectContaining({ lifecycle: "pagehide", evidenceSegmented: false, segment: 0 }),
      expect.objectContaining({ lifecycle: "pageshow", evidenceSegmented: false, segment: 0 })
    ]);
    const final = replay.steps.at(-1);
    expect(final?.kind).toBe("sample");
    if (final?.kind === "sample") expect(final.evaluation.features.distinctSamples).toBe(3);
  });

  it("rejects incompatible, identifying, and unordered traces with migration guidance", () => {
    expect(() => parseDetectorTrace({ ...retainedDomTrace(), traceFormatVersion: 99 })).toThrow(/migrate.*version 1/i);
    expect(() => parseDetectorTrace({
      ...retainedDomTrace(),
      redaction: { containsPageIdentifiers: true }
    })).toThrow(DetectorTraceError);
    expect(() => parseDetectorTrace({
      ...retainedDomTrace(),
      hostname: "private.example"
    })).toThrow(/unsupported field hostname/i);

    const unordered = retainedDomTrace();
    const duplicate = unordered.events[0];
    if (duplicate) unordered.events.splice(1, 0, duplicate);
    expect(() => parseDetectorTrace(unordered)).toThrow(/strictly ordered/i);
  });

  it("rejects malformed trace metadata and signal-health fields", () => {
    const trace = retainedDomTrace();
    const firstEvent = trace.events[0];
    if (!firstEvent || firstEvent.kind !== "sample") throw new Error("fixture must start with a sample");
    const invalidInputs: unknown[] = [
      null,
      { ...trace, traceId: "contains spaces" },
      { ...trace, expectedClass: "certain-leak" },
      { ...trace, events: [] },
      { ...trace, redaction: { containsPageIdentifiers: false, notes: Array.from({ length: 51 }, () => "x") } },
      {
        ...trace,
        events: [{ ...firstEvent, sample: { ...firstEvent.sample, visibility: "prerender" } }]
      },
      {
        ...trace,
        events: [{ ...firstEvent, sample: { ...firstEvent.sample, collectorHealth: "perfect" } }]
      },
      {
        ...trace,
        events: [{
          ...firstEvent,
          sample: {
            ...firstEvent.sample,
            capabilities: { ...firstEvent.sample.capabilities, secretCapability: true }
          }
        }]
      },
      {
        ...trace,
        events: [{ kind: "lifecycle", type: "teleport", documentAgeMs: 0 }]
      }
    ];
    for (const input of invalidInputs) expect(() => parseDetectorTrace(input)).toThrow(DetectorTraceError);
  });

  it("normalizes every supported optional signal-health field", () => {
    const parsed = parseDetectorTrace(traceWithSample(sample({
      userEditState: "unknown",
      collectorMode: "manual",
      collectorHealth: "stopped",
      resourceActivityCount: null,
      droppedPerformanceEntries: 2,
      sampleDurationMs: 3.5,
      mutationWorkDurationMs: 1.25,
      recountDurationMs: null,
      sampledAtEpochMs: 123_456
    })));
    const event = parsed.events[0];
    expect(event?.kind).toBe("sample");
    if (event?.kind === "sample") {
      expect(event.sample).toMatchObject({
        userEditState: "unknown",
        collectorMode: "manual",
        collectorHealth: "stopped",
        resourceActivityCount: null,
        droppedPerformanceEntries: 2,
        sampleDurationMs: 3.5,
        mutationWorkDurationMs: 1.25,
        recountDurationMs: null,
        sampledAtEpochMs: 123_456
      });
    }
  });

  it.each([
    ["userEditState", "edited"],
    ["collectorMode", "background"],
    ["resourceActivityCount", -1],
    ["droppedPerformanceEntries", 10_000_001],
    ["sampleDurationMs", 60_001],
    ["mutationWorkDurationMs", Number.NaN],
    ["recountDurationMs", -1],
    ["sampledAtEpochMs", 31_536_000_000_001]
  ])("rejects malformed optional signal-health field %s", (field, invalidValue) => {
    expect(() => parseDetectorTrace(traceWithSample({
      ...sample(),
      [field]: invalidValue
    }))).toThrow(/invalid signal-health metadata/i);
  });

  it("rejects malformed samples at strict numeric and privacy boundaries", () => {
    const malformed: Array<[unknown, RegExp]> = [
      [null, /no sample object/i],
      [{ ...sample(), sampleSequence: 1.5 }, /invalid sampleSequence/i],
      [{ ...sample(), documentAgeMs: -1 }, /invalid documentAgeMs/i],
      [{ ...sample(), dirty: "false" }, /invalid primitive measurements/i],
      [{ ...sample(), capabilities: { resourceObserver: true, longTasks: false } }, /invalid capability flags/i],
      [{ ...sample(), pageUrl: "https:\/\/private.example\/account" }, /unsupported field pageUrl/i]
    ];

    for (const [sampleValue, message] of malformed) {
      expect(() => parseDetectorTrace(traceWithSample(sampleValue))).toThrow(message);
    }
    expect(() => parseDetectorTrace({ ...retainedDomTrace(), events: [null] })).toThrow(/must be an object/i);
  });

  it("enforces trace redaction and event-count import limits", () => {
    const trace = retainedDomTrace();
    expect(() => parseDetectorTrace({
      ...trace,
      redaction: { containsPageIdentifiers: false, notes: ["x".repeat(201)] }
    })).toThrow(/page identifiers were removed/i);
    expect(() => parseDetectorTrace({
      ...trace,
      redaction: { containsPageIdentifiers: false, sourceUrl: "private.example" }
    })).toThrow(/unsupported field sourceUrl/i);
    expect(() => parseDetectorTrace({
      ...trace,
      events: Array.from({ length: 10_001 }, () => null)
    })).toThrow(/between 1 and 10,000 events/i);
  });

  it("clamps replay windows to safe bounds and defaults non-finite requests", () => {
    const trace: DetectorTrace = {
      ...stableTrace(),
      traceId: "window-bounds-v1",
      events: Array.from({ length: 70 }, (_, index) => ({
        kind: "sample" as const,
        sample: sample({
          sampleSequence: index,
          documentAgeMs: index * 60_000,
          liveDomNodes: 20_000,
          collectorHealth: "healthy"
        })
      }))
    };

    expect(finalSampleStep(trace, -10).evaluation.features.distinctSamples).toBe(2);
    expect(finalSampleStep(trace, 1_000).evaluation.features.distinctSamples).toBe(64);
    expect(finalSampleStep(trace, Number.NaN).evaluation.features.distinctSamples).toBe(24);
  });

  it("returns a null final status for lifecycle-only traces", () => {
    const trace: DetectorTrace = {
      ...stableTrace("unsupported"),
      traceId: "lifecycle-only-v1",
      events: [{ kind: "lifecycle", type: "pagehide", documentAgeMs: 0 }]
    };
    expect(replayDetectorTrace(trace, options).summary).toMatchObject({
      sampleCount: 0,
      segmentCount: 1,
      finalStatus: null,
      maximumScore: 0,
      everConfirmed: false,
      everAutomaticEligible: false,
      firstConfirmedDocumentAgeMs: null
    });
  });

  it("counts false negatives and false positives without coercing empty corpus rates", () => {
    const falsePositive = { ...retainedDomTrace(), traceId: "false-positive-v1", expectedClass: "benign" as const };
    const report = evaluateDetectorCorpus([stableTrace("retained-dom"), falsePositive], options);
    expect(report.confusion).toEqual({
      truePositive: 0,
      falseNegative: 1,
      trueNegative: 0,
      falsePositive: 1,
      recall: 0,
      falsePositiveRate: 1
    });
    expect(evaluateDetectorCorpus([], options).confusion).toEqual({
      truePositive: 0,
      falseNegative: 0,
      trueNegative: 0,
      falsePositive: 0,
      recall: null,
      falsePositiveRate: null
    });
  });
});
