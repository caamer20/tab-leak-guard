import { RECOVERY_TOKEN_TTL_MS, RESET_GRACE_MINUTES } from "../shared/constants";
import type {
  PreparedRecovery,
  RecoveryAction,
  RecoveryInitiator,
  TabRecord,
  TabSafety
} from "../shared/types";

export type PrepareRecoveryInput = {
  record: TabRecord;
  tab: browser.tabs.Tab;
  initiator: RecoveryInitiator;
  monitoringEpoch: number;
  permissionRevision?: number;
  now: number;
  operationId: string;
  nonce: string;
};

export type TransactionDecision =
  | { ok: true; operation: PreparedRecovery }
  | { ok: false; error: string };

export function prepareRecovery(input: PrepareRecoveryInput): TransactionDecision {
  const {
    record,
    tab,
    initiator,
    monitoringEpoch,
    permissionRevision = 0,
    now,
    operationId,
    nonce
  } = input;
  if (tab.id !== record.tabId || tab.windowId !== record.windowId) {
    return { ok: false, error: "Tab identity changed" };
  }
  if (record.monitoringEpoch !== monitoringEpoch) {
    return { ok: false, error: "Monitoring state changed" };
  }
  if (record.evidenceExpiresAt <= now) return { ok: false, error: "Detection evidence is stale" };
  if (record.cooldownUntil && record.cooldownUntil > now) {
    return { ok: false, error: "A previous recovery outcome is still in cooldown" };
  }
  if (record.snoozedUntil && record.snoozedUntil > now) {
    return { ok: false, error: "Recovery is snoozed for this tab" };
  }
  if (record.recovery.status === "executing" || record.recovery.status === "requested") {
    return { ok: false, error: "Another recovery operation is already running" };
  }
  if (initiator === "automatic" && !record.documentId) {
    return { ok: false, error: "Native document identity is unavailable" };
  }

  const action: RecoveryAction = tab.active ? "reload" : "discard";
  if (initiator === "automatic" && action !== "discard") {
    return { ok: false, error: "Automatic recovery never reloads an active tab" };
  }
  const warnings = warningsForSafety(record.safety, action);
  return {
    ok: true,
    operation: {
      operationId,
      nonce,
      tabId: record.tabId,
      windowId: record.windowId,
      hostname: record.hostname,
      documentId: record.documentId,
      documentInstanceId: record.documentInstanceId,
      recordRevision: record.revision,
      monitoringEpoch,
      permissionRevision,
      action,
      initiator,
      preparedAt: now,
      expiresAt:
        now +
        RECOVERY_TOKEN_TTL_MS +
        (initiator === "automatic" ? RESET_GRACE_MINUTES * 60_000 : 0),
      evidenceExpiresAt: record.evidenceExpiresAt,
      safetyFingerprint: safetyFingerprint(record.safety),
      warnings,
      acknowledgedUserEditRisk: false,
      state: initiator === "manual" ? "awaiting-consent" : "prepared"
    }
  };
}

export type ValidateExecutionInput = {
  operation: PreparedRecovery;
  record: TabRecord;
  tab: browser.tabs.Tab;
  monitoringEpoch: number;
  nonce: string;
  now: number;
  currentSafety: TabSafety;
  acknowledgeUserEditRisk: boolean;
};

export type ExecutionDecision =
  | { ok: true; action: RecoveryAction }
  | { ok: false; error: string; stateChanged?: boolean };

export function validateExecution(input: ValidateExecutionInput): ExecutionDecision {
  const { operation, record, tab, monitoringEpoch, nonce, now, currentSafety } = input;
  if (operation.state !== "prepared" && operation.state !== "awaiting-consent") {
    return { ok: false, error: "Recovery token has already been used" };
  }
  if (operation.nonce !== nonce) return { ok: false, error: "Recovery token is invalid" };
  if (operation.expiresAt <= now) return { ok: false, error: "Recovery confirmation expired" };
  if (operation.monitoringEpoch !== monitoringEpoch || record.monitoringEpoch !== monitoringEpoch) {
    return { ok: false, error: "Monitoring state changed", stateChanged: true };
  }
  if (operation.evidenceExpiresAt <= now || record.evidenceExpiresAt <= now) {
    return { ok: false, error: "Detection evidence is stale", stateChanged: true };
  }
  if (record.cooldownUntil && record.cooldownUntil > now) {
    return {
      ok: false,
      error: "A previous recovery outcome is still in cooldown",
      stateChanged: true
    };
  }
  if (record.snoozedUntil && record.snoozedUntil > now) {
    return {
      ok: false,
      error: "Recovery is snoozed for this tab",
      stateChanged: true
    };
  }
  if (
    operation.tabId !== record.tabId ||
    tab.id !== record.tabId ||
    operation.windowId !== record.windowId ||
    tab.windowId !== record.windowId
  ) {
    return { ok: false, error: "Tab identity changed", stateChanged: true };
  }
  if (
    operation.documentInstanceId !== record.documentInstanceId ||
    operation.documentId !== record.documentId
  ) {
    return { ok: false, error: "The tab navigated after recovery was prepared", stateChanged: true };
  }
  if (operation.recordRevision !== record.revision) {
    return { ok: false, error: "The finding changed after recovery was prepared", stateChanged: true };
  }
  const currentAction: RecoveryAction = tab.active ? "reload" : "discard";
  if (currentAction !== operation.action) {
    return {
      ok: false,
      error: `Tab state changed; ${operation.action} consent cannot authorize ${currentAction}`,
      stateChanged: true
    };
  }
  if (operation.initiator === "automatic" && currentAction !== "discard") {
    return { ok: false, error: "Automatic recovery never reloads an active tab", stateChanged: true };
  }
  const currentFingerprint = safetyFingerprint(currentSafety);
  if (currentFingerprint !== operation.safetyFingerprint) {
    return { ok: false, error: "Tab safety state changed; review the action again", stateChanged: true };
  }
  if (
    (currentSafety.userEditState === "edits-observed" ||
      currentSafety.userEditState === "unknown") &&
    !input.acknowledgeUserEditRisk
  ) {
    return {
      ok: false,
      error:
        currentSafety.userEditState === "edits-observed"
          ? "Edited input was observed; explicit confirmation is required"
          : "Edited-input state is unknown; explicit confirmation is required"
    };
  }
  return { ok: true, action: operation.action };
}

export function warningsForSafety(safety: TabSafety, action: RecoveryAction): string[] {
  const warnings = [
    action === "reload"
      ? "Reloading can lose page state that the website has not saved."
      : "Unloading keeps the tab in the tab strip and reloads it when selected."
  ];
  if (safety.userEditState === "edits-observed") {
    warnings.push("Edited input was observed in this document.");
  } else if (safety.userEditState === "unknown") {
    warnings.push("The extension cannot confirm whether this document contains edited input.");
  }
  if (!safety.safetyComplete) warnings.push("Some current tab safety signals are unavailable.");
  if (safety.active) warnings.push("This tab is currently active.");
  if (safety.pinned) warnings.push("This tab is pinned.");
  if (safety.audible) warnings.push("This tab is currently playing audio.");
  if (safety.attention) warnings.push("This tab is requesting your attention.");
  if (safety.sharingCamera || safety.sharingMicrophone || safety.sharingScreen) {
    warnings.push("This tab is currently sharing media or your screen.");
  }
  if (safety.fullscreen) warnings.push("The tab's browser window is fullscreen.");
  if (!safety.autoDiscardable && action === "discard") {
    warnings.push("Firefox marks this tab as protected from automatic unloading.");
  }
  return warnings;
}

export function safetyFingerprint(safety: TabSafety): string {
  return [
    safety.active,
    safety.highlighted,
    safety.audible,
    safety.pinned,
    safety.attention,
    safety.userEditState,
    safety.discarded,
    safety.loading,
    safety.recentlyAccessed,
    safety.autoDiscardable,
    safety.sharingCamera,
    safety.sharingMicrophone,
    safety.sharingScreen,
    safety.fullscreen,
    safety.safetyComplete
  ]
    .map(String)
    .join("|");
}

export function recoveryAlarmName(operation: PreparedRecovery): string {
  return `recovery:${operation.tabId}:${operation.operationId}`;
}

export function operationIdFromAlarm(name: string): string | null {
  const match = /^recovery:\d+:([a-f0-9-]{8,128})$/i.exec(name);
  return match?.[1] ?? null;
}
