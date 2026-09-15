import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateRepository } from "../../src/background/state-repository";
import {
  MAX_RECOVERY_OPERATIONS,
  MAX_TAB_RECORDS,
  RESET_COOLDOWN_MS,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION
} from "../../src/shared/constants";
import {
  DEFAULT_PREFERENCES,
  type PreparedRecovery,
  type ResetReceipt
} from "../../src/shared/types";
import { safeState, tabRecord } from "../helpers";
import { createFakeWebExtension, installFakeBrowser } from "../fakes/webextension";

const NOW = 1_800_000_000_000;

function operation(overrides: Partial<PreparedRecovery> = {}): PreparedRecovery {
  return {
    operationId: "12345678-1234-4234-8234-123456789abc",
    nonce: "abcdefabcdefabcdefabcdefabcdefab",
    tabId: 1,
    windowId: 1,
    documentId: "firefox-document-12345678",
    documentInstanceId: "document-12345678",
    recordRevision: 3,
    monitoringEpoch: 5,
    permissionRevision: 0,
    action: "discard",
    initiator: "manual",
    preparedAt: NOW,
    expiresAt: NOW + 60_000,
    evidenceExpiresAt: NOW + 120_000,
    safetyFingerprint: "safe-fingerprint",
    warnings: [],
    acknowledgedUserEditRisk: false,
    state: "awaiting-consent",
    ...overrides
  };
}

function receipt(overrides: Partial<ResetReceipt> = {}): ResetReceipt {
  return {
    id: "receipt-1",
    operationId: operation().operationId,
    tabId: 1,
    hostname: "example.test",
    action: "discard",
    occurredAt: NOW - 1_000,
    reasonCodes: [],
    outcome: "success",
    phase: "completed",
    initiator: "manual",
    message: "The tab was unloaded",
    requestedAt: NOW - 2_000,
    completedAt: NOW - 1_000,
    ...overrides
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StateRepository hydration and migration", () => {
  it("migrates old state fail-closed and invalidates all prepared authority", async () => {
    const oldRecord = tabRecord({
      revision: 3,
      createdAt: NOW - 10_000,
      updatedAt: NOW - 1_000,
      evidenceExpiresAt: NOW + 120_000,
      monitoringEpoch: 4,
      safety: { ...safeState, dirty: false, userEditState: "no-edits-observed" }
    });
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: 1,
        [STORAGE_KEYS.preferences]: {
          monitoringEnabled: true,
          recoveryMode: "auto-safe"
        },
        [STORAGE_KEYS.receipts]: [{ badly: "formed" }]
      },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 4,
        [STORAGE_KEYS.records]: { "1": oldRecord, bad: { tabId: "bad" } },
        [STORAGE_KEYS.operations]: [operation({ monitoringEpoch: 4 })]
      }
    });
    installFakeBrowser(fake);

    const repository = new StateRepository();
    await repository.ready;

    expect(repository.monitoringEpoch).toBe(5);
    expect(repository.operations.size).toBe(0);
    expect(repository.receipts).toEqual([]);
    expect(repository.preferences).toMatchObject({
      monitoringEnabled: true,
      monitoringIntent: "continuous",
      recoveryMode: "notify"
    });
    expect(repository.records.size).toBe(0);
    expect(fake.local[STORAGE_KEYS.schemaVersion]).toBe(STORAGE_SCHEMA_VERSION);
    expect(fake.session[STORAGE_KEYS.operations]).toEqual([]);
  });

  it("commits a backward-compatible issued journal before clearing session authority and publishes schema v3 last", async () => {
    const requested = operation({
      state: "requested",
      requestedAt: NOW - 5_000,
      monitoringEpoch: 5
    });
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: 2,
        [STORAGE_KEYS.operations]: [operation({ monitoringEpoch: 5 })]
      },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 5,
        [STORAGE_KEYS.records]: { "1": tabRecord({ monitoringEpoch: 5 }) },
        [STORAGE_KEYS.tabPolicies]: { "1": { tabId: 1, snoozedUntil: NOW + 60_000 } },
        [STORAGE_KEYS.operations]: [requested]
      }
    });
    installFakeBrowser(fake);

    const repository = new StateRepository();
    await repository.ready;

    const localWrites = fake.calls.storageLocalSet.mock.calls.map(
      ([value]) => value as Record<string, unknown>
    );
    const firstDurableWrite = localWrites[0];
    const migrationMarker = localWrites.at(-1);
    expect(firstDurableWrite).not.toHaveProperty(STORAGE_KEYS.schemaVersion);
    expect(firstDurableWrite?.[STORAGE_KEYS.operations]).toEqual([requested]);
    expect(fake.calls.storageSessionSet.mock.invocationCallOrder[0]).toBeGreaterThan(
      fake.calls.storageLocalSet.mock.invocationCallOrder[0] as number
    );
    expect(fake.calls.storageLocalSet.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      fake.calls.storageSessionSet.mock.invocationCallOrder.at(-1) as number
    );
    expect(migrationMarker).toEqual({ [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION });
    expect([...repository.operations.values()]).toEqual([requested]);
    expect(repository.records.size).toBe(0);
    expect(repository.tabPolicies.size).toBe(0);
    expect(fake.session).toMatchObject({
      [STORAGE_KEYS.records]: {},
      [STORAGE_KEYS.tabPolicies]: {},
      [STORAGE_KEYS.operations]: [],
      [STORAGE_KEYS.monitoringEpoch]: 6
    });
  });

  it("reruns migration after a crash before the durable journal write", async () => {
    const staleRecord = tabRecord({ monitoringEpoch: 5 });
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: 2,
        [STORAGE_KEYS.operations]: [operation({ state: "requested", requestedAt: NOW - 1_000 })]
      },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 5,
        [STORAGE_KEYS.records]: { "1": staleRecord }
      }
    });
    fake.calls.storageLocalSet.mockRejectedValueOnce(new Error("simulated migration crash"));
    installFakeBrowser(fake);

    await expect(new StateRepository().ready).rejects.toThrow("simulated migration crash");
    expect(fake.local[STORAGE_KEYS.schemaVersion]).toBe(2);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({ "1": staleRecord });

    const retried = new StateRepository();
    await retried.ready;
    expect(fake.local[STORAGE_KEYS.schemaVersion]).toBe(STORAGE_SCHEMA_VERSION);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
    expect([...retried.operations.values()]).toHaveLength(1);
    expect([...retried.operations.values()][0]).toMatchObject({ state: "requested" });
  });

  it("leaves the old marker after a crash clearing session authority and safely resumes migration", async () => {
    const requested = operation({ state: "requested", requestedAt: NOW - 1_000 });
    const staleRecord = tabRecord({ monitoringEpoch: 5 });
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: 2,
        [STORAGE_KEYS.operations]: []
      },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 5,
        [STORAGE_KEYS.records]: { "1": staleRecord },
        [STORAGE_KEYS.operations]: [requested]
      }
    });
    fake.calls.storageSessionSet.mockRejectedValueOnce(
      new Error("simulated session invalidation crash")
    );
    installFakeBrowser(fake);

    await expect(new StateRepository().ready).rejects.toThrow(
      "simulated session invalidation crash"
    );
    expect(fake.local[STORAGE_KEYS.schemaVersion]).toBe(2);
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([requested]);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({ "1": staleRecord });

    const retried = new StateRepository();
    await retried.ready;
    expect(fake.local[STORAGE_KEYS.schemaVersion]).toBe(STORAGE_SCHEMA_VERSION);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
    expect(fake.session[STORAGE_KEYS.operations]).toEqual([]);
    expect([...retried.operations.values()]).toEqual([requested]);
  });

  it("restores only valid manual operations from the current epoch", async () => {
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
        [STORAGE_KEYS.preferences]: { monitoringIntent: "manual" }
      },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 5,
        [STORAGE_KEYS.operations]: [
          operation(),
          operation({
            operationId: "automatic-operation-1234",
            nonce: "12345678901234567890123456789012",
            initiator: "automatic"
          }),
          operation({ operationId: "expired-operation-12345", expiresAt: NOW })
        ]
      }
    });
    installFakeBrowser(fake);

    const repository = new StateRepository();
    await repository.ready;

    expect([...repository.operations.keys()]).toEqual([operation().operationId]);
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([operation()]);
    expect(fake.session[STORAGE_KEYS.operations]).toEqual([]);
  });

  it("preserves future snooze and cooldown policy independently of navigation records", async () => {
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 1,
        [STORAGE_KEYS.tabPolicies]: {
          "1": {
            tabId: 1,
            snoozedUntil: NOW + 30_000,
            cooldownUntil: NOW + 60_000,
            lastAutomaticAttemptAt: NOW - 1_000,
            manualSessionStartedAt: NOW - 2_000,
            manualSessionExpiresAt: NOW + 45_000,
            manualSessionToken: "87654321-4321-4321-8321-cba987654321",
            manualSessionDocumentInstanceId: "document-instance-1234",
            manualSessionDocumentId: "native-document-1234"
          },
          "2": { tabId: 2, snoozedUntil: NOW - 1 },
          "3": {
            tabId: 3,
            snoozedUntil: NOW + 30_000,
            manualSessionStartedAt: NOW - 2_000,
            manualSessionExpiresAt: NOW + 45_000,
            manualSessionToken: "too-short"
          },
          "4": {
            tabId: 4,
            cooldownUntil: NOW + 60_000,
            manualSessionStartedAt: NOW - 2_000,
            manualSessionExpiresAt: NOW + 45_000,
            manualSessionToken: "87654321-4321-4321-8321-cba987654321"
          },
          corrupt: { tabId: "bad", cooldownUntil: NOW + 1_000 }
        }
      }
    });
    installFakeBrowser(fake);

    const first = new StateRepository();
    await first.ready;
    expect(first.tabPolicies.get(1)).toEqual({
      tabId: 1,
      snoozedUntil: NOW + 30_000,
      cooldownUntil: NOW + 60_000,
      lastAutomaticAttemptAt: NOW - 1_000,
      manualSessionStartedAt: NOW - 2_000,
      manualSessionExpiresAt: NOW + 45_000,
      manualSessionToken: "87654321-4321-4321-8321-cba987654321",
      manualSessionDocumentInstanceId: "document-instance-1234",
      manualSessionDocumentId: "native-document-1234"
    });
    expect(first.tabPolicies.has(2)).toBe(false);
    expect(first.tabPolicies.get(3)).toEqual({ tabId: 3, snoozedUntil: NOW + 30_000 });
    expect(first.tabPolicies.get(4)).toEqual({ tabId: 4, cooldownUntil: NOW + 60_000 });

    await first.upsertTabPolicy({ tabId: 3, cooldownUntil: NOW + 90_000 });
    const second = new StateRepository();
    await second.ready;
    expect(second.tabPolicies.get(3)).toEqual({ tabId: 3, cooldownUntil: NOW + 90_000 });
  });

  it("hydrates receipt cooldown, snooze, and record status as one conservative startup truth", async () => {
    const snoozedUntil = NOW + 30_000;
    const receiptCooldownUntil = NOW - 1_000 + RESET_COOLDOWN_MS;
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
        [STORAGE_KEYS.receipts]: [receipt()]
      },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 5,
        [STORAGE_KEYS.records]: {
          "1": tabRecord({
            monitoringEpoch: 5,
            recovery: { status: "idle" },
            cooldownUntil: undefined,
            snoozedUntil: undefined
          })
        },
        [STORAGE_KEYS.tabPolicies]: {
          "1": { tabId: 1, snoozedUntil, cooldownUntil: NOW + 10_000 }
        }
      }
    });
    installFakeBrowser(fake);

    const repository = new StateRepository();
    await repository.ready;

    expect(repository.tabPolicies.get(1)).toEqual({
      tabId: 1,
      snoozedUntil,
      cooldownUntil: receiptCooldownUntil
    });
    expect(repository.records.get(1)).toMatchObject({
      cooldownUntil: receiptCooldownUntil,
      recovery: { status: "cooldown" }
    });
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({
      "1": { tabId: 1, snoozedUntil, cooldownUntil: receiptCooldownUntil }
    });
  });

  it("quarantines records whose stored monitoring epoch is missing or stale", async () => {
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 5,
        [STORAGE_KEYS.records]: {
          current: tabRecord({ tabId: 1, monitoringEpoch: 5 }),
          stale: tabRecord({ tabId: 2, monitoringEpoch: 4 }),
          missing: { ...tabRecord({ tabId: 3, monitoringEpoch: 5 }), monitoringEpoch: undefined }
        }
      }
    });
    installFakeBrowser(fake);

    const repository = new StateRepository();
    await repository.ready;

    expect([...repository.records.keys()]).toEqual([1]);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({
      "1": expect.objectContaining({ tabId: 1, monitoringEpoch: 5 })
    });
  });

  it("serializes writes and persists bounded, sanitized receipts", async () => {
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
        [STORAGE_KEYS.preferences]: { historyRetentionHours: 24 }
      },
      session: { [STORAGE_KEYS.monitoringEpoch]: 1 }
    });
    installFakeBrowser(fake);
    const repository = new StateRepository();
    await repository.ready;

    await Promise.all([
      repository.updatePreferences({ notificationContent: "site" }),
      repository.updatePreferences({ confirmationScore: 80 })
    ]);
    await repository.addReceipt({
      id: "receipt-1",
      tabId: 1,
      hostname: "EXAMPLE.TEST",
      action: "discard",
      occurredAt: NOW,
      reasonCodes: [],
      outcome: "success",
      message: "ok"
    });

    expect(repository.preferences.notificationContent).toBe("site");
    expect(repository.preferences.confirmationScore).toBe(80);
    expect(repository.receipts[0]?.hostname).toBe("example.test");
    expect(fake.calls.storageLocalSet).toHaveBeenCalled();
  });

  it("coalesces checkpoints and cancels a pending checkpoint while deleting all local state", async () => {
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: { [STORAGE_KEYS.monitoringEpoch]: 1 }
    });
    installFakeBrowser(fake);
    const repository = new StateRepository();
    await repository.ready;
    repository.records.set(1, tabRecord({ updatedAt: NOW }));

    repository.scheduleRecordCheckpoint(1);
    repository.scheduleRecordCheckpoint(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.session[STORAGE_KEYS.records]).toMatchObject({ "1": { tabId: 1 } });

    repository.scheduleRecordCheckpoint(1);
    await repository.clearAllRuntimeState();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(repository.records.size).toBe(0);
    expect(repository.operations.size).toBe(0);
    expect(repository.tabPolicies.size).toBe(0);
    expect(fake.local[STORAGE_KEYS.preferences]).toMatchObject({ monitoringEnabled: false });
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
  });

  it("drops invalid host records and substitutes a privacy-safe title fallback", async () => {
    const valid = tabRecord({
      monitoringEpoch: 5,
      createdAt: NOW - 10_000,
      updatedAt: NOW - 1_000,
      title: 42 as unknown as string
    });
    const invalidHost = tabRecord({
      tabId: 2,
      monitoringEpoch: 5,
      documentInstanceId: "invalid-host-document-1234",
      hostname: "bad host"
    });
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 5,
        [STORAGE_KEYS.records]: { "1": valid, "2": invalidHost }
      }
    });
    installFakeBrowser(fake);

    const repository = new StateRepository();
    await repository.ready;

    expect([...repository.records.keys()]).toEqual([1]);
    expect(repository.records.get(1)?.title).toBe("example.test");
    expect(fake.session[STORAGE_KEYS.records]).toEqual({
      "1": expect.objectContaining({ tabId: 1, title: "example.test" })
    });
  });

  it("drains a delayed stale session write before delete-all clears and replaces storage", async () => {
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: { [STORAGE_KEYS.monitoringEpoch]: 1 }
    });
    installFakeBrowser(fake);
    const repository = new StateRepository();
    await repository.ready;
    repository.records.set(1, tabRecord({ updatedAt: NOW }));

    let releaseWrite: (() => void) | undefined;
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    fake.calls.storageSessionSet.mockImplementationOnce(
      async (values: Record<string, unknown>) => {
        await blockedWrite;
        Object.assign(fake.session, structuredClone(values));
      }
    );
    const stalePersist = repository.persistRecords();
    await Promise.resolve();
    const deletion = repository.clearAllRuntimeState();
    let deletionSettled = false;
    void deletion.then(() => {
      deletionSettled = true;
    });
    await Promise.resolve();
    expect(deletionSettled).toBe(false);

    releaseWrite?.();
    await Promise.all([stalePersist, deletion]);

    expect(repository.records.size).toBe(0);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
  });

  it("drains a delayed receipt publication before delete-all commits empty durable state", async () => {
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
        [STORAGE_KEYS.preferences]: { historyRetentionHours: 24 }
      },
      session: { [STORAGE_KEYS.monitoringEpoch]: 1 }
    });
    installFakeBrowser(fake);
    const repository = new StateRepository();
    await repository.ready;

    let releaseReceiptWrite: (() => void) | undefined;
    let signalReceiptWriteStarted: (() => void) | undefined;
    const receiptWriteStarted = new Promise<void>((resolve) => {
      signalReceiptWriteStarted = resolve;
    });
    const blockedReceiptWrite = new Promise<void>((resolve) => {
      releaseReceiptWrite = resolve;
    });
    fake.calls.storageLocalSet.mockImplementation(async (values: Record<string, unknown>) => {
      const receipts = values[STORAGE_KEYS.receipts];
      if (Array.isArray(receipts) && receipts.length > 0) {
        signalReceiptWriteStarted?.();
        await blockedReceiptWrite;
      }
      Object.assign(fake.local, structuredClone(values));
    });

    const publication = repository.addReceipt({
      id: "delayed-receipt",
      operationId: operation().operationId,
      tabId: 1,
      hostname: "example.test",
      action: "discard",
      occurredAt: NOW,
      reasonCodes: [],
      outcome: "success",
      phase: "completed",
      initiator: "manual",
      message: "The tab was unloaded"
    });
    await receiptWriteStarted;

    let deletionSettled = false;
    const deletion = repository.clearAllRuntimeState();
    void deletion.then(() => {
      deletionSettled = true;
    });
    await Promise.resolve();
    expect(deletionSettled).toBe(false);

    releaseReceiptWrite?.();
    await Promise.all([publication, deletion]);

    expect(repository.receipts).toEqual([]);
    expect(repository.operations.size).toBe(0);
    expect(fake.local).toMatchObject({
      [STORAGE_KEYS.preferences]: expect.objectContaining({ monitoringEnabled: false }),
      [STORAGE_KEYS.receipts]: [],
      [STORAGE_KEYS.operations]: [],
      [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION
    });
    expect(fake.session).toMatchObject({
      [STORAGE_KEYS.records]: {},
      [STORAGE_KEYS.tabPolicies]: {},
      [STORAGE_KEYS.monitoringEpoch]: 2
    });
  });

  it("does not resurrect an operation whose delayed put precedes an atomic terminal commit", async () => {
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
        [STORAGE_KEYS.preferences]: { historyRetentionHours: 24 }
      },
      session: { [STORAGE_KEYS.monitoringEpoch]: 5 }
    });
    installFakeBrowser(fake);
    const repository = new StateRepository();
    await repository.ready;

    let releasePut: (() => void) | undefined;
    let signalPutStarted: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      signalPutStarted = resolve;
    });
    const blockedPut = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    fake.calls.storageLocalSet.mockImplementation(async (values: Record<string, unknown>) => {
      if (
        Array.isArray(values[STORAGE_KEYS.operations]) &&
        (values[STORAGE_KEYS.operations] as unknown[]).length > 0 &&
        !Object.prototype.hasOwnProperty.call(values, STORAGE_KEYS.receipts)
      ) {
        signalPutStarted?.();
        await blockedPut;
      }
      Object.assign(fake.local, structuredClone(values));
    });

    const publication = repository.putOperation(operation());
    await putStarted;
    const terminalCommit = repository.commitReceiptAndRemoveOperation(receipt());
    let terminalSettled = false;
    void terminalCommit.then(() => {
      terminalSettled = true;
    });
    await Promise.resolve();
    expect(terminalSettled).toBe(false);

    releasePut?.();
    await Promise.all([publication, terminalCommit]);

    expect(repository.operations.size).toBe(0);
    expect(repository.receipts).toEqual([receipt()]);
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.local[STORAGE_KEYS.receipts]).toEqual([receipt()]);
  });

  it("quarantines all runtime authority written by a future schema", async () => {
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION + 10,
        [STORAGE_KEYS.preferences]: { monitoringIntent: "continuous" }
      },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 7,
        [STORAGE_KEYS.records]: { "1": tabRecord({ monitoringEpoch: 7 }) },
        [STORAGE_KEYS.tabPolicies]: { "1": { tabId: 1, snoozedUntil: NOW + 60_000 } },
        [STORAGE_KEYS.operations]: [operation({ monitoringEpoch: 7 })]
      }
    });
    installFakeBrowser(fake);

    const repository = new StateRepository();
    await repository.ready;

    expect(repository.monitoringEpoch).toBe(8);
    expect(repository.records.size).toBe(0);
    expect(repository.tabPolicies.size).toBe(0);
    expect(repository.operations.size).toBe(0);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect(fake.session[STORAGE_KEYS.operations]).toEqual([]);
  });

  it("caps hydrated records and policies and nulls undersized native document ids", async () => {
    const storedRecords = Object.fromEntries(
      Array.from({ length: MAX_TAB_RECORDS + 5 }, (_, index) => [
        String(index),
        tabRecord({
          tabId: index,
          windowId: 1,
          documentInstanceId: `document-instance-${index}`,
          documentId: index === 0 ? "short" : `native-document-${index}`,
          monitoringEpoch: 3,
          createdAt: NOW - 1_000,
          updatedAt: NOW
        })
      ])
    );
    const storedPolicies = Object.fromEntries(
      Array.from({ length: MAX_TAB_RECORDS + 5 }, (_, index) => [
        String(index),
        { tabId: index, snoozedUntil: NOW + 60_000 }
      ])
    );
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 3,
        [STORAGE_KEYS.records]: storedRecords,
        [STORAGE_KEYS.tabPolicies]: storedPolicies
      }
    });
    installFakeBrowser(fake);

    const repository = new StateRepository();
    await repository.ready;

    expect(repository.records.size).toBe(MAX_TAB_RECORDS);
    expect(repository.tabPolicies.size).toBe(MAX_TAB_RECORDS);
    expect(repository.records.get(0)?.documentId).toBeNull();
    expect(Object.keys(fake.session[STORAGE_KEYS.records] as object)).toHaveLength(MAX_TAB_RECORDS);
    expect(Object.keys(fake.session[STORAGE_KEYS.tabPolicies] as object)).toHaveLength(
      MAX_TAB_RECORDS
    );
  });

  it("caps inspection work for hostile invalid record and policy dictionaries", async () => {
    const invalidRecords: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: MAX_TAB_RECORDS * 4 + 10 }, (_, index) => [
        `invalid-${index}`,
        { tabId: "not-a-number" }
      ])
    );
    const invalidPolicies: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: MAX_TAB_RECORDS * 4 + 10 }, (_, index) => [
        `invalid-${index}`,
        { tabId: -1 }
      ])
    );
    invalidRecords.validAfterInspectionCap = tabRecord({ tabId: 99, monitoringEpoch: 3 });
    invalidPolicies.validAfterInspectionCap = { tabId: 99, snoozedUntil: NOW + 60_000 };
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: {
        [STORAGE_KEYS.monitoringEpoch]: 3,
        [STORAGE_KEYS.records]: invalidRecords,
        [STORAGE_KEYS.tabPolicies]: invalidPolicies
      }
    });
    installFakeBrowser(fake);

    const repository = new StateRepository();
    await repository.ready;

    expect(repository.records.size).toBe(0);
    expect(repository.tabPolicies.size).toBe(0);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
  });

  it("recovers rejected mutation queues and enforces operation ownership before journaling", async () => {
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: { [STORAGE_KEYS.monitoringEpoch]: 5 }
    });
    installFakeBrowser(fake);
    const repository = new StateRepository();
    await repository.ready;

    fake.calls.storageLocalSet.mockRejectedValueOnce(new Error("local write rejected"));
    await expect(repository.updatePreferences({ monitoringEnabled: true })).rejects.toThrow(
      "local write rejected"
    );
    await expect(repository.updatePreferences({ monitoringEnabled: true })).resolves.toMatchObject({
      monitoringEnabled: true,
      monitoringIntent: "continuous"
    });

    fake.calls.storageSessionSet.mockRejectedValueOnce(new Error("session write rejected"));
    await expect(
      repository.upsertTabPolicy({ tabId: 1, snoozedUntil: NOW + 60_000 })
    ).rejects.toThrow("session write rejected");
    await expect(repository.persistTabPolicies()).resolves.toBeUndefined();

    const owned = operation();
    await expect(repository.markOperationRequested(owned, NOW, false)).rejects.toThrow(
      "Recovery operation authority changed before journaling"
    );
    await repository.putOperation(owned);
    await repository.markOperationRequested(owned, NOW + 1, true);
    expect(owned).toMatchObject({
      state: "requested",
      requestedAt: NOW + 1,
      acknowledgedUserEditRisk: true
    });
    await repository.removeOperation(owned.operationId);
    expect(repository.operations.size).toBe(0);
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);

    fake.calls.storageLocalSet.mockRejectedValueOnce(new Error("receipt write rejected"));
    await expect(repository.addReceipt(receipt())).rejects.toThrow("receipt write rejected");
    await expect(repository.addReceipt(receipt())).resolves.toBeUndefined();
    expect(repository.receipts).toHaveLength(1);
  });

  it("restores stable defaults after delete-all drains rejected local, session, and receipt queues", async () => {
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: { [STORAGE_KEYS.monitoringEpoch]: 5 }
    });
    installFakeBrowser(fake);
    const repository = new StateRepository();
    await repository.ready;

    fake.calls.storageSessionSet.mockRejectedValueOnce(new Error("session write failed"));
    await expect(
      repository.upsertTabPolicy({ tabId: 1, snoozedUntil: NOW + 60_000 })
    ).rejects.toThrow("session write failed");
    fake.calls.storageLocalSet.mockRejectedValueOnce(new Error("receipt write failed"));
    await expect(repository.addReceipt(receipt())).rejects.toThrow("receipt write failed");

    await expect(repository.clearAllRuntimeState()).resolves.toBeUndefined();

    expect(repository.records.size).toBe(0);
    expect(repository.tabPolicies.size).toBe(0);
    expect(repository.operations.size).toBe(0);
    expect(repository.receipts).toEqual([]);
    expect(repository.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(fake.local).toMatchObject({
      [STORAGE_KEYS.preferences]: DEFAULT_PREFERENCES,
      [STORAGE_KEYS.receipts]: [],
      [STORAGE_KEYS.operations]: [],
      [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION
    });
    expect(fake.session).toMatchObject({
      [STORAGE_KEYS.records]: {},
      [STORAGE_KEYS.tabPolicies]: {},
      [STORAGE_KEYS.monitoringEpoch]: 6
    });
  });

  it("atomically purges expired receipt journals and clears retained receipt authority", async () => {
    const expiredOperation = operation();
    const retainedOperation = operation({
      operationId: "87654321-4321-4321-8321-cba987654321",
      nonce: "12345678901234567890123456789012"
    });
    const expiredReceipt = receipt({ occurredAt: NOW - 2 * 60 * 60_000 });
    const retainedReceipt = receipt({
      id: "receipt-2",
      operationId: retainedOperation.operationId,
      occurredAt: NOW
    });
    const fake = createFakeWebExtension({
      local: {
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
        [STORAGE_KEYS.preferences]: { historyRetentionHours: 24 }
      },
      session: { [STORAGE_KEYS.monitoringEpoch]: 5 }
    });
    installFakeBrowser(fake);
    const repository = new StateRepository();
    await repository.ready;
    repository.operations.set(expiredOperation.operationId, expiredOperation);
    repository.operations.set(retainedOperation.operationId, retainedOperation);
    repository.receipts = [retainedReceipt, expiredReceipt];

    await repository.purgeExpiredReceipts(NOW + 23 * 60 * 60_000);
    expect(repository.receipts).toEqual([retainedReceipt]);
    expect(repository.operations.has(expiredOperation.operationId)).toBe(false);
    expect(repository.operations.has(retainedOperation.operationId)).toBe(true);

    await repository.clearReceipts();
    expect(repository.receipts).toEqual([]);
    expect(repository.operations.size).toBe(0);
    expect(fake.local).toMatchObject({
      [STORAGE_KEYS.receipts]: [],
      [STORAGE_KEYS.operations]: []
    });
  });

  it("evicts the earliest non-executing authority at the operation bound and fails closed if all are active", async () => {
    const fake = createFakeWebExtension({
      local: { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION },
      session: { [STORAGE_KEYS.monitoringEpoch]: 5 }
    });
    installFakeBrowser(fake);
    const repository = new StateRepository();
    await repository.ready;
    for (let index = 0; index < MAX_RECOVERY_OPERATIONS; index += 1) {
      repository.operations.set(
        `operation-${String(index).padStart(8, "0")}`,
        operation({
          operationId: `operation-${String(index).padStart(8, "0")}`,
          expiresAt: NOW + index + 1
        })
      );
    }
    await repository.putOperation(
      operation({ operationId: "operation-new-authority", expiresAt: NOW + 120_000 })
    );
    expect(repository.operations.size).toBe(MAX_RECOVERY_OPERATIONS);
    expect(repository.operations.has("operation-00000000")).toBe(false);
    expect(repository.operations.has("operation-new-authority")).toBe(true);

    for (const stored of repository.operations.values()) stored.state = "executing";
    await expect(
      repository.putOperation(
        operation({ operationId: "operation-over-capacity", expiresAt: NOW + 180_000 })
      )
    ).rejects.toThrow("Too many recovery operations are active");
  });
});
