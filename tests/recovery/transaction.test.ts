import { describe, expect, it } from "vitest";
import {
  operationIdFromAlarm,
  prepareRecovery,
  recoveryAlarmName,
  safetyFingerprint,
  validateExecution,
  warningsForSafety
} from "../../src/recovery/transaction";
import type { PreparedRecovery, TabSafety } from "../../src/shared/types";
import { safeState, tabRecord } from "../helpers";
import { makeTab } from "../fakes/webextension";

const NOW = 1_800_000_000_000;
const OPERATION_ID = "12345678-1234-4234-8234-123456789abc";
const NONCE = "abcdefabcdefabcdefabcdefabcdefab";

function prepare(
  overrides: Partial<Parameters<typeof prepareRecovery>[0]> = {}
): PreparedRecovery {
  const record = tabRecord({
    updatedAt: NOW,
    evidenceExpiresAt: NOW + 120_000,
    monitoringEpoch: 7,
    safety: { ...safeState, evaluatedAt: NOW }
  });
  const decision = prepareRecovery({
    record,
    tab: makeTab({ id: 1, windowId: 1, active: false }),
    initiator: "manual",
    monitoringEpoch: 7,
    now: NOW,
    operationId: OPERATION_ID,
    nonce: NONCE,
    ...overrides
  });
  if (!decision.ok) throw new Error(decision.error);
  return decision.operation;
}

function validate(
  operation: PreparedRecovery,
  overrides: Partial<Parameters<typeof validateExecution>[0]> = {}
) {
  const record = tabRecord({
    updatedAt: NOW,
    evidenceExpiresAt: NOW + 120_000,
    monitoringEpoch: 7,
    safety: { ...safeState, evaluatedAt: NOW }
  });
  return validateExecution({
    operation,
    record,
    tab: makeTab({ id: 1, windowId: 1, active: false }),
    monitoringEpoch: 7,
    nonce: NONCE,
    now: NOW + 1,
    currentSafety: { ...safeState, evaluatedAt: NOW + 1 },
    acknowledgeUserEditRisk: false,
    ...overrides
  });
}

describe("two-phase recovery transaction", () => {
  it("binds consent to the exact discard action, document, revision, epoch, and safety state", () => {
    const operation = prepare();

    expect(operation).toMatchObject({
      action: "discard",
      documentId: "firefox-document-12345678",
      documentInstanceId: "document-12345678",
      recordRevision: 0,
      monitoringEpoch: 7,
      state: "awaiting-consent"
    });
    expect(validate(operation)).toEqual({ ok: true, action: "discard" });
  });

  it("never converts unload consent into a reload after an inactive-to-active race", () => {
    const operation = prepare();
    const result = validate(operation, {
      tab: makeTab({ id: 1, windowId: 1, active: true }),
      currentSafety: { ...safeState, active: true }
    });

    expect(result).toEqual({
      ok: false,
      error: "Tab state changed; discard consent cannot authorize reload",
      stateChanged: true
    });
  });

  it("rejects a nonce mismatch and an already-used operation", () => {
    expect(validate(prepare(), { nonce: "fedcbafedcbafedcbafedcbafedcbafe" })).toMatchObject({
      ok: false,
      error: "Recovery token is invalid"
    });
    expect(validate({ ...prepare(), state: "executing" })).toMatchObject({
      ok: false,
      error: "Recovery token has already been used"
    });
  });

  it("rejects expiration and stale detection evidence", () => {
    const operation = prepare();
    expect(validate(operation, { now: operation.expiresAt })).toMatchObject({
      ok: false,
      error: "Recovery confirmation expired"
    });
    expect(
      validate({ ...operation, evidenceExpiresAt: NOW + 30_000 }, {
        now: NOW + 30_001,
        record: tabRecord({
          evidenceExpiresAt: NOW + 30_000,
          monitoringEpoch: 7,
          safety: safeState
        })
      })
    ).toMatchObject({ ok: false, error: "Detection evidence is stale", stateChanged: true });
  });

  it("rejects navigation, record mutation, tab replacement, and epoch changes", () => {
    const operation = prepare();
    const cases = [
      validate(operation, {
        record: tabRecord({
          documentInstanceId: "different-document-123",
          monitoringEpoch: 7,
          evidenceExpiresAt: NOW + 120_000
        })
      }),
      validate(operation, {
        record: tabRecord({ revision: 1, monitoringEpoch: 7, evidenceExpiresAt: NOW + 120_000 })
      }),
      validate(operation, { tab: makeTab({ id: 1, windowId: 2 }) }),
      validate(operation, { monitoringEpoch: 8 })
    ];

    expect(cases.map((decision) => decision.ok)).toEqual([false, false, false, false]);
    expect(cases.every((decision) => !decision.ok && decision.stateChanged)).toBe(true);
  });

  it("requires explicit acknowledgement for observed or unknown edit state", () => {
    for (const userEditState of ["edits-observed", "unknown"] as const) {
      const safety: TabSafety = {
        ...safeState,
        dirty: userEditState === "edits-observed",
        userEditState
      };
      const operation = prepare({ record: tabRecord({ safety, monitoringEpoch: 7, evidenceExpiresAt: NOW + 120_000 }) });
      expect(validate(operation, { currentSafety: safety }).ok).toBe(false);
      expect(
        validate(operation, {
          currentSafety: safety,
          acknowledgeUserEditRisk: true,
          record: tabRecord({ safety, monitoringEpoch: 7, evidenceExpiresAt: NOW + 120_000 })
        })
      ).toEqual({ ok: true, action: "discard" });
    }
  });

  it.each([
    ["highlighted", true],
    ["audible", true],
    ["pinned", true],
    ["attention", true],
    ["loading", true],
    ["autoDiscardable", false],
    ["sharingCamera", true],
    ["sharingMicrophone", true],
    ["sharingScreen", true],
    ["fullscreen", true],
    ["safetyComplete", false]
  ] as const)("invalidates prepared authority when %s changes", (field, value) => {
    const operation = prepare();
    const changed = { ...safeState, [field]: value };
    expect(validate(operation, { currentSafety: changed })).toMatchObject({
      ok: false,
      error: "Tab safety state changed; review the action again",
      stateChanged: true
    });
  });

  it("prohibits automatic recovery without native identity or against an active tab", () => {
    const base = tabRecord({ monitoringEpoch: 7, evidenceExpiresAt: NOW + 120_000 });
    expect(
      prepareRecovery({
        record: { ...base, documentId: null },
        tab: makeTab({ active: false }),
        initiator: "automatic",
        monitoringEpoch: 7,
        now: NOW,
        operationId: OPERATION_ID,
        nonce: NONCE
      })
    ).toMatchObject({ ok: false, error: "Native document identity is unavailable" });
    expect(
      prepareRecovery({
        record: base,
        tab: makeTab({ active: true }),
        initiator: "automatic",
        monitoringEpoch: 7,
        now: NOW,
        operationId: OPERATION_ID,
        nonce: NONCE
      })
    ).toMatchObject({ ok: false, error: "Automatic recovery never reloads an active tab" });
  });

  it("prepares automatic authority only for the exact inactive discard with a grace-bound expiry", () => {
    const result = prepareRecovery({
      record: tabRecord({ monitoringEpoch: 7, evidenceExpiresAt: NOW + 300_000 }),
      tab: makeTab({ active: false }),
      initiator: "automatic",
      monitoringEpoch: 7,
      now: NOW,
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    expect(result).toMatchObject({
      ok: true,
      operation: { action: "discard", initiator: "automatic", state: "prepared" }
    });
    if (result.ok) expect(result.operation.expiresAt).toBe(NOW + 3 * 60_000);
  });

  it("refuses preparation after identity, epoch, evidence, or operation state changes", () => {
    const base = tabRecord({ monitoringEpoch: 7, evidenceExpiresAt: NOW + 120_000 });
    const input = {
      record: base,
      tab: makeTab({ id: 1, windowId: 1, active: false }),
      initiator: "manual" as const,
      monitoringEpoch: 7,
      now: NOW,
      operationId: OPERATION_ID,
      nonce: NONCE
    };
    expect(prepareRecovery({ ...input, tab: makeTab({ id: 2, windowId: 1 }) })).toEqual({
      ok: false,
      error: "Tab identity changed"
    });
    expect(prepareRecovery({ ...input, monitoringEpoch: 8 })).toEqual({
      ok: false,
      error: "Monitoring state changed"
    });
    expect(prepareRecovery({ ...input, record: { ...base, evidenceExpiresAt: NOW } })).toEqual({
      ok: false,
      error: "Detection evidence is stale"
    });
    for (const status of ["executing", "requested"] as const) {
      expect(
        prepareRecovery({ ...input, record: { ...base, recovery: { status } } })
      ).toEqual({ ok: false, error: "Another recovery operation is already running" });
    }
  });

  it("refuses preparation and execution while durable cooldown or snooze authority is active", () => {
    const base = tabRecord({ monitoringEpoch: 7, evidenceExpiresAt: NOW + 120_000 });
    const input = {
      record: base,
      tab: makeTab({ id: 1, windowId: 1, active: false }),
      initiator: "manual" as const,
      monitoringEpoch: 7,
      now: NOW,
      operationId: OPERATION_ID,
      nonce: NONCE
    };
    expect(
      prepareRecovery({ ...input, record: { ...base, cooldownUntil: NOW + 1 } })
    ).toEqual({ ok: false, error: "A previous recovery outcome is still in cooldown" });
    expect(
      prepareRecovery({ ...input, record: { ...base, snoozedUntil: NOW + 1 } })
    ).toEqual({ ok: false, error: "Recovery is snoozed for this tab" });

    const operation = prepare();
    expect(
      validate(operation, {
        record: { ...base, cooldownUntil: NOW + 2 }
      })
    ).toEqual({
      ok: false,
      error: "A previous recovery outcome is still in cooldown",
      stateChanged: true
    });
    expect(
      validate(operation, {
        record: { ...base, snoozedUntil: NOW + 2 }
      })
    ).toEqual({
      ok: false,
      error: "Recovery is snoozed for this tab",
      stateChanged: true
    });
  });

  it("defensively rejects a forged automatic reload operation during execution", () => {
    const operation = {
      ...prepare(),
      initiator: "automatic" as const,
      action: "reload" as const,
      safetyFingerprint: safetyFingerprint({ ...safeState, active: true })
    };
    expect(
      validate(operation, {
        tab: makeTab({ id: 1, windowId: 1, active: true }),
        currentSafety: { ...safeState, active: true }
      })
    ).toEqual({
      ok: false,
      error: "Automatic recovery never reloads an active tab",
      stateChanged: true
    });
  });

  it("generates actionable warnings without treating warnings as authorization", () => {
    const safety: TabSafety = {
      ...safeState,
      active: true,
      pinned: true,
      audible: true,
      userEditState: "unknown",
      safetyComplete: false
    };
    const warnings = warningsForSafety(safety, "reload");
    expect(warnings.join(" ")).toContain("lose page state");
    expect(warnings.join(" ")).toContain("cannot confirm");
    expect(warnings.join(" ")).toContain("currently active");
    expect(warnings.join(" ")).toContain("pinned");
    expect(safetyFingerprint(safety)).not.toBe(safetyFingerprint(safeState));
  });

  it("warns about sharing, fullscreen, attention, and non-auto-discardable tabs", () => {
    const warnings = warningsForSafety(
      {
        ...safeState,
        attention: true,
        sharingScreen: true,
        fullscreen: true,
        autoDiscardable: false
      },
      "discard"
    ).join(" ");
    expect(warnings).toContain("requesting your attention");
    expect(warnings).toContain("sharing media");
    expect(warnings).toContain("fullscreen");
    expect(warnings).toContain("protected from automatic unloading");
  });

  it("uses a namespaced, strictly parsed alarm identifier", () => {
    const operation = prepare();
    expect(recoveryAlarmName(operation)).toBe(`recovery:1:${OPERATION_ID}`);
    expect(operationIdFromAlarm(recoveryAlarmName(operation))).toBe(OPERATION_ID);
    expect(operationIdFromAlarm(`reset:1:${OPERATION_ID}`)).toBeNull();
    expect(operationIdFromAlarm("recovery:1:not-valid")).toBeNull();
  });
});
