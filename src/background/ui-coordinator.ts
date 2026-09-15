import { NOTIFICATION_COOLDOWN_MS } from "../shared/constants";
import type { NotificationContent, TabRecord } from "../shared/types";

const FINDINGS_NOTIFICATION_ID = "tab-leak-guard:findings";
let lastBadgeSignature = "";
let badgeQueue: Promise<void> = Promise.resolve();
let notificationQueue: Promise<void> = Promise.resolve();

function withNotificationMutation<T>(task: () => Promise<T>): Promise<T> {
  const next = notificationQueue.catch(() => undefined).then(task);
  notificationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export function updateBadge(
  records: Iterable<TabRecord>,
  monitoringEnabled: boolean
): Promise<void> {
  const all = [...records];
  const confirmed = all.filter((record) => record.detector.status === "confirmed");
  const concerning = all.filter(
    (record) => record.detector.status === "suspected" || record.detector.status === "watching"
  );
  const pending = all.filter(
    (record) => record.recovery.status === "awaiting-consent" && record.recovery.pendingAt
  );
  const blocked = all.filter(
    (record) => record.detector.status === "confirmed" &&
      (record.recovery.status === "blocked" ||
        record.recovery.status === "failed" ||
        record.recovery.status === "suppressed")
  );

  let text = "";
  let color = "#D88A12";
  let title = "Tab Leak Guard — tabs look stable";
  if (pending.length > 0) {
    text = String(Math.min(99, pending.length));
    color = "#7C5CFC";
    title = `Tab Leak Guard — ${pending.length} recovery action${pending.length === 1 ? "" : "s"} awaiting confirmation`;
  } else if (confirmed.length > 0) {
    text = String(Math.min(99, confirmed.length));
    color = "#E5484D";
    title = `Tab Leak Guard — ${confirmed.length} high-confidence tab${confirmed.length === 1 ? "" : "s"}${
      blocked.length ? `, ${blocked.length} protected` : ""
    }`;
  } else if (concerning.length > 0) {
    text = String(Math.min(99, concerning.length));
    title = `Tab Leak Guard — watching ${concerning.length} tab${concerning.length === 1 ? "" : "s"}`;
  } else if (!monitoringEnabled) {
    title = all.length
      ? "Tab Leak Guard — monitoring paused; showing earlier local results"
      : "Tab Leak Guard — monitoring paused";
  }

  const signature = JSON.stringify([text, color, title]);
  const next = badgeQueue.catch(() => undefined).then(async () => {
    if (signature === lastBadgeSignature) return;
    // Do not time out browser-chrome mutations: a timed-out underlying call
    // can still settle late and overwrite a newer clear/update. Wait until all
    // three calls settle before releasing the serialized queue, then surface
    // any failure so the signature remains retryable.
    const results = await Promise.allSettled([
      browser.action.setBadgeText({ text }),
      browser.action.setBadgeBackgroundColor({ color }),
      browser.action.setTitle({ title })
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
    // Commit the deduplication marker only after every browser UI call
    // succeeds; a partial/transient failure is retried by the next update.
    lastBadgeSignature = signature;
  });
  badgeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export async function maybeNotify(
  record: TabRecord,
  now: number,
  notificationContent: NotificationContent,
  confirmedCount: number,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  return withNotificationMutation(async () => {
    if (!isCurrent()) return false;
    if (record.notifiedAt && now - record.notifiedAt < NOTIFICATION_COOLDOWN_MS) return false;
    const site = notificationContent === "site" ? ` on ${record.hostname}` : "";
    const countMessage =
      confirmedCount > 1
        ? `${confirmedCount} tabs show sustained resource growth. Open Tab Leak Guard for details.`
        : `A tab${site} shows sustained resource growth. Open Tab Leak Guard for evidence and safe actions.`;
    const options: browser.notifications.CreateNotificationOptions = {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon-96.png"),
      title: "Possible runaway tab growth",
      message: countMessage
    };
    // Firefox does not implement notifications.update. Reuse one stable ID and
    // leave an existing aggregate visible so a burst cannot create OS-level spam.
    // Notification mutations are deliberately not timed out. Delete-all and
    // preference changes serialize behind this queue, so they never report
    // success while a late Firefox notification request could still publish
    // stale site information.
    const existing = await browser.notifications.getAll();
    if (!isCurrent()) return false;
    if (FINDINGS_NOTIFICATION_ID in existing) return false;
    await browser.notifications.create(FINDINGS_NOTIFICATION_ID, options);
    // Preference/site-policy invalidation can happen while Firefox is
    // creating the OS notification. Compensate before releasing the queue.
    if (!isCurrent()) {
      await browser.notifications.clear(FINDINGS_NOTIFICATION_ID).catch(() => false);
      return false;
    }
    return true;
  });
}

export function isFindingsNotification(id: string): boolean {
  return id === FINDINGS_NOTIFICATION_ID;
}

export function clearFindingsNotification(): Promise<void> {
  return withNotificationMutation(async () => {
    await browser.notifications.clear(FINDINGS_NOTIFICATION_ID);
  });
}

export function clearAllExtensionNotifications(): Promise<void> {
  return withNotificationMutation(async () => {
    const notifications = await browser.notifications.getAll();
    await Promise.all(
      Object.keys(notifications)
        .filter((id) => id.startsWith("tab-leak-guard:"))
        .map((id) => browser.notifications.clear(id))
    );
  });
}
