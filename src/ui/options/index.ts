import { MONITORED_ORIGINS } from "../../shared/constants";
import { permissionGrantCoversOrigin } from "../../shared/permission-pattern";
import type {
  ExtensionSnapshot,
  HistoryRetentionHours,
  Preferences,
  ResetReceipt,
  SitePolicy
} from "../../shared/types";
import {
  element,
  formatRelativeTime,
  getSnapshot,
  localizeDocument,
  requestContinuousPermission,
  sendCommand,
  showMessage,
  t
} from "../client";

const message = required("message");
const deleteDialog = requiredDialog("delete-dialog");
const controls = {
  monitoring: requiredInput("monitoring-enabled"),
  notifications: requiredInput("notifications-enabled"),
  notificationContent: requiredSelect("notification-content"),
  historyRetention: requiredSelect("history-retention"),
  visible: requiredInput("visible-seconds"),
  hidden: requiredInput("hidden-seconds"),
  quiet: requiredInput("quiet-minutes"),
  score: requiredInput("confirmation-score")
};

let latestSnapshot: ExtensionSnapshot | null = null;
let deleteReturnFocus: HTMLElement | null = null;
let firefoxGrantedOrigins: string[] = [];

localizeDocument();
required("grant-access").addEventListener("click", () => void grantAccess());
required("remove-access").addEventListener("click", () => void removeAccess());
required("save").addEventListener("click", () => void save());
required("clear-receipts").addEventListener("click", () => void clearReceipts());
required("export-diagnostics").addEventListener("click", () => void exportDiagnostics());
required("delete-all-data").addEventListener("click", openDeleteDialog);
required("delete-cancel").addEventListener("click", closeDeleteDialog);
required("delete-confirm").addEventListener("click", () => void deleteAllData());
required("selected-origin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void addSelectedOrigin();
});
requiredInput("delete-ack").addEventListener("change", updateDeleteButton);
deleteDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDeleteDialog();
});
deleteDialog.addEventListener("keydown", trapDeleteDialogFocus);
for (const control of [controls.visible, controls.hidden, controls.quiet, controls.score]) {
  control.addEventListener("input", updateOutputs);
}

void render();

async function render(): Promise<void> {
  try {
    const [snapshot, granted] = await Promise.all([getSnapshot(), browser.permissions.getAll()]);
    latestSnapshot = snapshot;
    firefoxGrantedOrigins = (granted.origins ?? []).filter(isWebsiteOriginPermission);
    populate(snapshot, actualPermissionScope(firefoxGrantedOrigins));
  } catch (error) {
    showMessage(message, errorText(error));
  }
}

function populate(
  snapshot: ExtensionSnapshot,
  storedPermissionScope: ExtensionSnapshot["permissionScope"]
): void {
  const { preferences } = snapshot;
  controls.monitoring.checked = preferences.monitoringIntent === "continuous";
  controls.notifications.checked = preferences.notificationsEnabled;
  controls.notificationContent.value = preferences.notificationContent;
  controls.historyRetention.value = String(preferences.historyRetentionHours);
  controls.visible.value = String(preferences.sampleVisibleSeconds);
  controls.hidden.value = String(preferences.sampleHiddenSeconds);
  controls.quiet.value = String(preferences.quietPeriodMinutes);
  controls.score.value = String(preferences.confirmationScore);

  const permission = required("permission-state");
  permission.textContent = permissionStateLabel(storedPermissionScope);
  permission.className = `status-pill ${storedPermissionScope === "none" ? "status-watching" : "status-healthy"}`;
  required("permission-detail").textContent = permissionDetail(snapshot, storedPermissionScope);
  required("grant-access").toggleAttribute(
    "hidden",
    storedPermissionScope === "all-sites" && snapshot.preferences.monitoringIntent === "continuous"
  );
  required("remove-access").toggleAttribute("hidden", storedPermissionScope === "none");
  renderIgnored(preferences.ignoredHosts);
  renderPolicies(preferences.sitePolicies);
  renderSelectedOrigins(preferences.selectedOrigins, storedPermissionScope);
  renderReceipts(snapshot.receipts);
  updateOutputs();
}

function renderSelectedOrigins(
  origins: string[],
  storedPermissionScope: ExtensionSnapshot["permissionScope"]
): void {
  const list = required("selected-origin-list");
  const input = requiredInput("selected-origin");
  const add = requiredButton("add-selected-origin");
  const guidance = required("selected-origin-guidance");
  const allSiteAccess = storedPermissionScope === "all-sites";
  input.disabled = allSiteAccess;
  add.disabled = allSiteAccess;
  guidance.textContent = allSiteAccess
    ? t("removeAllSiteBeforeSelected")
    : t("selectedSitePrivacyGuidance");
  list.replaceChildren();
  if (origins.length === 0) {
    list.append(element("p", "tiny", t("noSelectedSites")));
    return;
  }
  for (const origin of origins) {
    const row = element("div", "list-row");
    row.append(element("strong", undefined, displayOrigin(origin)));
    const remove = element("button", "quiet", t("removeSelectedSite"));
    remove.type = "button";
    remove.dataset.origin = origin;
    remove.setAttribute("aria-label", t("removeSelectedSiteNamed", displayOrigin(origin)));
    remove.addEventListener("click", () => void removeSelectedOrigin(origin, remove));
    row.append(remove);
    list.append(row);
  }
}

async function addSelectedOrigin(): Promise<void> {
  const input = requiredInput("selected-origin");
  const origin = normalizeOriginInput(input.value);
  if (!origin) {
    showMessage(message, t("invalidSiteAddress"));
    input.focus();
    return;
  }
  const button = requiredButton("add-selected-origin");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const granted = await browser.permissions.request({ origins: [origin] });
    if (!granted) throw new Error(t("selectedSitePermissionDenied"));
    const current = latestSnapshot?.preferences.selectedOrigins ?? [];
    await sendCommand({
      type: "UPDATE_PREFERENCES",
      patch: {
        selectedOrigins: [...new Set([...current, origin])].sort(),
        permissionMode: "selected-sites",
        monitoringIntent: "continuous",
        monitoringEnabled: true
      }
    });
    input.value = "";
    showMessage(message, t("selectedSiteAdded", displayOrigin(origin)), "success");
    await render();
    input.focus();
  } catch (error) {
    showMessage(message, errorText(error));
  } finally {
    button.removeAttribute("aria-busy");
    if (latestSnapshot?.permissionScope !== "all-sites") button.disabled = false;
  }
}

async function removeSelectedOrigin(origin: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const current = latestSnapshot?.preferences.selectedOrigins ?? [];
    const next = current.filter((candidate) => candidate !== origin);
    await browser.permissions.remove({ origins: [origin] });
    const grantedAfterRemoval = await browser.permissions.getAll();
    if (
      (grantedAfterRemoval.origins ?? []).some((granted) =>
        permissionGrantCoversOrigin(granted, origin)
      )
    ) {
      throw new Error(t("selectedSitePermissionStillGranted", displayOrigin(origin)));
    }
    await sendCommand({
      type: "UPDATE_PREFERENCES",
      patch: {
        selectedOrigins: next,
        permissionMode: next.length > 0 ? "selected-sites" : "manual",
        monitoringIntent: next.length > 0 ? "continuous" : "manual",
        monitoringEnabled: next.length > 0
      }
    });
    await sendCommand({ type: "SYNC_PERMISSION" });
    const finalPermissions = await browser.permissions.getAll();
    if (
      (finalPermissions.origins ?? []).some((granted) =>
        permissionGrantCoversOrigin(granted, origin)
      )
    ) {
      throw new Error(t("selectedSitePermissionStillGranted", displayOrigin(origin)));
    }
    showMessage(message, t("selectedSiteRemoved", displayOrigin(origin)), "success");
    await render();
  } catch (error) {
    showMessage(message, errorText(error));
    button.disabled = false;
  }
}

async function grantAccess(): Promise<void> {
  setBusy("grant-access", true);
  try {
    if (!(await requestContinuousPermission())) throw new Error(t("errorWebsiteAccessNotGranted"));
    await sendCommand({
      type: "UPDATE_PREFERENCES",
      patch: { monitoringEnabled: true, monitoringIntent: "continuous", permissionMode: "all-sites" }
    });
    showMessage(message, t("continuousMonitoringEnabled"), "success");
    await render();
  } catch (error) {
    showMessage(message, errorText(error));
  } finally {
    setBusy("grant-access", false);
  }
}

async function removeAccess(): Promise<void> {
  setBusy("remove-access", true);
  try {
    await sendCommand({
      type: "UPDATE_PREFERENCES",
      patch: { monitoringEnabled: false, monitoringIntent: "manual", permissionMode: "manual" }
    });
    const selected = latestSnapshot?.preferences.selectedOrigins ?? [];
    await browser.permissions.remove({
      origins: [...new Set([...MONITORED_ORIGINS, ...selected, ...firefoxGrantedOrigins])]
    });
    await sendCommand({ type: "SYNC_PERMISSION" });
    const granted = await browser.permissions.getAll();
    const remainingWebsiteOrigins = (granted.origins ?? []).filter(isWebsiteOriginPermission);
    if (remainingWebsiteOrigins.length > 0) {
      throw new Error(t("websitePermissionStillGranted"));
    }
    showMessage(message, t("websiteAccessRemoved"), "success");
    await render();
  } catch (error) {
    showMessage(message, errorText(error));
  } finally {
    setBusy("remove-access", false);
  }
}

async function save(): Promise<void> {
  const wantsContinuous = controls.monitoring.checked;
  const retention = Number(controls.historyRetention.value);
  const historyRetentionHours: HistoryRetentionHours = retention === 0 || retention === 168 ? retention : 24;
  const patch: Partial<Preferences> = {
    monitoringEnabled: wantsContinuous && (latestSnapshot?.permissionScope ?? "none") !== "none",
    monitoringIntent: wantsContinuous ? "continuous" : "manual",
    recoveryMode: "notify",
    notificationsEnabled: controls.notifications.checked,
    notificationContent: controls.notificationContent.value === "site" ? "site" : "generic",
    historyRetentionHours,
    sampleVisibleSeconds: Number(controls.visible.value),
    sampleHiddenSeconds: Number(controls.hidden.value),
    quietPeriodMinutes: Number(controls.quiet.value),
    confirmationScore: Number(controls.score.value)
  };
  setBusy("save", true);
  try {
    await sendCommand({ type: "UPDATE_PREFERENCES", patch });
    showMessage(
      message,
      wantsContinuous && latestSnapshot?.permissionScope === "none"
        ? t("settingsSavedPermissionNeeded")
        : t("settingsSaved"),
      "success"
    );
    await render();
  } catch (error) {
    showMessage(message, errorText(error));
  } finally {
    setBusy("save", false);
  }
}

function renderIgnored(hosts: string[]): void {
  const list = required("ignored-list");
  const focusHost = (document.activeElement as HTMLElement | null)?.dataset.host;
  list.replaceChildren();
  required("ignored-count").textContent = String(hosts.length);
  if (hosts.length === 0) {
    list.append(element("p", "tiny", t("noIgnoredSites")));
    return;
  }
  for (const host of hosts) {
    const row = element("div", "list-row");
    row.append(element("strong", undefined, host));
    const button = element("button", "quiet", t("monitorAgain"));
    button.type = "button";
    button.dataset.host = host;
    button.setAttribute("aria-label", t("monitorSiteAgain", host));
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await sendCommand({ type: "UNIGNORE_HOST", hostname: host });
        showMessage(message, t("siteMonitoringRestored", host), "success");
        await render();
      } catch (error) {
        showMessage(message, errorText(error));
        button.disabled = false;
      }
    });
    row.append(button);
    list.append(row);
  }
  if (focusHost) {
    [...list.querySelectorAll<HTMLElement>("[data-host]")]
      .find((node) => node.dataset.host === focusHost)?.focus({ preventScroll: true });
  }
}

function renderPolicies(policies: SitePolicy[]): void {
  const list = required("policy-list");
  list.replaceChildren();
  if (policies.length === 0) {
    list.append(element("p", "tiny", t("noSiteOverrides")));
    return;
  }
  for (const policy of policies) {
    const row = element("div", "list-row policy-row");
    const text = element("div");
    text.append(
      element("strong", undefined, policy.hostname),
      element("span", "tiny", sitePolicySummary(policy))
    );
    const button = element("button", "quiet", t("useGlobalDefaults"));
    button.type = "button";
    button.setAttribute("aria-label", t("useGlobalDefaultsForSite", policy.hostname));
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const current = latestSnapshot?.preferences.sitePolicies ?? [];
        await sendCommand({
          type: "UPDATE_PREFERENCES",
          patch: { sitePolicies: current.filter((candidate) => candidate.hostname !== policy.hostname) }
        });
        showMessage(message, t("siteDefaultsRestored", policy.hostname), "success");
        await render();
      } catch (error) {
        showMessage(message, errorText(error));
        button.disabled = false;
      }
    });
    row.append(text, button);
    list.append(row);
  }
}

function renderReceipts(receipts: ResetReceipt[]): void {
  const list = required("receipt-list");
  list.replaceChildren();
  if (receipts.length === 0) {
    list.append(element("p", "tiny", t("noRecoveryActions")));
    return;
  }
  for (const receipt of receipts.slice(0, 20)) {
    const row = element("div", "list-row");
    const text = element("div");
    const action = receipt.action === "discard" ? t("actionUnloaded") : t("actionReloaded");
    text.append(
      element("strong", `receipt-${receipt.outcome}`, t("receiptActionOutcome", [action, receiptOutcome(receipt.outcome)])),
      element("span", "tiny", t("receiptSiteTime", [receipt.hostname, formatRelativeTime(receipt.occurredAt)])),
      element("p", "tiny", receiptPhase(receipt.phase))
    );
    row.append(text);
    list.append(row);
  }
}

async function clearReceipts(): Promise<void> {
  setBusy("clear-receipts", true);
  try {
    await sendCommand({ type: "CLEAR_RECEIPTS" });
    showMessage(message, t("receiptsCleared"), "success");
    await render();
  } catch (error) {
    showMessage(message, errorText(error));
  } finally {
    setBusy("clear-receipts", false);
  }
}

async function exportDiagnostics(): Promise<void> {
  setBusy("export-diagnostics", true);
  try {
    const diagnostics = await sendCommand<Record<string, unknown>>({ type: "EXPORT_DIAGNOSTICS" });
    const blob = new Blob([`${JSON.stringify(diagnostics, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tab-leak-guard-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showMessage(message, t("diagnosticsExported"), "success");
  } catch (error) {
    showMessage(message, errorText(error));
  } finally {
    setBusy("export-diagnostics", false);
  }
}

function openDeleteDialog(): void {
  deleteReturnFocus = document.activeElement as HTMLElement | null;
  requiredInput("delete-ack").checked = false;
  updateDeleteButton();
  deleteDialog.showModal();
  required("delete-dialog-title").focus();
}

function closeDeleteDialog(): void {
  if (deleteDialog.open) deleteDialog.close();
  deleteReturnFocus?.focus({ preventScroll: true });
  deleteReturnFocus = null;
}

function updateDeleteButton(): void {
  requiredButton("delete-confirm").disabled = !requiredInput("delete-ack").checked;
}

async function deleteAllData(): Promise<void> {
  if (!requiredInput("delete-ack").checked) return;
  const button = requiredButton("delete-confirm");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await sendCommand({ type: "DELETE_ALL_DATA" });
    closeDeleteDialog();
    showMessage(message, t("allLocalDataDeleted"), "success", { autoHide: false });
    await render();
  } catch (error) {
    closeDeleteDialog();
    showMessage(message, errorText(error));
  } finally {
    button.removeAttribute("aria-busy");
    updateDeleteButton();
  }
}

function trapDeleteDialogFocus(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    const target = event.target as HTMLElement;
    const confirm = requiredButton("delete-confirm");
    if (!(target instanceof HTMLButtonElement) || (target === confirm && confirm.disabled)) {
      event.preventDefault();
    }
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...deleteDialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === required("delete-dialog-title"))
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function updateOutputs(): void {
  const seconds = (value: string) => t("secondsValue", value);
  const minutes = (value: string) => t("minutesValue", value);
  required("visible-output").textContent = seconds(controls.visible.value);
  required("hidden-output").textContent = seconds(controls.hidden.value);
  required("quiet-output").textContent = minutes(controls.quiet.value);
  required("score-output").textContent = t("scoreValue", controls.score.value);
  controls.visible.setAttribute("aria-valuetext", seconds(controls.visible.value));
  controls.hidden.setAttribute("aria-valuetext", seconds(controls.hidden.value));
  controls.quiet.setAttribute("aria-valuetext", minutes(controls.quiet.value));
  controls.score.setAttribute("aria-valuetext", t("scoreValue", controls.score.value));
}

function permissionStateLabel(scope: ExtensionSnapshot["permissionScope"]): string {
  if (scope === "all-sites") return t("allSiteAccessGranted");
  if (scope === "selected-sites") return t("selectedSiteAccessGranted");
  return t("websiteAccessNotGranted");
}

function permissionDetail(
  snapshot: ExtensionSnapshot,
  storedPermissionScope: ExtensionSnapshot["permissionScope"]
): string {
  if (storedPermissionScope !== "none" && snapshot.permissionScope === "none") {
    return t("permissionStoredManualDescription");
  }
  if (snapshot.permissionScope === "all-sites") return t("allSiteScopeDescription");
  if (snapshot.permissionScope === "selected-sites") {
    const count = snapshot.preferences.selectedOrigins.length || firefoxGrantedOrigins.length;
    return t(count === 1 ? "oneSelectedSiteScopeDescription" : "selectedSiteScopeDescription", String(count));
  }
  return t("manualScopeDescription");
}

function actualPermissionScope(origins: string[]): ExtensionSnapshot["permissionScope"] {
  if (origins.length === 0) return "none";
  if (origins.includes("<all_urls>") || origins.includes("*://*/*")) return "all-sites";
  const allSitePatterns = new Set(MONITORED_ORIGINS);
  return [...allSitePatterns].every((pattern) => origins.includes(pattern)) ? "all-sites" : "selected-sites";
}

function isWebsiteOriginPermission(origin: string): boolean {
  return origin === "<all_urls>" || /^(?:https?|\*):\/\//.test(origin);
}

function normalizeOriginInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return null;
  try {
    const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const authority = /^https?:\/\/([^/]+)/i.exec(candidate)?.[1];
    if (!authority || authority.includes(":")) return null;
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      parsed.hostname.includes("*")
    ) return null;
    return `${parsed.protocol}//${parsed.host.toLowerCase()}/*`;
  } catch {
    return null;
  }
}

function displayOrigin(origin: string): string {
  try {
    const parsed = new URL(origin.replace(/\/\*$/, "/"));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return origin;
  }
}

function sitePolicySummary(policy: SitePolicy): string {
  const monitoring = t({ inherit: "policyDefaultMonitoring", off: "policyMonitoringOff", monitor: "policyMonitoringOn" }[policy.monitoring]);
  const notifications = t({ inherit: "policyDefaultNotifications", off: "policyNotificationsOff", on: "policyNotificationsOn" }[policy.notifications]);
  const recovery = t({ inherit: "policyDefaultRecovery", never: "policyRecoveryNever", allow: "policyRecoveryAllowFuture" }[policy.automaticRecovery]);
  return t("policySummary", [monitoring, notifications, recovery]);
}

function receiptOutcome(outcome: ResetReceipt["outcome"]): string {
  return t({
    success: "outcomeSuccess",
    blocked: "outcomeBlocked",
    failed: "outcomeFailed",
    cancelled: "outcomeCancelled",
    expired: "outcomeExpired",
    unknown: "outcomeUnknown"
  }[outcome]);
}

function receiptPhase(phase: ResetReceipt["phase"]): string {
  if (!phase) return t("phaseRecorded");
  return t({
    cancelled: "phaseCancelled",
    expired: "phaseExpired",
    blocked: "phaseBlocked",
    "request-failed": "phaseRequestFailed",
    requested: "phaseRequested",
    completed: "phaseCompleted",
    "verification-timed-out": "phaseVerificationTimedOut"
  }[phase]);
}

function setBusy(id: string, busy: boolean): void {
  const button = requiredButton(id);
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function required(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node;
}

function requiredButton(id: string): HTMLButtonElement { return required(id) as HTMLButtonElement; }
function requiredInput(id: string): HTMLInputElement { return required(id) as HTMLInputElement; }
function requiredSelect(id: string): HTMLSelectElement { return required(id) as HTMLSelectElement; }
function requiredDialog(id: string): HTMLDialogElement { return required(id) as HTMLDialogElement; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
