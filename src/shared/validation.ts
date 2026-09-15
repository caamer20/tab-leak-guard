import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from "./constants";
import type { CollectorMessage, Preferences, SampleSummary, UiCommand } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function isSampleSummary(value: unknown): value is SampleSummary {
  if (!isRecord(value) || !isRecord(value.capabilities)) return false;
  if (
    !hasOnlyKeys(value, [
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
    ]) ||
    !hasOnlyKeys(value.capabilities, ["resourceObserver", "longTasks", "exactMemory"])
  ) return false;
  const nullableNumber = (candidate: unknown, max: number) =>
    candidate === null || isFiniteNumber(candidate, 0, max);
  const validOptionalNumber = (key: string, max: number) =>
    value[key] === undefined || isFiniteNumber(value[key], 0, max);
  return (
    isFiniteNumber(value.sampleSequence, 0, 10_000_000) &&
    isFiniteNumber(value.documentAgeMs, 0, 31_536_000_000) &&
    (value.visibility === "visible" || value.visibility === "hidden") &&
    nullableNumber(value.liveDomNodes, 100_000_000) &&
    isFiniteNumber(value.addedNodesSinceLast, 0, 100_000_000) &&
    isFiniteNumber(value.removedNodesSinceLast, 0, 100_000_000) &&
    nullableNumber(value.resourceEntriesSeen, 10_000_000) &&
    nullableNumber(value.timerDriftMs, 3_600_000) &&
    typeof value.dirty === "boolean" &&
    typeof value.overflowed === "boolean" &&
    typeof value.capabilities.resourceObserver === "boolean" &&
    typeof value.capabilities.longTasks === "boolean" &&
    typeof value.capabilities.exactMemory === "boolean" &&
    (value.userEditState === undefined ||
      value.userEditState === "no-edits-observed" ||
      value.userEditState === "edits-observed" ||
      value.userEditState === "unknown") &&
    (value.collectorMode === undefined || value.collectorMode === "manual" || value.collectorMode === "continuous") &&
    (value.collectorHealth === undefined ||
      value.collectorHealth === "healthy" ||
      value.collectorHealth === "degraded" ||
      value.collectorHealth === "stopped") &&
    (value.resourceActivityCount === undefined ||
      value.resourceActivityCount === null ||
      isFiniteNumber(value.resourceActivityCount, 0, 10_000_000)) &&
    validOptionalNumber("droppedPerformanceEntries", 10_000_000) &&
    validOptionalNumber("sampleDurationMs", 60_000) &&
    validOptionalNumber("mutationWorkDurationMs", 60_000) &&
    (value.recountDurationMs === undefined ||
      value.recountDurationMs === null ||
      isFiniteNumber(value.recountDurationMs, 0, 60_000)) &&
    validOptionalNumber("sampledAtEpochMs", 31_536_000_000_000)
  );
}

export function parseCollectorMessage(value: unknown): CollectorMessage | null {
  try {
    if (JSON.stringify(value).length > MAX_MESSAGE_BYTES) return null;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      "protocolVersion",
      "type",
      "sentAtMonotonicMs",
      "deliveryDeadlineEpochMs",
      "documentInstanceId",
      "collectorMode",
      "authorityToken",
      "payload"
    ]) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    typeof value.documentInstanceId !== "string" ||
    value.documentInstanceId.length < 8 ||
    value.documentInstanceId.length > 128 ||
    (value.collectorMode !== "manual" && value.collectorMode !== "continuous") ||
    !(value.authorityToken === null || boundedString(value.authorityToken, 16, 128)) ||
    (value.collectorMode === "manual" && value.authorityToken === null) ||
    (value.collectorMode === "continuous" && value.authorityToken !== null) ||
    !isFiniteNumber(value.sentAtMonotonicMs, 0, Number.MAX_SAFE_INTEGER) ||
    !isFiniteNumber(value.deliveryDeadlineEpochMs, 0, 31_536_000_000_000)
  ) {
    return null;
  }
  if (
    value.type === "COLLECTOR_SAMPLE" &&
    isSampleSummary(value.payload) &&
    value.payload.collectorMode === value.collectorMode
  ) {
    return value as unknown as CollectorMessage;
  }
  if (
    value.type === "COLLECTOR_HELLO" &&
    isRecord(value.payload) &&
    hasOnlyKeys(value.payload, ["hostname"]) &&
    typeof value.payload.hostname === "string" &&
    value.payload.hostname.length <= 253
  ) {
    return value as unknown as CollectorMessage;
  }
  return null;
}

const UI_COMMANDS = new Set([
  "GET_SNAPSHOT",
  "SCAN_ACTIVE_TAB",
  "SYNC_PERMISSION",
  "FOCUS_TAB",
  "PREPARE_RECOVERY",
  "EXECUTE_RECOVERY",
  "CANCEL_RECOVERY",
  "STOP_MONITORING_TAB",
  "SNOOZE_TAB",
  "IGNORE_HOST",
  "UNIGNORE_HOST",
  "UPDATE_PREFERENCES",
  "CLEAR_RECEIPTS",
  "DELETE_ALL_DATA",
  "EXPORT_DIAGNOSTICS"
]);

export function isUiCommand(value: unknown): value is UiCommand {
  try {
    if (JSON.stringify(value).length > MAX_MESSAGE_BYTES) return false;
  } catch {
    return false;
  }
  if (!isRecord(value) || typeof value.type !== "string" || !UI_COMMANDS.has(value.type)) return false;
  if ([
    "GET_SNAPSHOT",
    "SCAN_ACTIVE_TAB",
    "SYNC_PERMISSION",
    "CLEAR_RECEIPTS",
    "DELETE_ALL_DATA",
    "EXPORT_DIAGNOSTICS"
  ].includes(value.type)) {
    return hasOnlyKeys(value, ["type"]);
  }
  if (["FOCUS_TAB", "SNOOZE_TAB", "PREPARE_RECOVERY", "STOP_MONITORING_TAB"].includes(value.type)) {
    return hasOnlyKeys(value, ["type", "tabId"]) && Number.isInteger(value.tabId) && (value.tabId as number) >= 0;
  }
  if (value.type === "EXECUTE_RECOVERY") {
    return (
      hasOnlyKeys(value, ["type", "operationId", "nonce", "acknowledgeUserEditRisk"]) &&
      boundedString(value.operationId, 8, 128) &&
      boundedString(value.nonce, 16, 256) &&
      (value.acknowledgeUserEditRisk === undefined || typeof value.acknowledgeUserEditRisk === "boolean")
    );
  }
  if (value.type === "CANCEL_RECOVERY") {
    return hasOnlyKeys(value, ["type", "operationId"]) && boundedString(value.operationId, 8, 128);
  }
  if (value.type === "IGNORE_HOST" || value.type === "UNIGNORE_HOST") {
    return hasOnlyKeys(value, ["type", "hostname"]) && typeof value.hostname === "string" && value.hostname.length <= 253;
  }
  if (value.type === "UPDATE_PREFERENCES") {
    return hasOnlyKeys(value, ["type", "patch"]) && isPreferencePatch(value.patch);
  }
  return false;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

const PREFERENCE_KEYS = new Set<keyof Preferences>([
  "monitoringEnabled",
  "monitoringIntent",
  "permissionMode",
  "selectedOrigins",
  "recoveryMode",
  "automaticRecoveryAcknowledgementVersion",
  "notificationsEnabled",
  "notificationContent",
  "historyRetentionHours",
  "ignoredHosts",
  "sitePolicies",
  "sampleVisibleSeconds",
  "sampleHiddenSeconds",
  "quietPeriodMinutes",
  "confirmationScore"
]);

function isPreferencePatch(value: unknown): value is Partial<Preferences> {
  if (!isRecord(value) || Object.keys(value).some((key) => !PREFERENCE_KEYS.has(key as keyof Preferences))) return false;
  if (value.monitoringEnabled !== undefined && typeof value.monitoringEnabled !== "boolean") return false;
  if (
    value.monitoringIntent !== undefined &&
    !["paused", "manual", "continuous"].includes(String(value.monitoringIntent))
  ) return false;
  if (
    value.permissionMode !== undefined &&
    !["manual", "selected-sites", "all-sites"].includes(String(value.permissionMode))
  ) return false;
  if (value.selectedOrigins !== undefined && !Array.isArray(value.selectedOrigins)) return false;
  if (value.recoveryMode !== undefined && !["notify", "auto-safe"].includes(String(value.recoveryMode))) return false;
  if (
    value.automaticRecoveryAcknowledgementVersion !== undefined &&
    !isFiniteNumber(value.automaticRecoveryAcknowledgementVersion, 0, 100)
  ) return false;
  if (value.notificationsEnabled !== undefined && typeof value.notificationsEnabled !== "boolean") return false;
  if (value.notificationContent !== undefined && !["generic", "site"].includes(String(value.notificationContent))) {
    return false;
  }
  if (value.historyRetentionHours !== undefined && ![0, 24, 168].includes(Number(value.historyRetentionHours))) {
    return false;
  }
  if (value.ignoredHosts !== undefined && !Array.isArray(value.ignoredHosts)) return false;
  if (value.sitePolicies !== undefined && !Array.isArray(value.sitePolicies)) return false;
  for (const key of ["sampleVisibleSeconds", "sampleHiddenSeconds", "quietPeriodMinutes", "confirmationScore"]) {
    const candidate = value[key];
    if (candidate !== undefined && !isFiniteNumber(candidate, 0, 10_000)) return false;
  }
  return true;
}
