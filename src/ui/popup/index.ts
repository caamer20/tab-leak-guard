import type {
  ExtensionSnapshot,
  RecoveryPreparationView,
  TabRecord
} from "../../shared/types";
import {
  element,
  formatFutureTime,
  formatRelativeTime,
  getSnapshot,
  localizeDocument,
  requestContinuousPermission,
  sendCommand,
  showMessage,
  t
} from "../client";
import {
  compareTabViewModels,
  deriveTabViewModel,
  type EvidenceQualityLevel,
  type ProtectionCode
} from "../view-model";

type EvidenceQuality = {
  level: "high" | "medium" | "low" | "insufficient";
  distinctSamples: number;
  expectedSamples: number;
  reasonCodes: string[];
};

type PresentableDetector = TabRecord["detector"] & {
  quality?: EvidenceQuality;
  severity?: string;
  automaticEligible?: boolean;
  highEvidenceDistinctSamples?: number;
};

type RecoveryResult = { action: "discard" | "reload"; phase: string };
type MonitoringStartResult =
  | { tabId: number; mode: "manual"; expiresInMinutes: number }
  | { tabId: number; mode: "continuous"; alreadyMonitoring: boolean };

type DialogState = {
  preparation: RecoveryPreparationView;
  returnFocusKey: string | null;
  timer: number;
  announcedTenSeconds: boolean;
  executing: boolean;
  cancelling: boolean;
};

const LIVE_REFRESH_MS = 2_500;
const list = required("tab-list");
const message = required("message");
const permissionCard = required("permission-card");
const dialog = requiredDialog("recovery-dialog");
const busyActions = new Set<string>();
const manualSessionEnds = new Map<number, number>();

let latestSnapshot: ExtensionSnapshot | null = null;
let renderGeneration = 0;
let lastSummarySignature = "";
let liveTimer: number | undefined;
let deferredRenderTimer: number | undefined;
let stableSectionOpen = false;
let dialogState: DialogState | null = null;

localizeDocument();
required("settings").addEventListener("click", () => void browser.runtime.openOptionsPage());
required("refresh").addEventListener("click", () => void render(true));
required("enable-monitoring").addEventListener("click", () => void enableMonitoring());
required("scan-active").addEventListener("click", () => void scanActive());
required("scan-active-footer").addEventListener("click", () => void scanActive());
required("state-action").addEventListener("click", () => void enableMonitoring());
required("recovery-cancel").addEventListener("click", () => void cancelRecoveryDialog());
required("recovery-execute").addEventListener("click", () => void executePreparedRecovery());
requiredInput("edit-ack").addEventListener("change", updateExecuteButton);
list.addEventListener("click", (event) => void handleListAction(event));
list.addEventListener("toggle", handleDetailsToggle, true);
dialog.addEventListener("cancel", handleDialogCancel);
dialog.addEventListener("keydown", handleDialogKeydown);
document.addEventListener("visibilitychange", handleVisibilityChange);
browser.storage.onChanged.addListener(handleStorageChange);
window.addEventListener("pagehide", cleanup, { once: true });

void render(false);
startLiveRefresh();

async function render(announce = true): Promise<void> {
  const generation = ++renderGeneration;
  const focusKey = captureFocusKey();
  const refresh = requiredButton("refresh");
  refresh.disabled = true;
  try {
    const snapshot = await getSnapshot();
    if (generation !== renderGeneration) return;
    latestSnapshot = snapshot;
    renderMonitoringState(snapshot);
    renderSummary(snapshot, announce);
    renderRecords(snapshot.records);
    reconcileOpenDialog(snapshot);
    restoreFocus(focusKey);
  } catch (error) {
    if (generation === renderGeneration) showMessage(message, errorText(error));
  } finally {
    if (generation === renderGeneration) refresh.disabled = false;
  }
}

function renderMonitoringState(snapshot: ExtensionSnapshot): void {
  const title = required("monitoring-state-title");
  const description = required("monitoring-state-description");
  const action = requiredButton("state-action");
  const { preferences } = snapshot;
  action.hidden = true;

  if (preferences.monitoringIntent === "paused") {
    title.textContent = t("monitoringPaused");
    description.textContent = t("monitoringPausedDescription");
    action.textContent = t("enableMonitoring");
    action.hidden = false;
  } else if (preferences.monitoringIntent === "manual") {
    title.textContent = t("manualMonitoringOnly");
    description.textContent = t("manualMonitoringDescription");
    action.textContent = t("enableMonitoring");
    action.hidden = false;
  } else if (!snapshot.hasContinuousPermission) {
    title.textContent = t("permissionNeeded");
    description.textContent = t("permissionNeededDescription");
    action.textContent = t("grantAccess");
    action.hidden = false;
  } else if (preferences.permissionMode === "selected-sites") {
    title.textContent = t("monitoringSelectedSites");
    description.textContent = t(
      preferences.selectedOrigins.length === 1
        ? "monitoringOneSelectedSiteDescription"
        : "monitoringSelectedSitesDescription",
      String(preferences.selectedOrigins.length)
    );
  } else {
    title.textContent = t("monitoringAllSites");
    description.textContent = t("monitoringAllSitesDescription");
  }

  permissionCard.hidden = snapshot.hasContinuousPermission && preferences.monitoringIntent === "continuous";
}

function renderSummary(snapshot: ExtensionSnapshot, announce: boolean): void {
  const records = snapshot.records;
  const confirmed = records.filter((record) => record.detector.status === "confirmed");
  const watching = records.filter((record) =>
    record.detector.status === "watching" || record.detector.status === "suspected"
  );
  const stable = records.length - confirmed.length - watching.length;
  required("confirmed-count").textContent = String(confirmed.length);
  required("watching-count").textContent = String(watching.length);
  required("stable-count").textContent = String(stable);

  const signature = `${confirmed.length}:${watching.length}:${stable}`;
  if (announce && lastSummarySignature && signature !== lastSummarySignature) {
    required("live-summary").textContent = t("monitoringSummaryChanged", [
      String(confirmed.length),
      String(watching.length),
      String(stable)
    ]);
  }
  lastSummarySignature = signature;
}

function renderRecords(records: TabRecord[]): void {
  list.replaceChildren();
  if (records.length === 0) {
    const empty = element("div", "empty");
    empty.append(
      element("strong", undefined, t("noMonitoredTabs")),
      document.createTextNode(t("noMonitoredTabsDescription"))
    );
    list.append(empty);
    return;
  }

  const sorted = [...records].sort((a, b) => compareTabViewModels(a, b));
  const concerning = sorted.filter((record) => deriveTabViewModel(record).isConcerning);
  const stable = sorted.filter((record) => !deriveTabViewModel(record).isConcerning);
  if (concerning.length > 0) {
    const group = element("section", "record-group");
    const heading = element("h3", "group-heading", t("needsAttention"));
    heading.id = "attention-heading";
    group.setAttribute("aria-labelledby", heading.id);
    group.append(heading);
    for (const record of concerning) group.append(createRecordCard(record));
    list.append(group);
  }
  if (stable.length > 0) {
    const details = element("details", "stable-group");
    details.open = concerning.length === 0 || stableSectionOpen;
    details.dataset.stableGroup = "true";
    const summary = element(
      "summary",
      undefined,
      t(stable.length === 1 ? "oneStableTab" : "stableTabsCount", String(stable.length))
    );
    summary.dataset.focusKey = "stable-summary";
    details.append(summary);
    const group = element("div", "record-group stable-records");
    for (const record of stable) group.append(createRecordCard(record));
    details.append(group);
    list.append(details);
  }
}

function createRecordCard(record: TabRecord): HTMLElement {
  const view = deriveTabViewModel(record);
  const card = element("article", "tab-card");
  card.dataset.tabId = String(record.tabId);
  card.id = `tab-${record.tabId}`;

  const head = element("div", "tab-card-head");
  const identity = element("div", "tab-identity");
  const title = element("h4", "tab-title", record.title || record.hostname);
  title.title = record.title;
  identity.append(title, element("span", "hostname", record.hostname));
  const detection = element(
    "span",
    `status-pill status-${record.detector.status}`,
    t(view.detectionMessageKey)
  );
  detection.setAttribute("aria-label", t("detectionStatus", t(view.detectionMessageKey)));
  head.append(identity, detection);

  const recovery = element("div", "orthogonal-status");
  recovery.append(element("span", "status-label", t("detectionLabel")), detection);
  if (record.recovery.status !== "idle") {
    const recoveryPill = element(
      "span",
      `recovery-pill recovery-${record.recovery.status}`,
      t(view.recoveryMessageKey)
    );
    recoveryPill.setAttribute("aria-label", t("recoveryStatus", t(view.recoveryMessageKey)));
    recovery.append(element("span", "status-label", t("recoveryLabel")), recoveryPill);
  }

  const reasonId = `reason-${record.tabId}`;
  const reason = element("p", "reason", topReason(record));
  reason.id = reasonId;
  card.setAttribute("aria-describedby", reasonId);

  const evidence = createEvidenceSummary(record);
  const safety = element("div", "safety", undefined);
  safety.setAttribute("aria-label", t("currentProtections"));
  for (const label of safetyLabels(view.protections)) safety.append(element("span", undefined, label));

  const details = element("details", "advanced-details");
  const detailsSummary = element("summary", undefined, t("evidenceDetails"));
  detailsSummary.dataset.focusKey = `details:${record.tabId}`;
  const detailsBody = element("dl", "advanced-grid");
  appendDefinition(detailsBody, t("scoreLabel"), t("scoreValue", String(record.detector.score)));
  appendDefinition(detailsBody, t("sampleCountLabel"), String(record.samples.length));
  appendDefinition(detailsBody, t("lastUpdatedLabel"), formatRelativeTime(record.updatedAt));
  const codes = record.detector.reasonCodes.length > 0
    ? record.detector.reasonCodes.join(", ")
    : t("noneLabel");
  appendDefinition(detailsBody, t("reasonCodesLabel"), codes);
  details.append(detailsSummary, detailsBody);

  const actions = element("div", "tab-actions");
  actions.append(actionButton(t("focusTab"), "focus", record, "quiet"));
  if (view.canReviewRecovery) {
    actions.append(actionButton(t("reviewRecovery"), "recover", record, "primary"));
  }
  if (record.recovery.status === "awaiting-consent" && record.recovery.operationId) {
    const cancel = actionButton(t("cancelRecovery"), "cancel", record, "quiet");
    cancel.dataset.operationId = record.recovery.operationId;
    actions.append(cancel);
  }
  actions.append(actionButton(t("snooze30Minutes"), "snooze", record, "quiet"));
  actions.append(actionButton(t("stopMonitoring"), "stop", record, "quiet"));
  actions.append(actionButton(t("ignoreSite"), "ignore", record, "quiet"));
  actions.append(actionButton(t("siteSettings"), "site-policy", record, "link-button"));

  card.append(head, recovery, reason, evidence, safety, details, actions);
  return card;
}

function createEvidenceSummary(record: TabRecord): HTMLElement {
  const detector = record.detector as PresentableDetector;
  const view = deriveTabViewModel(record);
  const container = element("div", "evidence-summary");
  const evidence = element("dl", "evidence-grid");
  const freshness = view.evidenceIsFresh
    ? t("evidenceFresh", formatRelativeTime(view.sampledAt))
    : t("evidenceStale", formatRelativeTime(view.sampledAt));

  appendDefinition(evidence, t("confidenceLabel"), t(view.confidenceMessageKey));
  appendDefinition(evidence, t("qualityLabel"), qualityLabel(view.quality));
  appendDefinition(evidence, t("freshnessLabel"), freshness);

  if (record.detector.status === "warmup") {
    const received = detector.quality?.distinctSamples ?? record.samples.length;
    const expected = Math.max(received, detector.quality?.expectedSamples ?? 6);
    const percent = Math.min(100, Math.round((received / expected) * 100));
    const progress = element("div", "learning-progress");
    const label = element("span", undefined, t("learningProgress", String(percent)));
    const meter = element("progress") as HTMLProgressElement;
    meter.max = 100;
    meter.value = percent;
    meter.setAttribute("aria-label", t("learningProgress", String(percent)));
    progress.append(label, meter);
    const wrapper = element("div", "evidence-progress");
    wrapper.append(progress);
    container.append(evidence, wrapper);
  } else {
    container.append(evidence);
  }

  const latest = record.samples.at(-1);
  if (latest?.collectorMode === "manual") {
    const inferredEnd = manualSessionEnds.get(record.tabId) ?? record.createdAt + 15 * 60_000;
    const session = element("p", "temporary-session");
    session.textContent = inferredEnd > Date.now()
      ? t("temporarySessionEnds", formatFutureTime(inferredEnd))
      : t("temporarySessionExpired");
    container.append(session);
  }
  return container;
}

function appendDefinition(list: HTMLDListElement, term: string, description: string): void {
  const group = element("div");
  group.append(element("dt", undefined, term), element("dd", undefined, description));
  list.append(group);
}

function actionButton(
  label: string,
  action: string,
  record: TabRecord,
  className: string
): HTMLButtonElement {
  const button = element("button", className, label);
  const key = `${action}:${record.tabId}`;
  button.type = "button";
  button.dataset.action = action;
  button.dataset.tabId = String(record.tabId);
  button.dataset.focusKey = key;
  button.disabled = busyActions.has(key);
  button.setAttribute("aria-label", t("actionForTab", [label, record.title || record.hostname]));
  return button;
}

async function handleListAction(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button || button.disabled) return;
  const tabId = Number(button.dataset.tabId);
  const action = button.dataset.action;
  if (!Number.isSafeInteger(tabId) || !action) return;
  const key = `${action}:${tabId}`;
  busyActions.add(key);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    if (action === "focus") await sendCommand({ type: "FOCUS_TAB", tabId });
    if (action === "snooze") {
      await sendCommand({ type: "SNOOZE_TAB", tabId });
      showMessage(message, t("snoozedSuccess"), "success");
    }
    if (action === "stop") {
      await sendCommand({ type: "STOP_MONITORING_TAB", tabId });
      manualSessionEnds.delete(tabId);
      showMessage(message, t("monitoringStoppedSuccess"), "success");
    }
    if (action === "ignore") {
      const record = latestSnapshot?.records.find((candidate) => candidate.tabId === tabId);
      if (!record) throw new Error(t("errorTabNoLongerMonitored"));
      await sendCommand({ type: "IGNORE_HOST", hostname: record.hostname });
      showMessage(message, t("siteIgnoredSuccess", record.hostname), "success");
    }
    if (action === "site-policy") await browser.runtime.openOptionsPage();
    if (action === "recover") await prepareRecovery(tabId, key);
    if (action === "cancel") {
      const operationId = button.dataset.operationId;
      if (operationId) await sendCommand({ type: "CANCEL_RECOVERY", operationId });
      showMessage(message, t("recoveryCancelled"), "success");
    }
    if (action !== "recover") await render();
  } catch (error) {
    showMessage(message, errorText(error));
  } finally {
    busyActions.delete(key);
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function prepareRecovery(tabId: number, returnFocusKey: string): Promise<void> {
  if (dialogState) await closeRecoveryDialog(true);
  const preparation = await sendCommand<RecoveryPreparationView>({ type: "PREPARE_RECOVERY", tabId });
  const timer = window.setInterval(updateDialogCountdown, 1_000);
  dialogState = {
    preparation,
    returnFocusKey,
    timer,
    announcedTenSeconds: false,
    executing: false,
    cancelling: false
  };
  populateRecoveryDialog(preparation);
  dialog.showModal();
  required("recovery-dialog-title").focus();
}

function populateRecoveryDialog(preparation: RecoveryPreparationView): void {
  const title = required("recovery-dialog-title");
  title.tabIndex = -1;
  title.textContent = preparation.action === "discard" ? t("unloadThisTab") : t("reloadThisTab");
  required("recovery-target").textContent = t("recoveryTarget", [preparation.title, preparation.hostname]);
  required("recovery-effect").textContent = preparation.action === "discard"
    ? t("unloadEffect")
    : t("reloadEffect");

  const warningList = required("recovery-warnings");
  warningList.replaceChildren();
  const warnings = preparation.warnings.length > 0
    ? preparation.warnings.map(localizeRecoveryWarning)
    : [t("recoveryStateMayBeLost")];
  for (const warning of warnings) warningList.append(element("li", undefined, warning));

  const acknowledgement = required("edit-ack-row");
  const checkbox = requiredInput("edit-ack");
  acknowledgement.hidden = !preparation.requiresUserEditAcknowledgement;
  checkbox.checked = false;
  checkbox.required = preparation.requiresUserEditAcknowledgement;
  requiredButton("recovery-execute").textContent = preparation.action === "discard"
    ? t("confirmUnload")
    : t("confirmReload");
  updateExecuteButton();
  updateDialogCountdown();
}

async function executePreparedRecovery(): Promise<void> {
  const state = dialogState;
  if (!state || state.executing) return;
  const acknowledgement = requiredInput("edit-ack");
  if (state.preparation.requiresUserEditAcknowledgement && !acknowledgement.checked) {
    acknowledgement.focus();
    required("dialog-live").textContent = t("acknowledgementRequired");
    return;
  }
  if (Date.now() >= state.preparation.expiresAt) {
    await expireRecoveryDialog();
    return;
  }

  state.executing = true;
  updateExecuteButton();
  try {
    const result = await sendCommand<RecoveryResult>({
      type: "EXECUTE_RECOVERY",
      operationId: state.preparation.operationId,
      nonce: state.preparation.nonce,
      acknowledgeUserEditRisk: acknowledgement.checked
    });
    await closeRecoveryDialog(false);
    showMessage(
      message,
      result.action === "discard" ? t("unloadCompleted") : t("reloadCompleted"),
      "success"
    );
    await render();
  } catch (error) {
    await closeRecoveryDialog(false);
    showMessage(message, errorText(error));
    await render(false);
  }
}

async function closeRecoveryDialog(cancelOperation: boolean): Promise<boolean> {
  const state = dialogState;
  if (!state) return false;
  if (cancelOperation && (state.executing || state.cancelling)) return false;
  let cancellationApplied = !cancelOperation;
  if (cancelOperation) {
    state.cancelling = true;
    updateExecuteButton();
    try {
      await sendCommand({ type: "CANCEL_RECOVERY", operationId: state.preparation.operationId });
      cancellationApplied = true;
    } catch {
      cancellationApplied = false;
    }
  }
  if (dialogState !== state) return cancellationApplied;
  dialogState = null;
  window.clearInterval(state.timer);
  if (dialog.open) dialog.close();
  restoreFocus(state.returnFocusKey);
  return cancellationApplied;
}

async function cancelRecoveryDialog(): Promise<void> {
  const cancelled = await closeRecoveryDialog(true);
  if (cancelled) showMessage(message, t("recoveryCancelled"), "info");
}

function updateDialogCountdown(): void {
  const state = dialogState;
  if (!state) return;
  const remaining = state.preparation.expiresAt - Date.now();
  if (remaining <= 0) {
    void expireRecoveryDialog();
    return;
  }
  required("recovery-expiry").textContent = t(
    "recoveryConfirmationExpires",
    formatFutureTime(state.preparation.expiresAt)
  );
  if (remaining <= 10_000 && !state.announcedTenSeconds) {
    state.announcedTenSeconds = true;
    required("dialog-live").textContent = t("recoveryExpiresSoon");
  }
}

async function expireRecoveryDialog(): Promise<void> {
  if (!dialogState || dialogState.executing || dialogState.cancelling) return;
  const cancelled = await closeRecoveryDialog(true);
  if (cancelled) showMessage(message, t("recoveryPreparationExpired"));
  await render(false);
}

function reconcileOpenDialog(snapshot: ExtensionSnapshot): void {
  const state = dialogState;
  if (!state) return;
  if (state.executing || state.cancelling) return;
  const record = snapshot.records.find((candidate) => candidate.tabId === state.preparation.tabId);
  const operationStillCurrent = record?.recovery.operationId === state.preparation.operationId;
  const actionStillMatches = record
    ? (state.preparation.action === "reload") === record.safety.active
    : false;
  if (!record || !operationStillCurrent || !actionStillMatches) {
    void closeRecoveryDialog(true).then(() => {
      showMessage(message, t("recoveryStateChanged"));
    });
  }
}

function updateExecuteButton(): void {
  const state = dialogState;
  const execute = requiredButton("recovery-execute");
  const cancel = requiredButton("recovery-cancel");
  const requiresAcknowledgement = state?.preparation.requiresUserEditAcknowledgement === true;
  execute.disabled =
    !state || state.executing || state.cancelling || (requiresAcknowledgement && !requiredInput("edit-ack").checked);
  execute.setAttribute("aria-busy", state?.executing ? "true" : "false");
  cancel.disabled = !state || state.executing || state.cancelling;
  cancel.setAttribute("aria-busy", state?.cancelling ? "true" : "false");
}

function handleDialogCancel(event: Event): void {
  event.preventDefault();
  if (dialogState?.executing || dialogState?.cancelling) return;
  void cancelRecoveryDialog();
}

function handleDialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    const target = event.target as HTMLElement;
    const execute = requiredButton("recovery-execute");
    if (!(target instanceof HTMLButtonElement) || (target === execute && execute.disabled)) {
      event.preventDefault();
    }
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]):not([hidden]), [tabindex]:not([tabindex='-1'])"
  )].filter((node) => !node.closest("[hidden]"));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === required("recovery-dialog-title"))
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function enableMonitoring(): Promise<void> {
  try {
    const granted = await requestContinuousPermission();
    if (!granted) throw new Error(t("errorWebsiteAccessNotGranted"));
    await sendCommand({
      type: "UPDATE_PREFERENCES",
      patch: { monitoringEnabled: true, monitoringIntent: "continuous", permissionMode: "all-sites" }
    });
    showMessage(message, t("continuousMonitoringEnabled"), "success");
    await render();
  } catch (error) {
    showMessage(message, errorText(error));
  }
}

async function scanActive(): Promise<void> {
  try {
    const result = await sendCommand<MonitoringStartResult>({ type: "SCAN_ACTIVE_TAB" });
    if (result.mode === "manual") {
      manualSessionEnds.set(result.tabId, Date.now() + result.expiresInMinutes * 60_000);
      showMessage(message, t("temporaryMonitoringStarted", String(result.expiresInMinutes)), "success");
    } else {
      showMessage(message, t("continuousMonitoringActiveForTab"), "success");
    }
    scheduleRender(700);
  } catch (error) {
    showMessage(message, errorText(error));
  }
}

function qualityLabel(level: EvidenceQualityLevel): string {
  return t({
    high: "qualityHigh",
    medium: "qualityMedium",
    low: "qualityLow",
    insufficient: "qualityInsufficient"
  }[level]);
}

function topReason(record: TabRecord): string {
  const code = deriveTabViewModel(record).topReasonCode;
  if (!code) return t("collectingEvidence");
  const key = REASON_KEYS[code];
  return key ? t(key) : t("evidenceReasonUnavailable");
}

const REASON_KEYS: Record<string, string> = {
  QUALITY_NOT_ENOUGH_SAMPLES: "reasonNotEnoughSamples",
  DOM_GROWTH: "reasonDomGrowth",
  DOM_SLOPE: "reasonDomSlope",
  RECENT_DOM_SLOPE: "reasonRecentDomSlope",
  SUSTAINED_RETENTION: "reasonSustainedRetention",
  SEVERE_DOM_PATTERN: "reasonSevereDomPattern",
  RESOURCE_ACTIVITY: "reasonResourceActivity",
  RESPONSIVENESS_CONTEXT: "reasonResponsivenessContext",
  DOM_RELEASE: "reasonDomRelease",
  DOM_PLATEAU: "reasonDomPlateau",
  VIRTUALIZED_CHURN: "reasonVirtualizedChurn",
  CONFIRMATION_IN_PROGRESS: "reasonConfirmationInProgress",
  QUALITY_SAMPLE_GAPS: "reasonQualitySampleGaps",
  QUALITY_DOM_MISSING: "reasonQualityDomMissing",
  QUALITY_DOM_PARTIAL: "reasonQualityDomPartial",
  QUALITY_LARGE_GAP: "reasonQualityLargeGap",
  QUALITY_OVERFLOW: "reasonQualityOverflow",
  QUALITY_DROPPED_PERFORMANCE_ENTRIES: "reasonQualityDroppedEntries",
  QUALITY_COLLECTOR_DEGRADED: "reasonQualityCollectorDegraded",
  QUALITY_STALE: "reasonQualityStale",
  QUALITY_NON_MONOTONIC_TIME: "reasonQualityClock",
  QUALITY_RESOURCE_CONTEXT_UNAVAILABLE: "reasonQualityResourceUnavailable",
  QUALITY_RESPONSIVENESS_CONTEXT_PARTIAL: "reasonQualityResponsivenessPartial"
};

function safetyLabels(protections: ProtectionCode[]): string[] {
  const keys: Record<ProtectionCode, string> = {
    active: "safetyActive",
    highlighted: "safetyHighlighted",
    pinned: "safetyPinned",
    audio: "safetyAudio",
    attention: "safetyAttention",
    "edited-input": "safetyEditedInput",
    "edit-state-unknown": "safetyEditUnknown",
    sharing: "safetySharing",
    fullscreen: "safetyFullscreen",
    "recently-used": "safetyRecentlyUsed",
    unloaded: "safetyUnloaded",
    "firefox-protected": "safetyProtectedByFirefox",
    "signals-incomplete": "safetySignalsIncomplete",
    background: "safetyBackgroundTab"
  };
  return protections.map((protection) => t(keys[protection]));
}

function localizeRecoveryWarning(warning: string): string {
  const key = RECOVERY_WARNING_KEYS[warning];
  return key ? t(key) : warning;
}

const RECOVERY_WARNING_KEYS: Record<string, string> = {
  "Reloading can lose page state that the website has not saved.": "warningReloadState",
  "Unloading keeps the tab in the tab strip and reloads it when selected.": "warningUnloadRestore",
  "Edited input was observed in this document.": "warningEditedInput",
  "The extension cannot confirm whether this document contains edited input.": "warningUnknownInput",
  "Some current tab safety signals are unavailable.": "warningSafetyUnavailable",
  "This tab is currently active.": "warningTabActive",
  "This tab is pinned.": "warningTabPinned",
  "This tab is currently playing audio.": "warningTabAudio",
  "This tab is requesting your attention.": "warningTabAttention",
  "This tab is currently sharing media or your screen.": "warningTabSharing",
  "The tab's browser window is fullscreen.": "warningFullscreen",
  "Firefox marks this tab as protected from automatic unloading.": "warningFirefoxProtected"
};

function handleDetailsToggle(event: Event): void {
  const details = event.target as HTMLDetailsElement;
  if (details.matches("details[data-stable-group]")) stableSectionOpen = details.open;
}

function captureFocusKey(): string | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return null;
  return active.dataset.focusKey ?? (active.id ? `id:${active.id}` : null);
}

function restoreFocus(key: string | null): void {
  if (!key || dialog.open) return;
  const target = key.startsWith("id:")
    ? document.getElementById(key.slice(3))
    : [...document.querySelectorAll<HTMLElement>("[data-focus-key]")]
        .find((node) => node.dataset.focusKey === key);
  target?.focus({ preventScroll: true });
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible") {
    startLiveRefresh();
    void render(false);
  } else {
    stopLiveRefresh();
  }
}

function handleStorageChange(): void {
  if (document.visibilityState === "visible") scheduleRender(100);
}

function startLiveRefresh(): void {
  if (liveTimer !== undefined || document.visibilityState !== "visible") return;
  liveTimer = window.setInterval(() => void render(), LIVE_REFRESH_MS);
}

function stopLiveRefresh(): void {
  if (liveTimer !== undefined) window.clearInterval(liveTimer);
  liveTimer = undefined;
}

function scheduleRender(delayMs: number): void {
  if (deferredRenderTimer !== undefined) window.clearTimeout(deferredRenderTimer);
  deferredRenderTimer = window.setTimeout(() => {
    deferredRenderTimer = undefined;
    void render();
  }, delayMs);
}

function cleanup(): void {
  stopLiveRefresh();
  if (deferredRenderTimer !== undefined) window.clearTimeout(deferredRenderTimer);
  browser.storage.onChanged.removeListener(handleStorageChange);
  if (dialogState) {
    window.clearInterval(dialogState.timer);
    if (!dialogState.executing && !dialogState.cancelling) {
      void browser.runtime.sendMessage({
        type: "CANCEL_RECOVERY",
        operationId: dialogState.preparation.operationId
      });
    }
    dialogState = null;
  }
}

function required(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node;
}

function requiredButton(id: string): HTMLButtonElement {
  return required(id) as HTMLButtonElement;
}

function requiredInput(id: string): HTMLInputElement {
  return required(id) as HTMLInputElement;
}

function requiredDialog(id: string): HTMLDialogElement {
  return required(id) as HTMLDialogElement;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
