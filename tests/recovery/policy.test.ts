import { describe, expect, it } from "vitest";
import { evaluateSafety, safetyFromTab } from "../../src/recovery/policy";
import type { ResetReceipt, TabSafety } from "../../src/shared/types";
import { autoPreferences, safeState, tabRecord } from "../helpers";
import { makeTab } from "../fakes/webextension";

describe("automatic recovery safety", () => {
  it("allows a confirmed, quiet, safe background tab", () => {
    expect(evaluateSafety(tabRecord(), safeState, autoPreferences, [], Date.now())).toEqual({ safe: true });
  });

  for (const [field, reason] of [
    ["active", "Tab is active"],
    ["pinned", "Pinned tabs are protected"],
    ["audible", "Audible tabs are protected"],
    ["attention", "Tab is requesting attention"],
    ["recentlyAccessed", "Tab was used recently"],
    ["loading", "Tab is loading"]
  ] as const) {
    it(`protects a tab when ${field} is true`, () => {
      const safety: TabSafety = { ...safeState, [field]: true };
      expect(evaluateSafety(tabRecord(), safety, autoPreferences, [], Date.now())).toEqual({ safe: false, reason });
    });
  }

  it("protects edited and unknown user state", () => {
    expect(
      evaluateSafety(
        tabRecord(),
        { ...safeState, dirty: true, userEditState: "edits-observed" },
        autoPreferences,
        [],
        Date.now()
      )
    ).toEqual({ safe: false, reason: "Edited input was observed" });
    expect(
      evaluateSafety(
        tabRecord(),
        { ...safeState, userEditState: "unknown" },
        autoPreferences,
        [],
        Date.now()
      )
    ).toEqual({ safe: false, reason: "Current edited-input state is unknown" });
  });

  it("requires explicit automatic mode", () => {
    expect(evaluateSafety(tabRecord(), safeState, { ...autoPreferences, recoveryMode: "notify" }, [], Date.now()).safe).toBe(false);
  });

  it("fails closed for either paused monitoring dimension", () => {
    const now = Date.now();
    expect(
      evaluateSafety(tabRecord(), safeState, { ...autoPreferences, monitoringEnabled: false }, [], now)
    ).toEqual({ safe: false, reason: "Monitoring is paused" });
    expect(
      evaluateSafety(
        tabRecord(),
        safeState,
        { ...autoPreferences, monitoringIntent: "manual" },
        [],
        now
      )
    ).toEqual({ safe: false, reason: "Monitoring is paused" });
  });

  it("opens a per-host circuit breaker", () => {
    const now = Date.now();
    const receipts: ResetReceipt[] = [0, 1].map((index) => ({
      id: String(index),
      tabId: index,
      hostname: "example.test",
      action: "discard",
      occurredAt: now - index * 1_000,
      reasonCodes: [],
      outcome: "success",
      message: "ok"
    }));
    expect(evaluateSafety(tabRecord(), safeState, autoPreferences, receipts, now)).toEqual({
      safe: false,
      reason: "Site reset circuit breaker is open"
    });
  });

  it("opens the global circuit breaker across distinct sites", () => {
    const now = Date.now();
    const receipts: ResetReceipt[] = Array.from({ length: 5 }, (_, index) => ({
      id: `global-${index}`,
      tabId: index,
      hostname: `site-${index}.test`,
      action: "discard",
      occurredAt: now - index * 1_000,
      reasonCodes: [],
      initiator: "automatic",
      phase: "completed",
      outcome: "success",
      message: "ok"
    }));
    expect(evaluateSafety(tabRecord(), safeState, autoPreferences, receipts, now)).toEqual({
      safe: false,
      reason: "Global reset circuit breaker is open"
    });
  });

  it.each([
    ["highlighted", true, "Highlighted tabs are protected"],
    ["discarded", true, "Tab is already discarded"],
    ["autoDiscardable", false, "Firefox marks this tab as non-auto-discardable"],
    ["sharingCamera", true, "Tab is using the camera"],
    ["sharingMicrophone", true, "Tab is using the microphone"],
    ["sharingScreen", true, "Tab is sharing the screen"],
    ["fullscreen", true, "Fullscreen tabs are protected"],
    ["safetyComplete", false, "Complete current safety state is unavailable"]
  ] as const)("protects the %s safety invariant", (field, value, reason) => {
    expect(
      evaluateSafety(tabRecord(), { ...safeState, [field]: value }, autoPreferences, [], Date.now())
    ).toEqual({ safe: false, reason });
  });

  it("requires build availability, permission, current epoch, and native document identity", () => {
    const now = Date.now();
    expect(
      evaluateSafety(tabRecord(), safeState, autoPreferences, [], now, {
        automaticRecoveryAvailable: false
      })
    ).toEqual({ safe: false, reason: "Automatic recovery is not available in this build" });
    expect(
      evaluateSafety(tabRecord(), safeState, autoPreferences, [], now, {
        permissionGranted: false
      })
    ).toEqual({ safe: false, reason: "Website access is not granted" });
    expect(
      evaluateSafety(tabRecord(), safeState, autoPreferences, [], now, {
        expectedMonitoringEpoch: 2
      })
    ).toEqual({ safe: false, reason: "Monitoring state changed" });
    expect(
      evaluateSafety(tabRecord({ documentId: null }), safeState, autoPreferences, [], now, {
        requireNativeDocumentId: true
      })
    ).toEqual({ safe: false, reason: "Native document identity is unavailable" });
  });

  it("requires explicit site allowlisting and visible warnings", () => {
    const now = Date.now();
    expect(
      evaluateSafety(
        tabRecord(),
        safeState,
        { ...autoPreferences, sitePolicies: [] },
        [],
        now
      )
    ).toEqual({ safe: false, reason: "Site is not allowlisted for automatic recovery" });
    expect(
      evaluateSafety(
        tabRecord(),
        safeState,
        { ...autoPreferences, notificationsEnabled: false },
        [],
        now
      )
    ).toEqual({ safe: false, reason: "Automatic recovery requires visible warnings" });
  });

  it("requires confirmed, eligible, fresh evidence above the configured threshold", () => {
    const now = Date.now();
    const ineligibleDetector = {
      ...tabRecord().detector,
      automaticEligible: false
    };
    expect(
      evaluateSafety(
        tabRecord({ detector: { ...tabRecord().detector, status: "suspected" } }),
        safeState,
        autoPreferences,
        [],
        now
      )
    ).toEqual({ safe: false, reason: "The leak pattern is not confirmed" });
    expect(
      evaluateSafety(
        tabRecord({ detector: { ...tabRecord().detector, score: 70 } }),
        safeState,
        autoPreferences,
        [],
        now
      )
    ).toEqual({ safe: false, reason: "Confidence fell below the action threshold" });
    expect(
      evaluateSafety(
        tabRecord({ detector: ineligibleDetector }),
        safeState,
        autoPreferences,
        [],
        now
      )
    ).toEqual({ safe: false, reason: "Evidence is not eligible for automatic recovery" });
    expect(
      evaluateSafety(
        tabRecord({ evidenceExpiresAt: now }),
        safeState,
        autoPreferences,
        [],
        now
      )
    ).toEqual({ safe: false, reason: "Detection evidence is stale" });
    expect(
      evaluateSafety(
        tabRecord({ updatedAt: now + 1 }),
        safeState,
        autoPreferences,
        [],
        now
      )
    ).toEqual({ safe: false, reason: "Detection evidence is stale" });

    const legacyDetector = { ...tabRecord().detector } as Record<string, unknown>;
    delete legacyDetector.automaticEligible;
    expect(
      evaluateSafety(
        tabRecord({ detector: legacyDetector as ReturnType<typeof tabRecord>["detector"] }),
        safeState,
        autoPreferences,
        [],
        now
      )
    ).toEqual({ safe: true });
  });

  it("persists snooze, cooldown, ignored-host, and document suppression gates", () => {
    const now = Date.now();
    expect(
      evaluateSafety(tabRecord({ snoozedUntil: now + 1 }), safeState, autoPreferences, [], now)
    ).toEqual({ safe: false, reason: "Tab is snoozed" });
    expect(
      evaluateSafety(tabRecord({ cooldownUntil: now + 1 }), safeState, autoPreferences, [], now)
    ).toEqual({ safe: false, reason: "Tab is in reset cooldown" });
    expect(
      evaluateSafety(
        tabRecord(),
        safeState,
        { ...autoPreferences, ignoredHosts: ["example.test"] },
        [],
        now
      )
    ).toEqual({ safe: false, reason: "Site is ignored" });
    expect(
      evaluateSafety(
        tabRecord({ recovery: { status: "suppressed", automaticSuppressedForDocument: true } }),
        safeState,
        autoPreferences,
        [],
        now
      )
    ).toEqual({ safe: false, reason: "Automatic recovery is suppressed for this document" });
  });

  it("does not count manual, cancelled, or expired actions against automatic circuit breakers", () => {
    const now = Date.now();
    const receipts: ResetReceipt[] = [
      { initiator: "manual", phase: "completed", outcome: "success" },
      { initiator: "automatic", phase: "cancelled", outcome: "cancelled" },
      { initiator: "automatic", phase: "expired", outcome: "expired" }
    ].map((value, index) => ({
      id: String(index),
      tabId: index,
      hostname: "example.test",
      action: "discard",
      occurredAt: now,
      reasonCodes: [],
      message: "no action",
      ...value
    } as ResetReceipt));
    expect(evaluateSafety(tabRecord(), safeState, autoPreferences, receipts, now)).toEqual({
      safe: true
    });
  });

  it("fails closed when Firefox omits mandatory live tab state", () => {
    const tab = makeTab();
    tab.audible = undefined;
    tab.attention = undefined;
    tab.autoDiscardable = undefined;
    tab.sharingState = undefined;
    const safety = safetyFromTab(tab, false, 5 * 60_000, Date.now(), {
      userEditState: "no-edits-observed",
      safetyComplete: true
    });
    expect(safety).toMatchObject({ safetyComplete: false, autoDiscardable: false });
  });

  it("uses conservative defaults when optional live-tab values are omitted", () => {
    const now = Date.now();
    const tab = makeTab({ lastAccessed: undefined, discarded: undefined });
    const safety = safetyFromTab(tab, false, 1, now);
    expect(safety).toMatchObject({
      userEditState: "unknown",
      dirty: false,
      discarded: false,
      recentlyAccessed: true,
      fullscreen: false,
      safetyComplete: true
    });
  });
});
