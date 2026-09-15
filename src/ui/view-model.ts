import type { DetectorStatus, RecoveryStatus, TabRecord } from "../shared/types";

export type TabDisplayGroup =
  | "pending"
  | "likely-runaway"
  | "elevated"
  | "learning"
  | "stable"
  | "unsupported";

export type EvidenceQualityLevel = "high" | "medium" | "low" | "insufficient";

export type ProtectionCode =
  | "active"
  | "highlighted"
  | "pinned"
  | "audio"
  | "attention"
  | "edited-input"
  | "edit-state-unknown"
  | "sharing"
  | "fullscreen"
  | "recently-used"
  | "unloaded"
  | "firefox-protected"
  | "signals-incomplete"
  | "background";

export type TabViewModel = {
  tabId: number;
  group: TabDisplayGroup;
  isConcerning: boolean;
  detectionStatus: DetectorStatus;
  recoveryStatus: RecoveryStatus;
  detectionMessageKey: string;
  recoveryMessageKey: string;
  confidenceMessageKey: string;
  quality: EvidenceQualityLevel;
  evidenceIsFresh: boolean;
  sampledAt: number;
  topReasonCode: string | null;
  protections: ProtectionCode[];
  recoveryInFlight: boolean;
  canReviewRecovery: boolean;
  sortRank: number;
};

const DETECTION_MESSAGE_KEYS: Record<DetectorStatus, string> = {
  unsupported: "detectorUnsupported",
  warmup: "detectorLearning",
  healthy: "detectorStable",
  watching: "detectorWatching",
  suspected: "detectorElevated",
  confirmed: "detectorLikelyRunaway"
};

const RECOVERY_MESSAGE_KEYS: Record<RecoveryStatus, string> = {
  idle: "recoveryIdle",
  prepared: "recoveryPrepared",
  "awaiting-consent": "recoveryAwaitingConsent",
  executing: "recoveryExecuting",
  requested: "recoveryRequested",
  completed: "recoveryCompleted",
  cooldown: "recoveryCooldown",
  blocked: "recoveryBlocked",
  failed: "recoveryFailed",
  suppressed: "recoverySuppressed"
};

const IN_FLIGHT_RECOVERY = new Set<RecoveryStatus>([
  "prepared",
  "awaiting-consent",
  "executing",
  "requested"
]);

export function deriveTabViewModel(record: TabRecord, now = Date.now()): TabViewModel {
  const recoveryInFlight = IN_FLIGHT_RECOVERY.has(record.recovery.status);
  const recoverySuppressed =
    record.recovery.status === "cooldown" ||
    record.recovery.status === "suppressed" ||
    Boolean(record.cooldownUntil && record.cooldownUntil > now);
  const group = displayGroup(record.detector.status, recoveryInFlight);
  const quality = evidenceQuality(record);
  const sampledAt = record.samples.at(-1)?.sampledAtEpochMs ?? record.updatedAt;
  return {
    tabId: record.tabId,
    group,
    isConcerning: group === "pending" || group === "likely-runaway" || group === "elevated",
    detectionStatus: record.detector.status,
    recoveryStatus: record.recovery.status,
    detectionMessageKey: DETECTION_MESSAGE_KEYS[record.detector.status],
    recoveryMessageKey: RECOVERY_MESSAGE_KEYS[record.recovery.status],
    confidenceMessageKey: confidenceMessageKey(record.detector.status),
    quality,
    evidenceIsFresh: record.evidenceExpiresAt > now,
    sampledAt,
    topReasonCode: record.detector.reasonCodes[0] ?? null,
    protections: protectionCodes(record),
    recoveryInFlight,
    canReviewRecovery:
      record.detector.status === "confirmed" &&
      record.evidenceExpiresAt > now &&
      !recoveryInFlight &&
      !recoverySuppressed,
    sortRank: sortRank(group, record.recovery.status)
  };
}

export function compareTabViewModels(a: TabRecord, b: TabRecord, now = Date.now()): number {
  const first = deriveTabViewModel(a, now);
  const second = deriveTabViewModel(b, now);
  return (
    first.sortRank - second.sortRank ||
    b.detector.score - a.detector.score ||
    b.updatedAt - a.updatedAt ||
    a.tabId - b.tabId
  );
}

function displayGroup(status: DetectorStatus, recoveryInFlight: boolean): TabDisplayGroup {
  if (recoveryInFlight) return "pending";
  if (status === "confirmed") return "likely-runaway";
  if (status === "suspected" || status === "watching") return "elevated";
  if (status === "warmup") return "learning";
  if (status === "unsupported") return "unsupported";
  return "stable";
}

function confidenceMessageKey(status: DetectorStatus): string {
  if (status === "confirmed") return "confidenceHigh";
  if (status === "suspected" || status === "watching") return "confidenceDeveloping";
  if (status === "unsupported") return "confidenceUnavailable";
  return "confidenceNoConcern";
}

function evidenceQuality(record: TabRecord): EvidenceQualityLevel {
  const detector = record.detector as TabRecord["detector"] & {
    quality?: { level?: EvidenceQualityLevel };
  };
  const explicit = detector.quality?.level;
  if (explicit && ["high", "medium", "low", "insufficient"].includes(explicit)) return explicit;
  if (record.samples.length < 3) return "insufficient";
  if (
    record.samples.some(
      (sample) => sample.overflowed || sample.collectorHealth === "degraded" ||
        (sample.droppedPerformanceEntries ?? 0) > 0
    )
  ) return "low";
  return record.samples.length >= 6 ? "high" : "medium";
}

function protectionCodes(record: TabRecord): ProtectionCode[] {
  const safety = record.safety;
  const protections: ProtectionCode[] = [];
  if (safety.active) protections.push("active");
  if (safety.highlighted) protections.push("highlighted");
  if (safety.pinned) protections.push("pinned");
  if (safety.audible) protections.push("audio");
  if (safety.attention) protections.push("attention");
  if (safety.userEditState === "edits-observed") protections.push("edited-input");
  if (safety.userEditState === "unknown") protections.push("edit-state-unknown");
  if (safety.sharingCamera || safety.sharingMicrophone || safety.sharingScreen) protections.push("sharing");
  if (safety.fullscreen) protections.push("fullscreen");
  if (safety.recentlyAccessed) protections.push("recently-used");
  if (safety.discarded) protections.push("unloaded");
  if (!safety.autoDiscardable) protections.push("firefox-protected");
  if (!safety.safetyComplete) protections.push("signals-incomplete");
  if (protections.length === 0) protections.push("background");
  return protections;
}

function sortRank(group: TabDisplayGroup, recoveryStatus: RecoveryStatus): number {
  if (recoveryStatus === "blocked" || recoveryStatus === "failed") return 1;
  return {
    pending: 0,
    "likely-runaway": 2,
    elevated: 3,
    learning: 4,
    stable: 5,
    unsupported: 6
  }[group];
}
