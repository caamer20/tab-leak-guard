import type { PROTOCOL_VERSION } from "./constants";

export type DetectorStatus =
  | "unsupported"
  | "warmup"
  | "healthy"
  | "watching"
  | "suspected"
  | "confirmed";

export type RecoveryMode = "notify" | "auto-safe";
export type MonitoringIntent = "paused" | "manual" | "continuous";
export type PermissionMode = "manual" | "selected-sites" | "all-sites";
export type NotificationContent = "generic" | "site";
export type HistoryRetentionHours = 0 | 24 | 168;
export type UserEditState = "no-edits-observed" | "edits-observed" | "unknown";
export type CollectorMode = "manual" | "continuous";
export type CollectorHealth = "healthy" | "degraded" | "stopped";

export type SitePolicy = {
  hostname: string;
  monitoring: "inherit" | "off" | "monitor";
  notifications: "inherit" | "off" | "on";
  automaticRecovery: "inherit" | "never" | "allow";
  pausedUntil?: number;
};

export type Preferences = {
  monitoringEnabled: boolean;
  monitoringIntent: MonitoringIntent;
  permissionMode: PermissionMode;
  selectedOrigins: string[];
  recoveryMode: RecoveryMode;
  automaticRecoveryAcknowledgementVersion: number;
  notificationsEnabled: boolean;
  notificationContent: NotificationContent;
  historyRetentionHours: HistoryRetentionHours;
  ignoredHosts: string[];
  sitePolicies: SitePolicy[];
  sampleVisibleSeconds: number;
  sampleHiddenSeconds: number;
  quietPeriodMinutes: number;
  confirmationScore: number;
};

export const DEFAULT_PREFERENCES: Preferences = {
  monitoringEnabled: false,
  monitoringIntent: "manual",
  permissionMode: "manual",
  selectedOrigins: [],
  recoveryMode: "notify",
  automaticRecoveryAcknowledgementVersion: 0,
  notificationsEnabled: true,
  notificationContent: "generic",
  historyRetentionHours: 24,
  ignoredHosts: [],
  sitePolicies: [],
  sampleVisibleSeconds: 30,
  sampleHiddenSeconds: 90,
  quietPeriodMinutes: 5,
  confirmationScore: 75
};

export type CapabilityFlags = {
  resourceObserver: boolean;
  longTasks: boolean;
  exactMemory: boolean;
};

export type SampleSummary = {
  sampleSequence: number;
  documentAgeMs: number;
  visibility: "visible" | "hidden";
  liveDomNodes: number | null;
  addedNodesSinceLast: number;
  removedNodesSinceLast: number;
  resourceEntriesSeen: number | null;
  timerDriftMs: number | null;
  dirty: boolean;
  overflowed: boolean;
  capabilities: CapabilityFlags;
  userEditState?: UserEditState;
  collectorMode?: CollectorMode;
  collectorHealth?: CollectorHealth;
  resourceActivityCount?: number | null;
  droppedPerformanceEntries?: number;
  sampleDurationMs?: number;
  mutationWorkDurationMs?: number;
  recountDurationMs?: number | null;
  sampledAtEpochMs?: number;
};

export type MessageEnvelope<TType extends string, TPayload> = {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: TType;
  sentAtMonotonicMs: number;
  deliveryDeadlineEpochMs: number;
  documentInstanceId: string;
  collectorMode: CollectorMode;
  authorityToken: string | null;
  payload: TPayload;
};

export type CollectorSampleMessage = MessageEnvelope<"COLLECTOR_SAMPLE", SampleSummary>;
export type CollectorHelloMessage = MessageEnvelope<"COLLECTOR_HELLO", { hostname: string }>;
export type CollectorMessage = CollectorSampleMessage | CollectorHelloMessage;

export type DetectorFeatures = {
  durationMs: number;
  validSamples: number;
  baselineNodes: number | null;
  currentNodes: number | null;
  nodeGrowthAbsolute: number;
  nodeGrowthRatio: number;
  nodeSlopePerMinute: number;
  nodeMonotonicity: number;
  grossAddedNodes: number;
  grossRemovedNodes: number;
  retentionRatio: number;
  resourceGrowth: number;
  resourceSlopePerMinute: number;
  visibleTimerDriftP95: number | null;
  overflowCount: number;
};

export type DetectorResult = {
  status: DetectorStatus;
  score: number;
  consecutiveConfirmations: number;
  signalFamilies: string[];
  reasonCodes: string[];
  reasons: string[];
  features: DetectorFeatures;
};

export type TabSafety = {
  active: boolean;
  highlighted: boolean;
  audible: boolean;
  pinned: boolean;
  attention: boolean;
  dirty: boolean;
  userEditState: UserEditState;
  discarded: boolean;
  loading: boolean;
  recentlyAccessed: boolean;
  autoDiscardable: boolean;
  sharingCamera: boolean;
  sharingMicrophone: boolean;
  sharingScreen: boolean;
  fullscreen: boolean;
  safetyComplete: boolean;
  evaluatedAt: number;
};

export type RecoveryStatus =
  | "idle"
  | "prepared"
  | "awaiting-consent"
  | "executing"
  | "requested"
  | "completed"
  | "cooldown"
  | "blocked"
  | "failed"
  | "suppressed";

export type RecoveryState = {
  status: RecoveryStatus;
  operationId?: string;
  pendingAt?: number;
  blockedReason?: string;
  automaticSuppressedForDocument?: boolean;
  automaticAttemptedAt?: number;
};

export type TabPolicyState = {
  tabId: number;
  snoozedUntil?: number;
  cooldownUntil?: number;
  lastAutomaticAttemptAt?: number;
  manualSessionStartedAt?: number;
  manualSessionExpiresAt?: number;
  manualSessionToken?: string;
  manualSessionDocumentId?: string;
  manualSessionDocumentInstanceId?: string;
};

export type TabRecord = {
  tabId: number;
  windowId: number;
  documentInstanceId: string;
  documentId: string | null;
  revision: number;
  hostname: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  samples: SampleSummary[];
  detector: DetectorResult;
  safety: TabSafety;
  recovery: RecoveryState;
  evidenceExpiresAt: number;
  monitoringEpoch: number;
  monitoringMode: CollectorMode;
  manualSessionStartedAt?: number;
  manualSessionExpiresAt?: number;
  snoozedUntil?: number;
  cooldownUntil?: number;
  pendingResetAt?: number;
  notifiedAt?: number;
  blockedReason?: string;
};

export type ResetReceipt = {
  id: string;
  tabId: number;
  hostname: string;
  action: "discard" | "reload";
  occurredAt: number;
  reasonCodes: string[];
  outcome: "success" | "blocked" | "failed" | "cancelled" | "expired" | "unknown";
  message: string;
  operationId?: string;
  initiator?: "manual" | "automatic";
  phase?: "cancelled" | "expired" | "blocked" | "request-failed" | "requested" | "completed" | "verification-timed-out";
  requestedAt?: number;
  completedAt?: number;
};

export type RecoveryAction = "discard" | "reload";
export type RecoveryInitiator = "manual" | "automatic";

export type PreparedRecovery = {
  operationId: string;
  nonce: string;
  tabId: number;
  windowId: number;
  hostname?: string;
  documentId: string | null;
  documentInstanceId: string;
  recordRevision: number;
  monitoringEpoch: number;
  permissionRevision: number;
  action: RecoveryAction;
  initiator: RecoveryInitiator;
  preparedAt: number;
  expiresAt: number;
  evidenceExpiresAt: number;
  safetyFingerprint: string;
  warnings: string[];
  acknowledgedUserEditRisk: boolean;
  state: "prepared" | "awaiting-consent" | "executing" | "requested" | "terminal";
  requestedAt?: number;
};

export type RecoveryPreparationView = Pick<
  PreparedRecovery,
  "operationId" | "nonce" | "tabId" | "action" | "preparedAt" | "expiresAt" | "warnings"
> & {
  title: string;
  hostname: string;
  requiresUserEditAcknowledgement: boolean;
};

export type CollectorControlCommand =
  | { type: "GET_RECOVERY_PREFLIGHT"; expectedDocumentInstanceId?: string }
  | { type: "STOP_COLLECTOR"; expectedDocumentInstanceId?: string }
  | { type: "BACKOFF_COLLECTOR"; expectedDocumentInstanceId?: string };

export type CollectorPreflight = {
  documentInstanceId: string;
  userEditState: UserEditState;
  capturedAtMonotonicMs: number;
  collectorMode: CollectorMode;
  collectorHealth: CollectorHealth;
  sessionExpiresAtMonotonicMs: number | null;
  authorityToken: string | null;
};

export type ExtensionSnapshot = {
  preferences: Preferences;
  hasContinuousPermission: boolean;
  permissionScope: "none" | "selected-sites" | "all-sites";
  records: TabRecord[];
  receipts: ResetReceipt[];
  automaticRecoveryAvailable: boolean;
  monitoringEpoch: number;
};

export type UiCommand =
  | { type: "GET_SNAPSHOT" }
  | { type: "SCAN_ACTIVE_TAB" }
  | { type: "SYNC_PERMISSION" }
  | { type: "FOCUS_TAB"; tabId: number }
  | { type: "PREPARE_RECOVERY"; tabId: number }
  | {
      type: "EXECUTE_RECOVERY";
      operationId: string;
      nonce: string;
      acknowledgeUserEditRisk?: boolean;
    }
  | { type: "CANCEL_RECOVERY"; operationId: string }
  | { type: "STOP_MONITORING_TAB"; tabId: number }
  | { type: "SNOOZE_TAB"; tabId: number }
  | { type: "IGNORE_HOST"; hostname: string }
  | { type: "UNIGNORE_HOST"; hostname: string }
  | { type: "UPDATE_PREFERENCES"; patch: Partial<Preferences> }
  | { type: "CLEAR_RECEIPTS" }
  | { type: "DELETE_ALL_DATA" }
  | { type: "EXPORT_DIAGNOSTICS" };

export type CommandResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; retryable?: boolean };
