export const PROTOCOL_VERSION = 2 as const;
export const COLLECTOR_SCRIPT_ID = "tab-leak-guard-collector";
export const COLLECTOR_SCRIPT_PATH = "collector/index.js";
export const MONITORED_ORIGINS = ["http://*/*", "https://*/*"] as const;

export const MAX_SAMPLES_PER_DOCUMENT = 16;
export const MAX_MESSAGE_BYTES = 8_192;
export const MAX_RESET_RECEIPTS = 50;
export const MAX_RECOVERY_OPERATIONS = 100;
export const SNOOZE_DURATION_MS = 30 * 60_000;
export const MANUAL_SESSION_DURATION_MS = 15 * 60_000;
export const RESET_GRACE_MINUTES = 2;
export const NOTIFICATION_COOLDOWN_MS = 30 * 60_000;
export const RESET_COOLDOWN_MS = 60 * 60_000;
export const QUIET_PERIOD_MS = 5 * 60_000;
export const RECOVERY_TOKEN_TTL_MS = 60_000;
export const RECOVERY_PREFLIGHT_MAX_AGE_MS = 2_000;
// One end-to-end budget covers transport, event-page hydration, permission
// checks, document identity checks, and durable acceptance. Individual browser
// calls remain more tightly bounded by RECOVERY_PREFLIGHT_MAX_AGE_MS.
export const COLLECTOR_MESSAGE_TIMEOUT_MS = 10_000;
export const COLLECTOR_BOOTSTRAP_TIMEOUT_MS = COLLECTOR_MESSAGE_TIMEOUT_MS;
// A manual scan can span the initial bootstrap + HELLO and up to three
// bounded collector restarts after ambiguous transport failures. The waiter
// must not revoke the token while those fail-closed retries are still live.
export const MANUAL_SESSION_READY_TIMEOUT_MS = COLLECTOR_MESSAGE_TIMEOUT_MS * 8 + 5_000;
export const RECOVERY_REQUEST_TIMEOUT_MS = 15_000;
export const RECOVERY_VERIFICATION_TIMEOUT_MS = 15_000;
export const EVIDENCE_FRESHNESS_MS = 3 * 60_000;
export const STALE_RECORD_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_TAB_RECORDS = 300;
export const HOST_CIRCUIT_WINDOW_MS = 6 * 60 * 60_000;
export const HOST_CIRCUIT_MAX_RESETS = 2;
export const GLOBAL_CIRCUIT_WINDOW_MS = 60 * 60_000;
export const GLOBAL_CIRCUIT_MAX_RESETS = 5;

/**
 * Automatic recovery remains unavailable until the vNext safety and beta gates
 * pass. The implementation is kept behind this compile-time fail-safe so an
 * old preference or alarm can never opt itself back in.
 */
export const AUTOMATIC_RECOVERY_AVAILABLE = false;
export const AUTOMATIC_RECOVERY_ACKNOWLEDGEMENT_VERSION = 1;

export const STORAGE_KEYS = {
  preferences: "preferences",
  receipts: "resetReceipts",
  records: "tabRecords",
  tabPolicies: "tabPolicies",
  operations: "recoveryOperations",
  monitoringEpoch: "monitoringEpoch",
  schemaVersion: "schemaVersion"
} as const;

// v3 forces one fail-closed migration from prototypes that could publish the
// v2 local marker before session authority had been invalidated.
export const STORAGE_SCHEMA_VERSION = 3;
