import {
  GLOBAL_CIRCUIT_MAX_RESETS,
  GLOBAL_CIRCUIT_WINDOW_MS,
  HOST_CIRCUIT_MAX_RESETS,
  HOST_CIRCUIT_WINDOW_MS
} from "../shared/constants";
import type { Preferences, ResetReceipt, TabRecord, TabSafety } from "../shared/types";

export type SafetyDecision = { safe: true } | { safe: false; reason: string };

export type SafetyContext = {
  automaticRecoveryAvailable?: boolean;
  permissionGranted?: boolean;
  expectedMonitoringEpoch?: number;
  requireNativeDocumentId?: boolean;
};

export function evaluateSafety(
  record: TabRecord,
  safety: TabSafety,
  preferences: Preferences,
  receipts: readonly ResetReceipt[],
  now: number,
  context: SafetyContext = {}
): SafetyDecision {
  if (context.automaticRecoveryAvailable === false) {
    return { safe: false, reason: "Automatic recovery is not available in this build" };
  }
  if (!preferences.monitoringEnabled || preferences.monitoringIntent !== "continuous") {
    return { safe: false, reason: "Monitoring is paused" };
  }
  if (context.permissionGranted === false) return { safe: false, reason: "Website access is not granted" };
  if (preferences.recoveryMode !== "auto-safe") return { safe: false, reason: "Automatic reset is disabled" };
  if (
    context.expectedMonitoringEpoch !== undefined &&
    record.monitoringEpoch !== context.expectedMonitoringEpoch
  ) {
    return { safe: false, reason: "Monitoring state changed" };
  }
  if (context.requireNativeDocumentId && !record.documentId) {
    return { safe: false, reason: "Native document identity is unavailable" };
  }
  const sitePolicy = preferences.sitePolicies.find((policy) => policy.hostname === record.hostname);
  if (sitePolicy?.automaticRecovery !== "allow") {
    return { safe: false, reason: "Site is not allowlisted for automatic recovery" };
  }
  if (!preferences.notificationsEnabled) {
    return { safe: false, reason: "Automatic recovery requires visible warnings" };
  }
  if (record.detector.status !== "confirmed") {
    return { safe: false, reason: "The leak pattern is not confirmed" };
  }
  if (record.detector.score < preferences.confirmationScore) return { safe: false, reason: "Confidence fell below the action threshold" };
  if ("automaticEligible" in record.detector && record.detector.automaticEligible !== true) {
    return { safe: false, reason: "Evidence is not eligible for automatic recovery" };
  }
  if (record.updatedAt > now || record.evidenceExpiresAt <= now) {
    return { safe: false, reason: "Detection evidence is stale" };
  }
  if (record.recovery.automaticSuppressedForDocument) {
    return { safe: false, reason: "Automatic recovery is suppressed for this document" };
  }
  if (!safety.safetyComplete) return { safe: false, reason: "Complete current safety state is unavailable" };
  if (safety.active) return { safe: false, reason: "Tab is active" };
  if (safety.highlighted) return { safe: false, reason: "Highlighted tabs are protected" };
  if (safety.pinned) return { safe: false, reason: "Pinned tabs are protected" };
  if (safety.audible) return { safe: false, reason: "Audible tabs are protected" };
  if (safety.attention) return { safe: false, reason: "Tab is requesting attention" };
  if (safety.userEditState !== "no-edits-observed") {
    return {
      safe: false,
      reason:
        safety.userEditState === "edits-observed"
          ? "Edited input was observed"
          : "Current edited-input state is unknown"
    };
  }
  if (safety.discarded) return { safe: false, reason: "Tab is already discarded" };
  if (safety.loading) return { safe: false, reason: "Tab is loading" };
  if (safety.recentlyAccessed) return { safe: false, reason: "Tab was used recently" };
  if (!safety.autoDiscardable) return { safe: false, reason: "Firefox marks this tab as non-auto-discardable" };
  if (safety.sharingCamera) return { safe: false, reason: "Tab is using the camera" };
  if (safety.sharingMicrophone) return { safe: false, reason: "Tab is using the microphone" };
  if (safety.sharingScreen) return { safe: false, reason: "Tab is sharing the screen" };
  if (safety.fullscreen) return { safe: false, reason: "Fullscreen tabs are protected" };
  if (record.snoozedUntil && record.snoozedUntil > now) return { safe: false, reason: "Tab is snoozed" };
  if (record.cooldownUntil && record.cooldownUntil > now) return { safe: false, reason: "Tab is in reset cooldown" };
  if (preferences.ignoredHosts.includes(record.hostname)) return { safe: false, reason: "Site is ignored" };

  const automaticAttempts = receipts.filter(
    (receipt) => receipt.initiator !== "manual" && receipt.phase !== "cancelled" && receipt.phase !== "expired"
  );
  const recentForHost = automaticAttempts.filter(
    (receipt) => receipt.hostname === record.hostname && now - receipt.occurredAt <= HOST_CIRCUIT_WINDOW_MS
  );
  if (recentForHost.length >= HOST_CIRCUIT_MAX_RESETS) {
    return { safe: false, reason: "Site reset circuit breaker is open" };
  }
  const recentGlobal = automaticAttempts.filter((receipt) => now - receipt.occurredAt <= GLOBAL_CIRCUIT_WINDOW_MS);
  if (recentGlobal.length >= GLOBAL_CIRCUIT_MAX_RESETS) {
    return { safe: false, reason: "Global reset circuit breaker is open" };
  }
  return { safe: true };
}

export function safetyFromTab(
  tab: browser.tabs.Tab,
  dirty: boolean,
  quietPeriodMs: number,
  now: number,
  options: {
    userEditState?: TabSafety["userEditState"];
    fullscreen?: boolean;
    safetyComplete?: boolean;
  } = {}
): TabSafety {
  const lastAccessed = tab.lastAccessed ?? now;
  const sharing = tab.sharingState;
  const userEditState = options.userEditState ?? (dirty ? "edits-observed" : "unknown");
  const mandatoryPropertiesAvailable =
    tab.audible !== undefined &&
    tab.attention !== undefined &&
    tab.status !== undefined &&
    tab.autoDiscardable !== undefined &&
    sharing !== undefined;
  return {
    active: tab.active,
    highlighted: tab.highlighted,
    audible: tab.audible ?? false,
    pinned: tab.pinned,
    attention: tab.attention ?? false,
    dirty: userEditState === "edits-observed",
    userEditState,
    discarded: tab.discarded ?? false,
    loading: tab.status === "loading",
    recentlyAccessed: now - lastAccessed < quietPeriodMs,
    autoDiscardable: tab.autoDiscardable === true,
    sharingCamera: sharing?.camera === true,
    sharingMicrophone: sharing?.microphone === true,
    sharingScreen: Boolean(sharing?.screen),
    fullscreen: options.fullscreen ?? false,
    safetyComplete: mandatoryPropertiesAvailable && (options.safetyComplete ?? true),
    evaluatedAt: now
  };
}
