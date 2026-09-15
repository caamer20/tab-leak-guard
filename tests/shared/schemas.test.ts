import { describe, expect, it } from "vitest";
import { MAX_RECOVERY_OPERATIONS, MAX_RESET_RECEIPTS } from "../../src/shared/constants";
import {
  decodePreparedRecovery,
  normalizeSelectedOrigin,
  sanitizePreferences,
  sanitizePreparedRecoveries,
  sanitizeReceipts
} from "../../src/shared/schemas";
import { DEFAULT_PREFERENCES, type PreparedRecovery, type ResetReceipt } from "../../src/shared/types";

const NOW = 1_800_000_000_000;

function operation(overrides: Partial<PreparedRecovery> = {}): PreparedRecovery {
  return {
    operationId: "12345678-1234-4234-8234-123456789abc",
    nonce: "abcdefabcdefabcdefabcdefabcdefab",
    tabId: 3,
    windowId: 1,
    documentId: "firefox-document-12345678",
    documentInstanceId: "document-instance-12345678",
    recordRevision: 4,
    monitoringEpoch: 9,
    permissionRevision: 0,
    action: "discard",
    initiator: "manual",
    preparedAt: NOW,
    expiresAt: NOW + 60_000,
    evidenceExpiresAt: NOW + 90_000,
    safetyFingerprint: "false|false|false|false|false|no-edits-observed",
    warnings: ["Review before continuing"],
    acknowledgedUserEditRisk: false,
    state: "awaiting-consent",
    ...overrides
  };
}

function receipt(overrides: Partial<ResetReceipt> = {}): ResetReceipt {
  return {
    id: "receipt-1",
    tabId: 3,
    hostname: "example.test",
    action: "discard",
    occurredAt: NOW,
    reasonCodes: ["sustained-growth"],
    outcome: "success",
    message: "Completed",
    ...overrides
  };
}

describe("preference schema", () => {
  it("fails closed for corrupt input", () => {
    expect(sanitizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(sanitizePreferences("corrupt")).toEqual(DEFAULT_PREFERENCES);
  });

  it("migrates the legacy monitoring flag without silently enabling automatic recovery", () => {
    expect(
      sanitizePreferences({
        monitoringEnabled: true,
        recoveryMode: "auto-safe"
      })
    ).toMatchObject({
      monitoringEnabled: true,
      monitoringIntent: "continuous",
      permissionMode: "all-sites",
      recoveryMode: "notify"
    });
  });

  it("normalizes origins, hostnames, policies, enums, and numeric bounds", () => {
    const result = sanitizePreferences({
      monitoringEnabled: true,
      monitoringIntent: "continuous",
      permissionMode: "selected-sites",
      selectedOrigins: [
        "HTTPS://Example.TEST:443/*",
        "https://example.test/*",
        "https://user:password@example.test/*",
        "file:///*"
      ],
      ignoredHosts: ["EXAMPLE.test.", "bad host", "example.test"],
      sitePolicies: [
        {
          hostname: "Example.TEST.",
          monitoring: "off",
          notifications: "on",
          automaticRecovery: "allow",
          pausedUntil: NOW
        },
        { hostname: "bad host", automaticRecovery: "allow" }
      ],
      notificationContent: "not-valid",
      historyRetentionHours: 999,
      sampleVisibleSeconds: 1,
      sampleHiddenSeconds: 9_999,
      quietPeriodMinutes: -1,
      confirmationScore: 100
    });

    expect(result.selectedOrigins).toEqual(["https://example.test/*"]);
    expect(result.ignoredHosts).toEqual(["example.test"]);
    expect(result.sitePolicies).toEqual([
      {
        hostname: "example.test",
        monitoring: "off",
        notifications: "on",
        automaticRecovery: "allow",
        pausedUntil: NOW
      }
    ]);
    expect(result).toMatchObject({
      notificationContent: "generic",
      historyRetentionHours: 24,
      sampleVisibleSeconds: 10,
      sampleHiddenSeconds: 900,
      quietPeriodMinutes: 1,
      confirmationScore: 95
    });
  });

  it.each([
    ["https://example.test/*", "https://example.test/*"],
    ["http://localhost:8080/*", null],
    ["https://example.test:443/*", null],
    ["http://example.test:80/*", null],
    ["https://user@example.test/*", null],
    ["https://example.test/path/*", null],
    ["*://example.test/*", null],
    ["javascript:alert(1)", null]
  ])("normalizes selected origin %s", (input, expected) => {
    expect(normalizeSelectedOrigin(input)).toBe(expected);
  });
});

describe("recovery operation schema", () => {
  it("decodes a valid unexpired operation and strips oversized warning content", () => {
    const decoded = decodePreparedRecovery(
      operation({ warnings: ["x".repeat(1_000), 42 as unknown as string] }),
      NOW + 1
    );
    expect(decoded?.warnings).toHaveLength(1);
    expect(decoded?.warnings[0]).toHaveLength(512);
  });

  it("rejects expired, malformed, overbroad, and non-finite authority", () => {
    expect(decodePreparedRecovery(operation({ expiresAt: NOW }), NOW)).toBeNull();
    expect(decodePreparedRecovery(operation({ nonce: "short" }), NOW)).toBeNull();
    expect(decodePreparedRecovery(operation({ tabId: -1 }), NOW)).toBeNull();
    expect(decodePreparedRecovery(operation({ expiresAt: Number.POSITIVE_INFINITY }), NOW)).toBeNull();
    expect(decodePreparedRecovery({ ...operation(), action: "close" }, NOW)).toBeNull();
  });

  it("bounds the operation journal", () => {
    const candidates = Array.from({ length: MAX_RECOVERY_OPERATIONS + 10 }, (_, index) =>
      operation({ operationId: `operation-${String(index).padStart(8, "0")}` })
    );
    expect(sanitizePreparedRecoveries(candidates, NOW)).toHaveLength(MAX_RECOVERY_OPERATIONS);
  });
});

describe("receipt schema and retention", () => {
  it("drops corrupt and expired receipts, sanitizes text, and sorts newest first", () => {
    const values = [
      receipt({ id: "new", occurredAt: NOW, message: "m".repeat(1_000) }),
      receipt({ id: "older", occurredAt: NOW - 10_000 }),
      receipt({ id: "expired", occurredAt: NOW - 25 * 60 * 60_000 }),
      { ...receipt(), hostname: "not a host" }
    ];
    const result = sanitizeReceipts(values, NOW, 24);
    expect(result.map((value) => value.id)).toEqual(["new", "older"]);
    expect(result[0]?.message).toHaveLength(512);
  });

  it("supports privacy-first no-history and caps storage", () => {
    expect(sanitizeReceipts([receipt()], NOW, 0)).toEqual([]);
    const values = Array.from({ length: MAX_RESET_RECEIPTS + 20 }, (_, index) =>
      receipt({ id: `receipt-${index}`, occurredAt: NOW - index })
    );
    expect(sanitizeReceipts(values, NOW, 168)).toHaveLength(MAX_RESET_RECEIPTS);
  });
});
