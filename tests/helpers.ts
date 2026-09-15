import { emptyDetectorResult } from "../src/detector/score";
import { DEFAULT_PREFERENCES, type SampleSummary, type TabRecord, type TabSafety } from "../src/shared/types";

export function sample(overrides: Partial<SampleSummary> = {}): SampleSummary {
  return {
    sampleSequence: 0,
    documentAgeMs: 0,
    visibility: "visible",
    liveDomNodes: 10_000,
    addedNodesSinceLast: 0,
    removedNodesSinceLast: 0,
    resourceEntriesSeen: 10,
    timerDriftMs: 0,
    dirty: false,
    overflowed: false,
    capabilities: { resourceObserver: true, longTasks: false, exactMemory: false },
    ...overrides
  };
}

export const safeState: TabSafety = {
  active: false,
  highlighted: false,
  audible: false,
  pinned: false,
  attention: false,
  dirty: false,
  userEditState: "no-edits-observed",
  discarded: false,
  loading: false,
  recentlyAccessed: false,
  autoDiscardable: true,
  sharingCamera: false,
  sharingMicrophone: false,
  sharingScreen: false,
  fullscreen: false,
  safetyComplete: true,
  evaluatedAt: Date.now()
};

export function tabRecord(overrides: Partial<TabRecord> = {}): TabRecord {
  const detector = {
    ...emptyDetectorResult("confirmed"),
    score: 90,
    status: "confirmed" as const,
    automaticEligible: true
  };
  return {
    tabId: 1,
    windowId: 1,
    documentInstanceId: "document-12345678",
    documentId: "firefox-document-12345678",
    revision: 0,
    hostname: "example.test",
    title: "Example",
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    samples: [],
    detector,
    safety: safeState,
    recovery: { status: "idle" },
    evidenceExpiresAt: Date.now() + 60_000,
    monitoringEpoch: 1,
    monitoringMode: "continuous",
    ...overrides
  };
}

export const autoPreferences = {
  ...DEFAULT_PREFERENCES,
  monitoringEnabled: true,
  monitoringIntent: "continuous" as const,
  permissionMode: "all-sites" as const,
  recoveryMode: "auto-safe" as const,
  sitePolicies: [
    {
      hostname: "example.test",
      monitoring: "inherit" as const,
      notifications: "inherit" as const,
      automaticRecovery: "allow" as const
    }
  ]
};
