import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../src/shared/constants";
import { isUiCommand, parseCollectorMessage } from "../../src/shared/validation";
import { sample } from "../helpers";

describe("collector message validation", () => {
  const valid = {
    protocolVersion: PROTOCOL_VERSION,
    type: "COLLECTOR_SAMPLE",
    sentAtMonotonicMs: 10,
    deliveryDeadlineEpochMs: Date.now() + 10_000,
    documentInstanceId: "document-12345678",
    collectorMode: "continuous",
    authorityToken: null,
    payload: sample({ collectorMode: "continuous" })
  };

  it("accepts a valid sample", () => {
    expect(parseCollectorMessage(valid)?.type).toBe("COLLECTOR_SAMPLE");
  });

  it("rejects wrong protocol, identifiers, and numeric ranges", () => {
    expect(parseCollectorMessage({ ...valid, protocolVersion: 999 })).toBeNull();
    expect(parseCollectorMessage({ ...valid, documentInstanceId: "short" })).toBeNull();
    expect(parseCollectorMessage({ ...valid, payload: sample({ liveDomNodes: -1 }) })).toBeNull();
    expect(parseCollectorMessage({ ...valid, payload: sample({ timerDriftMs: Number.NaN }) })).toBeNull();
  });

  it("rejects oversized input", () => {
    expect(parseCollectorMessage({ ...valid, junk: "x".repeat(9_000) })).toBeNull();
  });

  it("accepts bounded collector health fields and rejects malformed optional telemetry", () => {
    expect(
      parseCollectorMessage({
        ...valid,
        collectorMode: "manual",
        authorityToken: "87654321-4321-4321-8321-cba987654321",
        payload: sample({
          userEditState: "unknown",
          collectorMode: "manual",
          collectorHealth: "degraded",
          resourceActivityCount: null,
          droppedPerformanceEntries: 2,
          sampleDurationMs: 3.5,
          mutationWorkDurationMs: 1.2,
          recountDurationMs: null,
          sampledAtEpochMs: Date.now()
        })
      })
    ).not.toBeNull();
    expect(
      parseCollectorMessage({
        ...valid,
        payload: { ...sample(), collectorHealth: "perfect" }
      })
    ).toBeNull();
    expect(
      parseCollectorMessage({
        ...valid,
        payload: { ...sample(), droppedPerformanceEntries: -1 }
      })
    ).toBeNull();
  });

  it("binds protocol mode to its authority-token shape and payload mode", () => {
    expect(parseCollectorMessage({ ...valid, authorityToken: "unexpected-token-1234" })).toBeNull();
    expect(
      parseCollectorMessage({
        ...valid,
        collectorMode: "manual",
        authorityToken: null,
        payload: sample({ collectorMode: "manual" })
      })
    ).toBeNull();
    expect(
      parseCollectorMessage({
        ...valid,
        collectorMode: "manual",
        authorityToken: "87654321-4321-4321-8321-cba987654321",
        payload: sample({ collectorMode: "continuous" })
      })
    ).toBeNull();
  });

  it("rejects cyclic and non-serializable envelopes", () => {
    const cyclic: Record<string, unknown> = { ...valid };
    cyclic.self = cyclic;
    expect(parseCollectorMessage(cyclic)).toBeNull();
  });

  it("rejects non-record envelopes and samples with malformed or overbroad capabilities", () => {
    expect(parseCollectorMessage(null)).toBeNull();
    expect(parseCollectorMessage([])).toBeNull();
    expect(parseCollectorMessage({ ...valid, payload: null })).toBeNull();
    expect(
      parseCollectorMessage({
        ...valid,
        payload: { ...sample({ collectorMode: "continuous" }), capabilities: null }
      })
    ).toBeNull();
    expect(
      parseCollectorMessage({
        ...valid,
        payload: {
          ...sample({ collectorMode: "continuous" }),
          unexpectedCounter: 1
        }
      })
    ).toBeNull();
    expect(
      parseCollectorMessage({
        ...valid,
        payload: {
          ...sample({ collectorMode: "continuous" }),
          capabilities: {
            resourceObserver: true,
            longTasks: false,
            exactMemory: false,
            pageText: true
          }
        }
      })
    ).toBeNull();
  });
});

describe("UI command validation", () => {
  it("requires typed targets and payloads", () => {
    expect(isUiCommand({ type: "FOCUS_TAB", tabId: 4 })).toBe(true);
    expect(isUiCommand({ type: "FOCUS_TAB", tabId: "4" })).toBe(false);
    expect(isUiCommand({ type: "RESET_TAB" })).toBe(false);
    expect(isUiCommand({ type: "IGNORE_HOST", hostname: "example.test" })).toBe(true);
    expect(isUiCommand({ type: "UPDATE_PREFERENCES", patch: null })).toBe(false);
  });

  it("validates the complete two-phase recovery command family", () => {
    expect(isUiCommand({ type: "PREPARE_RECOVERY", tabId: 4 })).toBe(true);
    expect(
      isUiCommand({
        type: "EXECUTE_RECOVERY",
        operationId: "operation-123456",
        nonce: "1234567890123456",
        acknowledgeUserEditRisk: true
      })
    ).toBe(true);
    expect(
      isUiCommand({
        type: "EXECUTE_RECOVERY",
        operationId: "short",
        nonce: "short"
      })
    ).toBe(false);
    expect(isUiCommand({ type: "CANCEL_RECOVERY", operationId: "operation-123456" })).toBe(true);
    expect(isUiCommand({ type: "STOP_MONITORING_TAB", tabId: 4 })).toBe(true);
    expect(isUiCommand({ type: "DELETE_ALL_DATA" })).toBe(true);
    expect(isUiCommand({ type: "EXPORT_DIAGNOSTICS" })).toBe(true);
    expect(isUiCommand({ type: "RESET_TAB", tabId: 4, forceDirty: true })).toBe(false);
  });

  it("rejects unknown preference keys and invalid enum values before schema sanitization", () => {
    expect(
      isUiCommand({ type: "UPDATE_PREFERENCES", patch: { recoveryMode: "auto-safe" } })
    ).toBe(true);
    expect(
      isUiCommand({ type: "UPDATE_PREFERENCES", patch: { recoveryMode: "always" } })
    ).toBe(false);
    expect(
      isUiCommand({ type: "UPDATE_PREFERENCES", patch: { monitoringIntent: "continuous" } })
    ).toBe(true);
    expect(
      isUiCommand({ type: "UPDATE_PREFERENCES", patch: { hiddenAuthority: true } })
    ).toBe(false);
    expect(
      isUiCommand({ type: "UPDATE_PREFERENCES", patch: { historyRetentionHours: 1_000 } })
    ).toBe(false);
  });

  it("rejects oversized, cyclic, and non-record UI command envelopes", () => {
    expect(isUiCommand(null)).toBe(false);
    expect(isUiCommand([])).toBe(false);
    expect(isUiCommand({ type: "GET_SNAPSHOT", padding: "x".repeat(9_000) })).toBe(false);
    const cyclic: Record<string, unknown> = { type: "UPDATE_PREFERENCES" };
    cyclic.patch = cyclic;
    expect(isUiCommand(cyclic)).toBe(false);
  });

  it.each([
    [{ monitoringEnabled: "yes" }, "monitoringEnabled"],
    [{ monitoringIntent: "sometimes" }, "monitoringIntent"],
    [{ permissionMode: "origin" }, "permissionMode"],
    [{ selectedOrigins: "https://example.test/*" }, "selectedOrigins"],
    [{ automaticRecoveryAcknowledgementVersion: -1 }, "automaticRecoveryAcknowledgementVersion"],
    [{ notificationsEnabled: 1 }, "notificationsEnabled"],
    [{ notificationContent: "title" }, "notificationContent"],
    [{ ignoredHosts: "example.test" }, "ignoredHosts"],
    [{ sitePolicies: {} }, "sitePolicies"],
    [{ sampleVisibleSeconds: Number.POSITIVE_INFINITY }, "sampleVisibleSeconds"]
  ])("rejects a malformed $1 preference patch", (patch, _label) => {
    expect(isUiCommand({ type: "UPDATE_PREFERENCES", patch })).toBe(false);
  });
});
