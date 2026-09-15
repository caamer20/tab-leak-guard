import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLECTOR_BOOTSTRAP_TIMEOUT_MS,
  COLLECTOR_MESSAGE_TIMEOUT_MS,
  MANUAL_SESSION_READY_TIMEOUT_MS,
  MAX_TAB_RECORDS,
  MONITORED_ORIGINS,
  PROTOCOL_VERSION,
  RECOVERY_PREFLIGHT_MAX_AGE_MS,
  RECOVERY_REQUEST_TIMEOUT_MS,
  RECOVERY_VERIFICATION_TIMEOUT_MS,
  RESET_COOLDOWN_MS,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION
} from "../../src/shared/constants";
import { evaluateSamples } from "../../src/detector/score";
import type {
  CommandResponse,
  ExtensionSnapshot,
  PreparedRecovery,
  Preferences,
  SampleSummary,
  TabRecord
} from "../../src/shared/types";
import { DEFAULT_PREFERENCES } from "../../src/shared/types";
import { safetyFingerprint } from "../../src/recovery/transaction";
import { safeState, sample, tabRecord } from "../helpers";
import {
  createFakeWebExtension,
  installFakeBrowser,
  makeTab,
  makeWindow,
  type FakeWebExtension
} from "../fakes/webextension";

const OPERATION_ID = "12345678-1234-4234-8234-123456789abc";
const NONCE = "abcdefabcdefabcdefabcdefabcdefab";
const MANUAL_AUTHORITY_TOKEN = "87654321-4321-4321-8321-cba987654321";
let fake: FakeWebExtension;

function confirmedEvidence(
  collectorMode: "manual" | "continuous",
  now = Date.now()
): Pick<TabRecord, "samples" | "detector"> {
  const samples = Array.from({ length: 10 }, (_, index) =>
    sample({
      sampleSequence: index,
      documentAgeMs: index * 60_000,
      liveDomNodes: 10_000 + index * 5_000,
      addedNodesSinceLast: index === 0 ? 0 : 6_000,
      removedNodesSinceLast: index === 0 ? 0 : 1_000,
      resourceEntriesSeen: 10 + index * 40,
      resourceActivityCount: 10 + index * 40,
      timerDriftMs: index * 80,
      collectorMode,
      collectorHealth: "healthy",
      sampledAtEpochMs: now - (9 - index) * 60_000
    })
  );
  const options = {
    confirmationScore: DEFAULT_PREFERENCES.confirmationScore,
    minimumSamples: 6,
    minimumDurationMs: 5 * 60_000,
    evaluatedAtEpochMs: now
  };
  let detector = evaluateSamples(samples.slice(0, 8), undefined, options);
  detector = evaluateSamples(samples.slice(0, 9), detector, options);
  detector = evaluateSamples(samples, detector, options);
  if (detector.status !== "confirmed") {
    throw new Error("The confirmed recovery fixture did not reach confirmation");
  }
  return { samples, detector };
}

function seed(
  options: {
    continuous?: boolean;
    withOperation?: boolean;
    manualAuthority?: boolean;
    record?: Partial<TabRecord>;
    operation?: Partial<PreparedRecovery>;
  } = {}
): FakeWebExtension {
  const now = Date.now();
  const continuous = options.continuous === true;
  const preferences: Preferences = {
    ...DEFAULT_PREFERENCES,
    monitoringEnabled: continuous,
    monitoringIntent: continuous ? "continuous" : "manual",
    permissionMode: continuous ? "all-sites" : "manual"
  };
  const evidence = confirmedEvidence(continuous ? "continuous" : "manual", now);
  const record = tabRecord({
    revision: 3,
    createdAt: now - 10_000,
    updatedAt: now,
    lastAccessedAt: now - 10 * 60_000,
    evidenceExpiresAt: now + 120_000,
    monitoringEpoch: 5,
    monitoringMode: continuous ? "continuous" : "manual",
    ...evidence,
    safety: { ...safeState, evaluatedAt: now },
    ...options.record
  });
  const operation: PreparedRecovery = {
    operationId: OPERATION_ID,
    nonce: NONCE,
    tabId: 1,
    windowId: 1,
    documentId: record.documentId,
    documentInstanceId: record.documentInstanceId,
    recordRevision: record.revision,
    monitoringEpoch: 5,
    permissionRevision: 0,
    action: "discard",
    initiator: "manual",
    preparedAt: now,
    expiresAt: now + 60_000,
    evidenceExpiresAt: now + 120_000,
    safetyFingerprint: safetyFingerprint(safeState),
    warnings: [],
    acknowledgedUserEditRisk: false,
    state: "awaiting-consent",
    ...options.operation
  };
  const manualAuthority =
    !continuous && (options.withOperation !== false || options.manualAuthority === true);
  const target = createFakeWebExtension({
    local: {
      [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION,
      [STORAGE_KEYS.preferences]: preferences,
      [STORAGE_KEYS.receipts]: [],
      [STORAGE_KEYS.operations]: options.withOperation === false ? [] : [operation]
    },
    session: {
      [STORAGE_KEYS.monitoringEpoch]: 5,
      [STORAGE_KEYS.records]: { "1": record },
      [STORAGE_KEYS.operations]: [],
      [STORAGE_KEYS.tabPolicies]: manualAuthority
        ? {
            "1": {
              tabId: 1,
              manualSessionStartedAt: now - 1_000,
              manualSessionExpiresAt: now + 15 * 60_000,
              manualSessionToken: MANUAL_AUTHORITY_TOKEN,
              manualSessionDocumentInstanceId: record.documentInstanceId,
              ...(record.documentId ? { manualSessionDocumentId: record.documentId } : {})
            }
          }
        : {}
    },
    tabs: [
      makeTab({
        id: 1,
        windowId: 1,
        active: false,
        lastAccessed: now - 10 * 60_000
      })
    ],
    windows: [makeWindow({ id: 1, state: "normal" })],
    grantedOrigins: continuous ? [...MONITORED_ORIGINS] : []
  });
  target.setContentMessageHandler(async () =>
    validPreflight(continuous ? "continuous" : "manual")
  );
  return target;
}

async function startRuntime(target: FakeWebExtension): Promise<ExtensionSnapshot> {
  const storedOperation = structuredClone(
    (
      (target.local[STORAGE_KEYS.operations] ??
        target.session[STORAGE_KEYS.operations]) as PreparedRecovery[] | undefined
    )?.[0]
  );
  const hasTerminalReceipt = (
    (target.local[STORAGE_KEYS.receipts] as Array<{ operationId?: string }> | undefined) ?? []
  ).some((receipt) => receipt.operationId === storedOperation?.operationId);
  installFakeBrowser(target);
  vi.resetModules();
  await import("../../src/background/index");
  let response = await target.dispatchRuntimeMessage<CommandResponse<ExtensionSnapshot>>({
    type: "GET_SNAPSHOT"
  });
  if (!response.ok) throw new Error(response.error);
  // An awaiting-consent operation is same-worker authority and is intentionally
  // invalidated on worker restart. Most transaction tests need a genuinely live
  // preparation, so issue it through the public command after initialization.
  if (storedOperation?.state === "awaiting-consent" && !hasTerminalReceipt) {
    const randomUuid = vi.spyOn(globalThis.crypto, "randomUUID");
    randomUuid
      .mockReturnValueOnce(storedOperation.operationId as ReturnType<Crypto["randomUUID"]>)
      .mockReturnValueOnce(storedOperation.nonce as ReturnType<Crypto["randomUUID"]>);
    const prepared = await target.dispatchRuntimeMessage<CommandResponse<{
      operationId: string;
      nonce: string;
      action: "discard" | "reload";
    }>>({ type: "PREPARE_RECOVERY", tabId: storedOperation.tabId });
    randomUuid.mockRestore();
    if (!prepared.ok) throw new Error(`Could not prepare live test recovery: ${prepared.error}`);
    if (
      prepared.data.operationId !== storedOperation.operationId ||
      prepared.data.nonce !== storedOperation.nonce ||
      prepared.data.action !== storedOperation.action
    ) {
      throw new Error("Live test recovery did not match the seeded transaction");
    }
    response = await target.dispatchRuntimeMessage<CommandResponse<ExtensionSnapshot>>({
      type: "GET_SNAPSHOT"
    });
    if (!response.ok) throw new Error(response.error);
    target.calls.tabsSendMessage.mockClear();
  }
  return response.data;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("background recovery authority integration", () => {
  it("durably cancels prepared authority and all recovery alarms when monitoring is paused", async () => {
    fake = seed({ continuous: true });
    const cooldownUntil = Date.now() + 60_000;
    const snoozedUntil = Date.now() + 120_000;
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": manualPolicyFor("document-12345678", "firefox-document-12345678"),
      "2": { tabId: 2, cooldownUntil },
      "3": { tabId: 3, snoozedUntil }
    };
    fake.setContentMessageHandler(async () => validPreflight("manual"));
    fake.tabs.set(2, makeTab({ id: 2, url: "https://other.test/" }));
    fake.tabs.set(3, makeTab({ id: 3, url: "https://third.test/" }));
    const snapshot = await startRuntime(fake);
    expect(snapshot.monitoringEpoch).toBe(5);
    expect(snapshot.records).toHaveLength(1);
    fake.alarms.set(`recovery:1:${OPERATION_ID}`, {
      name: `recovery:1:${OPERATION_ID}`,
      scheduledTime: Date.now() + 10_000
    });
    fake.notifications.set("tab-leak-guard:findings", {
      title: "Finding",
      message: "Finding"
    });

    const response = await fake.dispatchRuntimeMessage<CommandResponse<Preferences>>({
      type: "UPDATE_PREFERENCES",
      patch: { monitoringEnabled: false, monitoringIntent: "paused" }
    });

    expect(response).toMatchObject({
      ok: true,
      data: { monitoringEnabled: false, monitoringIntent: "paused" }
    });
    expect(fake.alarms.size).toBe(0);
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({
      "2": { tabId: 2, cooldownUntil },
      "3": { tabId: 3, snoozedUntil }
    });
    expect(fake.session[STORAGE_KEYS.monitoringEpoch]).toBe(6);
    expect(fake.notifications.size).toBe(0);
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      { type: "STOP_COLLECTOR", expectedDocumentInstanceId: "document-12345678" },
      { documentId: "firefox-document-12345678" }
    );
  });

  it("revokes pending authority, alarms, and continuous registration after permission removal", async () => {
    fake = seed({ continuous: true });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": manualPolicyFor("document-12345678", "firefox-document-12345678")
    };
    fake.setContentMessageHandler(async () => validPreflight("manual"));
    await startRuntime(fake);
    fake.alarms.set(`recovery:1:${OPERATION_ID}`, {
      name: `recovery:1:${OPERATION_ID}`,
      scheduledTime: Date.now() + 10_000
    });
    fake.grantedOrigins.clear();

    fake.events.permissionRemoved.emit({ origins: [...MONITORED_ORIGINS] });
    await eventually(() => fake.session[STORAGE_KEYS.monitoringEpoch] === 6);

    expect(fake.local[STORAGE_KEYS.preferences]).toMatchObject({ monitoringEnabled: false });
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect(fake.alarms.size).toBe(0);
    expect(fake.registeredScripts.size).toBe(0);
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: "STOP_COLLECTOR" }),
      { documentId: "firefox-document-12345678" }
    );
  });

  it("cannot act when permission is revoked while the final document preflight is in flight", async () => {
    fake = seed({ continuous: true });
    await startRuntime(fake);
    let preflightCount = 0;
    let releaseFinal: ((value: unknown) => void) | undefined;
    let markFinalStarted: (() => void) | undefined;
    const finalStarted = new Promise<void>((resolve) => {
      markFinalStarted = resolve;
    });
    const preflight = () => ({
      ok: true,
      data: {
        documentInstanceId: "document-12345678",
        userEditState: "no-edits-observed",
        capturedAtMonotonicMs: performance.now(),
        collectorMode: "continuous",
        collectorHealth: "healthy",
        sessionExpiresAtMonotonicMs: null,
        authorityToken: null
      }
    });
    fake.setContentMessageHandler(async (_tabId, message) => {
      if ((message as { type?: string }).type !== "GET_RECOVERY_PREFLIGHT") {
        return { ok: true, data: { stopped: true } };
      }
      preflightCount += 1;
      if (preflightCount !== 2) return preflight();
      markFinalStarted?.();
      return new Promise((resolve) => {
        releaseFinal = resolve;
      });
    });

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await finalStarted;
    fake.grantedOrigins.clear();
    fake.events.permissionRemoved.emit({ origins: [...MONITORED_ORIGINS] });
    await eventually(() => fake.session[STORAGE_KEYS.monitoringEpoch] === 6);
    releaseFinal?.(preflight());
    const response = await execution;

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toMatch(/stale|Monitoring state changed/i);
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
  });

  it("fences the final action on the synchronous permission revision and waits for notification revocation", async () => {
    fake = seed({ continuous: true });
    await startRuntime(fake);
    let preflightCount = 0;
    let releaseFinal: ((value: unknown) => void) | undefined;
    let signalFinalStarted: (() => void) | undefined;
    const finalStarted = new Promise<void>((resolve) => {
      signalFinalStarted = resolve;
    });
    fake.setContentMessageHandler(async (_tabId, message) => {
      if ((message as { type?: string }).type !== "GET_RECOVERY_PREFLIGHT") {
        return { ok: true, data: { stopped: true } };
      }
      preflightCount += 1;
      if (preflightCount === 1) return validPreflight("continuous");
      signalFinalStarted?.();
      return new Promise((resolve) => {
        releaseFinal = resolve;
      });
    });
    let releaseNotificationClear: ((cleared: boolean) => void) | undefined;
    let signalNotificationClearStarted: (() => void) | undefined;
    const notificationClearStarted = new Promise<void>((resolve) => {
      signalNotificationClearStarted = resolve;
    });
    fake.calls.notificationClear.mockImplementationOnce(
      (id: string) =>
        new Promise<boolean>((resolve) => {
          signalNotificationClearStarted?.();
          releaseNotificationClear = (cleared) => {
            fake.notifications.delete(id);
            resolve(cleared);
          };
        })
    );

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await finalStarted;
    fake.events.permissionAdded.emit({ origins: [...MONITORED_ORIGINS] });
    await notificationClearStarted;
    releaseFinal?.(validPreflight("continuous"));
    await drainMicrotasksUntil(
      () => (fake.local[STORAGE_KEYS.receipts] as unknown[]).length === 1
    );

    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    releaseNotificationClear?.(true);
    expect(await execution).toEqual({
      ok: false,
      error: "Recovery authority was revoked before the browser action"
    });
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "blocked",
      phase: "blocked"
    });
  });

  it("keeps permission reads fail-closed until the serialized notification clear settles", async () => {
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    fake.notifications.set("tab-leak-guard:findings", {
      title: "Possible runaway tab growth",
      message: "A private site-specific finding"
    });
    const permissionReadsBeforeEvent = fake.calls.permissionGetAll.mock.calls.length;
    let releaseNotificationClear: ((cleared: boolean) => void) | undefined;
    let signalNotificationClearStarted: (() => void) | undefined;
    const notificationClearStarted = new Promise<void>((resolve) => {
      signalNotificationClearStarted = resolve;
    });
    fake.calls.notificationClear.mockImplementationOnce(
      (id: string) =>
        new Promise<boolean>((resolve) => {
          signalNotificationClearStarted?.();
          releaseNotificationClear = (cleared) => {
            fake.notifications.delete(id);
            resolve(cleared);
          };
        })
    );

    fake.events.permissionAdded.emit({ origins: [...MONITORED_ORIGINS] });
    await notificationClearStarted;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "GET_SNAPSHOT" })
    ).toEqual({
      ok: false,
      error: "Firefox website permissions are changing; try again when reconciliation finishes"
    });
    expect(fake.calls.permissionGetAll).toHaveBeenCalledTimes(permissionReadsBeforeEvent);
    expect(fake.notifications.has("tab-leak-guard:findings")).toBe(true);

    releaseNotificationClear?.(true);
    await drainMicrotasksUntil(
      () => fake.calls.permissionGetAll.mock.calls.length > permissionReadsBeforeEvent
    );
    await fake.flush();
    expect(fake.notifications.has("tab-leak-guard:findings")).toBe(false);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "GET_SNAPSHOT" })
    ).toMatchObject({ ok: true });
  });

  it("retries permission reconciliation after notification revocation initially rejects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    fake.calls.notificationClear.mockRejectedValueOnce(
      new Error("notification service temporarily unavailable")
    );
    const permissionReadsBeforeEvent = fake.calls.permissionGetAll.mock.calls.length;

    fake.events.permissionAdded.emit({ origins: [...MONITORED_ORIGINS] });
    await drainMicrotasksUntil(() => fake.calls.notificationClear.mock.calls.length === 1);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "GET_SNAPSHOT" })
    ).toMatchObject({ ok: false, error: expect.stringContaining("permissions are changing") });

    await vi.advanceTimersByTimeAsync(250);
    await drainMicrotasksUntil(() => fake.calls.notificationClear.mock.calls.length === 2);
    await drainMicrotasksUntil(
      () => fake.calls.permissionGetAll.mock.calls.length > permissionReadsBeforeEvent
    );
    await Promise.resolve();
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "GET_SNAPSHOT" })
    ).toMatchObject({ ok: true });
  });

  it("blocks a delayed final preflight when a loading event installs a navigation fence", async () => {
    fake = seed();
    await startRuntime(fake);
    let preflightCount = 0;
    let releaseFinal: ((value: unknown) => void) | undefined;
    let signalFinalStarted: (() => void) | undefined;
    const finalStarted = new Promise<void>((resolve) => {
      signalFinalStarted = resolve;
    });
    fake.setContentMessageHandler(async (_tabId, message) => {
      if ((message as { type?: string }).type !== "GET_RECOVERY_PREFLIGHT") {
        return { ok: true, data: { stopped: true } };
      }
      preflightCount += 1;
      if (preflightCount === 1) return validPreflight("manual");
      signalFinalStarted?.();
      return new Promise((resolve) => {
        releaseFinal = resolve;
      });
    });

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await finalStarted;
    const tab = fake.tabs.get(1);
    if (!tab) throw new Error("Navigating tab is unavailable");
    fake.events.tabUpdated.emit(1, { status: "loading" }, structuredClone(tab));
    releaseFinal?.(validPreflight("manual"));

    expect(await execution).toEqual({
      ok: false,
      error: "The finding changed after recovery was prepared"
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "blocked",
      phase: "blocked"
    });
  });

  it("blocks the inactive-to-active race at the final preflight without reloading or unloading", async () => {
    fake = seed();
    await startRuntime(fake);
    let preflightCount = 0;
    fake.setContentMessageHandler(async (_tabId, message) => {
      if ((message as { type?: string }).type === "GET_RECOVERY_PREFLIGHT") {
        preflightCount += 1;
        if (preflightCount === 1) {
          const liveTab = fake.tabs.get(1);
          if (liveTab) liveTab.active = true;
        }
      }
      return {
        ok: true,
        data: {
          documentInstanceId: "document-12345678",
          userEditState: "no-edits-observed",
          capturedAtMonotonicMs: performance.now(),
          collectorMode: "manual",
          collectorHealth: "healthy",
          sessionExpiresAtMonotonicMs: null,
          authorityToken: MANUAL_AUTHORITY_TOKEN
        }
      };
    });

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toMatchObject({
      ok: false,
      error: "Tab state changed; discard consent cannot authorize reload"
    });
    expect(preflightCount).toBe(2);
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
  });

  it("consumes a recovery token once and verifies a successful unload before recording success", async () => {
    fake = seed();
    await startRuntime(fake);
    fake.setContentMessageHandler(async () => ({
      ok: true,
      data: {
        documentInstanceId: "document-12345678",
        userEditState: "no-edits-observed",
        capturedAtMonotonicMs: performance.now(),
        collectorMode: "manual",
        collectorHealth: "healthy",
        sessionExpiresAtMonotonicMs: null,
        authorityToken: MANUAL_AUTHORITY_TOKEN
      }
    }));

    const command = {
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    };
    const first = await fake.dispatchRuntimeMessage<CommandResponse>(command);
    const second = await fake.dispatchRuntimeMessage<CommandResponse>(command);

    expect(first).toEqual({ ok: true, data: { action: "discard", phase: "completed" } });
    expect(second).toMatchObject({
      ok: false,
      error: "Recovery confirmation is missing or expired"
    });
    expect(fake.calls.tabsDiscard).toHaveBeenCalledTimes(1);
    expect(fake.tabs.get(1)?.discarded).toBe(true);
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "completed"
    );
  });

  it("persists the requested recovery journal before Firefox receives the destructive tab call", async () => {
    fake = seed();
    let releaseDiscard: (() => void) | undefined;
    fake.calls.tabsDiscard.mockImplementationOnce(
      (tabId: number) =>
        new Promise<browser.tabs.Tab>((resolve) => {
          releaseDiscard = () => {
            const tab = fake.tabs.get(tabId);
            if (!tab) throw new Error("Discarded tab is unavailable");
            tab.discarded = true;
            resolve(structuredClone(tab));
          };
        })
    );
    await startRuntime(fake);

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await drainMicrotasksUntil(() => fake.calls.tabsDiscard.mock.calls.length === 1);

    const storedOperation = (fake.local[STORAGE_KEYS.operations] as PreparedRecovery[])[0];
    const storedRecord = (fake.session[STORAGE_KEYS.records] as Record<string, TabRecord>)["1"];
    expect(storedOperation).toMatchObject({
      operationId: OPERATION_ID,
      state: "requested",
      requestedAt: expect.any(Number)
    });
    expect(storedRecord?.recovery).toEqual({ status: "requested", operationId: OPERATION_ID });
    expect(storedRecord?.pendingResetAt).toBeUndefined();

    releaseDiscard?.();
    expect(await execution).toEqual({
      ok: true,
      data: { action: "discard", phase: "completed" }
    });
  });

  it("atomically replaces a requested journal with a blocked receipt when session publication fails before the tab API", async () => {
    fake = seed();
    await startRuntime(fake);
    fake.calls.storageSessionSet.mockRejectedValueOnce(
      new Error("requested record publication failed")
    );

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toEqual({
      ok: false,
      error:
        "Recovery was not sent because its durable request journal could not be completed: requested record publication failed"
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "blocked",
      phase: "blocked",
      requestedAt: expect.any(Number)
    });
    expect((await snapshotOf(fake)).records[0]).toMatchObject({
      recovery: {
        status: "blocked",
        blockedReason: expect.stringContaining("requested record publication failed")
      }
    });
  });

  it("rejects a queued cancellation after completed execution without adding a no-action receipt", async () => {
    fake = seed();
    let releaseDiscard: (() => void) | undefined;
    fake.calls.tabsDiscard.mockImplementationOnce(
      (tabId: number) =>
        new Promise<browser.tabs.Tab>((resolve) => {
          releaseDiscard = () => {
            const tab = fake.tabs.get(tabId);
            if (!tab) throw new Error("Discarded tab is unavailable");
            tab.discarded = true;
            resolve(structuredClone(tab));
          };
        })
    );
    await startRuntime(fake);

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await drainMicrotasksUntil(() => fake.calls.tabsDiscard.mock.calls.length === 1);
    const cancellation = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "CANCEL_RECOVERY",
      operationId: OPERATION_ID
    });

    releaseDiscard?.();
    expect(await execution).toEqual({
      ok: true,
      data: { action: "discard", phase: "completed" }
    });
    expect(await cancellation).toEqual({
      ok: false,
      error: "The recovery action already completed and was not cancelled"
    });
    expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "success",
      phase: "completed"
    });
    expect((await snapshotOf(fake)).records[0]).toMatchObject({
      recovery: { status: "cooldown" },
      cooldownUntil: expect.any(Number)
    });
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toMatchObject({
      "1": { cooldownUntil: expect.any(Number) }
    });
  });

  it("returns a neutral cancellation error after a successful action when receipt history is disabled", async () => {
    fake = seed();
    fake.local[STORAGE_KEYS.preferences] = {
      ...(fake.local[STORAGE_KEYS.preferences] as Preferences),
      historyRetentionHours: 0
    };
    let releaseDiscard: (() => void) | undefined;
    fake.calls.tabsDiscard.mockImplementationOnce(
      (tabId: number) =>
        new Promise<browser.tabs.Tab>((resolve) => {
          releaseDiscard = () => {
            const tab = fake.tabs.get(tabId);
            if (!tab) throw new Error("Discarded tab is unavailable");
            tab.discarded = true;
            resolve(structuredClone(tab));
          };
        })
    );
    await startRuntime(fake);
    fake.calls.storageLocalSet.mockClear();

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await drainMicrotasksUntil(() => fake.calls.tabsDiscard.mock.calls.length === 1);
    const cancellation = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "CANCEL_RECOVERY",
      operationId: OPERATION_ID
    });

    releaseDiscard?.();
    expect(await execution).toEqual({
      ok: true,
      data: { action: "discard", phase: "completed" }
    });
    expect(await cancellation).toEqual({
      ok: false,
      error: "Recovery is no longer pending; no cancellation was applied"
    });
    expect(fake.local[STORAGE_KEYS.receipts]).toEqual([]);
    const atomicTerminalCommit = fake.calls.storageLocalSet.mock.calls.find(
      ([values]) =>
        Object.prototype.hasOwnProperty.call(values, STORAGE_KEYS.receipts) &&
        Object.prototype.hasOwnProperty.call(values, STORAGE_KEYS.operations)
    )?.[0] as Record<string, unknown> | undefined;
    expect(atomicTerminalCommit).toMatchObject({
      [STORAGE_KEYS.receipts]: [],
      [STORAGE_KEYS.operations]: []
    });
    expect((await snapshotOf(fake)).records[0]).toMatchObject({
      recovery: { status: "cooldown" },
      cooldownUntil: expect.any(Number)
    });
  });

  it.each(["discard", "reload"] as const)(
    "drains a delayed %s and all resulting lifecycle work before delete-all returns",
    async (action) => {
      fake = seed();
      const liveTab = fake.tabs.get(1);
      const operation = (fake.local[STORAGE_KEYS.operations] as PreparedRecovery[])[0];
      if (!liveTab || !operation) throw new Error("Missing seeded recovery state");
      if (action === "reload") {
        liveTab.active = true;
        operation.action = "reload";
        operation.safetyFingerprint = safetyFingerprint({ ...safeState, active: true });
      }

      let releaseAction: (() => void) | undefined;
      if (action === "discard") {
        fake.calls.tabsDiscard.mockImplementationOnce(
          (tabId: number) =>
            new Promise<browser.tabs.Tab>((resolve) => {
              releaseAction = () => {
                const tab = fake.tabs.get(tabId);
                if (!tab) throw new Error("Discarded tab is unavailable");
                tab.discarded = true;
                resolve(structuredClone(tab));
              };
            })
        );
      } else {
        fake.calls.tabsReload.mockImplementationOnce(
          (tabId: number) =>
            new Promise<void>((resolve) => {
              releaseAction = () => {
                const tab = fake.tabs.get(tabId);
                if (!tab) throw new Error("Reloaded tab is unavailable");
                tab.status = "loading";
                fake.events.committed.emit({
                  tabId,
                  frameId: 0,
                  url: tab.url ?? "",
                  timeStamp: Date.now(),
                  transitionType: "reload",
                  transitionQualifiers: []
                });
                tab.status = "complete";
                fake.events.completed.emit({
                  tabId,
                  frameId: 0,
                  url: tab.url ?? "",
                  timeStamp: Date.now()
                });
                resolve();
              };
            })
        );
      }
      await startRuntime(fake);

      const execution = fake.dispatchRuntimeMessage<CommandResponse>({
        type: "EXECUTE_RECOVERY",
        operationId: OPERATION_ID,
        nonce: NONCE
      });
      const actionCall = action === "discard" ? fake.calls.tabsDiscard : fake.calls.tabsReload;
      await drainMicrotasksUntil(() => actionCall.mock.calls.length === 1);
      let deletionSettled = false;
      const deletion = fake.dispatchRuntimeMessage<CommandResponse>({ type: "DELETE_ALL_DATA" });
      void deletion.then(() => {
        deletionSettled = true;
      });
      expect(
        await fake.dispatchRuntimeMessage<CommandResponse>({ type: "GET_SNAPSHOT" })
      ).toEqual({ ok: false, error: "Local extension data is being deleted" });
      expect(deletionSettled).toBe(false);

      releaseAction?.();
      expect(await execution).toEqual({
        ok: true,
        data: { action, phase: "completed" }
      });
      expect(await deletion).toMatchObject({
        ok: true,
        data: { permissionsRetainedByFirefox: true }
      });
      expect(actionCall).toHaveBeenCalledTimes(1);
      expect(fake.local).toMatchObject({
        [STORAGE_KEYS.preferences]: DEFAULT_PREFERENCES,
        [STORAGE_KEYS.receipts]: [],
        [STORAGE_KEYS.operations]: [],
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION
      });
      expect(fake.session).toMatchObject({
        [STORAGE_KEYS.records]: {},
        [STORAGE_KEYS.tabPolicies]: {},
        [STORAGE_KEYS.monitoringEpoch]: expect.any(Number)
      });

      const stableLocal = structuredClone(fake.local);
      const stableSession = structuredClone(fake.session);
      await fake.flush();
      expect(fake.local).toEqual(stableLocal);
      expect(fake.session).toEqual(stableSession);
    }
  );

  it("does not admit navigation or recovery-alarm work while delete-all is draining", async () => {
    fake = seed();
    let releaseDiscard: (() => void) | undefined;
    fake.calls.tabsDiscard.mockImplementationOnce(
      (tabId: number) =>
        new Promise<browser.tabs.Tab>((resolve) => {
          releaseDiscard = () => {
            const tab = fake.tabs.get(tabId);
            if (!tab) throw new Error("Discarded tab is unavailable");
            tab.discarded = true;
            resolve(structuredClone(tab));
          };
        })
    );
    await startRuntime(fake);

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await drainMicrotasksUntil(() => fake.calls.tabsDiscard.mock.calls.length === 1);
    const alarmName = `recovery:1:${OPERATION_ID}`;
    fake.alarms.set(alarmName, { name: alarmName, scheduledTime: Date.now() });
    const deletion = fake.dispatchRuntimeMessage<CommandResponse>({ type: "DELETE_ALL_DATA" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "GET_SNAPSHOT" })
    ).toEqual({ ok: false, error: "Local extension data is being deleted" });

    const recordBeforeEvents = structuredClone(
      (fake.session[STORAGE_KEYS.records] as Record<string, TabRecord>)["1"]
    );
    const alarmClearCallsBeforeEvents = fake.calls.alarmClear.mock.calls.length;
    const tab = fake.tabs.get(1);
    if (!tab) throw new Error("Navigating tab is unavailable");
    fake.events.tabUpdated.emit(1, { status: "loading" }, structuredClone(tab));
    fake.events.committed.emit({
      tabId: 1,
      frameId: 0,
      url: "https://example.test/during-delete",
      timeStamp: Date.now(),
      transitionType: "link",
      transitionQualifiers: []
    });
    fake.events.historyStateUpdated.emit({
      tabId: 1,
      frameId: 0,
      url: "https://example.test/during-delete#history",
      timeStamp: Date.now(),
      transitionType: "link",
      transitionQualifiers: []
    });
    fake.events.alarm.emit({ name: alarmName, scheduledTime: Date.now() });
    await fake.flush();

    expect((fake.session[STORAGE_KEYS.records] as Record<string, TabRecord>)["1"]).toEqual(
      recordBeforeEvents
    );
    expect((fake.local[STORAGE_KEYS.operations] as PreparedRecovery[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      state: "requested"
    });
    expect(fake.calls.alarmClear).toHaveBeenCalledTimes(alarmClearCallsBeforeEvents);

    releaseDiscard?.();
    expect(await execution).toEqual({
      ok: false,
      error:
        "Firefox accepted the unload request, but the consent-bound document changed or was loaded during verification; whether an unload occurred is unknown"
    });
    expect(await deletion).toMatchObject({ ok: true });
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect(fake.local[STORAGE_KEYS.receipts]).toEqual([]);

    const stableSession = structuredClone(fake.session);
    await fake.flush();
    expect(fake.session).toEqual(stableSession);
  });

  it("revokes the mutation generation before the final preflight can reach a tab API", async () => {
    fake = seed();
    await startRuntime(fake);
    let preflightCount = 0;
    let releaseFinal: ((value: unknown) => void) | undefined;
    let signalFinalStarted: (() => void) | undefined;
    const finalStarted = new Promise<void>((resolve) => {
      signalFinalStarted = resolve;
    });
    fake.setContentMessageHandler(async (_tabId, message) => {
      if ((message as { type?: string }).type !== "GET_RECOVERY_PREFLIGHT") {
        return { ok: true, data: { stopped: true } };
      }
      preflightCount += 1;
      if (preflightCount === 1) return validPreflight("manual");
      signalFinalStarted?.();
      return new Promise((resolve) => {
        releaseFinal = resolve;
      });
    });
    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await finalStarted;
    const deletion = fake.dispatchRuntimeMessage<CommandResponse>({ type: "DELETE_ALL_DATA" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "GET_SNAPSHOT" })
    ).toEqual({ ok: false, error: "Local extension data is being deleted" });
    releaseFinal?.(validPreflight("manual"));

    expect(await execution).toMatchObject({
      ok: false,
      error: expect.stringContaining("revoked before the browser action")
    });
    expect(await deletion).toMatchObject({ ok: true });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.local[STORAGE_KEYS.receipts]).toEqual([]);
  });

  it("executes only the explicitly prepared reload and verifies its loading-to-complete lifecycle", async () => {
    fake = seed();
    const activeSafety = { ...safeState, active: true };
    const liveTab = fake.tabs.get(1);
    if (liveTab) liveTab.active = true;
    const storedOperations = fake.local[STORAGE_KEYS.operations] as PreparedRecovery[];
    const stored = storedOperations[0];
    if (!stored) throw new Error("Missing seeded operation");
    stored.action = "reload";
    stored.safetyFingerprint = safetyFingerprint(activeSafety);
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toEqual({ ok: true, data: { action: "reload", phase: "completed" } });
    expect(fake.calls.tabsReload).toHaveBeenCalledWith(1, { bypassCache: false });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "completed"
    );
  });

  it("reports an unknown outcome and cooldown when a loaded tab cannot prove accepted unload", async () => {
    fake = seed();
    fake.calls.tabsDiscard.mockImplementation(async () => fake.tabs.get(1));
    await startRuntime(fake);
    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("whether an unload occurred is unknown")
    });
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      outcome: "unknown",
      phase: "verification-timed-out"
    });
    expect((await snapshotOf(fake)).records[0]).toMatchObject({
      recovery: { status: "cooldown" },
      cooldownUntil: expect.any(Number)
    });
  });

  it("records one unknown outcome when an accepted discard is activated and restored before verification", async () => {
    fake = seed();
    fake.calls.tabsDiscard.mockImplementationOnce(async (tabId: number) => {
      const tab = fake.tabs.get(tabId);
      if (!tab) throw new Error("Discarded tab is unavailable");
      tab.discarded = true;
      const accepted = structuredClone(tab);
      tab.active = true;
      tab.discarded = false;
      fake.events.tabActivated.emit({ tabId, windowId: tab.windowId ?? 1 });
      return accepted;
    });
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toEqual({
      ok: false,
      error:
        "Firefox accepted the unload request, but the consent-bound document changed or was loaded during verification; whether an unload occurred is unknown"
    });
    expect(fake.calls.tabsDiscard).toHaveBeenCalledTimes(1);
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "unknown",
      phase: "verification-timed-out"
    });
    expect((await snapshotOf(fake)).records[0]).toMatchObject({
      recovery: { status: "cooldown" },
      cooldownUntil: expect.any(Number)
    });
  });

  it("records an unknown outcome when navigation is marked after Firefox accepts discard", async () => {
    fake = seed();
    fake.calls.tabsDiscard.mockImplementationOnce(async (tabId: number) => {
      const tab = fake.tabs.get(tabId);
      if (!tab) throw new Error("Discarded tab is unavailable");
      tab.discarded = true;
      fake.events.committed.emit({
        tabId,
        frameId: 0,
        url: "https://example.test/navigated-after-discard",
        timeStamp: Date.now(),
        transitionType: "link",
        transitionQualifiers: []
      });
      return structuredClone(tab);
    });
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toEqual({
      ok: false,
      error:
        "Firefox accepted the unload request, but the consent-bound document changed or was loaded during verification; whether an unload occurred is unknown"
    });
    expect(fake.calls.tabsDiscard).toHaveBeenCalledTimes(1);
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "unknown",
      phase: "verification-timed-out"
    });
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toMatchObject({
      "1": { cooldownUntil: expect.any(Number) }
    });
    await eventually(
      () => Object.keys(fake.session[STORAGE_KEYS.records] as object).length === 0
    );
  });

  it("times out a delayed post-discard tab lookup as unknown without retrying the action", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed();
    await startRuntime(fake);
    const liveTab = fake.tabs.get(1);
    if (!liveTab) throw new Error("Recovery tab is unavailable");
    vi.mocked(fake.browser.tabs.get)
      .mockResolvedValueOnce(structuredClone(liveTab))
      .mockResolvedValueOnce(structuredClone(liveTab))
      .mockResolvedValueOnce(structuredClone(liveTab))
      .mockResolvedValueOnce(structuredClone(liveTab))
      .mockImplementationOnce(() => new Promise(() => undefined));

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await drainMicrotasksUntil(() => fake.calls.tabsDiscard.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(RECOVERY_VERIFICATION_TIMEOUT_MS + 1);

    expect(await execution).toEqual({
      ok: false,
      error:
        "Firefox accepted the unload request, but its result could not be verified: Firefox did not return the unloaded tab state in time"
    });
    expect(fake.calls.tabsDiscard).toHaveBeenCalledTimes(1);
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "unknown",
      phase: "verification-timed-out",
      requestedAt: expect.any(Number)
    });
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toMatchObject({
      "1": { cooldownUntil: expect.any(Number) }
    });
  });

  it("records a request failure without retrying or changing the action", async () => {
    fake = seed();
    fake.calls.tabsDiscard.mockRejectedValueOnce(new Error("discard denied"));
    await startRuntime(fake);
    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    expect(response).toEqual({ ok: false, error: "discard denied" });
    expect(fake.calls.tabsDiscard).toHaveBeenCalledTimes(1);
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      outcome: "failed",
      phase: "request-failed",
      requestedAt: expect.any(Number)
    });
  });

  it.each(["discard", "reload"] as const)(
    "treats an unacknowledged %s request as unknown and never retries it",
    async (action) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
      fake = seed();
      const tab = fake.tabs.get(1);
      const operation = (fake.local[STORAGE_KEYS.operations] as PreparedRecovery[])[0];
      if (!tab || !operation) throw new Error("Missing seeded recovery state");
      if (action === "reload") {
        tab.active = true;
        operation.action = "reload";
        operation.safetyFingerprint = safetyFingerprint({ ...safeState, active: true });
        fake.calls.tabsReload.mockImplementationOnce(() => new Promise(() => undefined));
      } else {
        fake.calls.tabsDiscard.mockImplementationOnce(() => new Promise(() => undefined));
      }
      await startRuntime(fake);

      const execution = fake.dispatchRuntimeMessage<CommandResponse>({
        type: "EXECUTE_RECOVERY",
        operationId: OPERATION_ID,
        nonce: NONCE
      });
      const actionCall = action === "discard" ? fake.calls.tabsDiscard : fake.calls.tabsReload;
      await drainMicrotasksUntil(() => actionCall.mock.calls.length === 1);
      await vi.advanceTimersByTimeAsync(RECOVERY_REQUEST_TIMEOUT_MS + 1);
      const response = await execution;

      expect(response).toMatchObject({
        ok: false,
        error: expect.stringContaining("whether it will still run is unknown")
      });
      expect(actionCall).toHaveBeenCalledTimes(1);
      expect(fake.calls.tabsDiscard).toHaveBeenCalledTimes(action === "discard" ? 1 : 0);
      expect(fake.calls.tabsReload).toHaveBeenCalledTimes(action === "reload" ? 1 : 0);
      expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
      expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
        operationId: OPERATION_ID,
        outcome: "unknown",
        phase: "verification-timed-out",
        requestedAt: expect.any(Number)
      });
      expect((await snapshotOf(fake)).records[0]).toMatchObject({
        recovery: { status: "cooldown" },
        cooldownUntil: expect.any(Number)
      });
    }
  );

  it("records an unknown verification outcome when Firefox accepts discard but tab lookup fails", async () => {
    fake = seed();
    fake.calls.tabsDiscard.mockImplementationOnce(async (tabId: number) => {
      const tab = fake.tabs.get(tabId);
      if (!tab) throw new Error("Discarded tab is unavailable");
      tab.discarded = true;
      vi.mocked(fake.browser.tabs.get).mockRejectedValueOnce(
        new Error("tab lookup became unavailable")
      );
      return structuredClone(tab);
    });
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toEqual({
      ok: false,
      error:
        "Firefox accepted the unload request, but its result could not be verified: tab lookup became unavailable"
    });
    expect(fake.calls.tabsDiscard).toHaveBeenCalledTimes(1);
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "unknown",
      phase: "verification-timed-out",
      requestedAt: expect.any(Number)
    });
  });

  it.each([
    ["completed", "notification"],
    ["completed", "badge"],
    ["unknown", "notification"],
    ["unknown", "badge"],
    ["failed", "notification"],
    ["failed", "badge"]
  ] as const)(
    "preserves the exact %s recovery result and receipt when a %s API rejects",
    async (outcome, failingApi) => {
      fake = seed();
      if (outcome === "unknown") {
        fake.calls.tabsDiscard.mockImplementationOnce(async () => fake.tabs.get(1));
      } else if (outcome === "failed") {
        fake.calls.tabsDiscard.mockRejectedValueOnce(new Error("discard denied"));
      }
      await startRuntime(fake);
      if (failingApi === "notification") {
        fake.calls.notificationClear.mockRejectedValue(new Error("notification cleanup failed"));
      } else {
        fake.calls.badgeText.mockRejectedValue(new Error("badge update failed"));
      }

      const response = await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "EXECUTE_RECOVERY",
        operationId: OPERATION_ID,
        nonce: NONCE
      });

      if (outcome === "completed") {
        expect(response).toEqual({
          ok: true,
          data: { action: "discard", phase: "completed" }
        });
      } else if (outcome === "unknown") {
        expect(response).toEqual({
          ok: false,
          error:
            "Firefox accepted the unload request, but the consent-bound document changed or was loaded during verification; whether an unload occurred is unknown"
        });
      } else {
        expect(response).toEqual({ ok: false, error: "discard denied" });
      }
      expect(fake.calls.tabsDiscard).toHaveBeenCalledTimes(1);
      expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
      expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
        operationId: OPERATION_ID,
        outcome: outcome === "completed" ? "success" : outcome,
        phase:
          outcome === "completed"
            ? "completed"
            : outcome === "unknown"
              ? "verification-timed-out"
              : "request-failed"
      });
      expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    }
  );

  it.each(["transient", "persistent"] as const)(
    "preserves an accepted unload when receipt storage has a %s failure",
    async (failure) => {
      fake = seed();
      await startRuntime(fake);
      let receiptAttempts = 0;
      fake.calls.storageLocalSet.mockImplementation(async (values: Record<string, unknown>) => {
        const receipts = values[STORAGE_KEYS.receipts];
        if (Array.isArray(receipts) && receipts.length > 0) {
          receiptAttempts += 1;
          if (failure === "persistent" || receiptAttempts === 1) {
            throw new Error("receipt storage unavailable");
          }
        }
        Object.assign(fake.local, structuredClone(values));
      });

      const response = await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "EXECUTE_RECOVERY",
        operationId: OPERATION_ID,
        nonce: NONCE
      });

      expect(fake.calls.tabsDiscard).toHaveBeenCalledTimes(1);
      expect(fake.tabs.get(1)?.discarded).toBe(true);
      expect(receiptAttempts).toBe(2);
      expect((await snapshotOf(fake)).records[0]).toMatchObject({
        recovery: { status: "cooldown" },
        cooldownUntil: expect.any(Number)
      });
      if (failure === "transient") {
        expect(response).toEqual({
          ok: true,
          data: { action: "discard", phase: "completed" }
        });
        expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
        expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
      } else {
        expect(response).toMatchObject({
          ok: false,
          error: expect.stringContaining("local receipt could not be fully saved")
        });
        expect(fake.local[STORAGE_KEYS.receipts]).toEqual([]);
        expect((fake.local[STORAGE_KEYS.operations] as unknown[])[0]).toMatchObject({
          operationId: OPERATION_ID,
          state: "terminal"
        });
      }
    }
  );

  it("cancels a manual operation rather than acting when a recovery alarm is forged or stale", async () => {
    fake = seed();
    await startRuntime(fake);
    const name = `recovery:1:${OPERATION_ID}`;
    fake.alarms.set(name, { name, scheduledTime: Date.now() });

    fake.events.alarm.emit({ name, scheduledTime: Date.now() });
    await eventually(() => (fake.local[STORAGE_KEYS.operations] as unknown[]).length === 0);

    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect(fake.alarms.has(name)).toBe(false);
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "cancelled"
    );
  });

  it("records reload API rejection as a request failure and detaches verification listeners", async () => {
    fake = seed();
    const activeSafety = { ...safeState, active: true };
    const liveTab = fake.tabs.get(1);
    if (liveTab) liveTab.active = true;
    const operation = (fake.local[STORAGE_KEYS.operations] as PreparedRecovery[])[0];
    if (!operation) throw new Error("Missing seeded operation");
    operation.action = "reload";
    operation.safetyFingerprint = safetyFingerprint(activeSafety);
    fake.calls.tabsReload.mockRejectedValueOnce(new Error("reload denied"));
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toEqual({ ok: false, error: "reload denied" });
    expect(fake.calls.tabsReload).toHaveBeenCalledTimes(1);
    expect(fake.events.tabUpdated.listeners.size).toBe(1);
    expect(fake.events.tabRemoved.listeners.size).toBe(1);
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "request-failed"
    );
  });

  it("fails closed when Firefox accepts a reload but never proves loading-to-complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed();
    const activeSafety = { ...safeState, active: true };
    const liveTab = fake.tabs.get(1);
    if (liveTab) liveTab.active = true;
    const operation = (fake.local[STORAGE_KEYS.operations] as PreparedRecovery[])[0];
    if (!operation) throw new Error("Missing seeded operation");
    operation.action = "reload";
    operation.safetyFingerprint = safetyFingerprint(activeSafety);
    fake.calls.tabsReload.mockResolvedValueOnce(undefined);
    await startRuntime(fake);

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await drainMicrotasksUntil(() => fake.calls.tabsReload.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(RECOVERY_VERIFICATION_TIMEOUT_MS);
    const response = await execution;

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("outcome is unknown")
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "verification-timed-out"
    );
  });

  it("uses the untargeted message form only when Firefox provides no native document id", async () => {
    fake = seed({ record: { documentId: null } });
    const operation = (fake.local[STORAGE_KEYS.operations] as PreparedRecovery[])[0];
    if (!operation) throw new Error("Missing seeded operation");
    operation.documentId = null;
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toMatchObject({ ok: true, data: { action: "discard" } });
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(1, {
      type: "GET_RECOVERY_PREFLIGHT",
      expectedDocumentInstanceId: "document-12345678"
    });
  });

  it("blocks before any tab action when the initial collector preflight rejects", async () => {
    fake = seed();
    await startRuntime(fake);
    fake.setContentMessageHandler(async () => {
      throw new Error("collector context disappeared");
    });

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("collector context disappeared")
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "blocked"
    );
  });

  it("times out an unresponsive collector preflight without invoking a destructive API", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed();
    await startRuntime(fake);
    fake.setContentMessageHandler(() => new Promise(() => undefined));

    const execution = fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    await drainMicrotasksUntil(() => fake.calls.tabsSendMessage.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(RECOVERY_PREFLIGHT_MAX_AGE_MS);
    const response = await execution;

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("preflight timed out")
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "blocked"
    );
  });

  it("records expiry when consent is presented after its one-minute authority window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed();
    await startRuntime(fake);
    await vi.advanceTimersByTimeAsync(60_001);

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "expired"
    );
  });

  it("blocks after durable execution transition when the final preflight rejects", async () => {
    fake = seed();
    await startRuntime(fake);
    let requestCount = 0;
    fake.setContentMessageHandler(async () => {
      requestCount += 1;
      if (requestCount === 2) return { ok: false, error: "final collector refused" };
      return validPreflight("manual");
    });
    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("final collector refused")
    });
    expect(requestCount).toBe(2);
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "blocked"
    );
  });

  it("rejects document identity mismatch and expired manual collector sessions", async () => {
    fake = seed();
    await startRuntime(fake);
    fake.setContentMessageHandler(async () => ({
      ok: true,
      data: {
        ...validPreflight("manual").data,
        documentInstanceId: "different-document-1234"
      }
    }));
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "EXECUTE_RECOVERY",
        operationId: OPERATION_ID,
        nonce: NONCE
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("document identity changed") });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();

    fake = seed();
    await startRuntime(fake);
    fake.setContentMessageHandler(async () => ({
      ok: true,
      data: {
        ...validPreflight("manual").data,
        capturedAtMonotonicMs: 100,
        sessionExpiresAtMonotonicMs: 100
      }
    }));
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "EXECUTE_RECOVERY",
        operationId: OPERATION_ID,
        nonce: NONCE
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("session expired") });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
  });

  it("fails closed when the window state cannot be established or the tab changes windows", async () => {
    fake = seed();
    await startRuntime(fake);
    vi.mocked(fake.browser.windows.get).mockRejectedValueOnce(new Error("window unavailable"));
    const unknownWindow = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    expect(unknownWindow).toMatchObject({ ok: false });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();

    fake = seed();
    await startRuntime(fake);
    const tab = fake.tabs.get(1);
    if (tab) tab.windowId = 2;
    const movedWindow = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });
    expect(movedWindow).toMatchObject({
      ok: false,
      error: expect.stringContaining("Tab window changed")
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
  });

  it("treats tab removal during reload verification as an unverified destructive request", async () => {
    fake = seed();
    const activeSafety = { ...safeState, active: true };
    const liveTab = fake.tabs.get(1);
    if (liveTab) liveTab.active = true;
    const operation = (fake.local[STORAGE_KEYS.operations] as PreparedRecovery[])[0];
    if (!operation) throw new Error("Missing seeded operation");
    operation.action = "reload";
    operation.safetyFingerprint = safetyFingerprint(activeSafety);
    fake.calls.tabsReload.mockImplementationOnce(async () => {
      const tab = fake.tabs.get(1) as browser.tabs.Tab;
      fake.events.tabUpdated.emit(999, { status: "complete" }, makeTab({ id: 999 }));
      fake.events.tabUpdated.emit(1, { status: "loading" }, tab);
      fake.events.tabRemoved.emit(1, { windowId: 1, isWindowClosing: false });
    });
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "EXECUTE_RECOVERY",
      operationId: OPERATION_ID,
      nonce: NONCE
    });

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("outcome is unknown")
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ phase: string }>)[0]?.phase).toBe(
      "verification-timed-out"
    );
    await eventually(
      () => Object.keys(fake.session[STORAGE_KEYS.records] as object).length === 0
    );
  });

  it.each(["non-reload", "second-commit", "document-mismatch", "navigation-error"] as const)(
    "does not attribute reload completion across a %s navigation race",
    async (scenario) => {
      fake = seed();
      const activeSafety = { ...safeState, active: true };
      const tab = fake.tabs.get(1);
      const operation = (fake.local[STORAGE_KEYS.operations] as PreparedRecovery[])[0];
      if (!tab || !operation) throw new Error("Missing seeded recovery state");
      tab.active = true;
      operation.action = "reload";
      operation.safetyFingerprint = safetyFingerprint(activeSafety);
      fake.calls.tabsReload.mockImplementationOnce(async (tabId: number) => {
        const url = fake.tabs.get(tabId)?.url ?? "";
        fake.events.committed.emit({
          tabId: 999,
          frameId: 0,
          url,
          timeStamp: Date.now(),
          transitionType: "reload",
          transitionQualifiers: []
        });
        if (scenario === "non-reload") {
          fake.events.committed.emit({
            tabId,
            frameId: 0,
            url,
            timeStamp: Date.now(),
            transitionType: "link",
            transitionQualifiers: []
          });
        } else if (scenario === "second-commit") {
          for (const documentId of ["reload-document-a", "reload-document-b"]) {
            fake.events.committed.emit({
              tabId,
              frameId: 0,
              url,
              documentId,
              timeStamp: Date.now(),
              transitionType: "reload",
              transitionQualifiers: []
            });
          }
        } else if (scenario === "document-mismatch") {
          fake.events.committed.emit({
            tabId,
            frameId: 0,
            url,
            documentId: "reload-document-a",
            timeStamp: Date.now(),
            transitionType: "reload",
            transitionQualifiers: []
          });
          fake.events.completed.emit({
            tabId,
            frameId: 0,
            url,
            documentId: "reload-document-b",
            timeStamp: Date.now()
          });
        } else {
          fake.events.errorOccurred.emit({
            tabId,
            frameId: 0,
            url,
            error: "NS_ERROR_ABORT",
            timeStamp: Date.now()
          });
        }
      });
      await startRuntime(fake);

      const response = await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "EXECUTE_RECOVERY",
        operationId: OPERATION_ID,
        nonce: NONCE
      });

      expect(response).toEqual({
        ok: false,
        error:
          "Firefox accepted the reload request, but completion could not be tied to that exact reload; the outcome is unknown"
      });
      expect(fake.calls.tabsReload).toHaveBeenCalledTimes(1);
      expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
      expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
        operationId: OPERATION_ID,
        outcome: "unknown",
        phase: "verification-timed-out"
      });
      if (scenario !== "navigation-error") {
        await eventually(
          () => Object.keys(fake.session[STORAGE_KEYS.records] as object).length === 0
        );
      }
    }
  );
});

describe("background collector protocol and lifecycle", () => {
  it("returns a narrow continuous bootstrap only to an eligible top-level document", async () => {
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "GET_COLLECTOR_BOOTSTRAP",
      documentInstanceId: "collector-document-1234",
      deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
    }, { tab, frameId: 0 });
    expect(response).toEqual({
      ok: true,
      data: {
        mode: "continuous",
        sampleVisibleSeconds: 30,
        sampleHiddenSeconds: 90,
        manualSessionExpiresAtEpochMs: null,
        authorityToken: null
      }
    });
  });

  it.each([
    ["tab URL", "The collector document is no longer current"],
    ["missing frame", "The collector frame is no longer current"],
    ["frame URL", "The collector frame is no longer current"],
    ["native document", "The collector document identity changed"]
  ] as const)(
    "rejects collector HELLO when the current %s no longer matches its sender",
    async (mismatch, expectedError) => {
      fake = seed({ continuous: true, withOperation: false });
      fake.session[STORAGE_KEYS.records] = {};
      await startRuntime(fake);
      const tab = fake.tabs.get(1) as browser.tabs.Tab;
      const sender = {
        tab,
        frameId: 0,
        documentId: "sender-native-document-1234"
      } as browser.runtime.MessageSender;
      if (mismatch === "tab URL") {
        vi.mocked(fake.browser.tabs.get).mockResolvedValueOnce({
          ...tab,
          url: "https://different.test/"
        });
      } else if (mismatch === "missing frame") {
        vi.mocked(fake.browser.webNavigation.getFrame).mockResolvedValueOnce(
          null as unknown as browser.webNavigation._GetFrameReturnDetails
        );
      } else if (mismatch === "frame URL") {
        vi.mocked(fake.browser.webNavigation.getFrame).mockResolvedValueOnce({
          tabId: 1,
          frameId: 0,
          url: "https://different.test/",
          parentFrameId: -1
        });
      } else {
        vi.mocked(fake.browser.webNavigation.getFrame).mockResolvedValueOnce({
          tabId: 1,
          frameId: 0,
          url: tab.url ?? "",
          parentFrameId: -1,
          documentId: "different-native-document-1234"
        } as browser.webNavigation._GetFrameReturnDetails);
      }

      const response = await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("current-check-document-1234", "continuous"),
        sender
      );

      expect(response).toEqual({ ok: false, error: expectedError, retryable: true });
      expect((await snapshotOf(fake)).records).toEqual([]);
    }
  );

  it("rejects a retired collector document after a newer HELLO replaces it", async () => {
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const currentSender = {
      tab,
      frameId: 0,
      documentId: "current-native-document-1234"
    } as browser.runtime.MessageSender;

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("current-document-1234", "continuous"),
        currentSender
      )
    ).toEqual({ ok: true, data: { accepted: true } });
    const retired = await fake.dispatchRuntimeMessage<CommandResponse>(
      collectorHello("document-12345678", "continuous"),
      {
        tab,
        frameId: 0,
        documentId: "firefox-document-12345678"
      } as browser.runtime.MessageSender
    );

    expect(retired).toEqual({
      ok: false,
      error: "This collector belongs to a retired document",
      retryable: true
    });
    expect((await snapshotOf(fake)).records[0]?.documentInstanceId).toBe(
      "current-document-1234"
    );
  });

  it("clears permission-signature and retired-document caches during delete-all", async () => {
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const currentSender = {
      tab,
      frameId: 0,
      documentId: "current-native-document-1234"
    } as browser.runtime.MessageSender;
    const retiredSender = {
      tab,
      frameId: 0,
      documentId: "firefox-document-12345678"
    } as browser.runtime.MessageSender;

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("current-document-1234", "continuous"),
        currentSender
      )
    ).toEqual({ ok: true, data: { accepted: true } });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("document-12345678", "continuous"),
        retiredSender
      )
    ).toEqual({
      ok: false,
      error: "This collector belongs to a retired document",
      retryable: true
    });

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "DELETE_ALL_DATA" })
    ).toMatchObject({ ok: true });
    const epochAfterDelete = fake.session[STORAGE_KEYS.monitoringEpoch];
    const registrationChecksBeforePermissionEvent = vi.mocked(
      fake.browser.scripting.getRegisteredContentScripts
    ).mock.calls.length;

    // The first post-delete permission reconciliation establishes a fresh
    // baseline. It must not compare against the erased configuration's host
    // signature and spuriously revoke the new empty state.
    fake.events.permissionAdded.emit({ origins: [...MONITORED_ORIGINS] });
    await eventually(
      () =>
        vi.mocked(fake.browser.scripting.getRegisteredContentScripts).mock.calls.length >
        registrationChecksBeforePermissionEvent
    );
    await fake.flush();
    expect(fake.session[STORAGE_KEYS.monitoringEpoch]).toBe(epochAfterDelete);

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "UPDATE_PREFERENCES",
        patch: {
          monitoringEnabled: true,
          monitoringIntent: "continuous",
          permissionMode: "all-sites"
        }
      })
    ).toMatchObject({
      ok: true,
      data: { monitoringEnabled: true, monitoringIntent: "continuous" }
    });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("document-12345678", "continuous"),
        retiredSender
      )
    ).toEqual({ ok: true, data: { accepted: true } });
  });

  it("serves cold-start bootstrap without waiting for delayed registration reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ continuous: true, withOperation: false });
    let releaseRegistration:
      | ((scripts: browser.scripting.RegisteredContentScript[]) => void)
      | undefined;
    let signalRegistrationStarted: (() => void) | undefined;
    const registrationStarted = new Promise<void>((resolve) => {
      signalRegistrationStarted = resolve;
    });
    vi.mocked(fake.browser.scripting.getRegisteredContentScripts).mockImplementationOnce(
      () =>
        new Promise<browser.scripting.RegisteredContentScript[]>((resolve) => {
          releaseRegistration = resolve;
          signalRegistrationStarted?.();
        })
    );
    installFakeBrowser(fake);
    vi.resetModules();
    await import("../../src/background/index");
    await registrationStarted;

    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    let bootstrapSettled = false;
    const bootstrap = fake
      .dispatchRuntimeMessage<CommandResponse>({
        type: "GET_COLLECTOR_BOOTSTRAP",
        documentInstanceId: "cold-start-document-1234",
        deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
      }, { tab, frameId: 0, documentId: "cold-start-native-document-1234" })
      .then((response) => {
        bootstrapSettled = true;
        return response;
      });
    await drainMicrotasksUntil(() => bootstrapSettled);

    expect(await bootstrap).toMatchObject({
      ok: true,
      data: { mode: "continuous", authorityToken: null }
    });
    expect(releaseRegistration).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(bootstrapSettled).toBe(true);

    releaseRegistration?.([]);
    await fake.dispatchRuntimeMessage<CommandResponse>({ type: "GET_SNAPSHOT" });
  });

  it("expires a cold-start bootstrap delayed by hydration without erasing hydrated state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ continuous: true, withOperation: false });
    let releaseHydration: (() => void) | undefined;
    const blockedHydration = new Promise<Record<string, unknown>>((resolve) => {
      releaseHydration = () => resolve(structuredClone(fake.session));
    });
    vi.mocked(fake.browser.storage.session.get).mockImplementationOnce(
      async () => blockedHydration
    );
    installFakeBrowser(fake);
    vi.resetModules();
    await import("../../src/background/index");

    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const bootstrap = fake.dispatchRuntimeMessage<CommandResponse>(
      {
        type: "GET_COLLECTOR_BOOTSTRAP",
        documentInstanceId: "cold-hydration-document-1234",
        deliveryDeadlineEpochMs: Date.now() + COLLECTOR_BOOTSTRAP_TIMEOUT_MS
      },
      { tab, frameId: 0, documentId: "cold-hydration-native-document-1234" }
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(COLLECTOR_BOOTSTRAP_TIMEOUT_MS + 1);
    releaseHydration?.();

    expect(await bootstrap).toEqual({
      ok: false,
      error: "Collector bootstrap expired before initialization completed",
      retryable: true
    });
    const snapshot = await fake.dispatchRuntimeMessage<CommandResponse<ExtensionSnapshot>>({
      type: "GET_SNAPSHOT"
    });
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        preferences: { monitoringEnabled: true, monitoringIntent: "continuous" },
        records: [expect.objectContaining({ tabId: 1 })]
      }
    });
    expect(fake.session[STORAGE_KEYS.records]).toMatchObject({ "1": { tabId: 1 } });
  });

  it("expires continuous bootstrap authority delayed during current-document validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    const frame = deferred<browser.webNavigation._GetFrameReturnDetails>();
    vi.mocked(fake.browser.webNavigation.getFrame).mockImplementationOnce(
      async () => frame.promise
    );
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const response = fake.dispatchRuntimeMessage<CommandResponse>(
      {
        type: "GET_COLLECTOR_BOOTSTRAP",
        documentInstanceId: "deadline-document-1234",
        deliveryDeadlineEpochMs: Date.now() + 100
      },
      { tab, frameId: 0, documentId: "deadline-native-document-1234" }
    );
    await drainMicrotasksUntil(
      () => vi.mocked(fake.browser.webNavigation.getFrame).mock.calls.length > 0
    );

    await vi.advanceTimersByTimeAsync(101);
    frame.resolve({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: tab.url ?? "",
      documentId: "deadline-native-document-1234"
    } as browser.webNavigation._GetFrameReturnDetails);

    expect(await response).toEqual({
      ok: false,
      error: "Collector bootstrap expired during document validation",
      retryable: true
    });
    expect((await snapshotOf(fake)).records).toHaveLength(1);
  });

  it("expires continuous bootstrap authority delayed during permission validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    const permission = deferred<boolean>();
    const priorPermissionChecks = fake.calls.permissionContains.mock.calls.length;
    fake.calls.permissionContains.mockImplementationOnce(async () => permission.promise);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const response = fake.dispatchRuntimeMessage<CommandResponse>(
      {
        type: "GET_COLLECTOR_BOOTSTRAP",
        documentInstanceId: "permission-deadline-document-1234",
        deliveryDeadlineEpochMs: Date.now() + 100
      },
      { tab, frameId: 0, documentId: "permission-deadline-native-1234" }
    );
    await drainMicrotasksUntil(
      () => fake.calls.permissionContains.mock.calls.length > priorPermissionChecks
    );

    await vi.advanceTimersByTimeAsync(101);
    permission.resolve(true);

    expect(await response).toEqual({
      ok: false,
      error: "Collector bootstrap expired during permission validation",
      retryable: true
    });
    expect((await snapshotOf(fake)).records).toHaveLength(1);
  });

  it("expires collector HELLO authority delayed during initial authorization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    const permission = deferred<boolean>();
    const priorPermissionChecks = fake.calls.permissionContains.mock.calls.length;
    fake.calls.permissionContains.mockImplementationOnce(async () => permission.promise);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const message = {
      ...collectorHello("document-12345678", "continuous"),
      deliveryDeadlineEpochMs: Date.now() + 100
    };
    const response = fake.dispatchRuntimeMessage<CommandResponse>(message, {
      tab,
      frameId: 0,
      documentId: "firefox-document-12345678"
    });
    await drainMicrotasksUntil(
      () => fake.calls.permissionContains.mock.calls.length > priorPermissionChecks
    );

    await vi.advanceTimersByTimeAsync(101);
    permission.resolve(true);

    expect(await response).toEqual({
      ok: false,
      error: "Collector message expired during authorization",
      retryable: true
    });
    expect((await snapshotOf(fake)).records).toEqual([]);
  });

  it("expires collector HELLO authority delayed during current-document validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    const frame = deferred<browser.webNavigation._GetFrameReturnDetails>();
    vi.mocked(fake.browser.webNavigation.getFrame).mockImplementationOnce(
      async () => frame.promise
    );
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const message = {
      ...collectorHello("document-12345678", "continuous"),
      deliveryDeadlineEpochMs: Date.now() + 100
    };
    const response = fake.dispatchRuntimeMessage<CommandResponse>(message, {
      tab,
      frameId: 0,
      documentId: "firefox-document-12345678"
    });
    await drainMicrotasksUntil(
      () => vi.mocked(fake.browser.webNavigation.getFrame).mock.calls.length > 0
    );

    await vi.advanceTimersByTimeAsync(101);
    frame.resolve({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: tab.url ?? "",
      documentId: "firefox-document-12345678"
    } as browser.webNavigation._GetFrameReturnDetails);

    expect(await response).toEqual({
      ok: false,
      error: "Collector message expired during document validation",
      retryable: true
    });
    expect((await snapshotOf(fake)).records).toEqual([]);
  });

  it("expires collector HELLO authority delayed during its final authorization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    const permission = deferred<boolean>();
    const priorPermissionChecks = fake.calls.permissionContains.mock.calls.length;
    fake.calls.permissionContains
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => permission.promise);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const message = {
      ...collectorHello("document-12345678", "continuous"),
      deliveryDeadlineEpochMs: Date.now() + 100
    };
    const response = fake.dispatchRuntimeMessage<CommandResponse>(message, {
      tab,
      frameId: 0,
      documentId: "firefox-document-12345678"
    });
    await drainMicrotasksUntil(
      () => fake.calls.permissionContains.mock.calls.length >= priorPermissionChecks + 2
    );

    await vi.advanceTimersByTimeAsync(101);
    permission.resolve(true);

    expect(await response).toEqual({
      ok: false,
      error: "Collector message expired during final authorization",
      retryable: true
    });
    expect((await snapshotOf(fake)).records).toEqual([]);
  });

  it("does not let a paused cold-start recovery reconciliation republish data after deletion", async () => {
    fake = seed({ continuous: true });
    let releaseRecoveryReconciliation:
      | ((alarms: browser.alarms.Alarm[]) => void)
      | undefined;
    let signalRecoveryReconciliationStarted: (() => void) | undefined;
    const recoveryReconciliationStarted = new Promise<void>((resolve) => {
      signalRecoveryReconciliationStarted = resolve;
    });
    vi.mocked(fake.browser.alarms.getAll).mockImplementationOnce(
      () =>
        new Promise<browser.alarms.Alarm[]>((resolve) => {
          releaseRecoveryReconciliation = resolve;
          signalRecoveryReconciliationStarted?.();
        })
    );
    installFakeBrowser(fake);
    vi.resetModules();
    await import("../../src/background/index");
    await recoveryReconciliationStarted;

    const deletion = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "DELETE_ALL_DATA"
    });
    expect(deletion).toMatchObject({
      ok: true,
      data: { permissionsRetainedByFirefox: true }
    });
    const stableLocal = structuredClone(fake.local);
    const stableSession = structuredClone(fake.session);

    releaseRecoveryReconciliation?.([]);
    const snapshot = await fake.dispatchRuntimeMessage<CommandResponse<ExtensionSnapshot>>({
      type: "GET_SNAPSHOT"
    });
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        preferences: DEFAULT_PREFERENCES,
        records: [],
        receipts: []
      }
    });
    expect(fake.local).toEqual(stableLocal);
    expect(fake.session).toEqual(stableSession);
  });

  it("authorizes a live manual session without granting persistent host scope and returns its exact TTL", async () => {
    const expiresAt = Date.now() + 15 * 60_000;
    fake = seed({ withOperation: false });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": {
        tabId: 1,
        manualSessionStartedAt: Date.now(),
        manualSessionExpiresAt: expiresAt,
        manualSessionToken: MANUAL_AUTHORITY_TOKEN,
        manualSessionDocumentInstanceId: "collector-document-1234"
      }
    };
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "GET_COLLECTOR_BOOTSTRAP",
        documentInstanceId: "collector-document-1234",
        deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
      }, { tab, frameId: 0 })
    ).toEqual({
      ok: true,
      data: {
        mode: "manual",
        sampleVisibleSeconds: 30,
        sampleHiddenSeconds: 90,
        manualSessionExpiresAtEpochMs: expiresAt,
        authorityToken: MANUAL_AUTHORITY_TOKEN
      }
    });
    expect(fake.grantedOrigins.size).toBe(0);
  });

  it("gives an explicit manual session precedence over otherwise active continuous scope", async () => {
    const expiresAt = Date.now() + 15 * 60_000;
    fake = seed({ continuous: true, withOperation: false });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": {
        tabId: 1,
        manualSessionStartedAt: Date.now(),
        manualSessionExpiresAt: expiresAt,
        manualSessionToken: MANUAL_AUTHORITY_TOKEN,
        manualSessionDocumentInstanceId: "collector-document-1234",
        manualSessionDocumentId: "collector-native-document-1234"
      }
    };
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        {
          type: "GET_COLLECTOR_BOOTSTRAP",
          documentInstanceId: "collector-document-1234",
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
        },
        { tab, frameId: 0, documentId: "collector-native-document-1234" }
      )
    ).toMatchObject({
      ok: true,
      data: {
        mode: "manual",
        manualSessionExpiresAtEpochMs: expiresAt,
        authorityToken: MANUAL_AUTHORITY_TOKEN
      }
    });
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toMatchObject({
      manualSessionDocumentInstanceId: "collector-document-1234",
      manualSessionDocumentId: "collector-native-document-1234"
    });

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        {
          type: "GET_COLLECTOR_BOOTSTRAP",
          documentInstanceId: "different-document-1234",
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
        },
        { tab, frameId: 0, documentId: "different-native-document-1234" }
      )
    ).toMatchObject({
      ok: true,
      data: {
        mode: "continuous",
        manualSessionExpiresAtEpochMs: null,
        authorityToken: null
      }
    });
  });

  it("binds manual bootstrap authority to one document and rejects token replay", async () => {
    const expiresAt = Date.now() + 15 * 60_000;
    fake = seed({ withOperation: false });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": {
        tabId: 1,
        manualSessionStartedAt: Date.now(),
        manualSessionExpiresAt: expiresAt,
        manualSessionToken: MANUAL_AUTHORITY_TOKEN,
        manualSessionDocumentInstanceId: "collector-document-1234",
        manualSessionDocumentId: "collector-native-document-1234"
      }
    };
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const sender = {
      tab,
      frameId: 0,
      documentId: "collector-native-document-1234"
    } as browser.runtime.MessageSender;
    const request = {
      type: "GET_COLLECTOR_BOOTSTRAP",
      documentInstanceId: "collector-document-1234",
      deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
    };

    expect(await fake.dispatchRuntimeMessage<CommandResponse>(request, sender)).toMatchObject({
      ok: true,
      data: { mode: "manual", authorityToken: MANUAL_AUTHORITY_TOKEN }
    });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        {
          ...collectorSample("collector-document-1234", 0, "manual"),
          authorityToken: "11111111-1111-4111-8111-111111111111"
        },
        sender
      )
    ).toEqual({
      ok: false,
      error: "This collector is no longer authorized for the tab",
      retryable: true
    });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("collector-document-1234", "manual"),
        sender
      )
    ).toEqual({ ok: true, data: { accepted: true } });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorSample("collector-document-1234", 0, "manual"),
        sender
      )
    ).toMatchObject({ ok: true });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        { ...request, documentInstanceId: "different-document-1234" },
        {
          ...sender,
          documentId: "different-native-document-1234"
        }
      )
    ).toEqual({
      ok: false,
      error: "The temporary monitoring session belongs to another document"
    });
  });

  it("rearms a retryable manual document A without allowing document B to claim its token", async () => {
    const expiresAt = Date.now() + 15 * 60_000;
    fake = seed({ withOperation: false });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": manualPolicyFor(
        "document-12345678",
        "firefox-document-12345678",
        expiresAt
      )
    };
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const senderA = {
      tab,
      frameId: 0,
      documentId: "firefox-document-12345678"
    } as browser.runtime.MessageSender;

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        {
          ...collectorHello("document-12345678", "manual"),
          deliveryDeadlineEpochMs: Date.now()
        },
        senderA
      )
    ).toEqual({
      ok: false,
      error: "Collector message expired before it could be accepted",
      retryable: true
    });
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toEqual({
      tabId: 1,
      manualSessionStartedAt: expect.any(Number),
      manualSessionExpiresAt: expiresAt,
      manualSessionToken: MANUAL_AUTHORITY_TOKEN,
      manualSessionDocumentId: "firefox-document-12345678"
    });

    const bootstrapRequest = {
      type: "GET_COLLECTOR_BOOTSTRAP",
      documentInstanceId: "document-b-12345678",
      deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
    };
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(bootstrapRequest, {
        tab,
        frameId: 0,
        documentId: "firefox-document-b-12345678"
      })
    ).toEqual({
      ok: false,
      error: "The temporary monitoring session belongs to another document"
    });

    const rebound = await fake.dispatchRuntimeMessage<CommandResponse>(
      {
        ...bootstrapRequest,
        documentInstanceId: "document-a-retry-12345678",
        deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
      },
      senderA
    );
    expect(rebound).toMatchObject({
      ok: true,
      data: { mode: "manual", authorityToken: MANUAL_AUTHORITY_TOKEN }
    });
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toMatchObject({
      manualSessionDocumentInstanceId: "document-a-retry-12345678",
      manualSessionDocumentId: "firefox-document-12345678",
      manualSessionToken: MANUAL_AUTHORITY_TOKEN
    });
  });

  it("terminates retryable manual authority when Firefox exposes no native document identity", async () => {
    fake = seed({ withOperation: false });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": {
        tabId: 1,
        manualSessionStartedAt: Date.now() - 1_000,
        manualSessionExpiresAt: Date.now() + 15 * 60_000,
        manualSessionToken: MANUAL_AUTHORITY_TOKEN,
        manualSessionDocumentInstanceId: "document-12345678"
      }
    };
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const sender = { tab, frameId: 0 } as browser.runtime.MessageSender;

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        {
          ...collectorHello("document-12345678", "manual"),
          deliveryDeadlineEpochMs: Date.now()
        },
        sender
      )
    ).toMatchObject({ ok: false, retryable: true });
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        {
          type: "GET_COLLECTOR_BOOTSTRAP",
          documentInstanceId: "document-retry-12345678",
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
        },
        sender
      )
    ).toEqual({ ok: false, error: "Monitoring is not enabled for this document" });
  });

  it("rejects bootstrap from subframes, restricted pages, expired sessions, and malformed requests", async () => {
    fake = seed({ withOperation: false });
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const request = {
      type: "GET_COLLECTOR_BOOTSTRAP",
      documentInstanceId: "collector-document-1234",
      deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
    };
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(request, { tab, frameId: 1 })
    ).toEqual({ ok: false, error: "Top-level tab sender required" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(request, {
        tab: { ...tab, url: "about:config" },
        frameId: 0
      })
    ).toMatchObject({ ok: false });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(request, { tab, frameId: 0 })
    ).toEqual({ ok: false, error: "Monitoring is not enabled for this document" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        ...request,
        documentInstanceId: "short"
      }, { tab, frameId: 0 })
    ).toEqual({ ok: false, error: "Unknown or unauthorized message" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        ...request,
        unexpectedAuthority: true
      }, { tab, frameId: 0 })
    ).toEqual({ ok: false, error: "Unknown or unauthorized message" });
  });

  it("enforces selected-site and site-pause scope for collector bootstrap", async () => {
    fake = seed({ continuous: true, withOperation: false });
    fake.local[STORAGE_KEYS.preferences] = {
      ...(fake.local[STORAGE_KEYS.preferences] as Preferences),
      permissionMode: "selected-sites",
      selectedOrigins: ["https://example.test/*"]
    };
    fake.grantedOrigins.clear();
    fake.grantedOrigins.add("https://example.test/*");
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const request = {
      type: "GET_COLLECTOR_BOOTSTRAP",
      documentInstanceId: "collector-document-1234",
      deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
    };
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(request, { tab, frameId: 0 })
    ).toMatchObject({ ok: true, data: { mode: "continuous" } });

    await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "UPDATE_PREFERENCES",
      patch: {
        sitePolicies: [
          {
            hostname: "example.test",
            monitoring: "inherit",
            notifications: "inherit",
            automaticRecovery: "never",
            pausedUntil: Date.now() + 60_000
          }
        ]
      }
    });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(request, { tab, frameId: 0 })
    ).toEqual({
      ok: false,
      error: "Monitoring is disabled for this site",
      retryable: true
    });
  });

  it("handles install, startup, notification, alarm, activation, and highlight events safely", async () => {
    fake = seed({ withOperation: false });
    await startRuntime(fake);
    fake.events.startup.emit();
    fake.events.installed.emit({ reason: "install", temporary: false });
    await eventually(() => fake.tabs.size === 2);

    fake.notifications.set("tab-leak-guard:findings", {
      title: "Finding",
      message: "Finding"
    });
    fake.events.notificationClicked.emit("tab-leak-guard:findings");
    await eventually(() => !fake.notifications.has("tab-leak-guard:findings"));

    fake.alarms.set("reset:legacy", { name: "reset:legacy", scheduledTime: Date.now() });
    fake.events.alarm.emit({ name: "reset:legacy", scheduledTime: Date.now() });
    await eventually(() => !fake.alarms.has("reset:legacy"));

    fake.events.alarm.emit({
      name: "recovery:99:99999999-9999-4999-8999-999999999999",
      scheduledTime: Date.now()
    });
    await fake.flush();
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();

    const before = (await snapshotOf(fake)).records[0]?.revision ?? 0;
    fake.events.tabActivated.emit({ tabId: 1, windowId: 1 });
    fake.events.tabHighlighted.emit({ tabIds: [1], windowId: 1 });
    expect((await snapshotOf(fake)).records[0]?.revision).toBe(before + 2);
  });

  it("invalidates recovery authority on extension update without opening onboarding", async () => {
    fake = seed({ continuous: true });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": manualPolicyFor("document-12345678", "firefox-document-12345678")
    };
    fake.setContentMessageHandler(async () => validPreflight("manual"));
    await startRuntime(fake);
    const create = fake.browser.tabs.create as unknown as ReturnType<typeof vi.fn>;

    fake.events.installed.emit({ reason: "update", temporary: false });
    await eventually(() => fake.session[STORAGE_KEYS.monitoringEpoch] === 6);

    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect(create).not.toHaveBeenCalled();
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: "STOP_COLLECTOR" }),
      { documentId: "firefox-document-12345678" }
    );
  });

  it("clears legacy, orphaned, and manual recovery alarms during startup reconciliation", async () => {
    fake = seed();
    const current = `recovery:1:${OPERATION_ID}`;
    const orphaned = "recovery:9:87654321-4321-4321-8321-cba987654321";
    fake.alarms.set("reset:legacy-authority", {
      name: "reset:legacy-authority",
      scheduledTime: Date.now()
    });
    fake.alarms.set(current, { name: current, scheduledTime: Date.now() + 1_000 });
    fake.alarms.set(orphaned, { name: orphaned, scheduledTime: Date.now() + 1_000 });

    await startRuntime(fake);

    expect(fake.alarms.size).toBe(0);
    expect(fake.local[STORAGE_KEYS.operations]).toHaveLength(1);
    expect(fake.calls.alarmClear).toHaveBeenCalledWith("reset:legacy-authority");
    expect(fake.calls.alarmClear).toHaveBeenCalledWith(current);
    expect(fake.calls.alarmClear).toHaveBeenCalledWith(orphaned);
  });

  it("removes restored automatic authority and suppresses orphaned automatic records", async () => {
    const orphanedOperationId = "99999999-9999-4999-8999-999999999999";
    fake = seed({
      continuous: true,
      operation: { state: "prepared", initiator: "automatic" },
      record: { recovery: { status: "prepared", operationId: OPERATION_ID } }
    });
    const records = fake.session[STORAGE_KEYS.records] as Record<string, TabRecord>;
    records["2"] = tabRecord({
      tabId: 2,
      documentInstanceId: "orphaned-document-1234",
      documentId: "orphaned-native-document-1234",
      monitoringEpoch: 5,
      monitoringMode: "continuous",
      recovery: {
        status: "prepared",
        operationId: orphanedOperationId,
        automaticSuppressedForDocument: true
      }
    });
    fake.tabs.set(2, makeTab({ id: 2, url: "https://example.test/second" }));
    const alarmName = `recovery:1:${OPERATION_ID}`;
    fake.alarms.set(alarmName, { name: alarmName, scheduledTime: Date.now() + 60_000 });

    const snapshot = await startRuntime(fake);

    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.calls.alarmClear).toHaveBeenCalledWith(alarmName);
    expect(snapshot.records.find((record) => record.tabId === 1)?.recovery).toMatchObject({
      status: "idle"
    });
    expect(snapshot.records.find((record) => record.tabId === 2)?.recovery).toMatchObject({
      status: "suppressed",
      automaticSuppressedForDocument: true
    });
    expect(
      snapshot.records.find((record) => record.tabId === 2)?.recovery.operationId
    ).toBeUndefined();
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
  });

  it("clears restored manual tokens before a paused cold start becomes observable", async () => {
    const snoozedUntil = Date.now() + 60_000;
    fake = seed({ withOperation: false });
    fake.local[STORAGE_KEYS.preferences] = {
      ...DEFAULT_PREFERENCES,
      monitoringEnabled: false,
      monitoringIntent: "paused",
      permissionMode: "manual"
    };
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": {
        ...manualPolicyFor("document-12345678", "firefox-document-12345678"),
        snoozedUntil
      }
    };

    const snapshot = await startRuntime(fake);

    expect(snapshot.preferences).toMatchObject({
      monitoringEnabled: false,
      monitoringIntent: "paused"
    });
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({
      "1": { tabId: 1, snoozedUntil }
    });
  });

  it.each(["executing", "requested"] as const)(
    "quarantines restored %s authority with one unknown-outcome receipt and cooldown",
    async (state) => {
    const requestedAt = Date.now() - 1_000;
    fake = seed({
      operation: { state, requestedAt },
      record: {
        recovery: { status: state, operationId: OPERATION_ID },
        pendingResetAt: Date.now() + 60_000
      }
    });

    const snapshot = await startRuntime(fake);

    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(snapshot.records[0]?.recovery.status).toBe("cooldown");
    expect(snapshot.records[0]?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(snapshot.records[0]?.pendingResetAt).toBeUndefined();
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toMatchObject({
      "1": { tabId: 1, cooldownUntil: expect.any(Number) }
    });
    expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "unknown",
      phase: "requested",
      requestedAt
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    }
  );

  it.each(["success", "unknown"] as const)(
    "treats a durable %s receipt as the sole commit marker for a stale startup operation",
    async (outcome) => {
      const occurredAt = Date.now() - 1_000;
      const requestedAt = occurredAt - 500;
      const receiptId = `terminal-${outcome}-receipt`;
      fake = seed({
        operation: { state: "requested", requestedAt },
        record: {
          recovery: { status: "requested", operationId: OPERATION_ID },
          pendingResetAt: Date.now() + 60_000
        }
      });
      fake.local[STORAGE_KEYS.receipts] = [
        {
          id: receiptId,
          operationId: OPERATION_ID,
          tabId: 1,
          hostname: "example.test",
          action: "discard",
          occurredAt,
          reasonCodes: [],
          outcome,
          phase: outcome === "success" ? "completed" : "requested",
          initiator: "manual",
          message: outcome === "success" ? "Unload completed" : "Outcome could not be verified",
          requestedAt,
          ...(outcome === "success" ? { completedAt: occurredAt } : {})
        }
      ];

      const snapshot = await startRuntime(fake);

      expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
      expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
      expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
        id: receiptId,
        operationId: OPERATION_ID,
        outcome
      });
      if (outcome === "success") {
        expect(
          (fake.local[STORAGE_KEYS.receipts] as Array<{ outcome: string }>).filter(
            (receipt) => receipt.outcome === "unknown"
          )
        ).toEqual([]);
      }
      expect(snapshot.records[0]).toMatchObject({
        recovery: { status: "cooldown" },
        cooldownUntil: expect.any(Number)
      });
      expect(snapshot.records[0]?.cooldownUntil).toBeGreaterThanOrEqual(
        occurredAt + RESET_COOLDOWN_MS
      );
      expect(fake.session[STORAGE_KEYS.tabPolicies]).toMatchObject({
        "1": { cooldownUntil: expect.any(Number) }
      });
      expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
      expect(fake.calls.tabsReload).not.toHaveBeenCalled();
    }
  );

  it("retains an unknown receipt for a requested journal before pruning its absent tab", async () => {
    const requestedAt = Date.now() - 1_000;
    fake = seed({
      operation: { state: "requested", requestedAt },
      record: {
        recovery: { status: "requested", operationId: OPERATION_ID },
        pendingResetAt: Date.now() + 60_000
      }
    });
    fake.tabs.clear();

    const snapshot = await startRuntime(fake);

    expect(snapshot.records).toEqual([]);
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
    expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
    expect((fake.local[STORAGE_KEYS.receipts] as unknown[])[0]).toMatchObject({
      operationId: OPERATION_ID,
      outcome: "unknown",
      phase: "requested",
      requestedAt
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
  });

  it("prunes closed and day-old idle runtime records before exposing a snapshot", async () => {
    fake = seed({
      withOperation: false,
      manualAuthority: true,
      record: {
        updatedAt: Date.now() - 25 * 60 * 60_000,
        recovery: { status: "idle" }
      }
    });
    await startRuntime(fake);
    expect((await snapshotOf(fake)).records).toEqual([]);

    fake = seed({ withOperation: false });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": { tabId: 1, snoozedUntil: Date.now() + 60_000 }
    };
    fake.tabs.clear();
    await startRuntime(fake);
    expect((await snapshotOf(fake)).records).toEqual([]);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
  });

  it("enables continuous monitoring when Firefox reports newly granted scope", async () => {
    fake = seed({ continuous: true, withOperation: false });
    fake.grantedOrigins.clear();
    await startRuntime(fake);
    expect((fake.local[STORAGE_KEYS.preferences] as Preferences).monitoringEnabled).toBe(false);

    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    fake.events.permissionAdded.emit({ origins: [...MONITORED_ORIGINS] });
    await eventually(
      () => (fake.local[STORAGE_KEYS.preferences] as Preferences).monitoringEnabled === true
    );

    expect(fake.registeredScripts.get("tab-leak-guard-collector")).toMatchObject({
      runAt: "document_start",
      matches: [...MONITORED_ORIGINS]
    });
    expect(fake.session[STORAGE_KEYS.monitoringEpoch]).toBe(6);
  });

  it("invalidates both replaced-tab ids and top-frame history navigation only", async () => {
    fake = seed({ continuous: true });
    fake.tabs.set(2, makeTab({ id: 2, url: "https://example.test/replacement" }));
    await startRuntime(fake);

    fake.events.historyStateUpdated.emit({
      tabId: 1,
      frameId: 2,
      url: "https://example.test/subframe",
      timeStamp: Date.now(),
      transitionType: "link",
      transitionQualifiers: []
    });
    await fake.flush();
    expect((await snapshotOf(fake)).records).toHaveLength(1);

    fake.events.tabReplaced.emit(2, 1);
    await eventually(() => Object.keys(fake.session[STORAGE_KEYS.records] as object).length === 0);
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);

    const replacement = fake.tabs.get(2) as browser.tabs.Tab;
    const replacementSender = {
      tab: replacement,
      frameId: 0,
      documentId: "replacement-native-document-1234"
    } as browser.runtime.MessageSender;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("replacement-document-1234", "continuous"),
        replacementSender
      )
    ).toEqual({ ok: true, data: { accepted: true } });
    await fake.dispatchRuntimeMessage<CommandResponse>(
      collectorSample("replacement-document-1234", 0, "continuous"),
      replacementSender
    );
    expect((await snapshotOf(fake)).records).toHaveLength(1);
    fake.events.historyStateUpdated.emit({
      tabId: 2,
      frameId: 0,
      url: "https://example.test/history",
      timeStamp: Date.now() + 1,
      transitionType: "link",
      transitionQualifiers: []
    });
    await eventually(() => Object.keys(fake.session[STORAGE_KEYS.records] as object).length === 0);
  });

  it("backs off an over-budget collector and revokes its prepared recovery authority", async () => {
    fake = seed({ continuous: true });
    await startRuntime(fake);

    fake.events.performanceWarning.emit({
      category: "content_script",
      severity: "low",
      tabId: 1
    });
    fake.events.performanceWarning.emit({
      category: "background",
      severity: "high",
      tabId: 1
    });
    fake.events.performanceWarning.emit({ category: "content_script", severity: "high" });
    await fake.flush();
    expect(fake.local[STORAGE_KEYS.operations]).toHaveLength(1);

    fake.events.performanceWarning.emit({
      category: "content_script",
      severity: "medium",
      tabId: 1
    });
    await eventually(() => (fake.local[STORAGE_KEYS.operations] as unknown[]).length === 0);

    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      {
        type: "BACKOFF_COLLECTOR",
        expectedDocumentInstanceId: "document-12345678"
      },
      { documentId: "firefox-document-12345678" }
    );
    const snapshot = await snapshotOf(fake);
    expect(snapshot.records[0]).toMatchObject({
      evidenceExpiresAt: 0,
      safety: { safetyComplete: false }
    });
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
  });

  it("still revokes authority when backoff delivery fails and ignores warnings for unknown tabs", async () => {
    fake = seed({ continuous: true });
    await startRuntime(fake);
    fake.calls.tabsSendMessage.mockRejectedValueOnce(new Error("collector already gone"));

    fake.events.performanceWarning.emit({
      category: "content_script",
      severity: "high",
      tabId: 1
    });
    await eventually(() => (fake.local[STORAGE_KEYS.operations] as unknown[]).length === 0);
    expect((await snapshotOf(fake)).records[0]?.evidenceExpiresAt).toBe(0);

    const callCount = fake.calls.tabsSendMessage.mock.calls.length;
    fake.events.performanceWarning.emit({
      category: "content_script",
      severity: "high",
      tabId: 999
    });
    await fake.flush();
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledTimes(callCount);
  });

  it("restarts continuous collectors after a sampling schedule change", async () => {
    fake = seed({ continuous: true });
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse<Preferences>>({
      type: "UPDATE_PREFERENCES",
      patch: { sampleVisibleSeconds: 45, sampleHiddenSeconds: 120 }
    });

    expect(response).toMatchObject({
      ok: true,
      data: { sampleVisibleSeconds: 45, sampleHiddenSeconds: 120 }
    });
    expect((await snapshotOf(fake)).records).toEqual([]);
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: "STOP_COLLECTOR" }),
      { documentId: "firefox-document-12345678" }
    );
  });

  it("preserves an explicit manual session when only continuous sampling changes", async () => {
    fake = seed({ continuous: true, withOperation: false });
    const policy = manualPolicyFor(
      "document-12345678",
      "firefox-document-12345678",
      Date.now() + 10 * 60_000
    );
    fake.session[STORAGE_KEYS.tabPolicies] = { "1": policy };
    await startRuntime(fake);
    fake.calls.tabsSendMessage.mockClear();

    const response = await fake.dispatchRuntimeMessage<CommandResponse<Preferences>>({
      type: "UPDATE_PREFERENCES",
      patch: { sampleVisibleSeconds: 45 }
    });

    expect(response).toMatchObject({ ok: true, data: { sampleVisibleSeconds: 45 } });
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toEqual(
      policy
    );
    expect((await snapshotOf(fake)).records[0]).toMatchObject({
      monitoringMode: "manual",
      documentInstanceId: "document-12345678"
    });
    expect(fake.calls.tabsSendMessage).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: "STOP_COLLECTOR" }),
      expect.anything()
    );
  });

  it("orders findings by recovery urgency and then by freshness", async () => {
    fake = seed({
      withOperation: false,
      manualAuthority: true,
      record: {
        updatedAt: Date.now() - 2_000
      }
    });
    fake.tabs.set(2, makeTab({ id: 2, title: "Second" }));
    (fake.session[STORAGE_KEYS.records] as Record<string, TabRecord>)["2"] = tabRecord({
      tabId: 2,
      title: "Second",
      documentInstanceId: "second-document-1234",
      documentId: "second-native-document-1234",
      updatedAt: Date.now() - 1_000,
      createdAt: Date.now() - 5_000,
      monitoringEpoch: 5,
      monitoringMode: "manual",
      ...confirmedEvidence("manual")
    });
    await startRuntime(fake);
    expect((await snapshotOf(fake)).records.map((record) => record.tabId)).toEqual([2, 1]);

    const prepared = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "PREPARE_RECOVERY",
      tabId: 1
    });
    expect(prepared.ok).toBe(true);
    expect((await snapshotOf(fake)).records.map((record) => record.tabId)).toEqual([1, 2]);
  });

  it("stops explicit manual collectors when the user transitions to continuous mode", async () => {
    fake = seed({ record: { monitoringMode: "manual" } });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": {
        tabId: 1,
        manualSessionStartedAt: Date.now() - 1_000,
        manualSessionExpiresAt: Date.now() + 60_000,
        manualSessionToken: MANUAL_AUTHORITY_TOKEN,
        manualSessionDocumentInstanceId: "document-12345678",
        manualSessionDocumentId: "firefox-document-12345678"
      }
    };
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse<Preferences>>({
      type: "UPDATE_PREFERENCES",
      patch: {
        monitoringEnabled: true,
        monitoringIntent: "continuous",
        permissionMode: "all-sites"
      }
    });

    expect(response).toMatchObject({ ok: true, data: { monitoringIntent: "continuous" } });
    expect((await snapshotOf(fake)).records).toEqual([]);
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toBeUndefined();
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: "STOP_COLLECTOR" }),
      { documentId: "firefox-document-12345678" }
    );
  });

  it("stops and clears a bound policy-only manual collector when switching to continuous mode", async () => {
    fake = seed({ withOperation: false });
    fake.session[STORAGE_KEYS.records] = {};
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": manualPolicyFor(
        "policy-only-document-1234",
        "policy-only-native-document-1234"
      )
    };
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse<Preferences>>({
      type: "UPDATE_PREFERENCES",
      patch: {
        monitoringEnabled: true,
        monitoringIntent: "continuous",
        permissionMode: "all-sites"
      }
    });

    expect(response).toMatchObject({ ok: true, data: { monitoringIntent: "continuous" } });
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      {
        type: "STOP_COLLECTOR",
        expectedDocumentInstanceId: "policy-only-document-1234"
      },
      { documentId: "policy-only-native-document-1234" }
    );
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
  });

  it("accepts one top-frame sample, deduplicates sequence numbers, and binds native document identity", async () => {
    fake = seed({ continuous: true, withOperation: false });
    fake.session[STORAGE_KEYS.records] = {};
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const message = collectorSample("collector-document-1234", 0, "continuous");
    const sender = {
      tab,
      frameId: 0,
      documentId: "native-document-1234"
    } as browser.runtime.MessageSender;

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("collector-document-1234", "continuous"),
        sender
      )
    ).toEqual({ ok: true, data: { accepted: true } });
    const first = await fake.dispatchRuntimeMessage<CommandResponse>(message, sender);
    const duplicate = await fake.dispatchRuntimeMessage<CommandResponse>(message, sender);
    const snapshot = await snapshotOf(fake);

    expect(first).toMatchObject({ ok: true, data: { status: expect.any(String) } });
    expect(duplicate).toEqual({ ok: true, data: { duplicate: true } });
    expect(snapshot.records[0]).toMatchObject({
      documentInstanceId: "collector-document-1234",
      documentId: "native-document-1234",
      monitoringMode: "continuous"
    });
    expect(snapshot.records[0]?.samples).toHaveLength(1);
  });

  it("enforces the runtime record cap by evicting the oldest idle low-risk finding", async () => {
    fake = seed({ continuous: true, withOperation: false });
    const now = Date.now();
    const records: Record<string, TabRecord> = {};
    for (let tabId = 1; tabId <= MAX_TAB_RECORDS; tabId += 1) {
      records[String(tabId)] = tabRecord({
        tabId,
        windowId: 1,
        documentInstanceId: `bounded-document-${tabId}`,
        documentId: `bounded-native-document-${tabId}`,
        createdAt: now - MAX_TAB_RECORDS * 1_000,
        updatedAt: now - (MAX_TAB_RECORDS - tabId + 1) * 1_000,
        monitoringEpoch: 5,
        monitoringMode: "continuous",
        samples: [],
        recovery: { status: "idle" }
      });
      fake.tabs.set(tabId, makeTab({ id: tabId, title: `Tab ${tabId}` }));
    }
    fake.session[STORAGE_KEYS.records] = records;
    const newTabId = MAX_TAB_RECORDS + 1;
    fake.tabs.set(newTabId, makeTab({ id: newTabId, title: "Newest" }));
    await startRuntime(fake);

    const newTab = fake.tabs.get(newTabId) as browser.tabs.Tab;
    const sender = {
      tab: newTab,
      frameId: 0,
      documentId: "newest-native-document"
    } as browser.runtime.MessageSender;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("newest-bounded-document", "continuous"),
        sender
      )
    ).toEqual({ ok: true, data: { accepted: true } });
    await fake.dispatchRuntimeMessage<CommandResponse>(
      collectorSample("newest-bounded-document", 0, "continuous"),
      sender
    );

    const snapshot = await snapshotOf(fake);
    expect(snapshot.records).toHaveLength(MAX_TAB_RECORDS);
    expect(snapshot.records.some((record) => record.tabId === newTabId)).toBe(true);
    expect(snapshot.records.some((record) => record.tabId === 1)).toBe(false);
  });

  it("uses last-resort bounded eviction when every retained record is suppressed", async () => {
    fake = seed({ continuous: true, withOperation: false });
    const now = Date.now();
    const records: Record<string, TabRecord> = {};
    for (let tabId = 1; tabId <= MAX_TAB_RECORDS; tabId += 1) {
      records[String(tabId)] = tabRecord({
        tabId,
        windowId: 1,
        documentInstanceId: `suppressed-document-${tabId}`,
        documentId: `suppressed-native-document-${tabId}`,
        createdAt: now - MAX_TAB_RECORDS * 1_000,
        updatedAt: now - (MAX_TAB_RECORDS - tabId + 1) * 1_000,
        monitoringEpoch: 5,
        monitoringMode: "continuous",
        samples: [],
        recovery: { status: "suppressed", blockedReason: "Recovery suppressed" },
        blockedReason: "Recovery suppressed"
      });
      fake.tabs.set(tabId, makeTab({ id: tabId, title: `Tab ${tabId}` }));
    }
    fake.session[STORAGE_KEYS.records] = records;
    const newTabId = MAX_TAB_RECORDS + 1;
    fake.tabs.set(newTabId, makeTab({ id: newTabId, title: "Newest suppressed" }));
    fake.session[STORAGE_KEYS.tabPolicies] = {
      [String(newTabId)]: { tabId: newTabId, snoozedUntil: now + 60_000 }
    };
    await startRuntime(fake);

    const newTab = fake.tabs.get(newTabId) as browser.tabs.Tab;
    const sender = {
      tab: newTab,
      frameId: 0,
      documentId: "newest-suppressed-native"
    } as browser.runtime.MessageSender;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("newest-suppressed-document", "continuous"),
        sender
      )
    ).toEqual({ ok: true, data: { accepted: true } });
    await fake.dispatchRuntimeMessage<CommandResponse>(
      collectorSample("newest-suppressed-document", 0, "continuous"),
      sender
    );

    const snapshot = await snapshotOf(fake);
    expect(snapshot.records).toHaveLength(MAX_TAB_RECORDS);
    expect(snapshot.records.some((record) => record.tabId === newTabId)).toBe(true);
    expect(snapshot.records.some((record) => record.tabId === 1)).toBe(false);
  });

  it("accepts collector hello but rejects stale manual, unselected, and revoked continuous collectors", async () => {
    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    let tab = fake.tabs.get(1) as browser.tabs.Tab;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "COLLECTOR_HELLO",
          sentAtMonotonicMs: performance.now(),
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS,
          documentInstanceId: "collector-document-1234",
          collectorMode: "continuous",
          authorityToken: null,
          payload: { hostname: "example.test" }
        },
        { tab, frameId: 0 }
      )
    ).toEqual({ ok: true, data: { accepted: true } });
    expect((await snapshotOf(fake)).records[0]).toMatchObject({
      tabId: 1,
      documentInstanceId: "collector-document-1234",
      documentId: null,
      monitoringMode: "continuous",
      samples: [],
      detector: { status: "warmup", score: 0 }
    });

    fake = seed({ withOperation: false });
    await startRuntime(fake);
    tab = fake.tabs.get(1) as browser.tabs.Tab;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorSample("collector-document-1234", 0, "manual"),
        { tab, frameId: 0 }
      )
    ).toEqual({
      ok: false,
      error: "This collector is no longer authorized for the tab",
      retryable: true
    });

    fake = seed({ continuous: true, withOperation: false });
    fake.local[STORAGE_KEYS.preferences] = {
      ...(fake.local[STORAGE_KEYS.preferences] as Preferences),
      permissionMode: "selected-sites",
      selectedOrigins: ["https://other.test/*"]
    };
    fake.grantedOrigins.clear();
    fake.grantedOrigins.add("https://other.test/*");
    await startRuntime(fake);
    const unselected = fake.tabs.get(1) as browser.tabs.Tab;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorSample("collector-document-1234", 0, "continuous"),
        { tab: unselected, frameId: 0 }
      )
    ).toEqual({
      ok: false,
      error: "This collector is no longer authorized for the tab",
      retryable: true
    });

    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    fake.grantedOrigins.clear();
    const revoked = fake.tabs.get(1) as browser.tabs.Tab;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorSample("collector-document-1234", 0, "continuous"),
        { tab: revoked, frameId: 0 }
      )
    ).toEqual({
      ok: false,
      error: "This collector is no longer authorized for the tab",
      retryable: true
    });

    fake = seed({ continuous: true, withOperation: false });
    await startRuntime(fake);
    await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "UPDATE_PREFERENCES",
      patch: { monitoringEnabled: true, monitoringIntent: "continuous", permissionMode: "manual" }
    });
    const manualOnly = fake.tabs.get(1) as browser.tabs.Tab;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorSample("collector-document-1234", 0, "continuous"),
        { tab: manualOnly, frameId: 0 }
      )
    ).toEqual({
      ok: false,
      error: "This collector is no longer authorized for the tab",
      retryable: true
    });
  });

  it("keeps HELLO and samples authorized when notification and action APIs reject", async () => {
    fake = seed({ continuous: true, withOperation: false });
    fake.session[STORAGE_KEYS.records] = {};
    await startRuntime(fake);
    fake.calls.notificationCreate.mockRejectedValue(new Error("notifications unavailable"));
    fake.calls.badgeText.mockRejectedValue(new Error("badge text unavailable"));
    fake.calls.badgeColor.mockRejectedValue(new Error("badge color unavailable"));
    fake.calls.actionTitle.mockRejectedValue(new Error("action title unavailable"));
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const sender = {
      tab,
      frameId: 0,
      documentId: "resilient-native-document-1234"
    } as browser.runtime.MessageSender;

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "COLLECTOR_HELLO",
          sentAtMonotonicMs: performance.now(),
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS,
          documentInstanceId: "resilient-document-1234",
          collectorMode: "continuous",
          authorityToken: null,
          payload: { hostname: "example.test" }
        },
        sender
      )
    ).toEqual({ ok: true, data: { accepted: true } });

    for (let index = 0; index < 10; index += 1) {
      const response = await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorSample("resilient-document-1234", index, "continuous", {
          documentAgeMs: index * 60_000,
          liveDomNodes: 10_000 + index * 5_000,
          addedNodesSinceLast: index === 0 ? 0 : 6_000,
          removedNodesSinceLast: index === 0 ? 0 : 1_000,
          resourceEntriesSeen: 10 + index * 40,
          resourceActivityCount: 10 + index * 40,
          timerDriftMs: index * 80
        }),
        sender
      );
      expect(response.ok).toBe(true);
    }

    const snapshot = await snapshotOf(fake);
    expect(snapshot.records[0]).toMatchObject({
      documentInstanceId: "resilient-document-1234",
      monitoringMode: "continuous",
      detector: { status: "confirmed" }
    });
    expect(fake.calls.notificationCreate).toHaveBeenCalled();
    expect(fake.calls.badgeText).toHaveBeenCalled();
    expect(fake.grantedOrigins).toEqual(new Set(MONITORED_ORIGINS));
  });

  it("ignores collector samples while a per-site policy is off or paused", async () => {
    for (const sitePolicy of [
      {
        hostname: "example.test",
        monitoring: "off" as const,
        notifications: "inherit" as const,
        automaticRecovery: "never" as const
      },
      {
        hostname: "example.test",
        monitoring: "inherit" as const,
        notifications: "inherit" as const,
        automaticRecovery: "never" as const,
        pausedUntil: Date.now() + 60_000
      }
    ]) {
      fake = seed({ continuous: true, withOperation: false });
      fake.local[STORAGE_KEYS.preferences] = {
        ...(fake.local[STORAGE_KEYS.preferences] as Preferences),
        sitePolicies: [sitePolicy]
      };
      await startRuntime(fake);
      const tab = fake.tabs.get(1) as browser.tabs.Tab;
      expect(
        await fake.dispatchRuntimeMessage<CommandResponse>(
          collectorSample("collector-document-1234", 0, "continuous"),
          { tab, frameId: 0 }
        )
      ).toEqual({ ok: false, error: "Monitoring is disabled for this site" });
    }
  });

  it("aggregates a confirmed finding notification after distinct sustained growth samples", async () => {
    fake = seed({ continuous: true, withOperation: false });
    fake.local[STORAGE_KEYS.preferences] = {
      ...(fake.local[STORAGE_KEYS.preferences] as Preferences),
      sitePolicies: [
        {
          hostname: "example.test",
          monitoring: "inherit",
          notifications: "inherit",
          automaticRecovery: "never"
        }
      ]
    };
    fake.session[STORAGE_KEYS.records] = {};
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const sender = {
      tab,
      frameId: 0,
      documentId: "native-document-1234"
    } as browser.runtime.MessageSender;

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("collector-document-1234", "continuous"),
        sender
      )
    ).toEqual({ ok: true, data: { accepted: true } });

    for (let index = 0; index < 10; index += 1) {
      const response = await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorSample("collector-document-1234", index, "continuous", {
          documentAgeMs: index * 60_000,
          liveDomNodes: 10_000 + index * 5_000,
          addedNodesSinceLast: index === 0 ? 0 : 6_000,
          removedNodesSinceLast: index === 0 ? 0 : 1_000,
          resourceEntriesSeen: 10 + index * 40,
          resourceActivityCount: 10 + index * 40,
          timerDriftMs: index * 80
        }),
        sender
      );
      expect(response.ok).toBe(true);
    }

    const snapshot = await snapshotOf(fake);
    expect(snapshot.records[0]?.detector.status).toBe("confirmed");
    expect(fake.calls.notificationCreate).toHaveBeenCalledTimes(1);
    expect(fake.calls.notificationCreate).toHaveBeenCalledWith(
      "tab-leak-guard:findings",
      expect.objectContaining({
        title: "Possible runaway tab growth",
        message: expect.not.stringContaining("example.test")
      })
    );

    await fake.dispatchRuntimeMessage<CommandResponse>(
      collectorSample("collector-document-1234", 10, "continuous", {
        documentAgeMs: 10 * 60_000,
        liveDomNodes: 11_000,
        addedNodesSinceLast: 0,
        removedNodesSinceLast: 54_000,
        resourceEntriesSeen: 410,
        resourceActivityCount: 410,
        timerDriftMs: 0
      }),
      sender
    );
    expect((await snapshotOf(fake)).records[0]?.detector.status).not.toBe("confirmed");
    expect(fake.notifications.has("tab-leak-guard:findings")).toBe(false);

    // A stale aggregate can outlive browser chrome independently of the
    // record. Removing the finding must still clear that stable extension ID.
    fake.notifications.set("tab-leak-guard:findings", {
      title: "Possible runaway tab growth",
      message: "A tab shows sustained resource growth"
    });
    fake.events.tabRemoved.emit(1, { windowId: 1, isWindowClosing: false });
    await eventually(() => !fake.notifications.has("tab-leak-guard:findings"));
    expect((await snapshotOf(fake)).records).toEqual([]);
  });

  it("rejects non-top-frame, unsupported, and unauthorized messages", async () => {
    fake = seed({ withOperation: false });
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(collectorSample("collector-document-1234", 1), {
        tab,
        frameId: 2
      })
    ).toMatchObject({ ok: false, error: "Top-level tab sender required" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(collectorSample("collector-document-1234", 1), {
        tab: { ...tab, url: "about:config" },
        frameId: 0
      })
    ).toMatchObject({ ok: false });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "GET_SNAPSHOT" }, {
        url: "https://untrusted.example/"
      })
    ).toEqual({ ok: false, error: "Unknown or unauthorized message" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "COLLECTOR_HELLO",
          sentAtMonotonicMs: performance.now(),
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS,
          documentInstanceId: "collector-document-1234",
          collectorMode: "continuous",
          authorityToken: null,
          payload: { hostname: "example.test" }
        },
        { frameId: 0 }
      )
    ).toEqual({ ok: false, error: "Top-level tab sender required" });
  });

  it("cancels recovery authority when collector document identity changes", async () => {
    fake = seed({ continuous: true });
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const sender = {
      tab,
      frameId: 0,
      documentId: "new-native-document-123456"
    } as browser.runtime.MessageSender;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("new-document-123456", "continuous"),
        sender
      )
    ).toEqual({ ok: true, data: { accepted: true } });

    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    const snapshot = await snapshotOf(fake);
    expect(snapshot.records[0]?.documentInstanceId).toBe("new-document-123456");
  });

  it("honors ignored hosts and per-site monitoring-off policy before retaining samples", async () => {
    fake = seed({ withOperation: false });
    fake.local[STORAGE_KEYS.preferences] = {
      ...DEFAULT_PREFERENCES,
      monitoringIntent: "manual",
      ignoredHosts: ["example.test"]
    };
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(collectorSample("collector-document-1234", 2), {
        tab,
        frameId: 0
      })
    ).toEqual({ ok: false, error: "Monitoring is disabled for this site" });
  });

  it("invalidates a document and preserves snooze authority across navigation", async () => {
    fake = seed({ continuous: true });
    await startRuntime(fake);
    const snooze = await fake.dispatchRuntimeMessage<CommandResponse<number>>({
      type: "SNOOZE_TAB",
      tabId: 1
    });
    expect(snooze.ok).toBe(true);
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toMatchObject({
      snoozedUntil: expect.any(Number)
    });

    fake.events.committed.emit({
      tabId: 1,
      frameId: 0,
      url: "https://example.test/next",
      timeStamp: Date.now(),
      transitionType: "link",
      transitionQualifiers: []
    });
    await eventually(() => Object.keys(fake.session[STORAGE_KEYS.records] as object).length === 0);
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toBeDefined();

    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    tab.url = "https://example.test/next";
    const sender = {
      tab,
      frameId: 0,
      documentId: "next-native-document-123456"
    } as browser.runtime.MessageSender;
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("next-document-123456", "continuous"),
        sender
      )
    ).toEqual({ ok: true, data: { accepted: true } });
    const snapshot = await snapshotOf(fake);
    expect(snapshot.records[0]?.recovery.status).toBe("suppressed");
  });

  it("reconciles a loading fence from the completed current top-level frame before allowing recovery", async () => {
    fake = seed({ withOperation: false, manualAuthority: true });
    await startRuntime(fake);
    const tab = fake.tabs.get(1);
    if (!tab) throw new Error("Navigation-fence tab is unavailable");
    fake.events.tabUpdated.emit(1, { status: "loading" }, structuredClone(tab));
    tab.status = "complete";
    vi.mocked(fake.browser.webNavigation.getFrame).mockResolvedValueOnce({
      url: tab.url ?? "",
      parentFrameId: -1,
      documentId: "firefox-document-12345678"
    } as browser.webNavigation._GetFrameReturnDetails);
    fake.events.tabUpdated.emit(1, { status: "complete" }, structuredClone(tab));
    await drainMicrotasksUntil(
      () => vi.mocked(fake.browser.webNavigation.getFrame).mock.calls.length > 0
    );
    await fake.flush();

    const prepared = await fake.dispatchRuntimeMessage<CommandResponse<{
      operationId: string;
    }>>({ type: "PREPARE_RECOVERY", tabId: 1 });
    expect(prepared).toMatchObject({ ok: true, data: { operationId: expect.any(String) } });
    if (prepared.ok) {
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "CANCEL_RECOVERY",
        operationId: prepared.data.operationId
      });
    }
  });

  it("revokes navigation authority even when alarm and browser-chrome cleanup reject", async () => {
    fake = seed({ continuous: true });
    await startRuntime(fake);
    fake.calls.alarmClear.mockRejectedValue(new Error("alarm service unavailable"));
    fake.calls.notificationClear.mockRejectedValue(new Error("notifications unavailable"));
    fake.calls.badgeText.mockRejectedValue(new Error("badge text unavailable"));
    fake.calls.badgeColor.mockRejectedValue(new Error("badge color unavailable"));
    fake.calls.actionTitle.mockRejectedValue(new Error("action title unavailable"));

    fake.events.committed.emit({
      tabId: 1,
      frameId: 0,
      url: "https://example.test/replaced-document",
      timeStamp: Date.now(),
      transitionType: "link",
      transitionQualifiers: []
    });
    await eventually(
      () =>
        (fake.local[STORAGE_KEYS.operations] as unknown[]).length === 0 &&
        Object.keys(fake.session[STORAGE_KEYS.records] as object).length === 0
    );

    expect(fake.calls.alarmClear).toHaveBeenCalled();
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect(fake.calls.tabsDiscard).not.toHaveBeenCalled();
    expect(fake.calls.tabsReload).not.toHaveBeenCalled();
  });

  it("does not let an expired snooze suppress evidence from a new document", async () => {
    fake = seed({ continuous: true, withOperation: false });
    fake.session[STORAGE_KEYS.records] = {};
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": { tabId: 1, snoozedUntil: Date.now() - 1 }
    };
    await startRuntime(fake);
    const tab = fake.tabs.get(1) as browser.tabs.Tab;
    const sender = {
      tab,
      frameId: 0,
      documentId: "post-snooze-native-document-1234"
    } as browser.runtime.MessageSender;

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>(
        collectorHello("post-snooze-document-1234", "continuous"),
        sender
      )
    ).toEqual({ ok: true, data: { accepted: true } });

    const response = await fake.dispatchRuntimeMessage<CommandResponse>(
      collectorSample("post-snooze-document-1234", 0, "continuous"),
      sender
    );

    expect(response.ok).toBe(true);
    expect((await snapshotOf(fake)).records[0]?.recovery.status).toBe("idle");
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
  });

  it("restores a durable cooldown policy independently from collector evidence", async () => {
    const cooldownUntil = Date.now() + 60_000;
    fake = seed({
      withOperation: false,
      record: { recovery: { status: "idle" }, cooldownUntil: undefined }
    });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": { tabId: 1, cooldownUntil }
    };
    const snapshot = await startRuntime(fake);

    expect(snapshot.records[0]).toMatchObject({
      cooldownUntil,
      recovery: { status: "cooldown" }
    });
  });
});

describe("background user commands and privacy controls", () => {
  it("enforces paused, cooldown, snooze, confirmation, and freshness recovery admission", async () => {
    const now = Date.now();
    const scenarios: Array<{
      name: string;
      configure(target: FakeWebExtension): void;
      error: string;
    }> = [
      {
        name: "paused",
        configure(target) {
          target.local[STORAGE_KEYS.preferences] = {
            ...(target.local[STORAGE_KEYS.preferences] as Preferences),
            monitoringEnabled: false,
            monitoringIntent: "paused"
          };
        },
        error: "Monitoring is paused; collect fresh evidence before recovery"
      },
      {
        name: "cooldown",
        configure(target) {
          const records = target.session[STORAGE_KEYS.records] as Record<string, TabRecord>;
          const record = records["1"] as TabRecord;
          record.cooldownUntil = now + 60_000;
          record.recovery = { status: "cooldown" };
          target.session[STORAGE_KEYS.tabPolicies] = {
            "1": { tabId: 1, cooldownUntil: now + 60_000 }
          };
        },
        error: "A previous recovery outcome is still uncertain or cooling down; retry later"
      },
      {
        name: "snoozed",
        configure(target) {
          const records = target.session[STORAGE_KEYS.records] as Record<string, TabRecord>;
          (records["1"] as TabRecord).snoozedUntil = now + 60_000;
          target.session[STORAGE_KEYS.tabPolicies] = {
            "1": { tabId: 1, snoozedUntil: now + 60_000 }
          };
        },
        error: "Recovery is snoozed for this tab"
      },
      {
        name: "unconfirmed",
        configure(target) {
          const records = target.session[STORAGE_KEYS.records] as Record<string, TabRecord>;
          (records["1"] as TabRecord).samples = [];
        },
        error: "The finding is no longer confirmed; no recovery was prepared"
      },
      {
        name: "stale",
        configure(target) {
          const records = target.session[STORAGE_KEYS.records] as Record<string, TabRecord>;
          (records["1"] as TabRecord).evidenceExpiresAt = now - 1;
        },
        error: "The finding is stale; collect a fresh sample before recovery"
      }
    ];

    for (const scenario of scenarios) {
      fake = seed({ withOperation: false, manualAuthority: true });
      scenario.configure(fake);
      await startRuntime(fake);

      const response = await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "PREPARE_RECOVERY",
        tabId: 1
      });

      expect(response, scenario.name).toEqual({ ok: false, error: scenario.error });
      expect(fake.calls.tabsDiscard, scenario.name).not.toHaveBeenCalled();
      expect(fake.calls.tabsReload, scenario.name).not.toHaveBeenCalled();
    }
  });

  it("prepares an exact manual action from fresh evidence and supports idempotent cancellation", async () => {
    fake = seed({
      withOperation: false,
      manualAuthority: true
    });
    await startRuntime(fake);
    const prepared = await fake.dispatchRuntimeMessage<CommandResponse<{
      operationId: string;
      nonce: string;
      action: string;
    }>>({ type: "PREPARE_RECOVERY", tabId: 1 });
    expect(prepared).toMatchObject({ ok: true, data: { action: "discard" } });
    if (!prepared.ok) throw new Error(prepared.error);
    expect((fake.local[STORAGE_KEYS.operations] as unknown[])).toHaveLength(1);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "PREPARE_RECOVERY", tabId: 1 })
    ).toEqual({
      ok: false,
      error: "Another recovery confirmation is already open for this tab"
    });

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "CANCEL_RECOVERY",
        operationId: prepared.data.operationId
      })
    ).toEqual({ ok: true, data: null });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "CANCEL_RECOVERY",
        operationId: prepared.data.operationId
      })
    ).toEqual({ ok: true, data: { alreadyCancelled: true } });
  });

  it("keeps prepared recovery authority durable when the browser badge rejects", async () => {
    fake = seed({
      withOperation: false,
      manualAuthority: true
    });
    await startRuntime(fake);
    fake.calls.badgeText.mockRejectedValue(new Error("badge text unavailable"));
    fake.calls.badgeColor.mockRejectedValue(new Error("badge color unavailable"));
    fake.calls.actionTitle.mockRejectedValue(new Error("action title unavailable"));

    const prepared = await fake.dispatchRuntimeMessage<CommandResponse<{
      operationId: string;
      nonce: string;
      action: string;
    }>>({ type: "PREPARE_RECOVERY", tabId: 1 });

    expect(prepared).toMatchObject({
      ok: true,
      data: {
        operationId: expect.any(String),
        nonce: expect.any(String),
        action: "discard"
      }
    });
    expect(fake.local[STORAGE_KEYS.operations]).toHaveLength(1);
    expect((await snapshotOf(fake)).records[0]?.recovery).toMatchObject({
      status: "awaiting-consent",
      operationId: expect.any(String)
    });
  });

  it("does not duplicate a terminal receipt when the same operation phase is already durable", async () => {
    fake = seed({ withOperation: false });
    fake.local[STORAGE_KEYS.receipts] = [
      {
        id: "existing-cancellation-receipt",
        operationId: OPERATION_ID,
        tabId: 1,
        hostname: "example.test",
        action: "discard",
        occurredAt: Date.now(),
        reasonCodes: [],
        outcome: "cancelled",
        phase: "cancelled",
        initiator: "manual",
        message: "Already cancelled"
      }
    ];
    await startRuntime(fake);

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "CANCEL_RECOVERY",
        operationId: OPERATION_ID
      })
    ).toEqual({ ok: true, data: { alreadyCancelled: true } });
    expect(fake.local[STORAGE_KEYS.receipts]).toHaveLength(1);
    expect((fake.local[STORAGE_KEYS.receipts] as Array<{ id: string }>)[0]?.id).toBe(
      "existing-cancellation-receipt"
    );
  });

  it("fails closed when recovery preflight is malformed or evidence is stale", async () => {
    fake = seed({
      withOperation: false,
      manualAuthority: true
    });
    await startRuntime(fake);
    fake.setContentMessageHandler(async () => ({ ok: true, data: { userEditState: "safe" } }));
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "PREPARE_RECOVERY", tabId: 1 })
    ).toMatchObject({ ok: false, error: expect.stringContaining("safety preflight was invalid") });

    fake = seed({
      withOperation: false,
      record: { evidenceExpiresAt: Date.now() - 1 }
    });
    await startRuntime(fake);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "PREPARE_RECOVERY", tabId: 1 })
    ).toMatchObject({ ok: false, error: expect.stringContaining("stale") });
  });

  it("starts and stops an explicit temporary monitoring session", async () => {
    fake = seed({ withOperation: false });
    const active = fake.tabs.get(1);
    if (active) active.active = true;
    installSuccessfulManualCollectorHandshake(fake);
    await startRuntime(fake);
    const scan = await fake.dispatchRuntimeMessage<CommandResponse<{ expiresAt: number }>>({
      type: "SCAN_ACTIVE_TAB"
    });
    expect(scan).toMatchObject({
      ok: true,
      data: { mode: "manual", expiresInMinutes: 15, expiresAt: expect.any(Number) }
    });
    expect(fake.calls.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, frameIds: [0] },
      files: ["collector/index.js"]
    });
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toMatchObject({
      manualSessionToken: expect.any(String),
      manualSessionDocumentInstanceId: "manual-scan-document-1234",
      manualSessionDocumentId: "manual-scan-native-document-1234"
    });

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "STOP_MONITORING_TAB", tabId: 1 })
    ).toEqual({ ok: true, data: null });
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toBeUndefined();
  });

  it("requires an explicit scan to leave paused mode and establish fresh manual authority", async () => {
    fake = seed({ withOperation: false, manualAuthority: true });
    fake.local[STORAGE_KEYS.preferences] = {
      ...DEFAULT_PREFERENCES,
      monitoringEnabled: false,
      monitoringIntent: "paused",
      permissionMode: "manual"
    };
    const active = fake.tabs.get(1);
    if (active) active.active = true;
    installSuccessfulManualCollectorHandshake(fake, "paused-restart-document-1234");
    const initial = await startRuntime(fake);
    expect(initial.preferences.monitoringIntent).toBe("paused");
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "SCAN_ACTIVE_TAB"
    });

    expect(response).toMatchObject({
      ok: true,
      data: { mode: "manual", expiresInMinutes: 15 }
    });
    expect(fake.local[STORAGE_KEYS.preferences]).toMatchObject({
      monitoringEnabled: false,
      monitoringIntent: "manual",
      permissionMode: "manual"
    });
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toMatchObject({
      "1": {
        manualSessionToken: expect.any(String),
        manualSessionDocumentInstanceId: "paused-restart-document-1234"
      }
    });
  });

  it("reports scan eligibility failures without granting or persisting authority", async () => {
    fake = seed({ withOperation: false });
    await startRuntime(fake);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "SCAN_ACTIVE_TAB" })
    ).toEqual({ ok: false, error: "No active tab is available" });

    fake = seed({ withOperation: false });
    const restricted = fake.tabs.get(1);
    if (restricted) {
      restricted.active = true;
      restricted.url = "about:config";
    }
    await startRuntime(fake);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "SCAN_ACTIVE_TAB" })
    ).toMatchObject({ ok: false, error: expect.stringContaining("cannot") });

    fake = seed({ withOperation: false });
    const amo = fake.tabs.get(1);
    if (amo) {
      amo.active = true;
      amo.url = "https://addons.mozilla.org/en-US/firefox/extensions/";
    }
    await startRuntime(fake);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "SCAN_ACTIVE_TAB" })
    ).toEqual({
      ok: false,
      error: "Firefox does not allow extensions to monitor this site"
    });
    expect(fake.calls.executeScript).not.toHaveBeenCalled();

    fake = seed({ withOperation: false });
    const disabled = fake.tabs.get(1);
    if (disabled) disabled.active = true;
    fake.local[STORAGE_KEYS.preferences] = {
      ...DEFAULT_PREFERENCES,
      sitePolicies: [
        {
          hostname: "example.test",
          monitoring: "off",
          notifications: "inherit",
          automaticRecovery: "never"
        }
      ]
    };
    await startRuntime(fake);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "SCAN_ACTIVE_TAB" })
    ).toEqual({ ok: false, error: "Monitoring is disabled for this site" });
    expect(fake.calls.executeScript).not.toHaveBeenCalled();
  });

  it("returns idempotent scan results for already-running continuous and manual collectors", async () => {
    fake = seed({ continuous: true, withOperation: false });
    const continuous = fake.tabs.get(1);
    if (continuous) continuous.active = true;
    await startRuntime(fake);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "SCAN_ACTIVE_TAB" })
    ).toEqual({
      ok: true,
      data: { tabId: 1, mode: "continuous", alreadyMonitoring: true }
    });

    const startedAt = Date.now() - 1_000;
    const expiresAt = Date.now() + 60_000;
    fake = seed({
      withOperation: false,
      record: {
        monitoringMode: "manual",
        manualSessionStartedAt: startedAt,
        manualSessionExpiresAt: expiresAt
      }
    });
    const manual = fake.tabs.get(1);
    if (manual) manual.active = true;
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": {
        tabId: 1,
        manualSessionStartedAt: startedAt,
        manualSessionExpiresAt: expiresAt,
        manualSessionToken: MANUAL_AUTHORITY_TOKEN,
        manualSessionDocumentInstanceId: "document-12345678",
        manualSessionDocumentId: "firefox-document-12345678"
      }
    };
    await startRuntime(fake);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "SCAN_ACTIVE_TAB" })
    ).toEqual({
      ok: true,
      data: {
        tabId: 1,
        mode: "manual",
        alreadyMonitoring: true,
        startedAt,
        expiresAt,
        expiresInMinutes: 1
      }
    });
    expect(fake.calls.executeScript).not.toHaveBeenCalled();
  });

  it("recognizes a live policy-only manual collector through its exact bound preflight", async () => {
    const startedAt = Date.now() - 2_000;
    const expiresAt = Date.now() + 2 * 60_000;
    fake = seed({ withOperation: false });
    fake.session[STORAGE_KEYS.records] = {};
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": {
        tabId: 1,
        manualSessionStartedAt: startedAt,
        manualSessionExpiresAt: expiresAt,
        manualSessionToken: MANUAL_AUTHORITY_TOKEN,
        manualSessionDocumentInstanceId: "policy-live-document-1234",
        manualSessionDocumentId: "policy-live-native-document-1234"
      }
    };
    const active = fake.tabs.get(1);
    if (active) active.active = true;
    fake.setContentMessageHandler(async () => ({
      ok: true,
      data: {
        documentInstanceId: "policy-live-document-1234",
        userEditState: "no-edits-observed",
        capturedAtMonotonicMs: 100,
        collectorMode: "manual",
        collectorHealth: "healthy",
        sessionExpiresAtMonotonicMs: 10_000,
        authorityToken: MANUAL_AUTHORITY_TOKEN
      }
    }));
    await startRuntime(fake);

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "SCAN_ACTIVE_TAB" })
    ).toEqual({
      ok: true,
      data: {
        tabId: 1,
        mode: "manual",
        alreadyMonitoring: true,
        startedAt,
        expiresAt,
        expiresInMinutes: 2
      }
    });
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      {
        type: "GET_RECOVERY_PREFLIGHT",
        expectedDocumentInstanceId: "policy-live-document-1234"
      },
      { documentId: "policy-live-native-document-1234" }
    );
    expect(fake.calls.executeScript).not.toHaveBeenCalled();
  });

  it("stops and re-handshakes an authorized continuous collector after its liveness timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ continuous: true, withOperation: false });
    const active = fake.tabs.get(1);
    if (active) active.active = true;
    const lifecycle: string[] = [];
    let stopSeen = false;
    fake.setContentMessageHandler(async (_tabId, message) => {
      if ((message as { type?: string }).type === "GET_RECOVERY_PREFLIGHT") {
        lifecycle.push("preflight");
        return new Promise(() => undefined);
      }
      if ((message as { type?: string }).type === "STOP_COLLECTOR") {
        lifecycle.push("stop");
        stopSeen = true;
        return { ok: true, data: { stopped: true } };
      }
      return { ok: true, data: null };
    });
    await startRuntime(fake);
    fake.calls.executeScript.mockClear();
    installSuccessfulContinuousCollectorHandshake(
      fake,
      "repaired-continuous-document-1234",
      "repaired-continuous-native-document-1234",
      () => {
        lifecycle.push("inject");
        if (!stopSeen) throw new Error("The stale continuous sentinel blocked reinjection");
      }
    );

    const scanRequest = fake.dispatchRuntimeMessage<CommandResponse<Record<string, unknown>>>({
      type: "SCAN_ACTIVE_TAB"
    });
    await drainMicrotasksUntil(() => lifecycle.includes("preflight"));
    await vi.advanceTimersByTimeAsync(RECOVERY_PREFLIGHT_MAX_AGE_MS + 1);
    await drainMicrotasksUntil(() => lifecycle.includes("inject"));
    const scan = await scanRequest;

    expect(scan).toEqual({
      ok: true,
      data: { tabId: 1, mode: "continuous", alreadyMonitoring: false }
    });
    expect(lifecycle).toEqual(["preflight", "stop", "inject"]);
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      {
        type: "STOP_COLLECTOR",
        expectedDocumentInstanceId: "document-12345678"
      },
      { documentId: "firefox-document-12345678" }
    );
    expect(fake.calls.executeScript).toHaveBeenCalledTimes(1);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect((await snapshotOf(fake)).records[0]).toMatchObject({
      documentInstanceId: "repaired-continuous-document-1234",
      documentId: "repaired-continuous-native-document-1234",
      monitoringMode: "continuous",
      manualSessionStartedAt: undefined,
      manualSessionExpiresAt: undefined,
      detector: { status: "warmup" }
    });
  });

  it("stops a timed-out restored collector before reinjection can replace its stale sentinel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    const startedAt = Date.now() - 1_000;
    const expiresAt = Date.now() + 10 * 60_000;
    fake = seed({
      withOperation: false,
      record: {
        monitoringMode: "manual",
        manualSessionStartedAt: startedAt,
        manualSessionExpiresAt: expiresAt
      }
    });
    const active = fake.tabs.get(1);
    if (active) active.active = true;
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": manualPolicyFor(
        "document-12345678",
        "firefox-document-12345678",
        expiresAt
      )
    };
    const lifecycle: string[] = [];
    let stopSeen = false;
    fake.setContentMessageHandler(async (_tabId, message) => {
      if ((message as { type?: string }).type === "GET_RECOVERY_PREFLIGHT") {
        lifecycle.push("preflight");
        return new Promise(() => undefined);
      }
      if ((message as { type?: string }).type === "STOP_COLLECTOR") {
        lifecycle.push("stop");
        stopSeen = true;
        return { ok: true, data: { stopped: true } };
      }
      return { ok: true, data: null };
    });
    installSuccessfulManualCollectorHandshake(
      fake,
      "manual-scan-document-1234",
      "manual-scan-native-document-1234",
      () => {
        lifecycle.push("inject");
        if (!stopSeen) throw new Error("The stale collector sentinel blocked reinjection");
      }
    );
    await startRuntime(fake);

    const scanRequest = fake.dispatchRuntimeMessage<CommandResponse<Record<string, unknown>>>({
      type: "SCAN_ACTIVE_TAB"
    });
    await drainMicrotasksUntil(() => fake.calls.tabsSendMessage.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(RECOVERY_PREFLIGHT_MAX_AGE_MS);
    const scan = await scanRequest;

    expect(scan).toMatchObject({
      ok: true,
      data: {
        tabId: 1,
        mode: "manual",
        expiresInMinutes: 15,
        startedAt: expect.any(Number),
        expiresAt: expect.any(Number)
      }
    });
    if (!scan.ok) throw new Error(scan.error);
    expect(scan.data).not.toHaveProperty("alreadyMonitoring");
    expect(lifecycle).toEqual(["preflight", "stop", "inject"]);
    expect(fake.calls.executeScript).toHaveBeenCalledTimes(1);
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      {
        type: "GET_RECOVERY_PREFLIGHT",
        expectedDocumentInstanceId: "document-12345678"
      },
      { documentId: "firefox-document-12345678" }
    );
    expect(fake.calls.tabsSendMessage).toHaveBeenCalledWith(
      1,
      {
        type: "STOP_COLLECTOR",
        expectedDocumentInstanceId: "document-12345678"
      },
      { documentId: "firefox-document-12345678" }
    );
    expect((await snapshotOf(fake)).records[0]).toMatchObject({
      documentInstanceId: "manual-scan-document-1234",
      documentId: "manual-scan-native-document-1234",
      monitoringMode: "manual",
      samples: [],
      detector: { status: "warmup", score: 0 }
    });
  });

  it("rolls back temporary authority when Firefox refuses collector injection", async () => {
    fake = seed({ withOperation: false });
    const active = fake.tabs.get(1);
    if (active) active.active = true;
    fake.calls.executeScript.mockRejectedValueOnce(new Error("injection denied"));
    await startRuntime(fake);

    const response = await fake.dispatchRuntimeMessage<CommandResponse>({
      type: "SCAN_ACTIVE_TAB"
    });

    expect(response).toEqual({
      ok: false,
      error: "Firefox did not allow monitoring this page: injection denied"
    });
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toBeUndefined();
  });

  it("times out and rolls back temporary authority when injection never produces a bound HELLO", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    fake = seed({ withOperation: false });
    fake.session[STORAGE_KEYS.records] = {};
    const active = fake.tabs.get(1);
    if (active) active.active = true;
    await startRuntime(fake);

    const scan = fake.dispatchRuntimeMessage<CommandResponse>({ type: "SCAN_ACTIVE_TAB" });
    await drainMicrotasksUntil(() => fake.calls.executeScript.mock.calls.length === 1);
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toMatchObject({
      manualSessionToken: expect.any(String),
      manualSessionExpiresAt: expect.any(Number)
    });
    await vi.advanceTimersByTimeAsync(MANUAL_SESSION_READY_TIMEOUT_MS);

    expect(await scan).toEqual({
      ok: false,
      error:
        "Firefox did not allow monitoring this page: The page collector did not confirm that monitoring started"
    });
    expect(fake.calls.executeScript).toHaveBeenCalledTimes(1);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
  });

  it("removes only manual-session authority while preserving a durable snooze", async () => {
    const snoozedUntil = Date.now() + 60_000;
    fake = seed({ withOperation: false, record: { monitoringMode: "manual" } });
    fake.session[STORAGE_KEYS.tabPolicies] = {
      "1": {
        tabId: 1,
        snoozedUntil,
        manualSessionStartedAt: Date.now() - 1_000,
        manualSessionExpiresAt: Date.now() + 60_000,
        manualSessionToken: MANUAL_AUTHORITY_TOKEN
      }
    };
    await startRuntime(fake);

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "STOP_MONITORING_TAB",
        tabId: 1
      })
    ).toEqual({ ok: true, data: null });
    expect((fake.session[STORAGE_KEYS.tabPolicies] as Record<string, unknown>)["1"]).toEqual({
      tabId: 1,
      snoozedUntil
    });
  });

  it("handles missing-tab commands and explicit permission synchronization fail closed", async () => {
    fake = seed({ withOperation: false });
    await startRuntime(fake);

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "PREPARE_RECOVERY", tabId: 999 })
    ).toEqual({ ok: false, error: "Tab is no longer monitored" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "SNOOZE_TAB", tabId: 999 })
    ).toEqual({ ok: false, error: "Tab is no longer monitored" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "STOP_MONITORING_TAB", tabId: 999 })
    ).toEqual({ ok: true, data: null });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "FOCUS_TAB", tabId: 999 })
    ).toMatchObject({ ok: false, error: expect.stringContaining("No tab") });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse<boolean>>({ type: "SYNC_PERMISSION" })
    ).toEqual({ ok: true, data: false });
  });

  it("reports a tab with no Firefox window identity as unfocusable", async () => {
    fake = seed({ withOperation: false });
    const tab = fake.tabs.get(1);
    if (tab) tab.windowId = undefined;
    await startRuntime(fake);

    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "FOCUS_TAB", tabId: 1 })
    ).toEqual({ ok: false, error: "Tab window is unavailable" });
  });

  it("re-injects eligible open tabs when a continuously monitored host is unignored", async () => {
    fake = seed({ continuous: true, withOperation: false });
    fake.local[STORAGE_KEYS.preferences] = {
      ...(fake.local[STORAGE_KEYS.preferences] as Preferences),
      ignoredHosts: ["example.test"]
    };
    await startRuntime(fake);
    fake.calls.executeScript.mockClear();

    const response = await fake.dispatchRuntimeMessage<CommandResponse<Preferences>>({
      type: "UNIGNORE_HOST",
      hostname: "example.test"
    });

    expect(response).toMatchObject({ ok: true, data: { ignoredHosts: [] } });
    expect(fake.calls.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, frameIds: [0] },
      files: ["collector/index.js"]
    });
  });

  it("focuses tabs, ignores sites, clears receipts, and removes closed-tab state", async () => {
    fake = seed({ withOperation: false });
    fake.local[STORAGE_KEYS.receipts] = [
      {
        id: "receipt-1",
        tabId: 1,
        hostname: "example.test",
        action: "discard",
        occurredAt: Date.now(),
        reasonCodes: [],
        outcome: "failed",
        phase: "request-failed",
        initiator: "manual",
        message: "ok"
      }
    ];
    await startRuntime(fake);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "FOCUS_TAB", tabId: 1 })
    ).toEqual({ ok: true, data: null });
    expect(fake.tabs.get(1)?.active).toBe(true);
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "IGNORE_HOST", hostname: "bad host" })
    ).toEqual({ ok: false, error: "Invalid hostname" });
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "IGNORE_HOST",
        hostname: "EXAMPLE.test."
      })
    ).toMatchObject({ ok: true, data: { ignoredHosts: ["example.test"] } });
    expect((await snapshotOf(fake)).records).toHaveLength(0);
    expect(fake.session[STORAGE_KEYS.tabPolicies]).toEqual({});
    expect(
      await fake.dispatchRuntimeMessage<CommandResponse>({ type: "CLEAR_RECEIPTS" })
    ).toEqual({ ok: true, data: null });
    expect(fake.local[STORAGE_KEYS.receipts]).toEqual([]);

    fake.events.tabRemoved.emit(1, { windowId: 1, isWindowClosing: false });
    await eventually(
      () => Object.keys((fake.session[STORAGE_KEYS.tabPolicies] as object) ?? {}).length === 0
    );
  });

  it("exports diagnostics without titles, hostnames, page text, or form values", async () => {
    fake = seed({ withOperation: false });
    fake.local[STORAGE_KEYS.receipts] = [
      {
        id: "diagnostic-receipt",
        operationId: OPERATION_ID,
        tabId: 1,
        hostname: "example.test",
        action: "discard",
        occurredAt: Date.now(),
        reasonCodes: ["DOM_GROWTH"],
        outcome: "blocked",
        phase: "blocked",
        initiator: "manual",
        message: "Sensitive host must stay redacted"
      }
    ];
    await startRuntime(fake);
    const response = await fake.dispatchRuntimeMessage<CommandResponse<Record<string, unknown>>>({
      type: "EXPORT_DIAGNOSTICS"
    });
    expect(response).toMatchObject({
      ok: true,
      data: {
        format: "tab-leak-guard-redacted-diagnostics-v1",
        extensionVersion: "0.1.1",
        privacy: {
          redactedByDefault: true,
          containsTitles: false,
          containsHostnames: false,
          containsPageText: false,
          containsFormValues: false
        },
        receipts: [
          expect.objectContaining({
            action: "discard",
            phase: "blocked",
            outcome: "blocked",
            reasonCodes: ["DOM_GROWTH"]
          })
        ]
      }
    });
    expect(JSON.stringify(response)).not.toContain("example.test");
    expect(JSON.stringify(response)).not.toContain("Example");
  });

  it("deletes extension-local data while explicitly retaining Firefox-managed permissions", async () => {
    fake = seed();
    await startRuntime(fake);
    const response = await fake.dispatchRuntimeMessage<CommandResponse>({ type: "DELETE_ALL_DATA" });
    expect(response).toMatchObject({
      ok: true,
      data: { permissionsRetainedByFirefox: true }
    });
    expect(fake.session[STORAGE_KEYS.records]).toEqual({});
    expect(fake.local[STORAGE_KEYS.operations]).toEqual([]);
    expect(fake.local[STORAGE_KEYS.receipts]).toEqual([]);
    expect(fake.grantedOrigins).toEqual(new Set());
  });

  it.each(["notification-clear", "notification-api"] as const)(
    "keeps delete-all authoritative when %s cleanup fails",
    async (failure) => {
      fake = seed();
      await startRuntime(fake);
      fake.notifications.set("tab-leak-guard:findings", {
        title: "Finding",
        message: "Finding"
      });
      if (failure === "notification-clear") {
        fake.calls.notificationClear.mockRejectedValue(new Error("notification clear failed"));
      } else {
        vi.mocked(fake.browser.notifications.getAll).mockRejectedValue(
          new Error("notification API unavailable")
        );
      }

      const response = await fake.dispatchRuntimeMessage<CommandResponse>({
        type: "DELETE_ALL_DATA"
      });

      expect(response).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          "Local extension data was deleted, but Firefox could not confirm browser UI cleanup"
        )
      });
      expect(fake.local).toMatchObject({
        [STORAGE_KEYS.preferences]: DEFAULT_PREFERENCES,
        [STORAGE_KEYS.receipts]: [],
        [STORAGE_KEYS.operations]: [],
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION
      });
      expect(fake.session).toMatchObject({
        [STORAGE_KEYS.records]: {},
        [STORAGE_KEYS.tabPolicies]: {},
        [STORAGE_KEYS.monitoringEpoch]: expect.any(Number)
      });

      const stableLocal = structuredClone(fake.local);
      const stableSession = structuredClone(fake.session);
      await fake.flush();
      expect(fake.local).toEqual(stableLocal);
      expect(fake.session).toEqual(stableSession);
    }
  );
});

function collectorSample(
  documentInstanceId: string,
  sampleSequence: number,
  collectorMode: "manual" | "continuous" = "manual",
  overrides: Partial<SampleSummary> = {}
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "COLLECTOR_SAMPLE",
    sentAtMonotonicMs: performance.now(),
    deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS,
    documentInstanceId,
    collectorMode,
    authorityToken: collectorMode === "manual" ? MANUAL_AUTHORITY_TOKEN : null,
    payload: sample({
      sampleSequence,
      documentAgeMs: (sampleSequence + 1) * 30_000,
      collectorMode,
      collectorHealth: "healthy",
      userEditState: "no-edits-observed",
      sampledAtEpochMs: Date.now(),
      ...overrides
    })
  } as const;
}

function collectorHello(
  documentInstanceId: string,
  collectorMode: "manual" | "continuous" = "manual"
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "COLLECTOR_HELLO",
    sentAtMonotonicMs: performance.now(),
    deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS,
    documentInstanceId,
    collectorMode,
    authorityToken: collectorMode === "manual" ? MANUAL_AUTHORITY_TOKEN : null,
    payload: { hostname: "example.test" }
  } as const;
}

async function snapshotOf(target: FakeWebExtension): Promise<ExtensionSnapshot> {
  const response = await target.dispatchRuntimeMessage<CommandResponse<ExtensionSnapshot>>({
    type: "GET_SNAPSHOT"
  });
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

function validPreflight(collectorMode: "manual" | "continuous") {
  return {
    ok: true as const,
    data: {
      documentInstanceId: "document-12345678",
      userEditState: "no-edits-observed" as const,
      capturedAtMonotonicMs: performance.now(),
      collectorMode,
      collectorHealth: "healthy" as const,
      sessionExpiresAtMonotonicMs: null,
      authorityToken: collectorMode === "manual" ? MANUAL_AUTHORITY_TOKEN : null
    }
  };
}

function manualPolicyFor(
  documentInstanceId: string,
  documentId: string,
  expiresAt = Date.now() + 15 * 60_000
) {
  return {
    tabId: 1,
    manualSessionStartedAt: Date.now() - 1_000,
    manualSessionExpiresAt: expiresAt,
    manualSessionToken: MANUAL_AUTHORITY_TOKEN,
    manualSessionDocumentInstanceId: documentInstanceId,
    manualSessionDocumentId: documentId
  };
}

function installSuccessfulManualCollectorHandshake(
  target: FakeWebExtension,
  documentInstanceId = "manual-scan-document-1234",
  documentId = "manual-scan-native-document-1234",
  onInject?: () => void
): void {
  target.calls.executeScript.mockImplementationOnce(
    async (details: { target: { tabId: number } }) => {
      onInject?.();
      const tab = target.tabs.get(details.target.tabId);
      if (!tab) throw new Error("Injected tab is unavailable");
      const sender = {
        tab,
        frameId: 0,
        documentId
      } as browser.runtime.MessageSender;
      const bootstrap = await target.dispatchRuntimeMessage<
        CommandResponse<{
          mode: "manual" | "continuous";
          authorityToken: string | null;
        }>
      >(
        {
          type: "GET_COLLECTOR_BOOTSTRAP",
          documentInstanceId,
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
        },
        sender
      );
      if (!bootstrap.ok || bootstrap.data.mode !== "manual" || !bootstrap.data.authorityToken) {
        throw new Error("Manual bootstrap was not authorized");
      }
      const hello = await target.dispatchRuntimeMessage<CommandResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "COLLECTOR_HELLO",
          sentAtMonotonicMs: performance.now(),
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS,
          documentInstanceId,
          collectorMode: "manual",
          authorityToken: bootstrap.data.authorityToken,
          payload: { hostname: "example.test" }
        },
        sender
      );
      if (!hello.ok) throw new Error(hello.error);
      return [];
    }
  );
}

function installSuccessfulContinuousCollectorHandshake(
  target: FakeWebExtension,
  documentInstanceId = "continuous-scan-document-1234",
  documentId = "continuous-scan-native-document-1234",
  onInject?: () => void
): void {
  target.calls.executeScript.mockImplementationOnce(
    async (details: { target: { tabId: number } }) => {
      onInject?.();
      const tab = target.tabs.get(details.target.tabId);
      if (!tab) throw new Error("Injected tab is unavailable");
      const sender = {
        tab,
        frameId: 0,
        documentId
      } as browser.runtime.MessageSender;
      const bootstrap = await target.dispatchRuntimeMessage<
        CommandResponse<{
          mode: "manual" | "continuous";
          authorityToken: string | null;
        }>
      >(
        {
          type: "GET_COLLECTOR_BOOTSTRAP",
          documentInstanceId,
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS
        },
        sender
      );
      if (!bootstrap.ok || bootstrap.data.mode !== "continuous") {
        throw new Error("Continuous bootstrap was not authorized");
      }
      if (bootstrap.data.authorityToken !== null) {
        throw new Error("Continuous bootstrap returned manual authority");
      }
      const hello = await target.dispatchRuntimeMessage<CommandResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "COLLECTOR_HELLO",
          sentAtMonotonicMs: performance.now(),
          deliveryDeadlineEpochMs: Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS,
          documentInstanceId,
          collectorMode: "continuous",
          authorityToken: null,
          payload: { hostname: "example.test" }
        },
        sender
      );
      if (!hello.ok) throw new Error(hello.error);
      return [];
    }
  );
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for background work");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function drainMicrotasksUntil(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let index = 0; index < attempts && !predicate(); index += 1) {
    await Promise.resolve();
  }
  if (!predicate()) throw new Error("Timed out waiting for queued background microtasks");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
