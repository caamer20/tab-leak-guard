import {
  AUTOMATIC_RECOVERY_AVAILABLE,
  MAX_RECOVERY_OPERATIONS,
  MAX_RESET_RECEIPTS
} from "./constants";
import {
  DEFAULT_PREFERENCES,
  type HistoryRetentionHours,
  type NotificationContent,
  type PermissionMode,
  type Preferences,
  type PreparedRecovery,
  type ResetReceipt,
  type SitePolicy
} from "./types";
import { normalizeHostname } from "./url-policy";
import { isFiniteNumber, isRecord } from "./validation";

const MAX_HOSTS = 500;
const MAX_STRING = 512;
const MAX_STORAGE_CANDIDATES = 2_000;

export function sanitizePreferences(value: unknown): Preferences {
  const candidate = isRecord(value) ? value : {};
  const legacyEnabled = candidate.monitoringEnabled === true;
  const monitoringIntent =
    candidate.monitoringIntent === "paused" ||
    candidate.monitoringIntent === "manual" ||
    candidate.monitoringIntent === "continuous"
      ? candidate.monitoringIntent
      : legacyEnabled
        ? "continuous"
        : DEFAULT_PREFERENCES.monitoringIntent;
  const permissionMode = enumValue<PermissionMode>(
    candidate.permissionMode,
    ["manual", "selected-sites", "all-sites"],
    legacyEnabled ? "all-sites" : DEFAULT_PREFERENCES.permissionMode
  );
  const recoveryMode =
    AUTOMATIC_RECOVERY_AVAILABLE && candidate.recoveryMode === "auto-safe" ? "auto-safe" : "notify";

  return {
    monitoringEnabled: monitoringIntent === "continuous" && candidate.monitoringEnabled === true,
    monitoringIntent,
    permissionMode,
    selectedOrigins: sanitizeOrigins(candidate.selectedOrigins),
    recoveryMode,
    automaticRecoveryAcknowledgementVersion: integer(
      candidate.automaticRecoveryAcknowledgementVersion,
      0,
      100,
      0
    ),
    notificationsEnabled:
      typeof candidate.notificationsEnabled === "boolean"
        ? candidate.notificationsEnabled
        : DEFAULT_PREFERENCES.notificationsEnabled,
    notificationContent: enumValue<NotificationContent>(
      candidate.notificationContent,
      ["generic", "site"],
      DEFAULT_PREFERENCES.notificationContent
    ),
    historyRetentionHours: enumValue<HistoryRetentionHours>(
      candidate.historyRetentionHours,
      [0, 24, 168],
      DEFAULT_PREFERENCES.historyRetentionHours
    ),
    ignoredHosts: sanitizeHosts(candidate.ignoredHosts),
    sitePolicies: sanitizeSitePolicies(candidate.sitePolicies),
    sampleVisibleSeconds: bounded(
      candidate.sampleVisibleSeconds,
      10,
      300,
      DEFAULT_PREFERENCES.sampleVisibleSeconds
    ),
    sampleHiddenSeconds: bounded(
      candidate.sampleHiddenSeconds,
      30,
      900,
      DEFAULT_PREFERENCES.sampleHiddenSeconds
    ),
    quietPeriodMinutes: bounded(
      candidate.quietPeriodMinutes,
      1,
      60,
      DEFAULT_PREFERENCES.quietPeriodMinutes
    ),
    confirmationScore: bounded(
      candidate.confirmationScore,
      70,
      95,
      DEFAULT_PREFERENCES.confirmationScore
    )
  };
}

export function sanitizeReceipts(value: unknown, now = Date.now(), retentionHours = 24): ResetReceipt[] {
  if (!Array.isArray(value) || retentionHours === 0) return [];
  const cutoff = retentionHours > 0 ? now - retentionHours * 60 * 60_000 : Number.NEGATIVE_INFINITY;
  const receipts: ResetReceipt[] = [];
  for (const candidate of value.slice(0, MAX_STORAGE_CANDIDATES)) {
    const receipt = decodeReceipt(candidate);
    if (receipt && receipt.occurredAt >= cutoff) receipts.push(receipt);
    if (receipts.length >= MAX_RESET_RECEIPTS) break;
  }
  return receipts.sort((a, b) => b.occurredAt - a.occurredAt);
}

export function decodePreparedRecovery(value: unknown, now = Date.now()): PreparedRecovery | null {
  if (!isRecord(value)) return null;
  // Pre-0.1.1 issued journals do not carry a permission revision. Decode
  // those as revision zero so migration can preserve and reconcile them to an
  // unknown outcome; they are never restored as authority to issue an action.
  const permissionRevision = value.permissionRevision === undefined
    ? 0
    : value.permissionRevision;
  const action = value.action === "discard" || value.action === "reload" ? value.action : null;
  const initiator = value.initiator === "manual" || value.initiator === "automatic" ? value.initiator : null;
  const state = ["prepared", "awaiting-consent", "executing", "requested", "terminal"].includes(
    String(value.state)
  )
    ? (value.state as PreparedRecovery["state"])
    : null;
  if (
    !boundedString(value.operationId, 8, 128) ||
    !boundedString(value.nonce, 16, 256) ||
    !Number.isInteger(value.tabId) ||
    (value.tabId as number) < 0 ||
    !Number.isInteger(value.windowId) ||
    !boundedString(value.documentInstanceId, 8, 128) ||
    !(value.documentId === null || boundedString(value.documentId, 8, 128)) ||
    !Number.isInteger(value.recordRevision) ||
    !Number.isInteger(value.monitoringEpoch) ||
    !Number.isInteger(permissionRevision) ||
    (permissionRevision as number) < 0 ||
    !action ||
    !initiator ||
    !isFiniteNumber(value.preparedAt, 0) ||
    !isFiniteNumber(value.expiresAt, 0) ||
    !isFiniteNumber(value.evidenceExpiresAt, 0) ||
    !boundedString(value.safetyFingerprint, 8, 512) ||
    !Array.isArray(value.warnings) ||
    typeof value.acknowledgedUserEditRisk !== "boolean" ||
    !state
  ) {
    return null;
  }
  if (value.expiresAt < value.preparedAt) return null;
  if (
    value.expiresAt <= now &&
    state !== "executing" &&
    state !== "requested" &&
    state !== "terminal"
  ) return null;
  const hostname = typeof value.hostname === "string" ? normalizeHostname(value.hostname) : null;
  return {
    operationId: value.operationId,
    nonce: value.nonce,
    tabId: value.tabId as number,
    windowId: value.windowId as number,
    ...(hostname ? { hostname } : {}),
    documentId: value.documentId,
    documentInstanceId: value.documentInstanceId,
    recordRevision: value.recordRevision as number,
    monitoringEpoch: value.monitoringEpoch as number,
    permissionRevision: permissionRevision as number,
    action,
    initiator,
    preparedAt: value.preparedAt,
    expiresAt: value.expiresAt,
    evidenceExpiresAt: value.evidenceExpiresAt,
    safetyFingerprint: value.safetyFingerprint,
    warnings: value.warnings
      .slice(0, 100)
      .filter((warning): warning is string => typeof warning === "string")
      .map((warning) => warning.slice(0, MAX_STRING))
      .slice(0, 20),
    acknowledgedUserEditRisk: value.acknowledgedUserEditRisk,
    state,
    ...(isFiniteNumber(value.requestedAt, 0) ? { requestedAt: value.requestedAt } : {})
  };
}

export function sanitizePreparedRecoveries(value: unknown, now = Date.now()): PreparedRecovery[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_STORAGE_CANDIDATES)
    .map((candidate) => decodePreparedRecovery(candidate, now))
    .filter((candidate): candidate is PreparedRecovery => candidate !== null)
    .slice(0, MAX_RECOVERY_OPERATIONS);
}

export function normalizeSelectedOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_STRING) return null;
  const match = /^(https?):\/\/([^/]+)\/\*$/.exec(value.trim());
  if (!match) return null;
  // Firefox WebExtension match patterns do not accept ports (including an
  // explicitly written default port). IPv6 literals are conservatively left
  // to one-tab manual monitoring rather than broadening their scope.
  if (match[2]?.includes(":")) return null;
  try {
    const parsed = new URL(`${match[1]}://${match[2]}/`);
    if (
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      parsed.hostname.includes("*") ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    ) return null;
    return `${parsed.protocol}//${parsed.host.toLowerCase()}/*`;
  } catch {
    return null;
  }
}

function sanitizeOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const origins = value
    .slice(0, MAX_STORAGE_CANDIDATES)
    .map(normalizeSelectedOrigin)
    .filter((origin): origin is string => origin !== null);
  return [...new Set(origins)].sort().slice(0, MAX_HOSTS);
}

function sanitizeHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hosts = value
    .slice(0, MAX_STORAGE_CANDIDATES)
    .filter((host): host is string => typeof host === "string")
    .map(normalizeHostname)
    .filter((host): host is string => host !== null);
  return [...new Set(hosts)].sort().slice(0, MAX_HOSTS);
}

function sanitizeSitePolicies(value: unknown): SitePolicy[] {
  if (!Array.isArray(value)) return [];
  const policies = new Map<string, SitePolicy>();
  for (const candidate of value.slice(0, MAX_STORAGE_CANDIDATES)) {
    if (!isRecord(candidate) || typeof candidate.hostname !== "string") continue;
    const hostname = normalizeHostname(candidate.hostname);
    if (!hostname) continue;
    const monitoring = enumValue(candidate.monitoring, ["inherit", "off", "monitor"] as const, "inherit");
    const notifications = enumValue(candidate.notifications, ["inherit", "off", "on"] as const, "inherit");
    const automaticRecovery = enumValue(
      candidate.automaticRecovery,
      ["inherit", "never", "allow"] as const,
      "never"
    );
    const pausedUntil = isFiniteNumber(candidate.pausedUntil, 0) ? candidate.pausedUntil : undefined;
    policies.set(hostname, {
      hostname,
      monitoring,
      notifications,
      automaticRecovery,
      ...(pausedUntil === undefined ? {} : { pausedUntil })
    });
    if (policies.size >= MAX_HOSTS) break;
  }
  return [...policies.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

function decodeReceipt(value: unknown): ResetReceipt | null {
  if (!isRecord(value)) return null;
  const hostname = typeof value.hostname === "string" ? normalizeHostname(value.hostname) : null;
  if (
    !boundedString(value.id, 1, 128) ||
    !Number.isInteger(value.tabId) ||
    (value.tabId as number) < 0 ||
    !hostname ||
    (value.action !== "discard" && value.action !== "reload") ||
    !isFiniteNumber(value.occurredAt, 0) ||
    !Array.isArray(value.reasonCodes) ||
    !["success", "blocked", "failed", "cancelled", "expired", "unknown"].includes(String(value.outcome)) ||
    typeof value.message !== "string"
  ) {
    return null;
  }
  const initiator =
    value.initiator === "manual" || value.initiator === "automatic" ? value.initiator : undefined;
  const phases = [
    "cancelled",
    "expired",
    "blocked",
    "request-failed",
    "requested",
    "completed",
    "verification-timed-out"
  ] as const;
  const phase = phases.includes(value.phase as (typeof phases)[number])
    ? (value.phase as (typeof phases)[number])
    : undefined;
  return {
    id: value.id,
    tabId: value.tabId as number,
    hostname,
    action: value.action,
    occurredAt: value.occurredAt,
    reasonCodes: value.reasonCodes
      .slice(0, 100)
      .filter((reason): reason is string => typeof reason === "string")
      .map((reason) => reason.slice(0, 80))
      .slice(0, 20),
    outcome: value.outcome as ResetReceipt["outcome"],
    message: value.message.slice(0, MAX_STRING),
    ...(boundedString(value.operationId, 8, 128) ? { operationId: value.operationId } : {}),
    ...(initiator ? { initiator } : {}),
    ...(phase ? { phase } : {}),
    ...(isFiniteNumber(value.requestedAt, 0) ? { requestedAt: value.requestedAt } : {}),
    ...(isFiniteNumber(value.completedAt, 0) ? { completedAt: value.completedAt } : {})
  };
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value as number)) : fallback;
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function enumValue<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
