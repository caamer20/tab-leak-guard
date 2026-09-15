import {
  AUTOMATIC_RECOVERY_AVAILABLE,
  COLLECTOR_MESSAGE_TIMEOUT_MS,
  EVIDENCE_FRESHNESS_MS,
  MANUAL_SESSION_DURATION_MS,
  MANUAL_SESSION_READY_TIMEOUT_MS,
  MAX_SAMPLES_PER_DOCUMENT,
  MAX_TAB_RECORDS,
  QUIET_PERIOD_MS,
  RECOVERY_PREFLIGHT_MAX_AGE_MS,
  RECOVERY_REQUEST_TIMEOUT_MS,
  RECOVERY_VERIFICATION_TIMEOUT_MS,
  RESET_COOLDOWN_MS,
  RESET_GRACE_MINUTES,
  SNOOZE_DURATION_MS,
  STALE_RECORD_RETENTION_MS
} from "../shared/constants";
import { emptyDetectorResult, evaluateSamples, isAutomaticEligible } from "../detector/score";
import { evaluateSafety, safetyFromTab } from "../recovery/policy";
import {
  operationIdFromAlarm,
  prepareRecovery,
  recoveryAlarmName,
  validateExecution
} from "../recovery/transaction";
import type {
  CollectorMessage,
  CollectorPreflight,
  CommandResponse,
  ExtensionSnapshot,
  PreparedRecovery,
  RecoveryAction,
  RecoveryPreparationView,
  ResetReceipt,
  TabPolicyState,
  TabRecord,
  TabSafety,
  UiCommand
} from "../shared/types";
import { inspectUrl, normalizeHostname } from "../shared/url-policy";
import { isFiniteNumber, isRecord, isUiCommand, parseCollectorMessage } from "../shared/validation";
import {
  grantedOriginsFor,
  hasContinuousPermission,
  injectCollector,
  effectivePermissionScope,
  syncCollectorRegistration,
  unregisterCollectorRegistrationNow
} from "./permission-coordinator";
import { StateRepository } from "./state-repository";
import {
  clearAllExtensionNotifications,
  clearFindingsNotification,
  isFindingsNotification,
  maybeNotify,
  updateBadge
} from "./ui-coordinator";

const repository = new StateRepository();
const tabQueues = new Map<number, Promise<unknown>>();
let configurationQueue: Promise<void> = Promise.resolve();
let initialization: Promise<void> | null = null;
let lastGrantedOriginSignature: string | null = null;
let runtimeMutationGeneration = 0;
let permissionMutationRevision = 0;
let permissionReconciliationPending = false;
let permissionReconciliationFailureCount = 0;
let permissionReconciliationRetryTimer: ReturnType<typeof setTimeout> | undefined;
let deletionPending = false;
let deleteAllInFlight: Promise<CommandResponse> | null = null;
const retiredDocumentInstances = new Map<number, string[]>();
// A tabs.onUpdated("loading") signal can precede the definitive
// webNavigation event. Keep it as an immediate action-authority fence without
// retiring whichever document_start HELLO happens to arrive first.
type NavigationFence = { generation: number; startedAtEpochMs: number };
const pendingNavigationTabs = new Map<number, NavigationFence>();
let navigationFenceGeneration = 0;
const collectorReadyWaiters = new Map<
  number,
  {
    collectorMode: "manual" | "continuous";
    authorityToken: string | null;
    resolve: (ready: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

browser.runtime.onInstalled.addListener((details) => {
  void withConfigurationLock((generation) => onInstalled(details, generation));
});
browser.runtime.onStartup.addListener(() => {
  void initializeRuntime();
});
browser.runtime.onMessage.addListener((message: unknown, sender) => handleMessage(message, sender));
browser.permissions.onAdded.addListener(notePermissionMutation);
browser.permissions.onRemoved.addListener(notePermissionMutation);
browser.tabs.onRemoved.addListener((tabId) => {
  pendingNavigationTabs.delete(tabId);
  markDocumentChanging(tabId);
  if (deletionPending) return;
  void withTabLock(tabId, () => removeTab(tabId));
});
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  markTabStateChanging(tabId);
  if (changeInfo.status !== "loading") {
    if (changeInfo.status === "complete") {
      if (browser.webNavigation) {
        const fence = pendingNavigationTabs.get(tabId);
        if (fence) void reconcileCompletedNavigationFence(tabId, fence.generation);
      } else {
        pendingNavigationTabs.delete(tabId);
      }
    }
    return;
  }
  pendingNavigationTabs.set(tabId, {
    generation: ++navigationFenceGeneration,
    startedAtEpochMs: Date.now()
  });
  if (deletionPending) return;
  // webNavigation supplies a document identity/timestamp that lets us
  // distinguish an old document from a HELLO already accepted for the new
  // one. Older Firefox builds without it use the conservative fallback.
  if (browser.webNavigation) return;
  markDocumentChanging(tabId);
  void withTabLock(tabId, () => invalidateDocument(tabId));
});
browser.tabs.onActivated.addListener((activeInfo) => {
  if (deletionPending) return;
  markTabStateChanging(activeInfo.tabId);
  if (activeInfo.previousTabId !== undefined) markTabStateChanging(activeInfo.previousTabId);
});
browser.tabs.onHighlighted.addListener((highlightInfo) => {
  if (deletionPending) return;
  for (const tabId of highlightInfo.tabIds) markTabStateChanging(tabId);
});
browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  pendingNavigationTabs.delete(removedTabId);
  pendingNavigationTabs.delete(addedTabId);
  markDocumentChanging(removedTabId);
  markDocumentChanging(addedTabId);
  if (deletionPending) return;
  void withTabLock(removedTabId, () => removeTab(removedTabId));
  void withTabLock(addedTabId, () => invalidateDocument(addedTabId));
});
browser.alarms.onAlarm.addListener((alarm) => {
  if (deletionPending) return;
  if (alarm.name.startsWith("reset:")) {
    void browser.alarms.clear(alarm.name);
    return;
  }
  const operationId = operationIdFromAlarm(alarm.name);
  if (operationId) void handleRecoveryAlarm(operationId);
});
browser.notifications.onClicked.addListener((id) => {
  if (isFindingsNotification(id)) {
    void browser.runtime.openOptionsPage();
    void clearFindingsNotification().catch(() => undefined);
  }
});

type PerformanceWarningDetails = {
  category: string;
  severity: "low" | "medium" | "high";
  tabId?: number;
};
type PerformanceWarningEvent = {
  addListener(listener: (details: PerformanceWarningDetails) => void): void;
};
const performanceWarningEvent = (
  browser.runtime as unknown as { onPerformanceWarning?: PerformanceWarningEvent }
).onPerformanceWarning;
performanceWarningEvent?.addListener((details) => {
  if (deletionPending) return;
  if (
    details.category !== "content_script" ||
    details.severity === "low" ||
    details.tabId === undefined
  ) return;
  void withTabLock(details.tabId, () => handleCollectorPerformanceWarning(details.tabId as number));
});

if (browser.webNavigation) {
  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    clearNavigationFenceForEvent(details.tabId, details.timeStamp);
    if (navigationAlreadyRepresented(details, true)) return;
    markDocumentChanging(details.tabId);
    if (deletionPending) return;
    void withTabLock(details.tabId, () => invalidateDocument(details.tabId));
  });
  browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    clearNavigationFenceForEvent(details.tabId, details.timeStamp);
    if (navigationAlreadyRepresented(details, false)) return;
    markDocumentChanging(details.tabId);
    if (deletionPending) return;
    void withTabLock(details.tabId, () => invalidateDocument(details.tabId));
  });
}

void initializeRuntime();

async function initializeRuntime(): Promise<void> {
  if (deletionPending) return;
  if (initialization) return initialization;
  const generation = runtimeMutationGeneration;
  const current = () => !deletionPending && generation === runtimeMutationGeneration;
  initialization = (async () => {
    await repository.ready;
    if (!current()) return;
    if (repository.preferences.monitoringIntent === "paused") {
      await clearAllManualSessionPolicies();
      if (!current()) return;
    }
    await repository.purgeExpiredReceipts();
    if (!current()) return;
    await reconcileStoredRecovery(current);
    if (!current()) return;
    await pruneClosedTabs(current);
    if (!current()) return;
    await reconcilePermissionState({ invalidateOnChange: false, generation });
    if (!current()) return;
    await syncCollectorRegistration(repository.preferences, current);
    if (!current()) return;
    await Promise.allSettled([
      updateBadge(repository.records.values(), repository.preferences.monitoringEnabled)
    ]);
  })().catch((error) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

async function onInstalled(
  details: browser.runtime._OnInstalledDetails,
  generation: number
): Promise<void> {
  await initializeRuntime();
  assertConfigurationCurrent(generation);
  await repository.updatePreferences({});
  assertConfigurationCurrent(generation);
  if (details.reason === "update") {
    await invalidateRecoveryAuthority("Extension update", "all", true);
  }
  await syncCollectorRegistration(
    repository.preferences,
    () => !deletionPending && generation === runtimeMutationGeneration
  );
  assertConfigurationCurrent(generation);
  if (details.reason === "install") {
    await withTimeout(
      browser.tabs.create({ url: browser.runtime.getURL("ui/onboarding/index.html") }),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Onboarding tab creation timed out"
    );
    assertConfigurationCurrent(generation);
  }
}

async function handleMessage(
  message: unknown,
  sender: browser.runtime.MessageSender
): Promise<CommandResponse> {
  const messageGeneration = runtimeMutationGeneration;
  const uiCommand = isUiCommand(message) ? message : null;
  const trustedUi = Boolean(
    uiCommand && sender.url?.startsWith(browser.runtime.getURL(""))
  );
  if (trustedUi && uiCommand?.type === "DELETE_ALL_DATA") {
    return beginDeleteAllLocalData();
  }
  // A document_start collector may already own its isolated-world sentinel
  // while the event page is doing slower registration/tab reconciliation.
  // Bootstrap needs only hydrated, migrated state plus fresh permission checks;
  // waiting for the whole initialization cycle can make that collector time
  // out before reconciliation attempts an idempotent reinjection.
  if (isCollectorBootstrapRequest(message)) {
    await repository.ready;
    if (messageGeneration !== runtimeMutationGeneration || deletionPending) {
      return { ok: false, error: "Collector bootstrap expired or its authority changed" };
    }
    if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs)) {
      return {
        ok: false,
        error: "Collector bootstrap expired before initialization completed",
        retryable: true
      };
    }
    // Bootstrap is a bounded authority read, not a tab mutation. Do not queue
    // it behind a reload/discard verification lock: a new document_start
    // collector must learn its mode before its fail-closed bootstrap deadline.
    return handleCollectorBootstrap(message, sender);
  }
  const collectorMessage = parseCollectorMessage(message);
  if (collectorMessage) {
    // A hydrated collector has already passed the bootstrap authority read.
    // Do not keep its HELLO behind unrelated startup alarm/registration work;
    // the collector transport fails closed on a short timeout.
    await repository.ready;
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { ok: false, error: "Top-level tab sender required" };
    if (messageGeneration !== runtimeMutationGeneration || deletionPending) {
      return { ok: false, error: "Collector authority changed while the message was waiting" };
    }
    if (!collectorDeliveryCurrent(collectorMessage.deliveryDeadlineEpochMs)) {
      return withTabLock(tabId, (): Promise<CommandResponse> =>
        sender.frameId === 0
          ? rejectCollectorMessage(
              collectorMessage,
              tabId,
              "Collector message expired before it could be accepted",
              false,
              true
            )
          : Promise.resolve({ ok: false, error: "Top-level tab sender required" })
      );
    }
    return withTabLock(tabId, () => handleCollectorMessage(collectorMessage, sender));
  }
  await initializeRuntime();
  if (
    (deletionPending || messageGeneration !== runtimeMutationGeneration) &&
    uiCommand?.type !== "DELETE_ALL_DATA"
  ) {
    return { ok: false, error: "Local extension data is being deleted" };
  }
  if (trustedUi && uiCommand) {
    return handleUiCommand(uiCommand, messageGeneration);
  }
  return { ok: false, error: "Unknown or unauthorized message" };
}

function isCollectorBootstrapRequest(
  value: unknown
): value is CollectorBootstrapRequest {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.type === "GET_COLLECTOR_BOOTSTRAP" &&
    typeof value.documentInstanceId === "string" &&
    value.documentInstanceId.length >= 8 &&
    value.documentInstanceId.length <= 128 &&
    isFiniteNumber(value.deliveryDeadlineEpochMs, 0, 31_536_000_000_000)
  );
}

type CollectorBootstrapRequest = {
  type: "GET_COLLECTOR_BOOTSTRAP";
  documentInstanceId: string;
  deliveryDeadlineEpochMs: number;
};

async function handleCollectorBootstrap(
  request: CollectorBootstrapRequest,
  sender: browser.runtime.MessageSender
): Promise<CommandResponse> {
  if (!collectorDeliveryCurrent(request.deliveryDeadlineEpochMs)) {
    return {
      ok: false,
      error: "Collector bootstrap expired before it could be accepted",
      retryable: true
    };
  }
  const tab = sender.tab;
  if (tab?.id === undefined || sender.frameId !== 0) {
    return { ok: false, error: "Top-level tab sender required" };
  }
  const documentUrl = sender.url ?? tab.url;
  const support = inspectUrl(documentUrl);
  if (!support.supported) return { ok: false, error: support.reason };
  if (repository.preferences.monitoringIntent === "paused") {
    return { ok: false, error: "Monitoring is paused" };
  }
  const now = Date.now();
  const authorityEpoch = repository.monitoringEpoch;
  const authorityPermissionRevision = permissionMutationRevision;
  try {
    await requireCurrentCollectorDocument(
      tab,
      sender,
      documentUrl,
      request.documentInstanceId,
      authorityEpoch
    );
  } catch (error) {
    return { ok: false, error: errorMessage(error), retryable: true };
  }
  if (!collectorDeliveryCurrent(request.deliveryDeadlineEpochMs, authorityEpoch)) {
    await rearmManualSessionBinding(
      tab.id,
      request.documentInstanceId,
      repository.tabPolicies.get(tab.id)?.manualSessionToken
    );
    return {
      ok: false,
      error: "Collector bootstrap expired during document validation",
      retryable: true
    };
  }
  let tabPolicy = repository.tabPolicies.get(tab.id);
  const manualActive = Boolean(
    tabPolicy?.manualSessionExpiresAt &&
    tabPolicy.manualSessionExpiresAt > now &&
    tabPolicy.manualSessionToken
  );
  if (manualActive && tabPolicy) {
    const bindingMatches = manualSessionBindingMatches(
      tabPolicy,
      request.documentInstanceId,
      sender.documentId ?? null
    );
    if (bindingMatches) {
      if (!tabPolicy.manualSessionDocumentInstanceId) {
        const token = tabPolicy.manualSessionToken as string;
        await repository.upsertTabPolicy({
          ...tabPolicy,
          manualSessionDocumentInstanceId: request.documentInstanceId,
          ...(sender.documentId ? { manualSessionDocumentId: sender.documentId } : {})
        });
        if (!collectorDeliveryCurrent(request.deliveryDeadlineEpochMs, authorityEpoch)) {
          await rearmManualSessionBinding(tab.id, request.documentInstanceId, token);
          return {
            ok: false,
            error: "Collector bootstrap expired while binding its session",
            retryable: true
          };
        }
        try {
          await requireCurrentCollectorDocument(
            tab,
            sender,
            documentUrl,
            request.documentInstanceId,
            authorityEpoch
          );
        } catch (error) {
          const current = repository.tabPolicies.get(tab.id);
          if (
            current?.manualSessionToken === token &&
            current.manualSessionDocumentInstanceId === request.documentInstanceId
          ) await rearmManualSessionBinding(tab.id, request.documentInstanceId, token);
          return { ok: false, error: errorMessage(error), retryable: true };
        }
        if (!collectorDeliveryCurrent(request.deliveryDeadlineEpochMs, authorityEpoch)) {
          await rearmManualSessionBinding(tab.id, request.documentInstanceId, token);
          return {
            ok: false,
            error: "Collector bootstrap expired during final validation",
            retryable: true
          };
        }
        tabPolicy = repository.tabPolicies.get(tab.id);
      }
      if (
        !tabPolicy?.manualSessionToken ||
        !tabPolicy.manualSessionExpiresAt ||
        tabPolicy.manualSessionExpiresAt <= Date.now() ||
        !manualSessionBindingMatches(
          tabPolicy,
          request.documentInstanceId,
          sender.documentId ?? null
        )
      ) {
        return { ok: false, error: "Collector authority changed during bootstrap" };
      }
      if (!collectorDeliveryCurrent(request.deliveryDeadlineEpochMs, authorityEpoch)) {
        await rearmManualSessionBinding(
          tab.id,
          request.documentInstanceId,
          tabPolicy.manualSessionToken
        );
        return {
          ok: false,
          error: "Collector bootstrap expired before acceptance",
          retryable: true
        };
      }
      return {
        ok: true,
        data: {
          mode: "manual",
          sampleVisibleSeconds: repository.preferences.sampleVisibleSeconds,
          sampleHiddenSeconds: repository.preferences.sampleHiddenSeconds,
          manualSessionExpiresAtEpochMs: tabPolicy.manualSessionExpiresAt,
          authorityToken: tabPolicy.manualSessionToken
        }
      };
    }
  }

  const exactOrigin = originPattern(documentUrl);
  const selected =
    repository.preferences.permissionMode === "all-sites" ||
    (exactOrigin !== null && repository.preferences.selectedOrigins.includes(exactOrigin));
  let originGranted = false;
  if (exactOrigin !== null) {
    try {
      originGranted = await withTimeout(
        browser.permissions.contains({ origins: [exactOrigin] }),
        RECOVERY_PREFLIGHT_MAX_AGE_MS,
        "Collector permission check timed out"
      );
    } catch (error) {
      return {
        ok: false,
        error: errorMessage(error),
        retryable: error instanceof OperationTimeoutError
      };
    }
  }
  if (
    permissionReconciliationPending ||
    authorityPermissionRevision !== permissionMutationRevision
  ) {
    return {
      ok: false,
      error: "Website permission authority changed during bootstrap",
      retryable: true
    };
  }
  if (!collectorDeliveryCurrent(request.deliveryDeadlineEpochMs, authorityEpoch)) {
    await rearmManualSessionBinding(
      tab.id,
      request.documentInstanceId,
      repository.tabPolicies.get(tab.id)?.manualSessionToken
    );
    return {
      ok: false,
      error: "Collector bootstrap expired during permission validation",
      retryable: true
    };
  }
  try {
    await requireCurrentCollectorDocument(
      tab,
      sender,
      documentUrl,
      request.documentInstanceId,
      authorityEpoch
    );
  } catch (error) {
    return { ok: false, error: errorMessage(error), retryable: true };
  }
  if (!collectorDeliveryCurrent(request.deliveryDeadlineEpochMs, authorityEpoch)) {
    await rearmManualSessionBinding(
      tab.id,
      request.documentInstanceId,
      repository.tabPolicies.get(tab.id)?.manualSessionToken
    );
    return {
      ok: false,
      error: "Collector bootstrap expired during final validation",
      retryable: true
    };
  }
  const continuousActive =
    repository.preferences.monitoringEnabled &&
    repository.preferences.monitoringIntent === "continuous" &&
    (repository.preferences.permissionMode === "all-sites" ||
      (exactOrigin !== null && repository.preferences.selectedOrigins.includes(exactOrigin))) &&
    selected &&
    originGranted;
  if (!continuousActive) {
    return {
      ok: false,
      error: manualActive
        ? "The temporary monitoring session belongs to another document"
        : "Monitoring is not enabled for this document"
    };
  }
  if (!collectorDeliveryCurrent(request.deliveryDeadlineEpochMs, authorityEpoch)) {
    return {
      ok: false,
      error: "Collector bootstrap expired before acceptance",
      retryable: true
    };
  }
  return {
    ok: true,
    data: {
      mode: "continuous",
      sampleVisibleSeconds: repository.preferences.sampleVisibleSeconds,
      sampleHiddenSeconds: repository.preferences.sampleHiddenSeconds,
      manualSessionExpiresAtEpochMs: null,
      authorityToken: null
    }
  };
}

function collectorDeliveryCurrent(
  deliveryDeadlineEpochMs: number,
  authorityEpoch = repository.monitoringEpoch
): boolean {
  const now = Date.now();
  return (
    !deletionPending &&
    repository.monitoringEpoch === authorityEpoch &&
    deliveryDeadlineEpochMs > now &&
    // Reject forged or accidentally mixed-version envelopes that try to turn
    // a short transport lease into long-lived collector authority.
    deliveryDeadlineEpochMs <= now + COLLECTOR_MESSAGE_TIMEOUT_MS + 1_000
  );
}

async function clearExpiredManualSessionBinding(
  tabId: number,
  documentInstanceId: string,
  authorityToken?: string
): Promise<void> {
  const policy = repository.tabPolicies.get(tabId);
  if (
    !policy ||
    policy.manualSessionDocumentInstanceId !== documentInstanceId ||
    (authorityToken !== undefined && policy.manualSessionToken !== authorityToken)
  ) return;
  await clearManualSessionPolicy(tabId);
}

async function rejectCollectorMessage(
  message: CollectorMessage,
  tabId: number,
  error: string,
  currentDocumentWasValidated = false,
  retryable = false
): Promise<CommandResponse> {
  const record = repository.records.get(tabId);
  let findingSetChanged = false;
  if (
    record &&
    (record.documentInstanceId === message.documentInstanceId || currentDocumentWasValidated)
  ) {
    if (!retryable) retireDocumentInstance(record);
    // Fence the record synchronously before any fallible browser/storage work.
    // Recovery commands for this tab serialize behind this handler and can no
    // longer observe evidence owned by a collector that is about to stop.
    if (repository.records.get(tabId) === record) repository.records.delete(tabId);
    findingSetChanged = true;
  }
  const cleanup: Promise<unknown>[] = [];
  if (
    record &&
    (record.documentInstanceId === message.documentInstanceId || currentDocumentWasValidated)
  ) {
    cleanup.push(
      cancelOperationsForTab(tabId, "Collector admission was rejected").catch(async () => {
        await repository.persistOperations();
      }),
      repository.persistRecords().catch(async () => {
        try {
          await repository.persistRecords();
        } catch (persistenceError) {
          repository.scheduleRecordCheckpoint(1_000);
          throw persistenceError;
        }
      })
    );
  }
  if (message.collectorMode === "manual") {
    cleanup.push(
      (retryable
        ? rearmManualSessionBinding(
            tabId,
            message.documentInstanceId,
            message.authorityToken ?? undefined
          )
        : clearExpiredManualSessionBinding(
            tabId,
            message.documentInstanceId,
            message.authorityToken ?? undefined
          )).catch(async () => {
        await repository.persistTabPolicies();
      })
    );
  }
  await Promise.allSettled(cleanup);
  if (findingSetChanged) void resetFindingsNotification().catch(() => undefined);
  void updateBadge(
    repository.records.values(),
    repository.preferences.monitoringEnabled
  ).catch(() => undefined);
  return { ok: false, error, ...(retryable ? { retryable: true } : {}) };
}

async function rearmManualSessionBinding(
  tabId: number,
  documentInstanceId: string,
  authorityToken?: string
): Promise<void> {
  const policy = repository.tabPolicies.get(tabId);
  if (
    !policy ||
    policy.manualSessionDocumentInstanceId !== documentInstanceId ||
    policy.manualSessionToken !== authorityToken ||
    !policy.manualSessionExpiresAt ||
    policy.manualSessionExpiresAt <= Date.now() ||
    monitoringIsPaused()
  ) return;
  // Without Firefox's native document identity, clearing the UUID binding
  // would let the same temporary token bind to a later document. Require a
  // fresh user-initiated scan instead.
  if (!policy.manualSessionDocumentId) {
    await clearManualSessionPolicy(tabId);
    return;
  }
  const rearmed: TabPolicyState = { ...policy };
  delete rearmed.manualSessionDocumentInstanceId;
  await repository.upsertTabPolicy(rearmed);
}

async function handleCollectorMessage(
  message: CollectorMessage,
  sender: browser.runtime.MessageSender
): Promise<CommandResponse> {
  const senderTab = sender.tab;
  if (senderTab?.id === undefined || sender.frameId !== 0) {
    return { ok: false, error: "Top-level tab sender required" };
  }
  let tab = senderTab as browser.tabs.Tab & { id: number };
  if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs)) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector message expired before it could be accepted",
      false,
      true
    );
  }
  const documentUrl = sender.url ?? tab.url;
  const support = inspectUrl(documentUrl);
  if (!support.supported) {
    return rejectCollectorMessage(message, tab.id, support.reason);
  }
  if (repository.preferences.ignoredHosts.includes(support.hostname)) {
    return rejectCollectorMessage(message, tab.id, "Monitoring is disabled for this site");
  }
  const sitePolicy = repository.preferences.sitePolicies.find(
    (policy) => policy.hostname === support.hostname
  );
  if (sitePolicy?.monitoring === "off" || (sitePolicy?.pausedUntil ?? 0) > Date.now()) {
    return rejectCollectorMessage(message, tab.id, "Monitoring is disabled for this site");
  }
  const authorityEpoch = repository.monitoringEpoch;
  if (
    !(await isCollectorModeAuthorized(
      tab,
      documentUrl,
      message.collectorMode,
      message.authorityToken,
      message.documentInstanceId,
      sender.documentId ?? null
    ))
  ) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "This collector is no longer authorized for the tab",
      false,
      true
    );
  }
  if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector message expired during authorization",
      false,
      true
    );
  }
  try {
    tab = await requireCurrentCollectorDocument(
      tab,
      sender,
      documentUrl,
      message.documentInstanceId,
      authorityEpoch
    );
  } catch (error) {
    return rejectCollectorMessage(message, tab.id, errorMessage(error), false, true);
  }
  if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector message expired during document validation",
      true,
      true
    );
  }
  if (
    !(await isCollectorModeAuthorized(
      tab,
      documentUrl,
      message.collectorMode,
      message.authorityToken,
      message.documentInstanceId,
      sender.documentId ?? null
    ))
  ) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector authority expired during document validation",
      true,
      true
    );
  }
  if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector message expired during final authorization",
      true,
      true
    );
  }
  if (message.type === "COLLECTOR_HELLO") {
    const now = Date.now();
    const nativeDocumentId = sender.documentId ?? null;
    const existing = repository.records.get(tab.id);
    const sameDocument =
      existing?.documentInstanceId === message.documentInstanceId &&
      (existing.documentId === null ||
        nativeDocumentId === null ||
        existing.documentId === nativeDocumentId);
    const findingSetChanged = Boolean(existing && !sameDocument);
    if (existing && !sameDocument) {
      retireDocumentInstance(existing);
      try {
        await cancelOperationsForTab(tab.id, "Document identity changed");
      } catch (error) {
        return rejectCollectorMessage(message, tab.id, errorMessage(error), true, true);
      }
      if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
        return rejectCollectorMessage(
          message,
          tab.id,
          "Collector HELLO expired while replacing old evidence",
          true,
          true
        );
      }
      if (deletionPending || repository.monitoringEpoch !== authorityEpoch) {
        return rejectCollectorMessage(
          message,
          tab.id,
          "Collector authority changed while HELLO was processed",
          true
        );
      }
    }
    const record = sameDocument
      ? existing
      : createRecord(tab, message.documentInstanceId, nativeDocumentId, support.hostname, now);
    record.title = safeTitle(tab.title, support.hostname);
    record.windowId = tab.windowId ?? -1;
    record.documentId = nativeDocumentId ?? record.documentId;
    record.updatedAt = now;
    record.lastAccessedAt = tab.lastAccessed ?? record.lastAccessedAt;
    record.monitoringEpoch = repository.monitoringEpoch;
    record.monitoringMode = message.collectorMode;
    if (record.monitoringMode === "continuous") {
      record.manualSessionStartedAt = undefined;
      record.manualSessionExpiresAt = undefined;
      try {
        await clearManualSessionPolicy(record.tabId);
      } catch (error) {
        return rejectCollectorMessage(message, tab.id, errorMessage(error), true, true);
      }
      if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
        return rejectCollectorMessage(
          message,
          tab.id,
          "Collector HELLO expired while updating its session",
          true,
          true
        );
      }
      if (deletionPending || repository.monitoringEpoch !== authorityEpoch) {
        return rejectCollectorMessage(
          message,
          tab.id,
          "Collector authority changed while HELLO was processed",
          true
        );
      }
    }
    if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
      return rejectCollectorMessage(
        message,
        tab.id,
        "Collector HELLO expired before publication",
        true,
        true
      );
    }
    if (
      !(await isCollectorModeAuthorized(
        tab,
        documentUrl,
        message.collectorMode,
        message.authorityToken,
        message.documentInstanceId,
        sender.documentId ?? null
      ))
    ) {
      return rejectCollectorMessage(
      message,
      tab.id,
      "Collector authority expired before HELLO publication",
      true,
      true
      );
    }
    if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
      return rejectCollectorMessage(
        message,
        tab.id,
        "Collector HELLO expired during final authorization",
        true,
        true
      );
    }
    applyTabPolicy(record, now);
    repository.records.set(tab.id, record);
    enforceRecordBound();
    if (findingSetChanged) void resetFindingsNotification().catch(() => undefined);
    try {
      await repository.persistRecords();
    } catch (error) {
      return rejectCollectorMessage(message, tab.id, errorMessage(error), true, true);
    }
    if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
      return rejectCollectorMessage(
        message,
        tab.id,
        "Collector HELLO expired during durable publication",
        true,
        true
      );
    }
    if (
      !(await isCollectorModeAuthorized(
        tab,
        documentUrl,
        message.collectorMode,
        message.authorityToken,
        message.documentInstanceId,
        sender.documentId ?? null
      ))
    ) {
      return rejectCollectorMessage(
      message,
      tab.id,
      "Collector authority expired during HELLO publication",
      true,
      true
      );
    }
    if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
      return rejectCollectorMessage(
        message,
        tab.id,
        "Collector HELLO expired before acknowledgement",
        true,
        true
      );
    }
    if (
      deletionPending ||
      repository.monitoringEpoch !== authorityEpoch ||
      repository.records.get(tab.id) !== record
    ) {
      return rejectCollectorMessage(
        message,
        tab.id,
        "Collector authority changed while HELLO was processed",
        true
      );
    }
    settleCollectorReadyWaiter(
      tab.id,
      message.collectorMode,
      message.authorityToken,
      true
    );
    void updateBadge(repository.records.values(), repository.preferences.monitoringEnabled);
    return { ok: true, data: { accepted: true } };
  }

  const now = Date.now();
  const existing = repository.records.get(tab.id);
  const nativeDocumentId = sender.documentId ?? null;
  const sameDocument =
    existing?.documentInstanceId === message.documentInstanceId &&
    (existing.documentId === null || nativeDocumentId === null || existing.documentId === nativeDocumentId);
  if (existing && !sameDocument) {
    retireDocumentInstance(existing);
    try {
      await cancelOperationsForTab(tab.id, "Document identity changed");
    } catch (error) {
      return rejectCollectorMessage(message, tab.id, errorMessage(error), true, true);
    }
    if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
      return rejectCollectorMessage(
        message,
        tab.id,
        "Collector sample expired while replacing old evidence",
        true,
        true
      );
    }
  }
  if (!existing || !sameDocument) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "A current collector HELLO is required before samples",
      true,
      true
    );
  }
  const record = existing;
  const lastSequence = record.samples.at(-1)?.sampleSequence ?? -1;
  if (message.payload.sampleSequence <= lastSequence) {
    return { ok: true, data: { duplicate: true } };
  }

  const previousStatus = record.detector.status;
  const userEditState =
    message.payload.userEditState ?? (message.payload.dirty ? "edits-observed" : "unknown");
  record.title = safeTitle(tab.title, support.hostname);
  record.windowId = tab.windowId ?? -1;
  record.documentId = nativeDocumentId ?? record.documentId;
  record.updatedAt = now;
  record.lastAccessedAt = tab.lastAccessed ?? record.lastAccessedAt;
  record.revision += 1;
  record.monitoringEpoch = repository.monitoringEpoch;
  record.monitoringMode = message.collectorMode;
  if (record.monitoringMode === "continuous") {
    record.manualSessionStartedAt = undefined;
    record.manualSessionExpiresAt = undefined;
    try {
      await clearManualSessionPolicy(record.tabId);
    } catch (error) {
      return rejectCollectorMessage(message, tab.id, errorMessage(error), true, true);
    }
    if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
      return rejectCollectorMessage(
        message,
        tab.id,
        "Collector sample expired while updating its session",
        true,
        true
      );
    }
    if (deletionPending || repository.monitoringEpoch !== authorityEpoch) {
      return rejectCollectorMessage(
        message,
        tab.id,
        "Collector authority changed while the sample was processed",
        true
      );
    }
  }
  if (
    !(await isCollectorModeAuthorized(
      tab,
      documentUrl,
      message.collectorMode,
      message.authorityToken,
      message.documentInstanceId,
      sender.documentId ?? null
    ))
  ) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector authority expired before sample evaluation",
      true,
      true
    );
  }
  if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector sample expired before evaluation",
      true,
      true
    );
  }
  record.samples = [...record.samples, message.payload].slice(-MAX_SAMPLES_PER_DOCUMENT);
  record.evidenceExpiresAt = now + EVIDENCE_FRESHNESS_MS;
  record.safety = safetyFromTab(
    tab,
    userEditState === "edits-observed",
    repository.preferences.quietPeriodMinutes * 60_000,
    now,
    { userEditState, safetyComplete: false }
  );
  record.detector = evaluateSamples(record.samples, record.detector, {
    confirmationScore: repository.preferences.confirmationScore,
    evaluatedAtDocumentAgeMs: message.payload.documentAgeMs,
    evaluatedAtEpochMs: now
  });
  applyTabPolicy(record, now);
  repository.records.set(tab.id, record);
  enforceRecordBound();

  if (record.detector.status === "confirmed") {
    await onConfirmed(
      record,
      now,
      authorityEpoch,
      message.deliveryDeadlineEpochMs
    );
  }
  if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector sample expired during evaluation",
      true,
      true
    );
  }
  if (
    deletionPending ||
    repository.monitoringEpoch !== authorityEpoch ||
    repository.records.get(tab.id) !== record
  ) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector authority changed while the sample was processed",
      true
    );
  }
  if (previousStatus === "confirmed" && record.detector.status !== "confirmed") {
    void resetFindingsNotification().catch(() => undefined);
  }
  if (previousStatus !== record.detector.status) {
    try {
      await repository.persistRecords();
    } catch (error) {
      return rejectCollectorMessage(message, tab.id, errorMessage(error), true, true);
    }
  } else repository.scheduleRecordCheckpoint();
  if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector sample expired during durable publication",
      true,
      true
    );
  }
  if (
    !(await isCollectorModeAuthorized(
      tab,
      documentUrl,
      message.collectorMode,
      message.authorityToken,
      message.documentInstanceId,
      sender.documentId ?? null
    ))
  ) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector authority expired during sample publication",
      true,
      true
    );
  }
  if (!collectorDeliveryCurrent(message.deliveryDeadlineEpochMs, authorityEpoch)) {
    return rejectCollectorMessage(
      message,
      tab.id,
      "Collector sample expired before acknowledgement",
      true,
      true
    );
  }
  void updateBadge(repository.records.values(), repository.preferences.monitoringEnabled);
  return {
    ok: true,
    data: {
      status: record.detector.status,
      score: record.detector.score,
      quality: "quality" in record.detector ? record.detector.quality : undefined,
      automaticEligible: isAutomaticEligible(record.detector)
    }
  };
}

function createRecord(
  tab: browser.tabs.Tab,
  documentInstanceId: string,
  documentId: string | null,
  hostname: string,
  now: number
): TabRecord {
  const policy = repository.tabPolicies.get(tab.id as number);
  const record: TabRecord = {
    tabId: tab.id as number,
    windowId: tab.windowId ?? -1,
    documentInstanceId,
    documentId,
    revision: 0,
    hostname,
    title: safeTitle(tab.title, hostname),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: tab.lastAccessed ?? now,
    samples: [],
    detector: emptyDetectorResult(),
    safety: safetyFromTab(tab, false, QUIET_PERIOD_MS, now, {
      userEditState: "unknown",
      safetyComplete: false
    }),
    recovery: { status: "idle" },
    evidenceExpiresAt: now,
    monitoringEpoch: repository.monitoringEpoch,
    monitoringMode:
      policy?.manualSessionExpiresAt && policy.manualSessionExpiresAt > now
        ? "manual"
        : repository.preferences.monitoringEnabled
          ? "continuous"
          : "manual",
    ...(policy?.manualSessionStartedAt
      ? { manualSessionStartedAt: policy.manualSessionStartedAt }
      : {}),
    ...(policy?.manualSessionExpiresAt
      ? { manualSessionExpiresAt: policy.manualSessionExpiresAt }
      : {}),
    ...(policy?.snoozedUntil ? { snoozedUntil: policy.snoozedUntil } : {}),
    ...(policy?.cooldownUntil ? { cooldownUntil: policy.cooldownUntil } : {})
  };
  return record;
}

async function onConfirmed(
  record: TabRecord,
  now: number,
  authorityEpoch: number,
  deliveryDeadlineEpochMs: number
): Promise<void> {
  const notificationContent = repository.preferences.notificationContent;
  if (
    notificationAuthorityCurrent(
      record,
      authorityEpoch,
      notificationContent,
      deliveryDeadlineEpochMs
    )
  ) {
    const confirmedCount = [...repository.records.values()].filter(
      (candidate) => candidate.detector.status === "confirmed"
    ).length;
    // Browser notification calls can remain pending. Keep them serialized for
    // privacy, but do not hold this tab's collector/recovery lock while the OS
    // notification service responds.
    void notifyCurrentFinding(
      record,
      now,
      authorityEpoch,
      notificationContent,
      confirmedCount,
      deliveryDeadlineEpochMs
    );
  }
  if (!AUTOMATIC_RECOVERY_AVAILABLE || repository.preferences.recoveryMode !== "auto-safe") return;
  if (record.recovery.status !== "idle" || record.recovery.automaticSuppressedForDocument) return;

  const permissionGranted = await hasContinuousPermission(repository.preferences);
  let context: FreshRecoveryContext;
  try {
    context = await getFreshRecoveryContext(record);
  } catch {
    return;
  }
  record.safety = context.safety;
  const decision = evaluateSafety(
    record,
    context.safety,
    repository.preferences,
    repository.receipts,
    now,
    {
      automaticRecoveryAvailable: AUTOMATIC_RECOVERY_AVAILABLE,
      permissionGranted,
      expectedMonitoringEpoch: repository.monitoringEpoch,
      requireNativeDocumentId: true
    }
  );
  if (!decision.safe || !isAutomaticEligible(record.detector)) return;
  const prepared = prepareRecovery({
    record,
    tab: context.tab,
    initiator: "automatic",
    monitoringEpoch: repository.monitoringEpoch,
    permissionRevision: permissionMutationRevision,
    now,
    operationId: crypto.randomUUID(),
    nonce: crypto.randomUUID()
  });
  if (!prepared.ok) return;
  prepared.operation.state = "awaiting-consent";
  const pendingAt = now + RESET_GRACE_MINUTES * 60_000;
  record.recovery = {
    status: "awaiting-consent",
    operationId: prepared.operation.operationId,
    pendingAt
  };
  record.pendingResetAt = pendingAt;
  await repository.putOperation(prepared.operation);
  if (
    repository.monitoringEpoch !== prepared.operation.monitoringEpoch ||
    repository.records.get(record.tabId) !== record ||
    !recoveryPermissionAuthorityCurrent(record, prepared.operation) ||
    monitoringIsPaused()
  ) {
    await finishWithoutAction(
      prepared.operation,
      "Monitoring authority changed while recovery was prepared",
      "blocked"
    );
    return;
  }
  await repository.persistRecords();
  browser.alarms.create(recoveryAlarmName(prepared.operation), { when: pendingAt });
}

async function notifyCurrentFinding(
  record: TabRecord,
  now: number,
  authorityEpoch: number,
  notificationContent: ExtensionSnapshot["preferences"]["notificationContent"],
  confirmedCount: number,
  deliveryDeadlineEpochMs: number
): Promise<void> {
  const current = () =>
    notificationAuthorityCurrent(
      record,
      authorityEpoch,
      notificationContent,
      deliveryDeadlineEpochMs
    );
  const notified = await maybeNotify(
    record,
    now,
    notificationContent,
    confirmedCount,
    current
  ).catch(() => false);
  if (!notified || !current()) return;
  record.notifiedAt = now;
  repository.scheduleRecordCheckpoint();
}

function notificationAuthorityCurrent(
  record: TabRecord,
  authorityEpoch: number,
  expectedContent: ExtensionSnapshot["preferences"]["notificationContent"],
  deliveryDeadlineEpochMs = Number.MAX_SAFE_INTEGER
): boolean {
  const sitePolicy = repository.preferences.sitePolicies.find(
    (policy) => policy.hostname === record.hostname
  );
  return (
    !deletionPending &&
    Date.now() < deliveryDeadlineEpochMs &&
    repository.monitoringEpoch === authorityEpoch &&
    (record.monitoringMode !== "continuous" || !permissionReconciliationPending) &&
    repository.records.get(record.tabId) === record &&
    repository.preferences.monitoringIntent !== "paused" &&
    repository.preferences.notificationsEnabled &&
    repository.preferences.notificationContent === expectedContent &&
    !repository.preferences.ignoredHosts.includes(record.hostname) &&
    sitePolicy?.monitoring !== "off" &&
    (sitePolicy?.pausedUntil ?? 0) <= Date.now() &&
    sitePolicy?.notifications !== "off" &&
    record.recovery.status !== "cooldown" &&
    record.recovery.status !== "suppressed"
  );
}

async function handleRecoveryAlarm(operationId: string): Promise<void> {
  const alarmGeneration = runtimeMutationGeneration;
  await initializeRuntime();
  if (deletionPending || alarmGeneration !== runtimeMutationGeneration) return;
  const operation = repository.operations.get(operationId);
  if (!operation) return;
  await withTabLock(operation.tabId, async () => {
    if (deletionPending || alarmGeneration !== runtimeMutationGeneration) return;
    const current = repository.operations.get(operationId);
    if (!current) return;
    if (recoveryOperationWasIssued(current)) return;
    if (!AUTOMATIC_RECOVERY_AVAILABLE || current.initiator !== "automatic") {
      await finishWithoutAction(current, "Automatic recovery is unavailable", "cancelled");
      return;
    }
    await executeRecoveryOperation(operationId, current.nonce, false, true);
  });
}

async function handleUiCommand(
  command: UiCommand,
  messageGeneration: number
): Promise<CommandResponse> {
  if (command.type === "DELETE_ALL_DATA") return beginDeleteAllLocalData();
  if (deletionPending) {
    return { ok: false, error: "Local extension data is being deleted" };
  }
  switch (command.type) {
    case "GET_SNAPSHOT":
      try {
        return { ok: true, data: await snapshot(messageGeneration) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    case "SCAN_ACTIVE_TAB":
      return withConfigurationLock((generation) => monitorActiveTabTemporarily(generation));
    case "SYNC_PERMISSION":
      return withConfigurationLock(async (generation) => {
        const permissionRevision = permissionMutationRevision;
        assertPermissionReadCurrent(permissionRevision);
        await reconcilePermissionState({ generation });
        assertConfigurationCurrent(generation);
        assertPermissionReadCurrent(permissionRevision);
        const granted = await hasContinuousPermission(repository.preferences);
        assertConfigurationCurrent(generation);
        assertPermissionReadCurrent(permissionRevision);
        return { ok: true, data: granted };
      });
    case "FOCUS_TAB":
      return focusTab(command.tabId);
    case "PREPARE_RECOVERY":
      return withTabLock(command.tabId, () => prepareManualRecovery(command.tabId));
    case "EXECUTE_RECOVERY": {
      const operation = repository.operations.get(command.operationId);
      if (!operation) return { ok: false, error: "Recovery confirmation is missing or expired" };
      return withTabLock(operation.tabId, () =>
        executeRecoveryOperation(
          command.operationId,
          command.nonce,
          command.acknowledgeUserEditRisk === true,
          false
        )
      );
    }
    case "CANCEL_RECOVERY": {
      const operation = repository.operations.get(command.operationId);
      if (!operation) return cancellationResultForMissingOperation(command.operationId);
      return withTabLock(operation.tabId, async () => {
        const current = repository.operations.get(command.operationId);
        if (!current || recoveryOperationWasIssued(current)) {
          return cancellationResultForMissingOperation(command.operationId);
        }
        await finishWithoutAction(current, "Cancelled by the user", "cancelled");
        return { ok: true, data: null };
      });
    }
    case "STOP_MONITORING_TAB":
      return withTabLock(command.tabId, () => stopMonitoringTab(command.tabId));
    case "SNOOZE_TAB":
      return withTabLock(command.tabId, () => snoozeTab(command.tabId));
    case "IGNORE_HOST":
      return withConfigurationLock((generation) =>
        setHostIgnored(command.hostname, true, generation)
      );
    case "UNIGNORE_HOST":
      return withConfigurationLock((generation) =>
        setHostIgnored(command.hostname, false, generation)
      );
    case "UPDATE_PREFERENCES":
      return withConfigurationLock((generation) => updatePreferences(command.patch, generation));
    case "CLEAR_RECEIPTS":
      await repository.clearReceipts();
      return { ok: true, data: null };
    case "EXPORT_DIAGNOSTICS":
      return { ok: true, data: buildRedactedDiagnostics() };
  }
}

function cancellationResultForMissingOperation(operationId: string): CommandResponse {
  const receipt = repository.receipts.find((candidate) => candidate.operationId === operationId);
  if (!receipt) {
    return { ok: false, error: "Recovery is no longer pending; no cancellation was applied" };
  }
  if (receipt.outcome === "cancelled" || receipt.outcome === "expired") {
    return { ok: true, data: { alreadyCancelled: true } };
  }
  if (receipt.outcome === "success") {
    return { ok: false, error: "The recovery action already completed and was not cancelled" };
  }
  if (receipt.outcome === "unknown") {
    return {
      ok: false,
      error: "The recovery request was journaled, but whether Firefox received or completed it is unknown"
    };
  }
  return { ok: false, error: "The recovery attempt already finished and cannot be cancelled" };
}

async function prepareManualRecovery(tabId: number): Promise<CommandResponse> {
  if (deletionPending) return { ok: false, error: "Local extension data is being deleted" };
  if (repository.preferences.monitoringIntent === "paused") {
    return { ok: false, error: "Monitoring is paused; collect fresh evidence before recovery" };
  }
  const record = repository.records.get(tabId);
  if (!record) return { ok: false, error: "Tab is no longer monitored" };
  if (record.monitoringMode === "continuous" && permissionReconciliationPending) {
    return { ok: false, error: "Website permissions are changing; wait for Firefox to finish" };
  }
  if (pendingNavigationTabs.has(tabId)) {
    return { ok: false, error: "The tab is navigating; wait for the new document before recovery" };
  }
  const cooldownUntil = Math.max(
    record.cooldownUntil ?? 0,
    repository.tabPolicies.get(tabId)?.cooldownUntil ?? 0
  );
  if (cooldownUntil > Date.now() || record.recovery.status === "cooldown") {
    return {
      ok: false,
      error: "A previous recovery outcome is still uncertain or cooling down; retry later"
    };
  }
  const snoozedUntil = Math.max(
    record.snoozedUntil ?? 0,
    repository.tabPolicies.get(tabId)?.snoozedUntil ?? 0
  );
  if (snoozedUntil > Date.now()) {
    return { ok: false, error: "Recovery is snoozed for this tab" };
  }
  if (record.detector.status !== "confirmed") {
    return { ok: false, error: "The finding is no longer confirmed; no recovery was prepared" };
  }
  for (const operation of [...repository.operations.values()]) {
    if (
      operation.tabId === tabId &&
      operation.expiresAt <= Date.now() &&
      operation.state !== "requested" &&
      operation.state !== "terminal"
    ) {
      await finishWithoutAction(operation, "Recovery confirmation expired", "expired");
    }
  }
  if (record.samples.length === 0 || record.evidenceExpiresAt <= Date.now()) {
    return { ok: false, error: "The finding is stale; collect a fresh sample before recovery" };
  }
  if (
    [...repository.operations.values()].some(
      (operation) => operation.tabId === tabId && operation.state !== "terminal"
    )
  ) {
    return { ok: false, error: "Another recovery confirmation is already open for this tab" };
  }

  let context: FreshRecoveryContext;
  try {
    context = await getFreshRecoveryContext(record);
  } catch (error) {
    return { ok: false, error: `A current page safety check was not available: ${errorMessage(error)}` };
  }
  if (pendingNavigationTabs.has(tabId) || repository.records.get(tabId) !== record) {
    return { ok: false, error: "The tab began navigating during the safety check" };
  }
  record.safety = context.safety;
  const result = prepareRecovery({
    record,
    tab: context.tab,
    initiator: "manual",
    monitoringEpoch: repository.monitoringEpoch,
    permissionRevision: permissionMutationRevision,
    now: Date.now(),
    operationId: crypto.randomUUID(),
    nonce: crypto.randomUUID()
  });
  if (!result.ok) return { ok: false, error: result.error };
  if (pendingNavigationTabs.has(tabId) || repository.records.get(tabId) !== record) {
    return { ok: false, error: "The tab began navigating before recovery could be prepared" };
  }
  await repository.putOperation(result.operation);
  if (
    pendingNavigationTabs.has(tabId) ||
    repository.records.get(tabId) !== record ||
    repository.monitoringEpoch !== result.operation.monitoringEpoch ||
    !recoveryPermissionAuthorityCurrent(record, result.operation) ||
    monitoringIsPaused()
  ) {
    await finishWithoutAction(
      result.operation,
      "The tab began navigating while recovery was prepared",
      "blocked"
    );
    return { ok: false, error: "The tab began navigating while recovery was prepared" };
  }
  record.recovery = {
    status: "awaiting-consent",
    operationId: result.operation.operationId
  };
  await repository.persistRecords();
  if (pendingNavigationTabs.has(tabId) || repository.records.get(tabId) !== record) {
    await finishWithoutAction(
      result.operation,
      "The tab began navigating before recovery confirmation was shown",
      "blocked"
    );
    return { ok: false, error: "The tab began navigating before recovery confirmation was shown" };
  }
  const view: RecoveryPreparationView = {
    operationId: result.operation.operationId,
    nonce: result.operation.nonce,
    tabId,
    action: result.operation.action,
    preparedAt: result.operation.preparedAt,
    expiresAt: result.operation.expiresAt,
    warnings: result.operation.warnings,
    title: record.title,
    hostname: record.hostname,
    requiresUserEditAcknowledgement:
      record.safety.userEditState !== "no-edits-observed"
  };
  await updateBadge(
    repository.records.values(),
    repository.preferences.monitoringEnabled
  ).catch(() => undefined);
  return { ok: true, data: view };
}

async function executeRecoveryOperation(
  operationId: string,
  nonce: string,
  acknowledgeUserEditRisk: boolean,
  fromAlarm: boolean
): Promise<CommandResponse> {
  const executionGeneration = runtimeMutationGeneration;
  if (deletionPending) return { ok: false, error: "Local extension data is being deleted" };
  const operation = repository.operations.get(operationId);
  if (!operation) return { ok: false, error: "Recovery confirmation is missing or expired" };
  if (recoveryOperationWasIssued(operation)) {
    return {
      ok: false,
      error:
        "This recovery request was already issued or is being finalized; Firefox will not receive it again"
    };
  }
  const record = repository.records.get(operation.tabId);
  if (!record) {
    await finishWithoutAction(operation, "The monitored document no longer exists", "cancelled");
    return { ok: false, error: "The monitored document no longer exists" };
  }
  if (!recoveryPermissionAuthorityCurrent(record, operation)) {
    await finishWithoutAction(
      operation,
      "Website permission authority changed after recovery was prepared",
      "blocked"
    );
    return { ok: false, error: "Website permission authority changed after recovery was prepared" };
  }
  if (pendingNavigationTabs.has(operation.tabId)) {
    const message = "The tab is navigating; recovery was cancelled before any browser action";
    await finishWithoutAction(operation, message, "blocked");
    return { ok: false, error: message };
  }

  let context: FreshRecoveryContext;
  try {
    context = await getFreshRecoveryContext(record);
  } catch (error) {
    const message = `Current page safety could not be confirmed: ${errorMessage(error)}`;
    await finishWithoutAction(operation, message, "blocked");
    return { ok: false, error: message };
  }
  if (pendingNavigationTabs.has(operation.tabId)) {
    const message = "The tab began navigating during the safety check";
    await finishWithoutAction(operation, message, "blocked");
    return { ok: false, error: message };
  }
  record.safety = context.safety;
  const decision = validateExecution({
    operation,
    record,
    tab: context.tab,
    monitoringEpoch: repository.monitoringEpoch,
    nonce,
    now: Date.now(),
    currentSafety: context.safety,
    acknowledgeUserEditRisk
  });
  if (!decision.ok) {
    await finishWithoutAction(
      operation,
      decision.error,
      operation.expiresAt <= Date.now() ? "expired" : "cancelled"
    );
    return { ok: false, error: decision.error };
  }
  if (operation.initiator === "automatic") {
    const permissionGranted = await hasContinuousPermission(repository.preferences);
    const safetyDecision = evaluateSafety(
      record,
      context.safety,
      repository.preferences,
      repository.receipts,
      Date.now(),
      {
        automaticRecoveryAvailable: AUTOMATIC_RECOVERY_AVAILABLE,
        permissionGranted,
        expectedMonitoringEpoch: repository.monitoringEpoch,
        requireNativeDocumentId: true
      }
    );
    if (!safetyDecision.safe || !isAutomaticEligible(record.detector)) {
      const reason = safetyDecision.safe
        ? "Detection evidence is not eligible for automatic recovery"
        : safetyDecision.reason;
      await finishWithoutAction(operation, reason, "blocked");
      return { ok: false, error: reason };
    }
  }

  const validationState = operation.state;
  const requestedAt = Date.now();
  let requestJournalCommitted = false;
  try {
    await repository.markOperationRequested(
      operation,
      requestedAt,
      acknowledgeUserEditRisk
    );
    requestJournalCommitted = true;
    record.recovery = { status: "requested", operationId };
    record.pendingResetAt = undefined;
    await repository.persistRecords();
  } catch (error) {
    const reason = `Recovery was not sent because its durable request journal could not be completed: ${errorMessage(error)}`;
    if (requestJournalCommitted) {
      await finishRequestedBeforeBrowserAction(operation, record, reason).catch(() => undefined);
    }
    return { ok: false, error: reason };
  }

  if (
    deletionPending ||
    executionGeneration !== runtimeMutationGeneration ||
    repository.operations.get(operationId) !== operation ||
    repository.records.get(record.tabId) !== record ||
    pendingNavigationTabs.has(record.tabId)
  ) {
    const error = "Recovery authority was revoked before the browser action";
    await failOperation(operation, record, error, "blocked", requestedAt);
    return { ok: false, error };
  }

  // The request intent is durable before Firefox receives the tab API call.
  // Re-run the document-targeted preflight after that journal write so this is
  // the final asynchronous gate before invoking the exact action.
  let finalContext: FreshRecoveryContext;
  try {
    finalContext = await getFreshRecoveryContext(record);
  } catch (error) {
    const message = `Final page safety check failed: ${errorMessage(error)}`;
    await failOperation(operation, record, message, "blocked");
    return { ok: false, error: message };
  }
  const finalDecision = validateExecution({
    operation: { ...operation, state: validationState },
    record,
    tab: finalContext.tab,
    monitoringEpoch: repository.monitoringEpoch,
    nonce,
    now: Date.now(),
    currentSafety: finalContext.safety,
    acknowledgeUserEditRisk
  });
  if (!finalDecision.ok) {
    await failOperation(operation, record, finalDecision.error, "blocked");
    return { ok: false, error: finalDecision.error };
  }
  if (repository.monitoringEpoch !== operation.monitoringEpoch) {
    const error = "Monitoring state changed before recovery";
    await failOperation(operation, record, error, "blocked");
    return { ok: false, error };
  }
  if (
    deletionPending ||
    executionGeneration !== runtimeMutationGeneration ||
    repository.operations.get(operationId) !== operation ||
    repository.records.get(record.tabId) !== record ||
    operation.state !== "requested" ||
    pendingNavigationTabs.has(record.tabId) ||
    !recoveryPermissionAuthorityCurrent(record, operation) ||
    !collectorPolicyAuthorizedNow(
      finalContext.tab,
      finalContext.tab.url,
      record.monitoringMode,
      record.monitoringMode === "manual"
        ? repository.tabPolicies.get(record.tabId)?.manualSessionToken ?? null
        : null,
      record.documentInstanceId,
      record.documentId
    )
  ) {
    const error = "Recovery authority was revoked before the browser action";
    await failOperation(operation, record, error, "blocked", requestedAt);
    return { ok: false, error };
  }

  try {
    return await performExactAction(
      operation,
      record,
      finalDecision.action,
      fromAlarm,
      requestedAt
    );
  } catch (error) {
    // The request intent was durably journaled. Do not invent a failed result
    // if local bookkeeping itself becomes unavailable; startup reconciliation
    // will record an unknown outcome and enforce cooldown.
    return {
      ok: false,
      error: `The recovery result could not be safely finalized: ${errorMessage(error)}`
    };
  }
}

async function performExactAction(
  operation: PreparedRecovery,
  record: TabRecord,
  action: RecoveryAction,
  _fromAlarm: boolean,
  requestedAt: number
): Promise<CommandResponse> {
  if (action === "discard") {
    const targetDocumentInstanceId = record.documentInstanceId;
    // Do not replace this with reload. If active state changes after Firefox
    // accepts the request, verification remains conservative and reports an
    // unknown outcome because an unload-and-restore may already have occurred.
    try {
      await withTimeout(
        browser.tabs.discard(record.tabId),
        RECOVERY_REQUEST_TIMEOUT_MS,
        "Firefox did not acknowledge the unload request in time"
      );
    } catch (error) {
      const timedOut = error instanceof OperationTimeoutError;
      const reason = timedOut
        ? "Firefox did not acknowledge the unload request in time; whether it will still run is unknown"
        : errorMessage(error);
      await failOperation(
        operation,
        record,
        reason,
        timedOut ? "verification-timed-out" : "request-failed",
        requestedAt
      );
      return { ok: false, error: reason };
    }
    let verified: browser.tabs.Tab;
    try {
      verified = await withTimeout(
        browser.tabs.get(record.tabId),
        RECOVERY_VERIFICATION_TIMEOUT_MS,
        "Firefox did not return the unloaded tab state in time"
      );
    } catch (error) {
      const reason = `Firefox accepted the unload request, but its result could not be verified: ${errorMessage(error)}`;
      await failOperation(operation, record, reason, "verification-timed-out", requestedAt);
      return { ok: false, error: reason };
    }
    if (
      !discardTargetStillCurrent(operation, record, targetDocumentInstanceId) ||
      !verified.discarded
    ) {
      const reason =
        "Firefox accepted the unload request, but the consent-bound document changed or was loaded during verification; whether an unload occurred is unknown";
      await failOperation(operation, record, reason, "verification-timed-out", requestedAt);
      return { ok: false, error: reason };
    }
    const message = "The tab was unloaded and will restore when selected";
    try {
      await completeOperation(operation, record, message, requestedAt);
    } catch (error) {
      const receiptCommitted = await preserveVerifiedActionOutcome(
        operation,
        record,
        message,
        requestedAt
      );
      if (receiptCommitted) return { ok: true, data: { action, phase: "completed" } };
      return {
        ok: false,
        error: `The tab was unloaded, but its local receipt could not be fully saved: ${errorMessage(error)}`
      };
    }
    return { ok: true, data: { action, phase: "completed" } };
  }

  const verifier = createReloadVerifier(record.tabId, RECOVERY_VERIFICATION_TIMEOUT_MS);
  try {
    await withTimeout(
      browser.tabs.reload(record.tabId, { bypassCache: false }),
      RECOVERY_REQUEST_TIMEOUT_MS,
      "Firefox did not acknowledge the reload request in time"
    );
  } catch (error) {
    verifier.cancel();
    const timedOut = error instanceof OperationTimeoutError;
    const reason = timedOut
      ? "Firefox did not acknowledge the reload request in time; whether it will still run is unknown"
      : errorMessage(error);
    await failOperation(
      operation,
      record,
      reason,
      timedOut ? "verification-timed-out" : "request-failed",
      requestedAt
    );
    return { ok: false, error: reason };
  }
  const completed = await verifier.promise;
  if (!completed) {
    const reason =
      "Firefox accepted the reload request, but completion could not be tied to that exact reload; the outcome is unknown";
    await failOperation(operation, record, reason, "verification-timed-out", requestedAt);
    return { ok: false, error: reason };
  }
  const message = "The tab reload completed using the normal browser cache";
  try {
    await completeOperation(operation, record, message, requestedAt);
  } catch (error) {
    const receiptCommitted = await preserveVerifiedActionOutcome(
      operation,
      record,
      message,
      requestedAt
    );
    if (receiptCommitted) return { ok: true, data: { action, phase: "completed" } };
    return {
      ok: false,
      error: `The tab reload completed, but its local receipt could not be fully saved: ${errorMessage(error)}`
    };
  }
  return { ok: true, data: { action, phase: "completed" } };
}

function discardTargetStillCurrent(
  operation: PreparedRecovery,
  record: TabRecord,
  targetDocumentInstanceId: string
): boolean {
  return (
    repository.monitoringEpoch === operation.monitoringEpoch &&
    repository.operations.get(operation.operationId) === operation &&
    repository.records.get(record.tabId) === record &&
    record.documentInstanceId === targetDocumentInstanceId &&
    record.documentInstanceId === operation.documentInstanceId &&
    record.documentId === operation.documentId &&
    !pendingNavigationTabs.has(record.tabId) &&
    !(retiredDocumentInstances.get(record.tabId) ?? []).includes(targetDocumentInstanceId)
  );
}

async function preserveVerifiedActionOutcome(
  operation: PreparedRecovery,
  record: TabRecord,
  message: string,
  requestedAt: number
): Promise<boolean> {
  const now = Date.now();
  operation.state = "terminal";
  record.recovery = { status: "cooldown" };
  record.cooldownUntil = now + RESET_COOLDOWN_MS;
  record.pendingResetAt = undefined;
  repository.tabPolicies.set(record.tabId, {
    ...(repository.tabPolicies.get(record.tabId) ?? { tabId: record.tabId }),
    cooldownUntil: record.cooldownUntil,
    ...(operation.initiator === "automatic" ? { lastAutomaticAttemptAt: now } : {})
  });
  try {
    // The policy is the durable no-retry fence when history retention is off;
    // publish it before removing the issued operation journal.
    await repository.persistTabPolicies();
    await repository.persistRecords();
    await repository.commitReceiptAndRemoveOperation(
      receiptForOperation(
        operation,
        record,
        "success",
        "completed",
        message,
        now,
        requestedAt,
        now
      )
    );
  } catch {
    // Retain the issued journal if the durable receipt is unavailable. A
    // later event-page/browser restart will conservatively reconcile it to an
    // unknown outcome instead of losing the action from history.
    await Promise.allSettled([
      repository.persistTabPolicies(),
      repository.persistOperations(),
      repository.persistRecords()
    ]);
    return false;
  }
  return true;
}

async function completeOperation(
  operation: PreparedRecovery,
  record: TabRecord,
  message: string,
  requestedAt: number
): Promise<void> {
  const now = Date.now();
  operation.state = "terminal";
  record.recovery = { status: "cooldown" };
  record.cooldownUntil = now + RESET_COOLDOWN_MS;
  record.blockedReason = undefined;
  const policy = {
    ...(repository.tabPolicies.get(record.tabId) ?? { tabId: record.tabId }),
    cooldownUntil: record.cooldownUntil,
    ...(operation.initiator === "automatic" ? { lastAutomaticAttemptAt: now } : {})
  };
  await repository.upsertTabPolicy(policy);
  await repository.commitReceiptAndRemoveOperation(
    receiptForOperation(operation, record, "success", "completed", message, now, requestedAt, now)
  );
  await repository.persistRecords();
  // Browser chrome refresh is not part of the durable recovery transaction.
  // A notification/badge failure must never turn a committed success into a
  // contradictory failure response.
  await Promise.allSettled([
    resetFindingsNotification(),
    updateBadge(repository.records.values(), repository.preferences.monitoringEnabled)
  ]);
}

async function failOperation(
  operation: PreparedRecovery,
  record: TabRecord,
  reason: string,
  phase: "blocked" | "request-failed" | "verification-timed-out",
  requestedAt?: number
): Promise<void> {
  const now = Date.now();
  operation.state = "terminal";
  const outcomeUnknown = phase === "verification-timed-out";
  record.recovery = outcomeUnknown
    ? { status: "cooldown" }
    : {
        status: phase === "blocked" ? "blocked" : "failed",
        blockedReason: reason,
        automaticSuppressedForDocument:
          operation.initiator === "automatic" ||
          record.recovery.automaticSuppressedForDocument === true,
        ...(operation.initiator === "automatic" ? { automaticAttemptedAt: now } : {})
      };
  if (outcomeUnknown) {
    record.cooldownUntil = now + RESET_COOLDOWN_MS;
    await repository.upsertTabPolicy({
      ...(repository.tabPolicies.get(record.tabId) ?? { tabId: record.tabId }),
      cooldownUntil: record.cooldownUntil,
      ...(operation.initiator === "automatic" ? { lastAutomaticAttemptAt: now } : {})
    });
  }
  record.blockedReason = reason;
  record.pendingResetAt = undefined;
  if (!outcomeUnknown && operation.initiator === "automatic") {
    await repository.upsertTabPolicy({
      ...(repository.tabPolicies.get(record.tabId) ?? { tabId: record.tabId }),
      lastAutomaticAttemptAt: now
    });
  }
  await repository.commitReceiptAndRemoveOperation(
    receiptForOperation(
      operation,
      record,
      phase === "blocked"
        ? "blocked"
        : phase === "verification-timed-out"
          ? "unknown"
          : "failed",
      phase,
      reason,
      now,
      requestedAt
    )
  );
  await withTimeout(
    browser.alarms.clear(recoveryAlarmName(operation)),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Recovery alarm cleanup timed out"
  ).catch(() => false);
  await repository.persistRecords();
  await Promise.allSettled([
    resetFindingsNotification(),
    updateBadge(repository.records.values(), repository.preferences.monitoringEnabled)
  ]);
}

async function finishWithoutAction(
  operation: PreparedRecovery,
  reason: string,
  phase: "cancelled" | "expired" | "blocked"
): Promise<void> {
  if (repository.operations.get(operation.operationId) !== operation) return;
  if (recoveryOperationWasIssued(operation)) return;
  const record = repository.records.get(operation.tabId);
  // This path runs before any Firefox tab API request. Keep the journal in a
  // non-issued state until receipt+removal commits atomically; persisting a
  // transient terminal state could make startup misreport a cancellation or
  // preflight block as an action with an unknown outcome.
  await withTimeout(
    browser.alarms.clear(recoveryAlarmName(operation)),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Recovery alarm cleanup timed out"
  ).catch(() => false);
  if (record && record.documentInstanceId === operation.documentInstanceId) {
    record.pendingResetAt = undefined;
    record.recovery =
      phase === "blocked"
        ? {
            status: "blocked",
            blockedReason: reason,
            automaticSuppressedForDocument: operation.initiator === "automatic"
          }
        : { status: "idle" };
    await repository.commitReceiptAndRemoveOperation(
      receiptForOperation(
        operation,
        record,
        phase === "expired" ? "expired" : phase === "cancelled" ? "cancelled" : "blocked",
        phase,
        reason,
        Date.now()
      )
    );
    await repository.persistRecords();
  } else {
    await repository.removeOperation(operation.operationId);
  }
  await Promise.allSettled([
    updateBadge(repository.records.values(), repository.preferences.monitoringEnabled)
  ]);
}

async function finishRequestedBeforeBrowserAction(
  operation: PreparedRecovery,
  record: TabRecord,
  reason: string
): Promise<void> {
  if (
    repository.operations.get(operation.operationId) !== operation ||
    operation.state !== "requested"
  ) return;
  const now = Date.now();
  // The requested journal is conservative write-ahead intent; this path is
  // reached before any tabs API call. Atomically replace it with a truthful
  // blocked receipt, then expose the non-issued result in session state.
  await repository.commitReceiptAndRemoveOperation(
    receiptForOperation(
      operation,
      record,
      "blocked",
      "blocked",
      reason,
      now,
      operation.requestedAt
    )
  );
  record.recovery = { status: "blocked", blockedReason: reason };
  record.blockedReason = reason;
  record.pendingResetAt = undefined;
  await repository.persistRecords();
}

function recoveryOperationWasIssued(operation: PreparedRecovery): boolean {
  return (
    operation.state === "executing" ||
    operation.state === "requested" ||
    operation.state === "terminal"
  );
}

function receiptForOperation(
  operation: PreparedRecovery,
  record: TabRecord,
  outcome: ResetReceipt["outcome"],
  phase: NonNullable<ResetReceipt["phase"]>,
  message: string,
  occurredAt: number,
  requestedAt?: number,
  completedAt?: number
): ResetReceipt {
  return {
    id: crypto.randomUUID(),
    operationId: operation.operationId,
    tabId: record.tabId,
    hostname: record.hostname,
    action: operation.action,
    occurredAt,
    reasonCodes: record.detector.reasonCodes,
    outcome,
    phase,
    initiator: operation.initiator,
    message,
    ...(requestedAt === undefined ? {} : { requestedAt }),
    ...(completedAt === undefined ? {} : { completedAt })
  };
}

function receiptForIssuedJournal(
  operation: PreparedRecovery,
  record: TabRecord | undefined,
  message: string,
  occurredAt: number,
  requestedAt: number
): ResetReceipt {
  return {
    id: crypto.randomUUID(),
    operationId: operation.operationId,
    tabId: operation.tabId,
    hostname: operation.hostname ?? record?.hostname ?? "unavailable",
    action: operation.action,
    occurredAt,
    reasonCodes: record?.detector.reasonCodes ?? [],
    outcome: "unknown",
    phase: "requested",
    initiator: operation.initiator,
    message,
    requestedAt
  };
}

type FreshRecoveryContext = {
  tab: browser.tabs.Tab;
  preflight: CollectorPreflight;
  safety: TabSafety;
};

async function getFreshRecoveryContext(record: TabRecord): Promise<FreshRecoveryContext> {
  let tab = await withTimeout(
    browser.tabs.get(record.tabId),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Current tab state timed out"
  );
  if (tab.windowId !== record.windowId) throw new Error("Tab window changed");
  const expectedAuthorityToken =
    record.monitoringMode === "manual"
      ? repository.tabPolicies.get(record.tabId)?.manualSessionToken ?? null
      : null;
  if (
    !(await withTimeout(
      isCollectorModeAuthorized(
        tab,
        tab.url,
        record.monitoringMode,
        expectedAuthorityToken,
        record.documentInstanceId,
        record.documentId
      ),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Collector permission check timed out"
    ))
  ) {
    throw new Error("Collector authority expired or changed");
  }
  let fullscreen = false;
  let windowStateKnown = false;
  try {
    const currentWindow = await withTimeout(
      browser.windows.get(tab.windowId),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Current window state timed out"
    );
    fullscreen = currentWindow.state === "fullscreen";
    windowStateKnown = currentWindow.state !== undefined;
  } catch {
    windowStateKnown = false;
  }
  // Re-read after the window query so active/highlighted/sharing state is as
  // current as possible, then make the document-bound edit preflight last.
  tab = await withTimeout(
    browser.tabs.get(record.tabId),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Current tab state timed out"
  );
  if (tab.windowId !== record.windowId) throw new Error("Tab window changed");
  const startedAt = Date.now();
  const command = {
    type: "GET_RECOVERY_PREFLIGHT" as const,
    expectedDocumentInstanceId: record.documentInstanceId
  };
  const request = record.documentId
    ? browser.tabs.sendMessage(record.tabId, command, { documentId: record.documentId })
    : browser.tabs.sendMessage(record.tabId, command);
  const response = await withTimeout(
    request,
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Collector safety preflight timed out"
  );
  const receivedAt = Date.now();
  if (receivedAt - startedAt > RECOVERY_PREFLIGHT_MAX_AGE_MS) {
    throw new Error("Collector safety preflight was stale");
  }
  const preflight = decodeCollectorPreflight(response);
  if (preflight.documentInstanceId !== record.documentInstanceId) {
    throw new Error("Collector document identity changed");
  }
  if (
    preflight.collectorMode === "manual" &&
    preflight.sessionExpiresAtMonotonicMs !== null &&
    preflight.capturedAtMonotonicMs >= preflight.sessionExpiresAtMonotonicMs
  ) {
    throw new Error("Temporary monitoring session expired");
  }
  if (preflight.collectorMode !== record.monitoringMode) {
    throw new Error("Collector monitoring mode changed");
  }
  if (preflight.collectorMode === "manual") {
    const policy = repository.tabPolicies.get(record.tabId);
    if (
      !policy ||
      policy.manualSessionExpiresAt === undefined ||
      policy.manualSessionExpiresAt <= receivedAt ||
      policy.manualSessionToken !== preflight.authorityToken ||
      !manualSessionBindingMatches(policy, preflight.documentInstanceId, record.documentId)
    ) {
      throw new Error("Collector authority expired or changed");
    }
  } else if (preflight.authorityToken !== null) {
    throw new Error("Collector authority token was invalid");
  }
  const safety = safetyFromTab(
    tab,
    preflight.userEditState === "edits-observed",
    repository.preferences.quietPeriodMinutes * 60_000,
    receivedAt,
    {
      userEditState: preflight.userEditState,
      fullscreen,
      safetyComplete: windowStateKnown && preflight.collectorHealth === "healthy"
    }
  );
  return { tab, preflight, safety };
}

function decodeCollectorPreflight(value: unknown): CollectorPreflight {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    throw new Error(
      isRecord(value) && typeof value.error === "string"
        ? value.error
        : "Collector did not return a safety preflight"
    );
  }
  const data = value.data;
  if (
    typeof data.documentInstanceId !== "string" ||
    data.documentInstanceId.length < 8 ||
    data.documentInstanceId.length > 128 ||
    !["no-edits-observed", "edits-observed", "unknown"].includes(String(data.userEditState)) ||
    !isFiniteNumber(data.capturedAtMonotonicMs, 0) ||
    !["manual", "continuous"].includes(String(data.collectorMode)) ||
    !["healthy", "degraded"].includes(String(data.collectorHealth)) ||
    !(data.sessionExpiresAtMonotonicMs === null ||
      isFiniteNumber(data.sessionExpiresAtMonotonicMs, 0)) ||
    !(data.authorityToken === null ||
      (typeof data.authorityToken === "string" &&
        data.authorityToken.length >= 16 &&
        data.authorityToken.length <= 128)) ||
    (data.collectorMode === "manual" && data.authorityToken === null) ||
    (data.collectorMode === "continuous" && data.authorityToken !== null)
  ) {
    throw new Error("Collector safety preflight was invalid");
  }
  return data as CollectorPreflight;
}

async function snapshot(messageGeneration: number): Promise<ExtensionSnapshot> {
  const permissionRevision = permissionMutationRevision;
  assertPermissionReadCurrent(permissionRevision);
  await repository.purgeExpiredReceipts();
  assertRuntimeReadCurrent(messageGeneration);
  assertPermissionReadCurrent(permissionRevision);
  const continuousPermission = await hasContinuousPermission(repository.preferences);
  assertRuntimeReadCurrent(messageGeneration);
  assertPermissionReadCurrent(permissionRevision);
  const permissionScope = await effectivePermissionScope(repository.preferences);
  assertRuntimeReadCurrent(messageGeneration);
  assertPermissionReadCurrent(permissionRevision);
  return {
    preferences: repository.preferences,
    hasContinuousPermission: continuousPermission,
    permissionScope,
    records: [...repository.records.values()].sort(compareRecords),
    receipts: repository.receipts,
    automaticRecoveryAvailable: AUTOMATIC_RECOVERY_AVAILABLE,
    monitoringEpoch: repository.monitoringEpoch
  };
}

function assertRuntimeReadCurrent(generation: number): void {
  if (deletionPending || generation !== runtimeMutationGeneration) {
    throw new Error("Local extension data was deleted while this request was in progress");
  }
}

function assertPermissionReadCurrent(revision: number): void {
  if (
    permissionReconciliationPending ||
    revision !== permissionMutationRevision
  ) {
    throw new Error("Firefox website permissions are changing; try again when reconciliation finishes");
  }
}

function monitoringIsPaused(): boolean {
  return repository.preferences.monitoringIntent === "paused";
}

function beginDeleteAllLocalData(): Promise<CommandResponse> {
  if (deleteAllInFlight) return deleteAllInFlight;
  deletionPending = true;
  runtimeMutationGeneration += 1;
  settleAllCollectorReadyWaiters(false);
  const deletion = (async () => {
    try {
      // Serialize behind hydration and all earlier storage writes. If Firefox
      // rejects hydration, clear still proceeds; if it never settles we do not
      // falsely claim erasure while an older write could still publish data.
      await repository.ready.catch(() => undefined);
      return await deleteAllLocalData();
    } finally {
      deletionPending = false;
      deleteAllInFlight = null;
    }
  })();
  deleteAllInFlight = deletion;
  return deletion;
}

async function deleteAllLocalData(): Promise<CommandResponse> {
  // A tab API request already accepted before deletion cannot be recalled.
  // Drain it (and any lifecycle work it emitted), then clear all resulting
  // state. Generation checks prevent preflight-bound work from starting a new
  // tab action after deletion was requested.
  await drainTabQueues();
  // deletionPending plus the mutation generation is already the authority
  // fence. Avoid routing erasure through normal reconciliation: alarm or
  // permission APIs must not delay clearing extension-managed storage.
  const records = [...repository.records.values()];
  const recordTabIds = new Set(records.map((record) => record.tabId));
  const policyOnlyCollectors = [...repository.tabPolicies.values()].filter(
    (policy) => policy.manualSessionToken && !recordTabIds.has(policy.tabId)
  );
  await withTimeout(
    Promise.allSettled([
      ...records.map(sendStopCollector),
      ...policyOnlyCollectors.map(sendStopCollectorForPolicy)
    ]),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Collector shutdown timed out"
  ).catch(() => undefined);
  await repository.clearAllRuntimeState();
  lastGrantedOriginSignature = null;
  retiredDocumentInstances.clear();
  // Privacy-sensitive notification work shares one unbounded queue. Await it
  // before reporting deletion so a late site-specific notification cannot
  // appear after the data has supposedly been erased.
  let notificationCleanupError: string | null = null;
  try {
    await clearAllExtensionNotifications();
  } catch (error) {
    notificationCleanupError = errorMessage(error);
  }
  pendingNavigationTabs.clear();
  const browserCleanupResults = await Promise.allSettled([
    withTimeout(
      clearRecoveryAlarms(),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Recovery alarm cleanup timed out"
    ),
    withTimeout(
      unregisterCollectorRegistrationNow(),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Collector registration cleanup timed out"
    ),
    updateBadge(repository.records.values(), false)
  ]);
  const badgeCleanup = browserCleanupResults[2];
  const badgeCleanupError = badgeCleanup?.status === "rejected"
    ? errorMessage(badgeCleanup.reason)
    : null;
  if (notificationCleanupError || badgeCleanupError) {
    return {
      ok: false,
      error:
        "Local extension data was deleted, but Firefox could not confirm browser UI cleanup: " +
        [
          notificationCleanupError
            ? `notification removal (${notificationCleanupError})`
            : null,
          badgeCleanupError ? `toolbar reset (${badgeCleanupError})` : null
        ].filter(Boolean).join("; ")
    };
  }
  return {
    ok: true,
    data: {
      permissionsRetainedByFirefox: true,
      message: "Local extension data was deleted. Website permissions are managed separately by Firefox."
    }
  };
}

async function clearRecoveryAlarms(): Promise<void> {
  const alarms = await browser.alarms.getAll();
  await Promise.all(
    alarms
      .filter((alarm) => alarm.name.startsWith("recovery:") || alarm.name.startsWith("reset:"))
      .map((alarm) => browser.alarms.clear(alarm.name))
  );
}

async function clearAlarmBounded(name: string): Promise<boolean> {
  return withTimeout(
    browser.alarms.clear(name),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Recovery alarm cleanup timed out"
  );
}

async function drainTabQueues(): Promise<void> {
  while (tabQueues.size > 0) {
    await Promise.allSettled([...tabQueues.values()]);
  }
}

function buildRedactedDiagnostics(): Record<string, unknown> {
  const now = Date.now();
  return {
    format: "tab-leak-guard-redacted-diagnostics-v1",
    generatedAt: new Date(now).toISOString(),
    extensionVersion: browser.runtime.getManifest().version,
    privacy: {
      redactedByDefault: true,
      containsTitles: false,
      containsHostnames: false,
      containsPageText: false,
      containsFormValues: false
    },
    configuration: {
      monitoringIntent: repository.preferences.monitoringIntent,
      permissionMode: repository.preferences.permissionMode,
      recoveryMode: repository.preferences.recoveryMode,
      notificationsEnabled: repository.preferences.notificationsEnabled,
      notificationContent: repository.preferences.notificationContent,
      historyRetentionHours: repository.preferences.historyRetentionHours,
      selectedOriginCount: repository.preferences.selectedOrigins.length,
      ignoredHostCount: repository.preferences.ignoredHosts.length,
      sitePolicyCount: repository.preferences.sitePolicies.length,
      sampleVisibleSeconds: repository.preferences.sampleVisibleSeconds,
      sampleHiddenSeconds: repository.preferences.sampleHiddenSeconds,
      quietPeriodMinutes: repository.preferences.quietPeriodMinutes,
      confirmationScore: repository.preferences.confirmationScore
    },
    runtime: {
      automaticRecoveryAvailable: AUTOMATIC_RECOVERY_AVAILABLE,
      monitoringEpoch: repository.monitoringEpoch,
      recordCount: repository.records.size,
      receiptCount: repository.receipts.length
    },
    findings: [...repository.records.values()].map((record, index) => ({
      finding: index + 1,
      ageMs: Math.max(0, now - record.createdAt),
      sampleAgeMs: Math.max(0, now - record.updatedAt),
      sampleCount: record.samples.length,
      nativeDocumentIdentityAvailable: record.documentId !== null,
      detector: {
        status: record.detector.status,
        score: record.detector.score,
        reasonCodes: record.detector.reasonCodes,
        signalFamilies: record.detector.signalFamilies,
        features: record.detector.features,
        ...extendedDetectorMetadata(record.detector)
      },
      recovery: {
        status: record.recovery.status,
        hasBlockedReason: Boolean(record.recovery.blockedReason),
        automaticSuppressedForDocument:
          record.recovery.automaticSuppressedForDocument === true
      },
      safety: {
        active: record.safety.active,
        highlighted: record.safety.highlighted,
        audible: record.safety.audible,
        pinned: record.safety.pinned,
        attention: record.safety.attention,
        userEditState: record.safety.userEditState,
        discarded: record.safety.discarded,
        loading: record.safety.loading,
        recentlyAccessed: record.safety.recentlyAccessed,
        autoDiscardable: record.safety.autoDiscardable,
        sharingCamera: record.safety.sharingCamera,
        sharingMicrophone: record.safety.sharingMicrophone,
        sharingScreen: record.safety.sharingScreen,
        fullscreen: record.safety.fullscreen,
        safetyComplete: record.safety.safetyComplete,
        ageMs: Math.max(0, now - record.safety.evaluatedAt)
      }
    })),
    receipts: repository.receipts.map((receipt) => ({
      action: receipt.action,
      initiator: receipt.initiator,
      phase: receipt.phase,
      outcome: receipt.outcome,
      ageMs: Math.max(0, now - receipt.occurredAt),
      reasonCodes: receipt.reasonCodes
    }))
  };
}

function extendedDetectorMetadata(detector: TabRecord["detector"]): Record<string, unknown> {
  const candidate = detector as unknown as Record<string, unknown>;
  if (typeof candidate.modelVersion !== "string") return {};
  return {
    modelVersion: candidate.modelVersion,
    configurationVersion: candidate.configurationVersion,
    quality: candidate.quality,
    automaticEligible: candidate.automaticEligible
  };
}

async function monitorActiveTabTemporarily(generation: number): Promise<CommandResponse> {
  if (deletionPending) return { ok: false, error: "Local extension data is being deleted" };
  if (repository.preferences.monitoringIntent === "paused") {
    await invalidateRecoveryAuthority(
      "Manual monitoring was explicitly restarted",
      "all",
      true
    );
    assertConfigurationCurrent(generation);
    await repository.updatePreferences({
      monitoringEnabled: false,
      monitoringIntent: "manual"
    });
    assertConfigurationCurrent(generation);
  }
  const [tab] = await withTimeout(
    browser.tabs.query({ active: true, currentWindow: true }),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Active-tab lookup timed out"
  );
  assertConfigurationCurrent(generation);
  if (tab?.id === undefined) return { ok: false, error: "No active tab is available" };
  const support = inspectUrl(tab.url);
  if (!support.supported) return { ok: false, error: support.reason };
  const sitePolicy = repository.preferences.sitePolicies.find(
    (policy) => policy.hostname === support.hostname
  );
  if (
    repository.preferences.ignoredHosts.includes(support.hostname) ||
    sitePolicy?.monitoring === "off" ||
    (sitePolicy?.pausedUntil ?? 0) > Date.now()
  ) {
    return { ok: false, error: "Monitoring is disabled for this site" };
  }
  const existing = repository.records.get(tab.id);
  let repairContinuous = false;
  if (existing) {
    try {
      await getFreshRecoveryContext(existing);
      assertConfigurationCurrent(generation);
      if (existing.monitoringMode === "continuous") {
        return { ok: true, data: { tabId: tab.id, mode: "continuous", alreadyMonitoring: true } };
      }
      if (existing.manualSessionExpiresAt && existing.manualSessionExpiresAt > Date.now()) {
        return {
          ok: true,
          data: {
            tabId: tab.id,
            mode: "manual",
            alreadyMonitoring: true,
            startedAt: existing.manualSessionStartedAt,
            expiresAt: existing.manualSessionExpiresAt,
            expiresInMinutes: Math.max(
              0,
              Math.ceil((existing.manualSessionExpiresAt - Date.now()) / 60_000)
            )
          }
        };
      }
    } catch {
      assertConfigurationCurrent(generation);
      repairContinuous =
        existing.monitoringMode === "continuous" &&
        (await isCollectorModeAuthorized(
          tab,
          tab.url,
          "continuous",
          null,
          existing.documentInstanceId,
          existing.documentId
        ));
      assertConfigurationCurrent(generation);
      // A transient preflight timeout does not prove that the collector is
      // gone. Stop the document-bound instance before revoking its authority;
      // otherwise its sentinel can make the replacement injection a no-op.
      await sendStopCollector(existing);
      assertConfigurationCurrent(generation);
      await cancelOperationsForTab(tab.id, "Collector liveness could not be confirmed");
      assertConfigurationCurrent(generation);
      repository.records.delete(tab.id);
      if (existing.monitoringMode === "manual") await clearManualSessionPolicy(tab.id);
      assertConfigurationCurrent(generation);
      await repository.persistRecords();
      assertConfigurationCurrent(generation);
    }
  }
  if (repairContinuous) {
    const ready = waitForCollectorReady(tab.id, "continuous", null);
    try {
      await injectCollector(tab.id);
      assertConfigurationCurrent(generation);
      const collectorReady = await ready;
      assertConfigurationCurrent(generation);
      if (!collectorReady) {
        throw new Error("The page collector did not confirm that continuous monitoring resumed");
      }
      return {
        ok: true,
        data: { tabId: tab.id, mode: "continuous", alreadyMonitoring: false }
      };
    } catch (error) {
      settleCollectorReadyWaiter(tab.id, "continuous", null, false);
      return {
        ok: false,
        error: `Firefox did not allow monitoring this page: ${errorMessage(error)}`
      };
    }
  }
  const existingPolicy = repository.tabPolicies.get(tab.id);
  const existingPolicyExpiresAt = existingPolicy?.manualSessionExpiresAt;
  const existingPolicyLive =
    existingPolicy?.manualSessionToken &&
    existingPolicyExpiresAt &&
    existingPolicyExpiresAt > Date.now()
      ? await isManualPolicyCollectorLive(existingPolicy)
      : false;
  assertConfigurationCurrent(generation);
  if (existingPolicyLive && existingPolicy && existingPolicyExpiresAt) {
    return {
      ok: true,
      data: {
        tabId: tab.id,
        mode: "manual",
        alreadyMonitoring: true,
        startedAt: existingPolicy.manualSessionStartedAt,
        expiresAt: existingPolicyExpiresAt,
        expiresInMinutes: Math.max(
          0,
          Math.ceil((existingPolicyExpiresAt - Date.now()) / 60_000)
        )
      }
    };
  }
  if (existingPolicy?.manualSessionToken) {
    await sendStopCollectorForPolicy(existingPolicy);
    assertConfigurationCurrent(generation);
    await clearManualSessionPolicy(tab.id);
    assertConfigurationCurrent(generation);
  }
  const startedAt = Date.now();
  const authorityToken = crypto.randomUUID();
  const manualSession = {
    ...(repository.tabPolicies.get(tab.id) ?? { tabId: tab.id }),
    manualSessionStartedAt: startedAt,
    manualSessionExpiresAt: startedAt + MANUAL_SESSION_DURATION_MS,
    manualSessionToken: authorityToken
  };
  const ready = waitForCollectorReady(tab.id, "manual", authorityToken);
  try {
    await repository.upsertTabPolicy(manualSession);
    assertConfigurationCurrent(generation);
    await injectCollector(tab.id);
    assertConfigurationCurrent(generation);
    const collectorReady = await ready;
    assertConfigurationCurrent(generation);
    if (!collectorReady) {
      throw new Error("The page collector did not confirm that monitoring started");
    }
    return {
      ok: true,
      data: {
        tabId: tab.id,
        mode: "manual",
        startedAt,
        expiresAt: manualSession.manualSessionExpiresAt,
        expiresInMinutes: MANUAL_SESSION_DURATION_MS / 60_000
      }
    };
  } catch (error) {
    settleCollectorReadyWaiter(tab.id, "manual", authorityToken, false);
    if (!deletionPending && generation === runtimeMutationGeneration) {
      await clearManualSessionPolicy(tab.id);
    }
    return {
      ok: false,
      error: `Firefox did not allow monitoring this page: ${errorMessage(error)}`
    };
  }
}

async function stopMonitoringTab(tabId: number): Promise<CommandResponse> {
  const record = repository.records.get(tabId);
  if (record) {
    await sendStopCollector(record);
    await cancelOperationsForTab(tabId, "Monitoring stopped for this tab");
  }
  repository.records.delete(tabId);
  await clearManualSessionPolicy(tabId);
  await repository.persistRecords();
  await resetFindingsNotification();
  await updateBadge(
    repository.records.values(),
    repository.preferences.monitoringEnabled
  ).catch(() => undefined);
  return { ok: true, data: null };
}

async function snoozeTab(tabId: number): Promise<CommandResponse> {
  const record = repository.records.get(tabId);
  if (!record) return { ok: false, error: "Tab is no longer monitored" };
  const snoozedUntil = Date.now() + SNOOZE_DURATION_MS;
  await cancelOperationsForTab(tabId, "Tab was snoozed");
  const policy = {
    ...(repository.tabPolicies.get(tabId) ?? { tabId }),
    snoozedUntil
  };
  await repository.upsertTabPolicy(policy);
  record.snoozedUntil = snoozedUntil;
  record.recovery = { status: "suppressed", blockedReason: "Snoozed by the user" };
  await repository.persistRecords();
  await resetFindingsNotification();
  await updateBadge(
    repository.records.values(),
    repository.preferences.monitoringEnabled
  ).catch(() => undefined);
  return { ok: true, data: snoozedUntil };
}

async function updatePreferences(
  patch: Partial<ExtensionSnapshot["preferences"]>,
  generation: number
): Promise<CommandResponse> {
  const previous = repository.preferences;
  const preferences = await repository.updatePreferences(patch);
  assertConfigurationCurrent(generation);
  const monitoringScopeChanged =
    previous.monitoringEnabled !== preferences.monitoringEnabled ||
    previous.monitoringIntent !== preferences.monitoringIntent ||
    previous.permissionMode !== preferences.permissionMode ||
    JSON.stringify(previous.selectedOrigins) !== JSON.stringify(preferences.selectedOrigins) ||
    JSON.stringify(previous.ignoredHosts) !== JSON.stringify(preferences.ignoredHosts) ||
    JSON.stringify(previous.sitePolicies) !== JSON.stringify(preferences.sitePolicies);
  const recoveryAuthorityChanged =
    monitoringScopeChanged ||
    previous.recoveryMode !== preferences.recoveryMode ||
    previous.automaticRecoveryAcknowledgementVersion !==
      preferences.automaticRecoveryAcknowledgementVersion ||
    previous.notificationsEnabled !== preferences.notificationsEnabled ||
    previous.notificationContent !== preferences.notificationContent ||
    previous.quietPeriodMinutes !== preferences.quietPeriodMinutes ||
    previous.confirmationScore !== preferences.confirmationScore;
  const samplingChanged =
    previous.sampleVisibleSeconds !== preferences.sampleVisibleSeconds ||
    previous.sampleHiddenSeconds !== preferences.sampleHiddenSeconds;
  if (recoveryAuthorityChanged || samplingChanged) {
    const stopScope =
      preferences.monitoringIntent === "paused"
        ? "all"
        : monitoringScopeChanged || samplingChanged
          ? "continuous"
          : "none";
    await invalidateRecoveryAuthority(
      "Preferences changed",
      stopScope,
      preferences.monitoringIntent === "paused"
    );
    assertConfigurationCurrent(generation);
  }
  if (samplingChanged && preferences.monitoringEnabled) {
    await restartContinuousCollectors();
    assertConfigurationCurrent(generation);
  } else if (
    preferences.monitoringEnabled &&
    preferences.monitoringIntent === "continuous" &&
    previous.monitoringIntent !== "continuous"
  ) {
    await stopManualCollectorsForContinuousMode();
    assertConfigurationCurrent(generation);
  }
  await syncCollectorRegistration(
    preferences,
    () => !deletionPending && generation === runtimeMutationGeneration
  );
  assertConfigurationCurrent(generation);
  await updateBadge(repository.records.values(), preferences.monitoringEnabled).catch(
    () => undefined
  );
  return { ok: true, data: preferences };
}

async function setHostIgnored(
  hostname: string,
  ignored: boolean,
  generation: number
): Promise<CommandResponse> {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return { ok: false, error: "Invalid hostname" };
  const hosts = new Set(repository.preferences.ignoredHosts);
  if (ignored) hosts.add(normalized);
  else hosts.delete(normalized);
  await repository.updatePreferences({ ignoredHosts: [...hosts].sort() });
  assertConfigurationCurrent(generation);
  await invalidateRecoveryAuthority("Site policy changed", "none");
  assertConfigurationCurrent(generation);
  if (ignored) {
    const affectedTabIds = new Set<number>();
    for (const [tabId, record] of [...repository.records]) {
      if (record.hostname !== normalized) continue;
      affectedTabIds.add(tabId);
      await sendStopCollector(record);
      assertConfigurationCurrent(generation);
      await cancelOperationsForTab(tabId, "Site was ignored");
      assertConfigurationCurrent(generation);
      repository.records.delete(tabId);
    }
    const tabs = await withTimeout(
      browser.tabs.query({}),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Open-tab lookup timed out"
    );
    assertConfigurationCurrent(generation);
    for (const tab of tabs) {
      const support = inspectUrl(tab.url);
      if (tab.id === undefined || !support.supported || support.hostname !== normalized) continue;
      affectedTabIds.add(tab.id);
    }
    for (const tabId of affectedTabIds) await clearManualSessionPolicy(tabId);
    assertConfigurationCurrent(generation);
    await repository.persistRecords();
    assertConfigurationCurrent(generation);
  } else if (repository.preferences.monitoringEnabled) {
    const tabs = await withTimeout(
      browser.tabs.query({}),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Open-tab lookup timed out"
    );
    assertConfigurationCurrent(generation);
    await Promise.allSettled(
      tabs.map(async (tab) => {
        assertConfigurationCurrent(generation);
        const support = inspectUrl(tab.url);
        if (
          !support.supported ||
          support.hostname !== normalized ||
          tab.id === undefined ||
          tab.discarded
        ) return;
        await injectCollector(tab.id);
        assertConfigurationCurrent(generation);
      })
    );
    assertConfigurationCurrent(generation);
  }
  await resetFindingsNotification();
  await updateBadge(
    repository.records.values(),
    repository.preferences.monitoringEnabled
  ).catch(() => undefined);
  return { ok: true, data: repository.preferences };
}

async function reconcilePermissionState(
  options: { invalidateOnChange?: boolean; generation?: number } = {}
): Promise<void> {
  await repository.ready;
  if (options.generation !== undefined) assertConfigurationCurrent(options.generation);
  const grantedOrigins = await grantedOriginsFor(repository.preferences);
  if (options.generation !== undefined) assertConfigurationCurrent(options.generation);
  const grantedSignature = [...grantedOrigins].sort().join("\n");
  const grantedScopeChanged =
    lastGrantedOriginSignature !== null && lastGrantedOriginSignature !== grantedSignature;
  lastGrantedOriginSignature = grantedSignature;
  const granted = grantedOrigins.length > 0;
  const wasEnabled = repository.preferences.monitoringEnabled;
  const shouldEnable =
    repository.preferences.monitoringIntent === "continuous" && granted;
  if (wasEnabled !== shouldEnable) {
    await repository.updatePreferences({
      monitoringEnabled: shouldEnable,
      monitoringIntent: repository.preferences.monitoringIntent
    });
    if (options.generation !== undefined) assertConfigurationCurrent(options.generation);
  }
  if (
    options.invalidateOnChange !== false &&
    (wasEnabled !== shouldEnable || grantedScopeChanged)
  ) {
    await invalidateRecoveryAuthority(
      granted ? "Website permission scope changed" : "Website permission was removed",
      "all",
      true
    );
    if (options.generation !== undefined) assertConfigurationCurrent(options.generation);
  }
  const registrationGeneration = options.generation ?? runtimeMutationGeneration;
  await syncCollectorRegistration(
    repository.preferences,
    () => !deletionPending && registrationGeneration === runtimeMutationGeneration
  );
  if (options.generation !== undefined) assertConfigurationCurrent(options.generation);
  await updateBadge(
    repository.records.values(),
    repository.preferences.monitoringEnabled
  ).catch(() => undefined);
}

type CollectorStopScope = "none" | "continuous" | "all";

async function invalidateRecoveryAuthority(
  reason: string,
  stopScope: CollectorStopScope,
  clearManualSessions = false
): Promise<void> {
  const records = [...repository.records.values()];
  await repository.incrementMonitoringEpoch();
  const alarms = await withTimeout(
    browser.alarms.getAll(),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Recovery alarm lookup timed out"
  );
  await withTimeout(
    Promise.allSettled(
      alarms
        .filter((alarm) => alarm.name.startsWith("recovery:") || alarm.name.startsWith("reset:"))
        .map((alarm) => browser.alarms.clear(alarm.name))
    ),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Recovery alarm cleanup timed out"
  );
  // Once an action request has been durably journaled, revocation cannot
  // recall a Firefox API call that may already be in flight. Preserve that
  // journal (and a rare persisted terminal transition) so completion or
  // restart reconciliation can produce one exact/unknown receipt + cooldown.
  const issuedOperationIds = new Set(
    [...repository.operations.values()]
      .filter(
        (operation) =>
          operation.state === "executing" ||
          operation.state === "requested" ||
          operation.state === "terminal"
      )
      .map((operation) => operation.operationId)
  );
  for (const [operationId] of [...repository.operations]) {
    if (!issuedOperationIds.has(operationId)) repository.operations.delete(operationId);
  }
  for (const record of records) {
    record.monitoringEpoch = repository.monitoringEpoch;
    record.evidenceExpiresAt = 0;
    record.pendingResetAt = undefined;
    if (
      !record.recovery.operationId ||
      !issuedOperationIds.has(record.recovery.operationId)
    ) {
      if (
      record.recovery.status === "prepared" ||
      record.recovery.status === "awaiting-consent" ||
      record.recovery.status === "executing" ||
      record.recovery.status === "requested"
      ) {
        record.recovery = { status: "idle", blockedReason: reason };
      }
    }
  }
  if (stopScope !== "none") {
    const collectorsToStop = records.filter(
      (record) => stopScope === "all" || record.monitoringMode === "continuous"
    );
    await Promise.allSettled(collectorsToStop.map(sendStopCollector));
  }
  if (clearManualSessions) {
    await clearAllManualSessionPolicies();
  }
  await repository.persistOperations();
  await repository.persistRecords();
  await resetFindingsNotification();
}

async function reconcileStoredRecovery(isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return;
  const now = Date.now();
  const alarms = await withTimeout(
    browser.alarms.getAll(),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Recovery alarm lookup timed out"
  );
  if (!isCurrent()) return;
  const alarmNames = new Set(alarms.map((alarm) => alarm.name));
  let changed = false;
  for (const alarm of alarms) {
    if (!isCurrent()) return;
    if (alarm.name.startsWith("reset:")) {
      await clearAlarmBounded(alarm.name);
      if (!isCurrent()) return;
      changed = true;
      continue;
    }
    const operationId = operationIdFromAlarm(alarm.name);
    if (!operationId || repository.operations.has(operationId)) continue;
    await clearAlarmBounded(alarm.name);
    if (!isCurrent()) return;
    changed = true;
  }
  for (const [operationId, operation] of [...repository.operations]) {
    if (!isCurrent()) return;
    const record = repository.records.get(operation.tabId);
    const terminalReceipt = repository.receipts.find(
      (receipt) => receipt.operationId === operationId
    );
    if (terminalReceipt) {
      // A terminal receipt is the commit marker. A crash between receipt
      // persistence and operation removal must never synthesize a second,
      // contradictory unknown outcome.
      if (record?.recovery.operationId === operationId) {
        record.recovery =
          terminalReceipt.outcome === "success" || terminalReceipt.outcome === "unknown"
            ? { status: "cooldown" }
            : { status: "idle" };
      }
      if (
        record &&
        (terminalReceipt.outcome === "success" || terminalReceipt.outcome === "unknown")
      ) {
        const cooldownUntil = Math.max(
          repository.tabPolicies.get(record.tabId)?.cooldownUntil ?? 0,
          terminalReceipt.occurredAt + RESET_COOLDOWN_MS
        );
        if (cooldownUntil > now) {
          record.cooldownUntil = cooldownUntil;
          repository.tabPolicies.set(record.tabId, {
            ...(repository.tabPolicies.get(record.tabId) ?? { tabId: record.tabId }),
            cooldownUntil
          });
        }
      }
      await repository.commitReceiptAndRemoveOperation(terminalReceipt);
      if (!isCurrent()) return;
      await clearAlarmBounded(recoveryAlarmName(operation));
      if (!isCurrent()) return;
      changed = true;
      continue;
    }
    const documentMatches =
      record?.documentInstanceId === operation.documentInstanceId &&
      record.documentId === operation.documentId;
    if (
      operation.state === "executing" ||
      operation.state === "requested" ||
      operation.state === "terminal"
    ) {
      operation.state = "terminal";
      const requestedAt = operation.requestedAt ?? operation.preparedAt;
      const matchingRecord = record && documentMatches ? record : undefined;
      const cooldownUntil = now + RESET_COOLDOWN_MS;
      repository.tabPolicies.set(operation.tabId, {
        ...(repository.tabPolicies.get(operation.tabId) ?? { tabId: operation.tabId }),
        cooldownUntil,
        ...(operation.initiator === "automatic" ? { lastAutomaticAttemptAt: now } : {})
      });
      if (matchingRecord) {
        matchingRecord.recovery = { status: "cooldown" };
        matchingRecord.cooldownUntil = cooldownUntil;
      }
      if (!isCurrent()) return;
      // Make the cooldown durable before the local receipt removes the last
      // issued-operation journal. A crash can then never expose the old
      // finding without either a journal, receipt, or persisted cooldown.
      await repository.persistTabPolicies();
      if (!isCurrent()) return;
      await repository.persistRecords();
      if (!isCurrent()) return;
      await repository.commitReceiptAndRemoveOperation(
        receiptForIssuedJournal(
          operation,
          matchingRecord,
          "A recovery request was journaled before the extension restarted; whether Firefox received or completed it is unknown, and it will not be retried automatically.",
          now,
          requestedAt
        )
      );
      if (!isCurrent()) return;
      await clearAlarmBounded(recoveryAlarmName(operation));
      if (!isCurrent()) return;
      changed = true;
      continue;
    }
    const invalid =
      operation.expiresAt <= now ||
      operation.monitoringEpoch !== repository.monitoringEpoch ||
      !record ||
      !documentMatches ||
      operation.initiator === "automatic" ||
      operation.state === "prepared" ||
      operation.state === "awaiting-consent";
    if (invalid) {
      repository.operations.delete(operationId);
      await clearAlarmBounded(recoveryAlarmName(operation));
      if (!isCurrent()) return;
      if (record?.recovery.operationId === operationId) record.recovery = { status: "idle" };
      changed = true;
      continue;
    }
    if (alarmNames.has(recoveryAlarmName(operation))) {
      // Manual confirmations never use alarms. Any such alarm is stale authority.
      await clearAlarmBounded(recoveryAlarmName(operation));
      if (!isCurrent()) return;
      changed = true;
    }
  }
  if (!isCurrent()) return;
  for (const record of repository.records.values()) {
    record.pendingResetAt = undefined;
    if (
      record.recovery.operationId &&
      !repository.operations.has(record.recovery.operationId)
    ) {
      record.recovery = record.recovery.automaticSuppressedForDocument
        ? { ...record.recovery, status: "suppressed", operationId: undefined }
        : { status: "idle" };
      changed = true;
    }
    applyTabPolicy(record, now);
  }
  if (!isCurrent()) return;
  for (const [tabId, policy] of [...repository.tabPolicies]) {
    const previousPolicy = JSON.stringify(policy);
    const next = {
      tabId,
      ...(policy.snoozedUntil && policy.snoozedUntil > now
        ? { snoozedUntil: policy.snoozedUntil }
        : {}),
      ...(policy.cooldownUntil && policy.cooldownUntil > now
        ? { cooldownUntil: policy.cooldownUntil }
        : {}),
      ...(policy.lastAutomaticAttemptAt
        ? { lastAutomaticAttemptAt: policy.lastAutomaticAttemptAt }
        : {}),
      ...(policy.manualSessionExpiresAt && policy.manualSessionExpiresAt > now
        ? {
            manualSessionStartedAt: policy.manualSessionStartedAt,
            manualSessionExpiresAt: policy.manualSessionExpiresAt,
            manualSessionToken: policy.manualSessionToken,
            manualSessionDocumentInstanceId: policy.manualSessionDocumentInstanceId,
            manualSessionDocumentId: policy.manualSessionDocumentId
          }
        : {})
    };
    if (Object.keys(next).length === 1) repository.tabPolicies.delete(tabId);
    else repository.tabPolicies.set(tabId, next);
    if (JSON.stringify(next) !== previousPolicy) changed = true;
  }
  if (changed) {
    if (!isCurrent()) return;
    await repository.persistOperations();
    if (!isCurrent()) return;
    await repository.persistRecords();
    if (!isCurrent()) return;
    await repository.persistTabPolicies();
  }
}

async function cancelOperationsForTab(tabId: number, _reason: string): Promise<void> {
  const operations = [...repository.operations.values()].filter(
    (operation) => operation.tabId === tabId
  );
  const cancelledOperationIds = new Set<string>();
  for (const operation of operations) {
    await withTimeout(
      browser.alarms.clear(recoveryAlarmName(operation)),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Recovery alarm cleanup timed out"
    ).catch(() => false);
    if (
      operation.state === "executing" ||
      operation.state === "requested" ||
      operation.state === "terminal"
    ) continue;
    repository.operations.delete(operation.operationId);
    cancelledOperationIds.add(operation.operationId);
  }
  const record = repository.records.get(tabId);
  if (record) {
    record.pendingResetAt = undefined;
    if (
      record.recovery.operationId &&
      cancelledOperationIds.has(record.recovery.operationId)
    ) record.recovery = { status: "idle" };
  }
  if (operations.length > 0) await repository.persistOperations();
}

async function invalidateDocument(tabId: number): Promise<void> {
  await repository.ready;
  await cancelOperationsForTab(tabId, "Document navigated");
  repository.records.delete(tabId);
  await clearManualSessionPolicy(tabId);
  await repository.persistRecords();
  await resetFindingsNotification();
  await updateBadge(
    repository.records.values(),
    repository.preferences.monitoringEnabled
  ).catch(() => undefined);
}

async function removeTab(tabId: number): Promise<void> {
  await repository.ready;
  await cancelOperationsForTab(tabId, "Tab closed");
  repository.records.delete(tabId);
  await repository.removeTabPolicy(tabId);
  await repository.persistRecords();
  await resetFindingsNotification();
  await updateBadge(
    repository.records.values(),
    repository.preferences.monitoringEnabled
  ).catch(() => undefined);
}

async function pruneClosedTabs(isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return;
  const openTabs = new Set(
    (await withTimeout(
      browser.tabs.query({}),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Open-tab reconciliation timed out"
    )).flatMap((tab) => (tab.id === undefined ? [] : [tab.id]))
  );
  if (!isCurrent()) return;
  for (const tabId of [...repository.records.keys()]) {
    if (!openTabs.has(tabId)) repository.records.delete(tabId);
  }
  for (const tabId of [...repository.tabPolicies.keys()]) {
    if (!openTabs.has(tabId)) repository.tabPolicies.delete(tabId);
  }
  const cutoff = Date.now() - STALE_RECORD_RETENTION_MS;
  for (const [tabId, record] of [...repository.records]) {
    if (record.updatedAt < cutoff && record.recovery.status === "idle") {
      repository.records.delete(tabId);
    }
  }
  if (!isCurrent()) return;
  await repository.persistRecords();
  if (!isCurrent()) return;
  await repository.persistTabPolicies();
}

function enforceRecordBound(): void {
  if (repository.records.size <= MAX_TAB_RECORDS) return;
  const evictable = [...repository.records.values()]
    .filter(
      (record) =>
        record.recovery.status === "idle" &&
        record.detector.status !== "confirmed" &&
        record.detector.status !== "suspected"
    )
    .sort((a, b) => a.updatedAt - b.updatedAt);
  while (repository.records.size > MAX_TAB_RECORDS && evictable.length > 0) {
    const record = evictable.shift();
    if (record) repository.records.delete(record.tabId);
  }
  if (repository.records.size <= MAX_TAB_RECORDS) return;
  const lastResort = [...repository.records.values()]
    .filter(
      (record) =>
        record.recovery.status !== "executing" && record.recovery.status !== "requested"
    )
    .sort((a, b) => a.updatedAt - b.updatedAt || a.detector.score - b.detector.score);
  while (repository.records.size > MAX_TAB_RECORDS && lastResort.length > 0) {
    const record = lastResort.shift();
    if (record) repository.records.delete(record.tabId);
  }
}

function applyTabPolicy(record: TabRecord, now: number): void {
  const policy = repository.tabPolicies.get(record.tabId);
  if (policy?.snoozedUntil && policy.snoozedUntil > now) {
    record.snoozedUntil = policy.snoozedUntil;
    record.recovery = { status: "suppressed", blockedReason: "Snoozed by the user" };
  } else {
    record.snoozedUntil = undefined;
    if (
      record.recovery.status === "suppressed" &&
      record.recovery.blockedReason === "Snoozed by the user" &&
      record.recovery.automaticSuppressedForDocument !== true
    ) {
      record.recovery = { status: "idle" };
    }
  }
  if (policy?.cooldownUntil && policy.cooldownUntil > now) {
    record.cooldownUntil = policy.cooldownUntil;
    if (record.recovery.status === "idle") record.recovery = { status: "cooldown" };
  } else {
    record.cooldownUntil = undefined;
    if (record.recovery.status === "cooldown") record.recovery = { status: "idle" };
  }
  if (policy?.manualSessionExpiresAt && policy.manualSessionExpiresAt > now) {
    record.monitoringMode = "manual";
    record.manualSessionStartedAt = policy.manualSessionStartedAt;
    record.manualSessionExpiresAt = policy.manualSessionExpiresAt;
  } else if (record.monitoringMode === "manual") {
    record.manualSessionStartedAt = undefined;
    record.manualSessionExpiresAt = undefined;
  }
}

async function clearManualSessionPolicy(tabId: number): Promise<void> {
  settleCollectorReadyWaiter(tabId, "manual", undefined, false);
  const existing = repository.tabPolicies.get(tabId);
  if (!existing) return;
  if (
    existing.manualSessionStartedAt === undefined &&
    existing.manualSessionExpiresAt === undefined &&
    existing.manualSessionToken === undefined &&
    existing.manualSessionDocumentId === undefined &&
    existing.manualSessionDocumentInstanceId === undefined
  ) return;
  const next = tabPolicyWithoutManualSession(existing);
  if (Object.keys(next).length === 1) await repository.removeTabPolicy(tabId);
  else await repository.upsertTabPolicy(next);
}

async function clearAllManualSessionPolicies(): Promise<void> {
  settleAllCollectorReadyWaiters(false);
  let changed = false;
  for (const [tabId, policy] of repository.tabPolicies) {
    if (
      policy.manualSessionStartedAt === undefined &&
      policy.manualSessionExpiresAt === undefined &&
      policy.manualSessionToken === undefined &&
      policy.manualSessionDocumentId === undefined &&
      policy.manualSessionDocumentInstanceId === undefined
    ) continue;
    const next = tabPolicyWithoutManualSession(policy);
    if (Object.keys(next).length === 1) repository.tabPolicies.delete(tabId);
    else repository.tabPolicies.set(tabId, next);
    changed = true;
  }
  if (changed) await repository.persistTabPolicies();
}

function tabPolicyWithoutManualSession(policy: TabPolicyState): TabPolicyState {
  return {
    tabId: policy.tabId,
    ...(policy.snoozedUntil ? { snoozedUntil: policy.snoozedUntil } : {}),
    ...(policy.cooldownUntil ? { cooldownUntil: policy.cooldownUntil } : {}),
    ...(policy.lastAutomaticAttemptAt
      ? { lastAutomaticAttemptAt: policy.lastAutomaticAttemptAt }
      : {})
  };
}

function waitForCollectorReady(
  tabId: number,
  collectorMode: "manual" | "continuous",
  authorityToken: string | null
): Promise<boolean> {
  settleCollectorReadyWaiter(tabId, undefined, undefined, false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      settleCollectorReadyWaiter(tabId, collectorMode, authorityToken, false);
    }, MANUAL_SESSION_READY_TIMEOUT_MS);
    collectorReadyWaiters.set(tabId, { collectorMode, authorityToken, resolve, timer });
  });
}

function settleCollectorReadyWaiter(
  tabId: number,
  collectorMode: "manual" | "continuous" | undefined,
  authorityToken: string | null | undefined,
  ready: boolean
): void {
  const waiter = collectorReadyWaiters.get(tabId);
  if (
    !waiter ||
    (collectorMode !== undefined && waiter.collectorMode !== collectorMode) ||
    (authorityToken !== undefined && waiter.authorityToken !== authorityToken)
  ) return;
  collectorReadyWaiters.delete(tabId);
  clearTimeout(waiter.timer);
  waiter.resolve(ready);
}

function settleAllCollectorReadyWaiters(ready: boolean): void {
  for (const tabId of [...collectorReadyWaiters.keys()]) {
    settleCollectorReadyWaiter(tabId, undefined, undefined, ready);
  }
}

function markDocumentChanging(tabId: number): void {
  const record = repository.records.get(tabId);
  if (!record) return;
  retireDocumentInstance(record);
  record.revision += 1;
  record.evidenceExpiresAt = 0;
}

function navigationAlreadyRepresented(details: {
  tabId: number;
  timeStamp: number;
  documentId?: string;
}, nativeIdentityDefinesNavigation: boolean): boolean {
  const record = repository.records.get(details.tabId);
  if (!record) return false;
  // document_start HELLO can beat Firefox's webNavigation delivery. Native
  // identity is definitive for a full commit; creation time correlates an SPA
  // evidence segment with the history event that triggered it. In either
  // ordering, retire exactly the pre-navigation segment, never the new one.
  if (
    nativeIdentityDefinesNavigation &&
    details.documentId &&
    record.documentId === details.documentId
  ) return true;
  return isFiniteNumber(details.timeStamp, 1) && record.createdAt >= details.timeStamp;
}

function clearNavigationFenceForEvent(tabId: number, eventTimeStamp: number): void {
  const fence = pendingNavigationTabs.get(tabId);
  if (!fence || !isFiniteNumber(eventTimeStamp, 1)) return;
  // Event delivery can be delayed and reordered. Only an event that occurred
  // after this loading fence may release it; an older commit/SPA event belongs
  // to an earlier navigation generation.
  if (eventTimeStamp >= fence.startedAtEpochMs) pendingNavigationTabs.delete(tabId);
}

async function reconcileCompletedNavigationFence(
  tabId: number,
  expectedGeneration: number
): Promise<void> {
  try {
    const tab = await withTimeout(
      browser.tabs.get(tabId),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Completed-navigation tab lookup timed out"
    );
    if (tab.status !== "complete") return;
    const frame = await withTimeout(
      browser.webNavigation.getFrame({ tabId, frameId: 0 }),
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Completed-navigation frame lookup timed out"
    ) as (browser.webNavigation._GetFrameReturnDetails & { documentId?: string }) | null;
    const currentFence = pendingNavigationTabs.get(tabId);
    if (!frame || currentFence?.generation !== expectedGeneration || frame.url !== tab.url) return;
    const record = repository.records.get(tabId);
    if (record) {
      const support = inspectUrl(tab.url);
      if (!support.supported || support.hostname !== record.hostname) return;
      if (record.documentId && frame.documentId && record.documentId !== frame.documentId) return;
    }
    pendingNavigationTabs.delete(tabId);
  } catch {
    // Keeping the fence is the fail-closed outcome. A later lifecycle event or
    // document invalidation can safely reconcile it.
  }
}

function retireDocumentInstance(record: TabRecord): void {
  const previous = retiredDocumentInstances.get(record.tabId) ?? [];
  const next = [record.documentInstanceId, ...previous.filter(
    (documentInstanceId) => documentInstanceId !== record.documentInstanceId
  )].slice(0, 8);
  retiredDocumentInstances.set(record.tabId, next);
  while (retiredDocumentInstances.size > MAX_TAB_RECORDS * 2) {
    const oldestTabId = retiredDocumentInstances.keys().next().value as number | undefined;
    if (oldestTabId === undefined) break;
    retiredDocumentInstances.delete(oldestTabId);
  }
}

function markTabStateChanging(tabId: number): void {
  const record = repository.records.get(tabId);
  if (record) record.revision += 1;
}

async function sendStopCollector(record: TabRecord): Promise<void> {
  const command = {
    type: "STOP_COLLECTOR" as const,
    expectedDocumentInstanceId: record.documentInstanceId
  };
  try {
    const request = record.documentId
      ? browser.tabs.sendMessage(record.tabId, command, { documentId: record.documentId })
      : browser.tabs.sendMessage(record.tabId, command);
    await withTimeout(request, RECOVERY_PREFLIGHT_MAX_AGE_MS, "Collector stop timed out");
  } catch {
    // Navigated, closed, restricted, or already-stopped collectors need no retry.
  }
}

async function sendStopCollectorForPolicy(policy: TabPolicyState): Promise<void> {
  const command = {
    type: "STOP_COLLECTOR" as const,
    ...(policy.manualSessionDocumentInstanceId
      ? { expectedDocumentInstanceId: policy.manualSessionDocumentInstanceId }
      : {})
  };
  try {
    const request = policy.manualSessionDocumentId
      ? browser.tabs.sendMessage(policy.tabId, command, {
          documentId: policy.manualSessionDocumentId
        })
      : browser.tabs.sendMessage(policy.tabId, command);
    await withTimeout(request, RECOVERY_PREFLIGHT_MAX_AGE_MS, "Collector stop timed out");
  } catch {
    // An unready, navigated, closed, or already-stopped session needs no retry.
  }
}

async function isManualPolicyCollectorLive(policy: TabPolicyState): Promise<boolean> {
  if (
    !policy.manualSessionToken ||
    !policy.manualSessionDocumentInstanceId ||
    !policy.manualSessionExpiresAt ||
    policy.manualSessionExpiresAt <= Date.now()
  ) return false;
  const command = {
    type: "GET_RECOVERY_PREFLIGHT" as const,
    expectedDocumentInstanceId: policy.manualSessionDocumentInstanceId
  };
  try {
    const request = policy.manualSessionDocumentId
      ? browser.tabs.sendMessage(policy.tabId, command, {
          documentId: policy.manualSessionDocumentId
        })
      : browser.tabs.sendMessage(policy.tabId, command);
    const response = await withTimeout(
      request,
      RECOVERY_PREFLIGHT_MAX_AGE_MS,
      "Collector liveness check timed out"
    );
    const preflight = decodeCollectorPreflight(response);
    return (
      preflight.collectorMode === "manual" &&
      preflight.documentInstanceId === policy.manualSessionDocumentInstanceId &&
      preflight.authorityToken === policy.manualSessionToken &&
      preflight.sessionExpiresAtMonotonicMs !== null &&
      preflight.capturedAtMonotonicMs < preflight.sessionExpiresAtMonotonicMs
    );
  } catch {
    return false;
  }
}

async function restartContinuousCollectors(): Promise<void> {
  const records = [...repository.records.values()].filter(
    (record) => record.monitoringMode === "continuous"
  );
  await Promise.allSettled(records.map(sendStopCollector));
  for (const record of records) {
    await cancelOperationsForTab(record.tabId, "Sampling schedule changed");
    repository.records.delete(record.tabId);
  }
  if (records.length > 0) await repository.persistRecords();
}

async function stopManualCollectorsForContinuousMode(): Promise<void> {
  const records = [...repository.records.values()].filter(
    (record) => record.monitoringMode === "manual"
  );
  await Promise.allSettled(records.map(sendStopCollector));
  const recordTabIds = new Set(records.map((record) => record.tabId));
  const policyOnlyCollectors = [...repository.tabPolicies.values()].filter(
    (policy) =>
      policy.manualSessionToken !== undefined &&
      policy.manualSessionExpiresAt !== undefined &&
      policy.manualSessionExpiresAt > Date.now() &&
      !recordTabIds.has(policy.tabId)
  );
  await Promise.allSettled(policyOnlyCollectors.map(sendStopCollectorForPolicy));
  for (const record of records) {
    await cancelOperationsForTab(record.tabId, "Continuous monitoring was enabled");
    repository.records.delete(record.tabId);
  }
  settleAllCollectorReadyWaiters(false);
  await clearAllManualSessionPolicies();
  if (records.length > 0) await repository.persistRecords();
}

async function handleCollectorPerformanceWarning(tabId: number): Promise<void> {
  const record = repository.records.get(tabId);
  if (!record) return;
  record.revision += 1;
  record.evidenceExpiresAt = 0;
  record.safety = { ...record.safety, safetyComplete: false };
  try {
    const command = {
      type: "BACKOFF_COLLECTOR" as const,
      expectedDocumentInstanceId: record.documentInstanceId
    };
    const request = record.documentId
      ? browser.tabs.sendMessage(record.tabId, command, { documentId: record.documentId })
      : browser.tabs.sendMessage(record.tabId, command);
    await withTimeout(request, RECOVERY_PREFLIGHT_MAX_AGE_MS, "Collector backoff timed out");
  } catch {
    // Stale/closed contexts will be reconciled by normal lifecycle handlers.
  }
  await cancelOperationsForTab(tabId, "Collector exceeded its performance budget");
  await repository.persistRecords();
}

async function focusTab(tabId: number): Promise<CommandResponse> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId === undefined) throw new Error("Tab window is unavailable");
    await browser.windows.update(tab.windowId, { focused: true });
    await browser.tabs.update(tabId, { active: true });
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function resetFindingsNotification(): Promise<void> {
  // The stable notification ID cannot prove which site-specific finding it
  // currently represents. Any finding-set mutation clears it and releases
  // surviving confirmed records to create truthful content on their next
  // sample. Explicit configuration/data changes wait for the serialized
  // notification mutation; they never claim stale content was revoked while
  // Firefox still has a notification request in flight.
  await clearFindingsNotification();
  for (const record of repository.records.values()) record.notifiedAt = undefined;
  await repository.persistRecords();
}

function compareRecords(a: TabRecord, b: TabRecord): number {
  const detectionPriority: Record<TabRecord["detector"]["status"], number> = {
    confirmed: 0,
    suspected: 1,
    watching: 2,
    warmup: 3,
    healthy: 4,
    unsupported: 5
  };
  const recoveryPriority = (record: TabRecord): number =>
    record.recovery.status === "awaiting-consent"
      ? -2
      : record.recovery.status === "blocked" || record.recovery.status === "failed"
        ? -1
        : 0;
  return (
    recoveryPriority(a) - recoveryPriority(b) ||
    detectionPriority[a.detector.status] - detectionPriority[b.detector.status] ||
    b.detector.score - a.detector.score ||
    b.updatedAt - a.updatedAt
  );
}

function createReloadVerifier(
  tabId: number,
  timeoutMs: number
): { promise: Promise<boolean>; cancel: () => void } {
  let finished = false;
  let committedReload: { url: string; documentId: string | null } | null = null;
  let timer: ReturnType<typeof setTimeout>;
  let resolvePromise: (value: boolean) => void = () => undefined;
  const finish = (value: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    browser.webNavigation.onCommitted.removeListener(onCommitted);
    browser.webNavigation.onCompleted.removeListener(onCompleted);
    browser.webNavigation.onErrorOccurred.removeListener(onErrorOccurred);
    browser.tabs.onRemoved.removeListener(onRemoved);
    resolvePromise(value);
  };
  const onCommitted = (details: browser.webNavigation._OnCommittedDetails) => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    // A second top-level commit means the accepted reload was superseded or
    // raced another navigation. Never let a later reload overwrite the first
    // candidate and masquerade as completion of our request.
    if (committedReload || details.transitionType !== "reload") {
      finish(false);
      return;
    }
    committedReload = {
      url: details.url,
      documentId: details.documentId ?? null
    };
  };
  const onCompleted = (details: browser.webNavigation._OnCompletedDetails) => {
    if (details.tabId !== tabId || details.frameId !== 0 || committedReload === null) return;
    const sameDocument =
      committedReload.documentId && details.documentId
        ? committedReload.documentId === details.documentId
        : committedReload.url === details.url;
    finish(Boolean(sameDocument));
  };
  const onErrorOccurred = (details: browser.webNavigation._OnErrorOccurredDetails) => {
    if (details.tabId === tabId && details.frameId === 0) finish(false);
  };
  const onRemoved = (removedTabId: number) => {
    if (removedTabId === tabId) finish(false);
  };
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
    browser.webNavigation.onCommitted.addListener(onCommitted);
    browser.webNavigation.onCompleted.addListener(onCompleted);
    browser.webNavigation.onErrorOccurred.addListener(onErrorOccurred);
    browser.tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
  return { promise, cancel: () => finish(false) };
}

function withTabLock<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const previous = tabQueues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  tabQueues.set(tabId, next);
  void next.finally(() => {
    if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
  }).catch(() => undefined);
  return next;
}

function assertConfigurationCurrent(generation: number): void {
  if (deletionPending || generation !== runtimeMutationGeneration) {
    throw new Error("Local extension data was deleted while this request was in progress");
  }
}

function withConfigurationLock<T>(task: (generation: number) => Promise<T>): Promise<T> {
  const generation = runtimeMutationGeneration;
  const next = configurationQueue.catch(() => undefined).then(async () => {
    assertConfigurationCurrent(generation);
    const result = await task(generation);
    assertConfigurationCurrent(generation);
    return result;
  });
  configurationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function notePermissionMutation(): void {
  const revision = ++permissionMutationRevision;
  permissionReconciliationPending = true;
  permissionReconciliationFailureCount = 0;
  if (permissionReconciliationRetryTimer !== undefined) {
    clearTimeout(permissionReconciliationRetryTimer);
    permissionReconciliationRetryTimer = undefined;
  }
  runPermissionReconciliation(revision);
}

function runPermissionReconciliation(revision: number): void {
  // The Firefox event itself revokes visible site-specific content. Start the
  // serialized clear immediately and make reconciliation wait for it, so no
  // UI command can report permission success while stale content is visible.
  // A rejected clear is retried with the rest of reconciliation; a promise
  // that never settles remains an explicit Firefox liveness dependency.
  const notificationRevocation = resetFindingsNotification();
  const reconciliation = withConfigurationLock(async (generation) => {
    await notificationRevocation;
    await initializeRuntime();
    assertConfigurationCurrent(generation);
    await reconcilePermissionState({ generation });
    assertConfigurationCurrent(generation);
  });
  void reconciliation.then(
    () => {
      if (revision !== permissionMutationRevision) return;
      permissionReconciliationPending = false;
      permissionReconciliationFailureCount = 0;
      if (permissionReconciliationRetryTimer !== undefined) {
        clearTimeout(permissionReconciliationRetryTimer);
        permissionReconciliationRetryTimer = undefined;
      }
    },
    () => {
      if (revision !== permissionMutationRevision) return;
      permissionReconciliationFailureCount = Math.min(
        8,
        permissionReconciliationFailureCount + 1
      );
      const delayMs = Math.min(
        30_000,
        250 * 2 ** (permissionReconciliationFailureCount - 1)
      );
      permissionReconciliationRetryTimer = setTimeout(() => {
        permissionReconciliationRetryTimer = undefined;
        if (revision === permissionMutationRevision) runPermissionReconciliation(revision);
      }, delayMs);
    }
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

function safeTitle(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  return (normalized || fallback).slice(0, 160);
}

function originPattern(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

async function requireCurrentCollectorDocument(
  senderTab: browser.tabs.Tab,
  sender: browser.runtime.MessageSender,
  documentUrl: string | undefined,
  documentInstanceId: string,
  authorityEpoch: number
): Promise<browser.tabs.Tab & { id: number }> {
  if (senderTab.id === undefined) throw new Error("Top-level tab sender required");
  if (retiredDocumentInstances.get(senderTab.id)?.includes(documentInstanceId)) {
    throw new Error("This collector belongs to a retired document");
  }
  const currentTab = await withTimeout(
    browser.tabs.get(senderTab.id),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Collector tab lookup timed out"
  );
  if (currentTab.windowId !== senderTab.windowId) throw new Error("Tab window changed");
  const currentSupport = inspectUrl(currentTab.url);
  const senderSupport = inspectUrl(documentUrl);
  if (
    !currentSupport.supported ||
    !senderSupport.supported ||
    currentSupport.hostname !== senderSupport.hostname ||
    currentTab.url !== documentUrl
  ) {
    throw new Error("The collector document is no longer current");
  }
  const frame = await withTimeout(
    browser.webNavigation.getFrame({ tabId: senderTab.id, frameId: 0 }),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Collector frame lookup timed out"
  );
  const frameDetails = frame as (browser.webNavigation._GetFrameReturnDetails & {
    documentId?: string;
  }) | null;
  if (!frameDetails || frameDetails.url !== documentUrl) {
    throw new Error("The collector frame is no longer current");
  }
  if (
    sender.documentId &&
    frameDetails.documentId &&
    sender.documentId !== frameDetails.documentId
  ) {
    throw new Error("The collector document identity changed");
  }
  if (
    deletionPending ||
    repository.monitoringEpoch !== authorityEpoch ||
    retiredDocumentInstances.get(senderTab.id)?.includes(documentInstanceId)
  ) {
    throw new Error("Collector authority changed while the message was being checked");
  }
  const latestSitePolicy = repository.preferences.sitePolicies.find(
    (policy) => policy.hostname === senderSupport.hostname
  );
  if (
    repository.preferences.ignoredHosts.includes(senderSupport.hostname) ||
    latestSitePolicy?.monitoring === "off" ||
    (latestSitePolicy?.pausedUntil ?? 0) > Date.now()
  ) {
    throw new Error("Monitoring is disabled for this site");
  }
  return currentTab as browser.tabs.Tab & { id: number };
}

async function isCollectorModeAuthorized(
  tab: browser.tabs.Tab,
  documentUrl: string | undefined,
  mode: "manual" | "continuous",
  authorityToken: string | null,
  documentInstanceId: string,
  documentId: string | null
): Promise<boolean> {
  if (tab.id === undefined) return false;
  const support = inspectUrl(documentUrl);
  if (!support.supported) return false;
  const sitePolicy = repository.preferences.sitePolicies.find(
    (policy) => policy.hostname === support.hostname
  );
  if (
    repository.preferences.ignoredHosts.includes(support.hostname) ||
    sitePolicy?.monitoring === "off" ||
    (sitePolicy?.pausedUntil ?? 0) > Date.now()
  ) return false;
  if (mode === "manual") {
    if (repository.preferences.monitoringIntent === "paused") return false;
    const policy = repository.tabPolicies.get(tab.id);
    return Boolean(
      policy?.manualSessionExpiresAt &&
      policy.manualSessionExpiresAt > Date.now() &&
      policy.manualSessionToken === authorityToken &&
      manualSessionBindingMatches(policy, documentInstanceId, documentId)
    );
  }
  if (authorityToken !== null) return false;
  if (
    !repository.preferences.monitoringEnabled ||
    repository.preferences.monitoringIntent !== "continuous"
  ) return false;
  const exactOrigin = originPattern(documentUrl);
  if (!exactOrigin) return false;
  if (
    repository.preferences.permissionMode === "selected-sites" &&
    !repository.preferences.selectedOrigins.includes(exactOrigin)
  ) return false;
  if (repository.preferences.permissionMode === "manual") return false;
  if (permissionReconciliationPending) return false;
  const permissionRevision = permissionMutationRevision;
  const granted = await withTimeout(
    browser.permissions.contains({ origins: [exactOrigin] }),
    RECOVERY_PREFLIGHT_MAX_AGE_MS,
    "Collector permission check timed out"
  ).catch(() => false);
  return Boolean(
    granted &&
    !permissionReconciliationPending &&
    permissionRevision === permissionMutationRevision
  );
}

function recoveryPermissionAuthorityCurrent(
  record: TabRecord,
  operation: PreparedRecovery
): boolean {
  return record.monitoringMode !== "continuous" || (
    !permissionReconciliationPending &&
    operation.permissionRevision === permissionMutationRevision
  );
}

function collectorPolicyAuthorizedNow(
  tab: browser.tabs.Tab,
  documentUrl: string | undefined,
  mode: "manual" | "continuous",
  authorityToken: string | null,
  documentInstanceId: string,
  documentId: string | null
): boolean {
  if (tab.id === undefined || monitoringIsPaused()) return false;
  const support = inspectUrl(documentUrl);
  if (!support.supported) return false;
  const sitePolicy = repository.preferences.sitePolicies.find(
    (policy) => policy.hostname === support.hostname
  );
  if (
    repository.preferences.ignoredHosts.includes(support.hostname) ||
    sitePolicy?.monitoring === "off" ||
    (sitePolicy?.pausedUntil ?? 0) > Date.now()
  ) return false;
  if (mode === "manual") {
    const policy = repository.tabPolicies.get(tab.id);
    return Boolean(
      policy?.manualSessionExpiresAt &&
      policy.manualSessionExpiresAt > Date.now() &&
      policy.manualSessionToken === authorityToken &&
      manualSessionBindingMatches(policy, documentInstanceId, documentId)
    );
  }
  const exactOrigin = originPattern(documentUrl);
  return Boolean(
    authorityToken === null &&
    repository.preferences.monitoringEnabled &&
    repository.preferences.monitoringIntent === "continuous" &&
    exactOrigin &&
    repository.preferences.permissionMode !== "manual" &&
    (repository.preferences.permissionMode === "all-sites" ||
      repository.preferences.selectedOrigins.includes(exactOrigin))
  );
}

function manualSessionBindingMatches(
  policy: TabPolicyState,
  documentInstanceId: string,
  documentId: string | null
): boolean {
  if (
    policy.manualSessionDocumentInstanceId !== undefined &&
    policy.manualSessionDocumentInstanceId !== documentInstanceId
  ) return false;
  if (
    policy.manualSessionDocumentId !== undefined &&
    policy.manualSessionDocumentId !== documentId
  ) return false;
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
