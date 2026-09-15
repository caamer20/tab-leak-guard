import { COLLECTOR_SCRIPT_ID, COLLECTOR_SCRIPT_PATH, MONITORED_ORIGINS } from "../shared/constants";
import { permissionGrantCoversOrigin } from "../shared/permission-pattern";
import type { PermissionMode, Preferences } from "../shared/types";
import { inspectUrl } from "../shared/url-policy";

export type EffectivePermissionScope = "none" | "selected-sites" | "all-sites";
const BROWSER_COORDINATION_TIMEOUT_MS = 2_000;
let registrationQueue: Promise<void> = Promise.resolve();
let registrationRevision = 0;
let reconciliationScheduled = false;
let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
let reconciliationFailureCount = 0;
let latestRegistrationRequest: {
  preferences: Preferences | boolean;
  isCurrent: () => boolean;
  revision: number;
} | null = null;

export async function grantedOriginsFor(preferences?: Preferences): Promise<string[]> {
  const desired = desiredOrigins(preferences);
  if (desired.length === 0) return [];
  const permissions = await withCoordinatorTimeout(
    browser.permissions.getAll(),
    "Permission lookup timed out"
  );
  const grantedPatterns = (permissions.origins ?? []).filter(
    (origin): origin is string => typeof origin === "string"
  );
  return desired.filter((origin) =>
    grantedPatterns.some((grantedPattern) => permissionGrantCoversOrigin(grantedPattern, origin))
  );
}

export async function hasContinuousPermission(preferences?: Preferences): Promise<boolean> {
  return (await grantedOriginsFor(preferences)).length > 0;
}

export async function effectivePermissionScope(
  preferences: Preferences
): Promise<EffectivePermissionScope> {
  const granted = await grantedOriginsFor(preferences);
  if (granted.length === 0) return "none";
  return preferences.permissionMode === "all-sites" && granted.length === MONITORED_ORIGINS.length
    ? "all-sites"
    : "selected-sites";
}

export function syncCollectorRegistration(
  preferences: Preferences | boolean,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const revision = ++registrationRevision;
  latestRegistrationRequest = { preferences, isCurrent, revision };
  const requestIsCurrent = () =>
    revision === registrationRevision && isCurrent();
  const next = registrationQueue
    .catch(() => undefined)
    .then(async () => {
      const fullyReconciled = await performCollectorRegistrationSync(
        preferences,
        requestIsCurrent
      );
      if (!requestIsCurrent()) return;
      if (fullyReconciled) markRegistrationHealthy(revision);
      else scheduleLatestRegistrationReconciliation();
    });
  registrationQueue = next.then(
    () => undefined,
    () => undefined
  );
  void next.catch(() => scheduleLatestRegistrationReconciliation());
  return next;
}

async function performCollectorRegistrationSync(
  preferences: Preferences | boolean,
  isCurrent: () => boolean
): Promise<boolean> {
  if (!isCurrent()) return true;
  const normalized = normalizeRegistrationPreferences(preferences);
  const scripting = browser.scripting;
  const existing = await withCoordinatorTimeout(
    scripting.getRegisteredContentScripts({ ids: [COLLECTOR_SCRIPT_ID] }),
    "Collector registration lookup timed out"
  );
  if (!isCurrent()) return true;
  const matches = normalized.monitoringEnabled ? await grantedOriginsFor(normalized) : [];
  if (!isCurrent()) return true;
  const shouldRegister =
    normalized.monitoringEnabled && normalized.monitoringIntent === "continuous" && matches.length > 0;
  const registeredMatches = [...(existing[0]?.matches ?? [])].sort();
  const matchesChanged = registeredMatches.join("\n") !== [...matches].sort().join("\n");

  if (existing.length > 0 && (!shouldRegister || matchesChanged)) {
    const unregistration = scripting.unregisterContentScripts({ ids: [COLLECTOR_SCRIPT_ID] });
    reconcileAfterLateMutation(unregistration, isCurrent);
    await withCoordinatorTimeout(unregistration, "Collector unregister timed out");
    if (!isCurrent()) return true;
  }
  if (shouldRegister && (existing.length === 0 || matchesChanged)) {
    if (!isCurrent()) return true;
    const registration = scripting.registerContentScripts([
      {
        id: COLLECTOR_SCRIPT_ID,
        matches,
        js: [COLLECTOR_SCRIPT_PATH],
        allFrames: false,
        runAt: "document_start",
        persistAcrossSessions: true
      }
    ]);
    reconcileAfterLateMutation(registration, isCurrent);
    try {
      await withCoordinatorTimeout(registration, "Collector registration timed out");
    } catch (error) {
      throw error;
    }
    if (!isCurrent()) {
      scheduleLatestRegistrationReconciliation();
      return true;
    }
  }

  // Registration persistence does not prove that every already-loaded eligible
  // document has a live isolated-world collector, so reconcile idempotently.
  return shouldRegister && isCurrent()
    ? injectIntoEligibleTabs(matches, isCurrent)
    : true;
}

export async function injectIntoEligibleTabs(
  grantedOrigins?: readonly string[],
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  if (!isCurrent()) return true;
  const tabs = await withCoordinatorTimeout(
    browser.tabs.query({}),
    "Eligible-tab lookup timed out"
  );
  if (!isCurrent()) return true;
  const eligible = tabs.filter((tab) => {
    if (tab.id === undefined || tab.discarded) return false;
    const support = inspectUrl(tab.url);
    return support.supported && (!grantedOrigins || originMatches(tab.url, grantedOrigins));
  });
  return runBounded(eligible, 8, async (tab) => {
    if (!isCurrent()) return;
    await injectCollector(tab.id as number);
  });
}

export async function injectCollector(tabId: number): Promise<void> {
  await withCoordinatorTimeout(
    browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: [COLLECTOR_SCRIPT_PATH]
    }),
    "Collector injection timed out"
  );
}

export async function unregisterCollectorRegistrationNow(): Promise<void> {
  const revision = ++registrationRevision;
  latestRegistrationRequest = { preferences: false, isCurrent: () => true, revision };
  const unregistration = browser.scripting.unregisterContentScripts({
    ids: [COLLECTOR_SCRIPT_ID]
  });
  reconcileAfterLateMutation(
    unregistration,
    () => revision === registrationRevision
  );
  await withCoordinatorTimeout(unregistration, "Collector unregister timed out").catch(
    () => {
      scheduleLatestRegistrationReconciliation();
    }
  );
}

function desiredOrigins(preferences?: Preferences): string[] {
  if (!preferences || preferences.permissionMode === "all-sites") return [...MONITORED_ORIGINS];
  if (preferences.permissionMode === "selected-sites") return [...preferences.selectedOrigins];
  return [];
}

function normalizeRegistrationPreferences(value: Preferences | boolean): Preferences {
  if (typeof value !== "boolean") return value;
  return {
    monitoringEnabled: value,
    monitoringIntent: value ? "continuous" : "paused",
    permissionMode: "all-sites",
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
}

function originMatches(url: string | undefined, origins: readonly string[]): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const exact = `${parsed.protocol}//${parsed.hostname}/*`;
    return origins.includes(exact) || origins.includes(`${parsed.protocol}//*/*`);
  } catch {
    return false;
  }
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<boolean> {
  let cursor = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const value = values[cursor++];
      if (value === undefined) continue;
      try {
        await task(value);
      } catch (error) {
        // Keep processing the rest of the batch, but surface the failure so the
        // latest-revision reconciliation loop requeries open tabs and retries.
        // Tabs that closed, navigated to a restricted URL, or became discarded
        // naturally disappear from that next eligible set.
        failed = true;
      }
    }
  });
  await Promise.all(workers);
  return !failed;
}

export function desiredPermissionMode(preferences: Preferences): PermissionMode {
  return preferences.permissionMode;
}

async function withCoordinatorTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), BROWSER_COORDINATION_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reconcileAfterLateMutation(
  mutation: Promise<unknown>,
  isCurrent: () => boolean
): void {
  void mutation.then(
    () => {
      if (!isCurrent()) scheduleLatestRegistrationReconciliation();
    },
    () => scheduleLatestRegistrationReconciliation()
  );
}

function scheduleLatestRegistrationReconciliation(): void {
  if (reconciliationScheduled) return;
  reconciliationScheduled = true;
  reconciliationFailureCount = Math.min(8, reconciliationFailureCount + 1);
  const delayMs = Math.min(30_000, 250 * 2 ** (reconciliationFailureCount - 1));
  reconciliationTimer = setTimeout(() => {
    reconciliationScheduled = false;
    reconciliationTimer = undefined;
    const next = registrationQueue.catch(() => undefined).then(async () => {
      const latest = latestRegistrationRequest;
      if (!latest) return;
      const isCurrent = () =>
        latest.revision === registrationRevision && latest.isCurrent();
      try {
        const fullyReconciled = await performCollectorRegistrationSync(
          latest.preferences,
          isCurrent
        );
        if (!isCurrent()) return;
        if (fullyReconciled) markRegistrationHealthy(latest.revision);
        else scheduleLatestRegistrationReconciliation();
      } catch {
        if (isCurrent()) scheduleLatestRegistrationReconciliation();
      }
    });
    registrationQueue = next.then(
      () => undefined,
      () => undefined
    );
  }, delayMs);
}

function markRegistrationHealthy(revision: number): void {
  if (revision !== registrationRevision) return;
  reconciliationFailureCount = 0;
  if (reconciliationTimer !== undefined) clearTimeout(reconciliationTimer);
  reconciliationTimer = undefined;
  reconciliationScheduled = false;
}
