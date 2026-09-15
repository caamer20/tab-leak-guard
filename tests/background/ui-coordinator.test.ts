import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllExtensionNotifications,
  clearFindingsNotification,
  isFindingsNotification,
  maybeNotify,
  updateBadge
} from "../../src/background/ui-coordinator";
import { NOTIFICATION_COOLDOWN_MS } from "../../src/shared/constants";
import { tabRecord } from "../helpers";
import {
  createFakeWebExtension,
  installFakeBrowser,
  type FakeWebExtension
} from "../fakes/webextension";

const NOW = 1_800_000_000_000;
const FINDINGS_ID = "tab-leak-guard:findings";
let fake: FakeWebExtension;

beforeEach(() => {
  fake = createFakeWebExtension();
  installFakeBrowser(fake);
});

describe("privacy-preserving notifications", () => {
  it("uses generic content by default without disclosing the hostname", async () => {
    const notified = await maybeNotify(tabRecord({ hostname: "private.example" }), NOW, "generic", 1);

    expect(notified).toBe(true);
    const options = fake.calls.notificationCreate.mock.calls[0]?.[1];
    expect(options.message).toContain("A tab shows sustained resource growth");
    expect(JSON.stringify(options)).not.toContain("private.example");
  });

  it("shows a hostname only after the user selects site-level notification content", async () => {
    await maybeNotify(tabRecord({ hostname: "chosen.example" }), NOW, "site", 1);
    expect(fake.calls.notificationCreate.mock.calls[0]?.[1].message).toContain("chosen.example");
  });

  it("aggregates multiple findings into one stable notification without listing sites", async () => {
    await maybeNotify(tabRecord({ hostname: "secret.example" }), NOW, "site", 4);
    const [id, options] = fake.calls.notificationCreate.mock.calls[0] as [string, { message: string }];
    expect(id).toBe(FINDINGS_ID);
    expect(options.message).toContain("4 tabs");
    expect(options.message).not.toContain("secret.example");
    expect(fake.notifications.size).toBe(1);
  });

  it("returns false for an existing aggregate so only the record that creates it is throttled", async () => {
    fake.notifications.set(FINDINGS_ID, { title: "old", message: "old" });
    const recordThatEncounteredTheAggregate = tabRecord();
    expect(await maybeNotify(recordThatEncounteredTheAggregate, NOW, "generic", 2)).toBe(false);
    expect(recordThatEncounteredTheAggregate.notifiedAt).toBeUndefined();
    expect(fake.calls.notificationUpdate).not.toHaveBeenCalled();
    expect(fake.calls.notificationCreate).not.toHaveBeenCalled();

    const recent = tabRecord({ notifiedAt: NOW - NOTIFICATION_COOLDOWN_MS + 1 });
    expect(await maybeNotify(recent, NOW, "generic", 1)).toBe(false);
    expect(fake.calls.notificationUpdate).not.toHaveBeenCalled();

    fake.notifications.delete(FINDINGS_ID);
    expect(await maybeNotify(recordThatEncounteredTheAggregate, NOW, "generic", 1)).toBe(true);
    expect(fake.calls.notificationCreate).toHaveBeenCalledTimes(1);
  });

  it("clears a site-specific notification when a concurrent preference change makes it stale", async () => {
    let current = true;
    let releaseCreate: (() => void) | undefined;
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    fake.calls.notificationCreate.mockImplementationOnce(
      (id: string, options: browser.notifications.NotificationItem) =>
        new Promise<string>((resolve) => {
          signalCreateStarted?.();
          releaseCreate = () => {
            fake.notifications.set(id, structuredClone(options));
            resolve(id);
          };
        })
    );

    const staleSiteNotification = maybeNotify(
      tabRecord({ hostname: "private.example" }),
      NOW,
      "site",
      1,
      () => current
    );
    await createStarted;
    current = false;
    releaseCreate?.();

    expect(await staleSiteNotification).toBe(false);
    expect(fake.calls.notificationClear).toHaveBeenCalledWith(FINDINGS_ID);
    expect(fake.notifications.has(FINDINGS_ID)).toBe(false);

    expect(
      await maybeNotify(
        tabRecord({ hostname: "private.example" }),
        NOW + 1,
        "generic",
        1
      )
    ).toBe(true);
    expect(JSON.stringify(fake.notifications.get(FINDINGS_ID))).not.toContain(
      "private.example"
    );
  });

  it("clears only extension-owned notification identifiers", async () => {
    fake.notifications.set(FINDINGS_ID, { title: "ours", message: "ours" });
    fake.notifications.set("tab-leak-guard:legacy", {
      title: "ours",
      message: "ours"
    });
    fake.notifications.set("another-extension", {
      title: "theirs",
      message: "theirs"
    });
    await clearAllExtensionNotifications();
    expect([...fake.notifications.keys()]).toEqual(["another-extension"]);
    expect(isFindingsNotification(FINDINGS_ID)).toBe(true);
    expect(isFindingsNotification("another-extension")).toBe(false);

    fake.notifications.set(FINDINGS_ID, { title: "ours", message: "ours" });
    await clearFindingsNotification();
    expect(fake.notifications.has(FINDINGS_ID)).toBe(false);
  });
});

describe("badge state", () => {
  it("prioritizes pending recovery over findings and reports protected findings", async () => {
    const pending = tabRecord({ recovery: { status: "awaiting-consent", pendingAt: NOW + 1_000 } });
    const blocked = tabRecord({
      tabId: 2,
      recovery: { status: "blocked", blockedReason: "protected" }
    });
    await updateBadge([pending, blocked], true);
    expect(fake.calls.badgeText).toHaveBeenLastCalledWith({ text: "1" });
    expect(fake.calls.badgeColor).toHaveBeenLastCalledWith({ color: "#7C5CFC" });
    expect(fake.calls.actionTitle.mock.calls.at(-1)?.[0].title).toContain("awaiting confirmation");
  });

  it("retries an identical badge state after a partial browser-action failure", async () => {
    const watching = tabRecord({
      detector: {
        ...tabRecord().detector,
        status: "watching",
        score: 45
      }
    });
    fake.calls.badgeColor.mockRejectedValueOnce(new Error("transient badge color failure"));

    await expect(updateBadge([watching], true)).rejects.toThrow(
      "transient badge color failure"
    );
    expect(fake.calls.badgeText).toHaveBeenCalledTimes(1);
    expect(fake.calls.badgeColor).toHaveBeenCalledTimes(1);
    expect(fake.calls.actionTitle).toHaveBeenCalledTimes(1);

    await expect(updateBadge([watching], true)).resolves.toBeUndefined();
    expect(fake.calls.badgeText).toHaveBeenCalledTimes(2);
    expect(fake.calls.badgeColor).toHaveBeenCalledTimes(2);
    expect(fake.calls.actionTitle).toHaveBeenCalledTimes(2);
  });

  it("serializes a late badge write so it cannot overwrite a newer cleared state", async () => {
    const confirmed = [
      tabRecord({
        tabId: 1,
        detector: { ...tabRecord().detector, status: "confirmed", score: 90 }
      }),
      tabRecord({
        tabId: 2,
        detector: { ...tabRecord().detector, status: "confirmed", score: 91 }
      })
    ];
    let releaseFirstText: (() => void) | undefined;
    let signalFirstTextStarted: (() => void) | undefined;
    const firstTextStarted = new Promise<void>((resolve) => {
      signalFirstTextStarted = resolve;
    });
    fake.calls.badgeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          signalFirstTextStarted?.();
          releaseFirstText = resolve;
        })
    );

    const staleFindingUpdate = updateBadge(confirmed, true);
    await firstTextStarted;
    const clearAfterPause = updateBadge([], false);

    await Promise.resolve();
    expect(fake.calls.badgeText).toHaveBeenCalledTimes(1);
    expect(fake.calls.badgeText).toHaveBeenLastCalledWith({ text: "2" });

    releaseFirstText?.();
    await Promise.all([staleFindingUpdate, clearAfterPause]);

    expect(fake.calls.badgeText).toHaveBeenCalledTimes(2);
    expect(fake.calls.badgeText).toHaveBeenLastCalledWith({ text: "" });
    expect(fake.calls.actionTitle.mock.calls.at(-1)?.[0].title).toBe(
      "Tab Leak Guard — monitoring paused"
    );
  });
});
