import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectivePermissionScope,
  grantedOriginsFor,
  hasContinuousPermission,
  injectIntoEligibleTabs,
  desiredPermissionMode,
  syncCollectorRegistration,
  unregisterCollectorRegistrationNow
} from "../../src/background/permission-coordinator";
import {
  COLLECTOR_SCRIPT_ID,
  COLLECTOR_SCRIPT_PATH,
  MONITORED_ORIGINS
} from "../../src/shared/constants";
import { DEFAULT_PREFERENCES, type Preferences } from "../../src/shared/types";
import {
  createFakeWebExtension,
  installFakeBrowser,
  makeTab,
  makeWindow,
  type FakeWebExtension
} from "../fakes/webextension";

let fake: FakeWebExtension;

beforeEach(() => {
  fake = createFakeWebExtension({
    tabs: [
      makeTab({ id: 1, url: "https://allowed.test/page" }),
      makeTab({ id: 2, url: "https://other.test/page" }),
      makeTab({ id: 3, url: "about:config" }),
      makeTab({ id: 4, url: "https://allowed.test/sleeping", discarded: true }),
      makeTab({ id: 5, url: "https://addons.mozilla.org/en-US/firefox/extensions/" })
    ],
    windows: [makeWindow()]
  });
  installFakeBrowser(fake);
});

afterEach(() => {
  vi.useRealTimers();
});

function preferences(overrides: Partial<Preferences> = {}): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    monitoringEnabled: true,
    monitoringIntent: "continuous",
    ...overrides
  };
}

describe("permission-scoped collector registration", () => {
  it("registers all-sites access at document_start and reconciles existing eligible tabs", async () => {
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    const value = preferences({ permissionMode: "all-sites" });

    await syncCollectorRegistration(value);

    expect(fake.calls.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: COLLECTOR_SCRIPT_ID,
        matches: [...MONITORED_ORIGINS],
        js: [COLLECTOR_SCRIPT_PATH],
        allFrames: false,
        runAt: "document_start",
        persistAcrossSessions: true
      })
    ]);
    expect(
      fake.calls.executeScript.mock.calls
        .filter((call) => "files" in call[0])
        .map((call) => call[0].target.tabId)
        .sort()
    ).toEqual([1, 2]);
    expect(fake.calls.executeScript).not.toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ tabId: 5 }) })
    );
    expect(await effectivePermissionScope(value)).toBe("all-sites");
  });

  it("registers and injects only granted selected origins", async () => {
    const selected = ["https://allowed.test/*", "https://not-granted.test/*"];
    fake.grantedOrigins.add(selected[0] as string);
    const value = preferences({ permissionMode: "selected-sites", selectedOrigins: selected });

    expect(await grantedOriginsFor(value)).toEqual(["https://allowed.test/*"]);
    expect(await hasContinuousPermission(value)).toBe(true);
    expect(await effectivePermissionScope(value)).toBe("selected-sites");
    await syncCollectorRegistration(value);

    expect(fake.registeredScripts.get(COLLECTOR_SCRIPT_ID)?.matches).toEqual([
      "https://allowed.test/*"
    ]);
    expect(
      fake.calls.executeScript.mock.calls
        .filter((call) => "files" in call[0])
        .map((call) => call[0].target.tabId)
    ).toEqual([1]);
    expect(fake.calls.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, frameIds: [0] },
      files: [COLLECTOR_SCRIPT_PATH]
    });
    expect(fake.calls.permissionContains).not.toHaveBeenCalled();
  });

  it("projects broad Firefox grants onto exact desired selected origins", async () => {
    const selected = [
      "https://example.test/*",
      "https://child.example.test/*",
      "https://not-example.test/*"
    ];
    fake.grantedOrigins.add("https://*.example.test/*");
    const value = preferences({ permissionMode: "selected-sites", selectedOrigins: selected });

    expect(await grantedOriginsFor(value)).toEqual([
      "https://example.test/*",
      "https://child.example.test/*"
    ]);
    expect(fake.calls.permissionGetAll).toHaveBeenCalledTimes(1);
    expect(fake.calls.permissionContains).not.toHaveBeenCalled();

    await syncCollectorRegistration(value);
    expect(fake.registeredScripts.get(COLLECTOR_SCRIPT_ID)?.matches).toEqual([
      "https://example.test/*",
      "https://child.example.test/*"
    ]);
  });

  it("uses one permission snapshot for the 500-selected-origin cap", async () => {
    const selectedOrigins = Array.from(
      { length: 500 },
      (_, index) => `https://site-${index}.example.test/*`
    );
    fake.grantedOrigins.add("https://*/*");
    const value = preferences({ permissionMode: "selected-sites", selectedOrigins });

    expect(await grantedOriginsFor(value)).toEqual(selectedOrigins);
    expect(fake.calls.permissionGetAll).toHaveBeenCalledTimes(1);
    expect(fake.calls.permissionContains).not.toHaveBeenCalled();

    fake.calls.permissionGetAll.mockClear();
    await syncCollectorRegistration(value);
    expect(fake.calls.permissionGetAll).toHaveBeenCalledTimes(1);
    expect(fake.calls.permissionContains).not.toHaveBeenCalled();
  });

  it("unregisters on pause or permission loss", async () => {
    fake.registeredScripts.set(COLLECTOR_SCRIPT_ID, {
      id: COLLECTOR_SCRIPT_ID,
      matches: ["https://allowed.test/*"],
      js: [COLLECTOR_SCRIPT_PATH],
      runAt: "document_start"
    });

    await syncCollectorRegistration(
      preferences({
        monitoringEnabled: false,
        monitoringIntent: "paused",
        permissionMode: "selected-sites",
        selectedOrigins: ["https://allowed.test/*"]
      })
    );

    expect(fake.calls.unregisterContentScripts).toHaveBeenCalledWith({
      ids: [COLLECTOR_SCRIPT_ID]
    });
    expect(fake.registeredScripts.size).toBe(0);
  });

  it("manual permission mode never creates persistent registration", async () => {
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    await syncCollectorRegistration(preferences({ permissionMode: "manual" }));

    expect(fake.calls.registerContentScripts).not.toHaveBeenCalled();
    expect(await hasContinuousPermission(preferences({ permissionMode: "manual" }))).toBe(false);
    expect(desiredPermissionMode(preferences({ permissionMode: "manual" }))).toBe("manual");
  });

  it("supports the boolean compatibility API and reports an empty effective scope", async () => {
    const manual = preferences({ permissionMode: "manual" });
    expect(await grantedOriginsFor(manual)).toEqual([]);
    expect(await effectivePermissionScope(manual)).toBe("none");
    expect(fake.calls.permissionGetAll).not.toHaveBeenCalled();

    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    await syncCollectorRegistration(true);
    expect(fake.registeredScripts.has(COLLECTOR_SCRIPT_ID)).toBe(true);
    await syncCollectorRegistration(false);
    expect(fake.registeredScripts.has(COLLECTOR_SCRIPT_ID)).toBe(false);
  });

  it("fences a stale registration request before and during browser reconciliation", async () => {
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    let releaseLookup: ((scripts: browser.scripting.RegisteredContentScript[]) => void) | undefined;
    let signalLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    vi.mocked(fake.browser.scripting.getRegisteredContentScripts).mockImplementationOnce(
      () =>
        new Promise<browser.scripting.RegisteredContentScript[]>((resolve) => {
          signalLookupStarted?.();
          releaseLookup = resolve;
        })
    );

    const stale = syncCollectorRegistration(preferences({ permissionMode: "all-sites" }));
    await lookupStarted;
    const latest = syncCollectorRegistration(
      preferences({ monitoringEnabled: false, monitoringIntent: "paused" })
    );
    releaseLookup?.([]);
    await Promise.all([stale, latest]);

    expect(fake.calls.registerContentScripts).not.toHaveBeenCalled();
    expect(fake.registeredScripts.size).toBe(0);

    let current = true;
    let releaseTabs: ((tabs: browser.tabs.Tab[]) => void) | undefined;
    vi.mocked(fake.browser.tabs.query).mockImplementationOnce(
      () => new Promise<browser.tabs.Tab[]>((resolve) => { releaseTabs = resolve; })
    );
    const injection = injectIntoEligibleTabs(undefined, () => current);
    current = false;
    releaseTabs?.([...fake.tabs.values()]);
    expect(await injection).toBe(true);
    expect(fake.calls.executeScript).not.toHaveBeenCalled();

    let checks = 0;
    await expect(
      injectIntoEligibleTabs(undefined, () => {
        checks += 1;
        return checks < 3;
      })
    ).resolves.toBe(true);
    expect(fake.calls.executeScript).not.toHaveBeenCalled();
  });

  it("retries a bounded partial injection failure from the latest registration request", async () => {
    vi.useFakeTimers();
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    fake.calls.executeScript.mockRejectedValueOnce(new Error("one tab raced navigation"));

    await syncCollectorRegistration(preferences({ permissionMode: "all-sites" }));
    expect(fake.calls.executeScript).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTicks();

    expect(fake.calls.executeScript.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(fake.registeredScripts.get(COLLECTOR_SCRIPT_ID)).toMatchObject({
      runAt: "document_start"
    });
  });

  it("bounds permission lookup and recovers a rejected immediate unregistration", async () => {
    vi.useFakeTimers();
    vi.mocked(fake.browser.permissions.getAll).mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    const lookup = grantedOriginsFor(preferences({ permissionMode: "all-sites" }));
    const timedOut = expect(lookup).rejects.toThrow("Permission lookup timed out");
    await vi.advanceTimersByTimeAsync(2_001);
    await timedOut;

    fake.registeredScripts.set(COLLECTOR_SCRIPT_ID, {
      id: COLLECTOR_SCRIPT_ID,
      matches: [...MONITORED_ORIGINS],
      js: [COLLECTOR_SCRIPT_PATH],
      runAt: "document_start"
    });
    fake.calls.unregisterContentScripts.mockRejectedValueOnce(
      new Error("temporary unregister failure")
    );
    await unregisterCollectorRegistrationNow();
    expect(fake.registeredScripts.has(COLLECTOR_SCRIPT_ID)).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTicks();
    expect(fake.registeredScripts.has(COLLECTOR_SCRIPT_ID)).toBe(false);
  });

  it("bounds reconciliation failures so one restricted tab cannot stop other injections", async () => {
    fake.calls.executeScript.mockImplementationOnce(async () => {
      throw new Error("restricted");
    });
    await injectIntoEligibleTabs();
    expect(
      [...new Set(fake.calls.executeScript.mock.calls.map((call) => call[0].target.tabId))].sort()
    ).toEqual([1, 2]);
  });

  it("short-circuits stale registration and injection requests before browser work", async () => {
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);

    await expect(
      syncCollectorRegistration(
        preferences({ permissionMode: "all-sites" }),
        () => false
      )
    ).resolves.toBeUndefined();
    await expect(injectIntoEligibleTabs(undefined, () => false)).resolves.toBe(true);

    expect(fake.browser.scripting.getRegisteredContentScripts).not.toHaveBeenCalled();
    expect(fake.browser.tabs.query).not.toHaveBeenCalled();
    expect(fake.calls.registerContentScripts).not.toHaveBeenCalled();
    expect(fake.calls.executeScript).not.toHaveBeenCalled();
  });

  it("recovers the serialized registration queue after a rejected browser registration", async () => {
    vi.useFakeTimers();
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    fake.calls.registerContentScripts.mockRejectedValueOnce(
      new Error("registration temporarily unavailable")
    );

    await expect(
      syncCollectorRegistration(preferences({ permissionMode: "all-sites" }))
    ).rejects.toThrow("registration temporarily unavailable");
    await expect(syncCollectorRegistration(false)).resolves.toBeUndefined();

    expect(fake.calls.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(fake.registeredScripts.has(COLLECTOR_SCRIPT_ID)).toBe(false);
    await vi.runOnlyPendingTimersAsync();
  });

  it("reconciles a registration that becomes stale while Firefox is committing it", async () => {
    vi.useFakeTimers();
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    let current = true;
    let releaseRegistration:
      | ((value: void | PromiseLike<void>) => void)
      | undefined;
    fake.calls.registerContentScripts.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseRegistration = resolve; })
    );

    const registration = syncCollectorRegistration(
      preferences({ permissionMode: "all-sites" }),
      () => current
    );
    await drainMicrotasksUntil(() => fake.calls.registerContentScripts.mock.calls.length === 1);
    current = false;
    releaseRegistration?.();

    await expect(registration).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.calls.executeScript).not.toHaveBeenCalled();
  });

  it("retries both a partial injection and a failed reconciliation lookup", async () => {
    vi.useFakeTimers();
    for (const origin of MONITORED_ORIGINS) fake.grantedOrigins.add(origin);
    fake.calls.executeScript.mockRejectedValueOnce(new Error("tab navigated"));

    await syncCollectorRegistration(preferences({ permissionMode: "all-sites" }));
    vi.mocked(fake.browser.scripting.getRegisteredContentScripts).mockRejectedValueOnce(
      new Error("registration lookup unavailable")
    );
    await vi.runAllTimersAsync();

    expect(fake.browser.scripting.getRegisteredContentScripts).toHaveBeenCalledTimes(3);
    expect(fake.calls.executeScript.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("fails closed when an eligible tab URL mutates between inspection and matching", async () => {
    const missingUrl = makeTab({ id: 20 });
    let missingReads = 0;
    Object.defineProperty(missingUrl, "url", {
      configurable: true,
      get: () => (++missingReads === 1 ? "https://allowed.test/page" : undefined)
    });
    const malformedUrl = makeTab({ id: 21 });
    let malformedReads = 0;
    Object.defineProperty(malformedUrl, "url", {
      configurable: true,
      get: () => (++malformedReads === 1 ? "https://allowed.test/page" : "%")
    });
    vi.mocked(fake.browser.tabs.query).mockResolvedValueOnce([missingUrl, malformedUrl]);

    await expect(
      injectIntoEligibleTabs(["https://allowed.test/*"])
    ).resolves.toBe(true);
    expect(fake.calls.executeScript).not.toHaveBeenCalled();
  });
});

async function drainMicrotasksUntil(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let index = 0; index < attempts && !predicate(); index += 1) {
    await Promise.resolve();
  }
  if (!predicate()) throw new Error("Timed out waiting for queued permission work");
}
