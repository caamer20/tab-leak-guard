import { vi, type Mock } from "vitest";
import { permissionGrantCoversOrigin } from "../../src/shared/permission-pattern";

type Listener = (...args: any[]) => unknown;

export class FakeEvent<TListener extends Listener> {
  readonly listeners = new Set<TListener>();

  addListener = (listener: TListener): void => {
    this.listeners.add(listener);
  };

  removeListener = (listener: TListener): void => {
    this.listeners.delete(listener);
  };

  hasListener = (listener: TListener): boolean => this.listeners.has(listener);

  emit(...args: Parameters<TListener>): Array<ReturnType<TListener>> {
    return [...this.listeners].map((listener) => listener(...args) as ReturnType<TListener>);
  }
}

type RuntimeMessageListener = (
  message: unknown,
  sender: browser.runtime.MessageSender
) => unknown;

export type StoredValues = Record<string, unknown>;

export type FakeWebExtensionOptions = {
  local?: StoredValues;
  session?: StoredValues;
  tabs?: browser.tabs.Tab[];
  windows?: browser.windows.Window[];
  grantedOrigins?: string[];
  alarms?: browser.alarms.Alarm[];
  notifications?: Record<string, browser.notifications.NotificationItem>;
};

export type FakeWebExtension = {
  browser: typeof browser;
  local: StoredValues;
  session: StoredValues;
  tabs: Map<number, browser.tabs.Tab>;
  windows: Map<number, browser.windows.Window>;
  grantedOrigins: Set<string>;
  alarms: Map<string, browser.alarms.Alarm>;
  notifications: Map<string, browser.notifications.NotificationItem>;
  registeredScripts: Map<string, browser.scripting.RegisteredContentScript>;
  events: {
    runtimeMessage: FakeEvent<RuntimeMessageListener>;
    installed: FakeEvent<(details: browser.runtime._OnInstalledDetails) => unknown>;
    startup: FakeEvent<() => unknown>;
    permissionAdded: FakeEvent<(permissions: browser.permissions.Permissions) => unknown>;
    permissionRemoved: FakeEvent<(permissions: browser.permissions.Permissions) => unknown>;
    alarm: FakeEvent<(alarm: browser.alarms.Alarm) => unknown>;
    notificationClicked: FakeEvent<(id: string) => unknown>;
    tabRemoved: FakeEvent<(tabId: number, removeInfo: browser.tabs._OnRemovedRemoveInfo) => unknown>;
    tabUpdated: FakeEvent<(
      tabId: number,
      changeInfo: browser.tabs._OnUpdatedChangeInfo,
      tab: browser.tabs.Tab
    ) => unknown>;
    tabActivated: FakeEvent<(activeInfo: browser.tabs._OnActivatedActiveInfo) => unknown>;
    tabHighlighted: FakeEvent<(highlightInfo: browser.tabs._OnHighlightedHighlightInfo) => unknown>;
    tabReplaced: FakeEvent<(addedTabId: number, removedTabId: number) => unknown>;
    committed: FakeEvent<(details: browser.webNavigation._OnCommittedDetails) => unknown>;
    completed: FakeEvent<(details: browser.webNavigation._OnCompletedDetails) => unknown>;
    errorOccurred: FakeEvent<(
      details: browser.webNavigation._OnErrorOccurredDetails
    ) => unknown>;
    historyStateUpdated: FakeEvent<(
      details: browser.webNavigation._OnHistoryStateUpdatedDetails
    ) => unknown>;
    performanceWarning: FakeEvent<(
      details: {
        category: string;
        severity: "low" | "medium" | "high";
        tabId?: number;
      }
    ) => unknown>;
  };
  calls: {
    storageLocalSet: Mock;
    storageSessionSet: Mock;
    permissionContains: Mock;
    permissionGetAll: Mock;
    registerContentScripts: Mock;
    unregisterContentScripts: Mock;
    executeScript: Mock;
    tabsSendMessage: Mock;
    tabsDiscard: Mock;
    tabsReload: Mock;
    alarmClear: Mock;
    notificationCreate: Mock;
    notificationUpdate: Mock;
    notificationClear: Mock;
    badgeText: Mock;
    badgeColor: Mock;
    actionTitle: Mock;
  };
  setContentMessageHandler(
    handler: (
      tabId: number,
      message: unknown,
      options?: browser.tabs._SendMessageOptions
    ) => unknown | Promise<unknown>
  ): void;
  dispatchRuntimeMessage<T = unknown>(
    message: unknown,
    sender?: browser.runtime.MessageSender
  ): Promise<T>;
  flush(): Promise<void>;
};

const EXTENSION_ORIGIN = "moz-extension://tab-leak-guard-test/";

export function createFakeWebExtension(options: FakeWebExtensionOptions = {}): FakeWebExtension {
  const local = clone(options.local ?? {});
  const session = clone(options.session ?? {});
  const tabMap = new Map<number, browser.tabs.Tab>();
  for (const tab of options.tabs ?? []) {
    if (tab.id !== undefined) tabMap.set(tab.id, clone(tab));
  }
  const windowMap = new Map<number, browser.windows.Window>();
  for (const window of options.windows ?? []) {
    if (window.id !== undefined) windowMap.set(window.id, clone(window));
  }
  const grantedOrigins = new Set(options.grantedOrigins ?? []);
  const alarms = new Map((options.alarms ?? []).map((alarm) => [alarm.name, clone(alarm)]));
  const notifications = new Map(
    Object.entries(options.notifications ?? {}).map(([id, item]) => [id, clone(item)])
  );
  const registeredScripts = new Map<string, browser.scripting.RegisteredContentScript>();

  const events = {
    runtimeMessage: new FakeEvent<RuntimeMessageListener>(),
    installed: new FakeEvent<(details: browser.runtime._OnInstalledDetails) => unknown>(),
    startup: new FakeEvent<() => unknown>(),
    permissionAdded: new FakeEvent<(permissions: browser.permissions.Permissions) => unknown>(),
    permissionRemoved: new FakeEvent<(permissions: browser.permissions.Permissions) => unknown>(),
    alarm: new FakeEvent<(alarm: browser.alarms.Alarm) => unknown>(),
    notificationClicked: new FakeEvent<(id: string) => unknown>(),
    tabRemoved: new FakeEvent<(
      tabId: number,
      removeInfo: browser.tabs._OnRemovedRemoveInfo
    ) => unknown>(),
    tabUpdated: new FakeEvent<(
      tabId: number,
      changeInfo: browser.tabs._OnUpdatedChangeInfo,
      tab: browser.tabs.Tab
    ) => unknown>(),
    tabActivated: new FakeEvent<(activeInfo: browser.tabs._OnActivatedActiveInfo) => unknown>(),
    tabHighlighted: new FakeEvent<(
      highlightInfo: browser.tabs._OnHighlightedHighlightInfo
    ) => unknown>(),
    tabReplaced: new FakeEvent<(addedTabId: number, removedTabId: number) => unknown>(),
    committed: new FakeEvent<(details: browser.webNavigation._OnCommittedDetails) => unknown>(),
    completed: new FakeEvent<(details: browser.webNavigation._OnCompletedDetails) => unknown>(),
    errorOccurred: new FakeEvent<(
      details: browser.webNavigation._OnErrorOccurredDetails
    ) => unknown>(),
    historyStateUpdated: new FakeEvent<(
      details: browser.webNavigation._OnHistoryStateUpdatedDetails
    ) => unknown>(),
    performanceWarning: new FakeEvent<(
      details: {
        category: string;
        severity: "low" | "medium" | "high";
        tabId?: number;
      }
    ) => unknown>()
  };

  const storageLocalSet = vi.fn(async (values: StoredValues) => mergeClone(local, values));
  const storageSessionSet = vi.fn(async (values: StoredValues) => mergeClone(session, values));
  const permissionContains = vi.fn(async (request: browser.permissions.Permissions) =>
    (request.origins ?? []).every((origin) =>
      [...grantedOrigins].some((granted) => permissionGrantCoversOrigin(granted, origin))
    )
  );
  const permissionGetAll = vi.fn(async () => ({ origins: [...grantedOrigins] }));
  const registerContentScripts = vi.fn(
    async (scripts: browser.scripting.RegisteredContentScript[]) => {
      for (const script of scripts) registeredScripts.set(script.id, clone(script));
    }
  );
  const unregisterContentScripts = vi.fn(async ({ ids }: { ids?: string[] }) => {
    for (const id of ids ?? [...registeredScripts.keys()]) registeredScripts.delete(id);
  });
  const executeScript = vi.fn(async () => []);
  let contentMessageHandler: (
    tabId: number,
    message: unknown,
    options?: browser.tabs._SendMessageOptions
  ) => unknown | Promise<unknown> = async () => ({
    ok: true,
    data: {
      documentInstanceId: "document-12345678",
      userEditState: "no-edits-observed",
      capturedAtMonotonicMs: 1,
      collectorMode: "continuous",
      collectorHealth: "healthy",
      sessionExpiresAtMonotonicMs: null,
      authorityToken: null
    }
  });
  const tabsSendMessage = vi.fn(
    async (
      tabId: number,
      message: unknown,
      sendOptions?: browser.tabs._SendMessageOptions
    ) => contentMessageHandler(tabId, message, sendOptions)
  );
  const tabsDiscard = vi.fn(async (tabId: number) => {
    const current = requiredTab(tabMap, tabId);
    if (!current.active) current.discarded = true;
    return clone(current);
  });
  const tabsReload = vi.fn(async (tabId: number) => {
    const current = requiredTab(tabMap, tabId);
    current.status = "loading";
    events.tabUpdated.emit(tabId, { status: "loading" }, clone(current));
    events.committed.emit({
      tabId,
      frameId: 0,
      url: current.url ?? "",
      timeStamp: Date.now(),
      transitionType: "reload",
      transitionQualifiers: []
    });
    queueMicrotask(() => {
      const latest = tabMap.get(tabId);
      if (!latest) return;
      latest.status = "complete";
      events.tabUpdated.emit(tabId, { status: "complete" }, clone(latest));
      events.completed.emit({
        tabId,
        frameId: 0,
        url: latest.url ?? "",
        timeStamp: Date.now()
      });
    });
  });
  const alarmClear = vi.fn(async (name: string) => alarms.delete(name));
  const notificationCreate = vi.fn(
    async (
      idOrOptions: string | browser.notifications.CreateNotificationOptions,
      maybeOptions?: browser.notifications.CreateNotificationOptions
    ) => {
      const id = typeof idOrOptions === "string" ? idOrOptions : `notification-${notifications.size + 1}`;
      const notificationOptions = typeof idOrOptions === "string" ? maybeOptions : idOrOptions;
      notifications.set(id, clone((notificationOptions ?? {}) as browser.notifications.NotificationItem));
      return id;
    }
  );
  const notificationUpdate = vi.fn(
    async (id: string, update: browser.notifications.UpdateNotificationOptions) => {
      if (!notifications.has(id)) return false;
      notifications.set(id, clone(update as browser.notifications.NotificationItem));
      return true;
    }
  );
  const notificationClear = vi.fn(async (id: string) => notifications.delete(id));
  const badgeText = vi.fn(async () => undefined);
  const badgeColor = vi.fn(async () => undefined);
  const actionTitle = vi.fn(async () => undefined);

  const fakeBrowser = {
    runtime: {
      onInstalled: eventApi(events.installed),
      onStartup: eventApi(events.startup),
      onMessage: eventApi(events.runtimeMessage),
      onPerformanceWarning: eventApi(events.performanceWarning),
      getURL: (path = "") => `${EXTENSION_ORIGIN}${path.replace(/^\//, "")}`,
      getManifest: () => ({
        manifest_version: 3,
        name: "Tab Leak Guard Test",
        version: "0.1.1"
      }),
      openOptionsPage: vi.fn(async () => undefined)
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: unknown) => selectStorage(local, keys)),
        set: storageLocalSet,
        remove: vi.fn(async (keys: string | string[]) => removeStorage(local, keys)),
        clear: vi.fn(async () => clearStorage(local))
      },
      session: {
        get: vi.fn(async (keys?: unknown) => selectStorage(session, keys)),
        set: storageSessionSet,
        remove: vi.fn(async (keys: string | string[]) => removeStorage(session, keys)),
        clear: vi.fn(async () => clearStorage(session))
      }
    },
    permissions: {
      contains: permissionContains,
      request: vi.fn(async (request: browser.permissions.Permissions) => {
        for (const origin of request.origins ?? []) grantedOrigins.add(origin);
        return true;
      }),
      remove: vi.fn(async (request: browser.permissions.Permissions) => {
        for (const origin of request.origins ?? []) grantedOrigins.delete(origin);
        return true;
      }),
      getAll: permissionGetAll,
      onAdded: eventApi(events.permissionAdded),
      onRemoved: eventApi(events.permissionRemoved)
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(async ({ ids }: { ids?: string[] } = {}) =>
        [...registeredScripts.values()]
          .filter((script) => !ids || ids.includes(script.id))
          .map(clone)
      ),
      registerContentScripts,
      unregisterContentScripts,
      executeScript
    },
    tabs: {
      query: vi.fn(async (queryInfo: browser.tabs._QueryQueryInfo = {}) =>
        [...tabMap.values()]
          .filter((tab) => queryInfo.active === undefined || tab.active === queryInfo.active)
          .filter((tab) => !queryInfo.currentWindow || tab.windowId === 1)
          .map(clone)
      ),
      get: vi.fn(async (tabId: number) => clone(requiredTab(tabMap, tabId))),
      sendMessage: tabsSendMessage,
      discard: tabsDiscard,
      reload: tabsReload,
      update: vi.fn(async (tabId: number, update: browser.tabs._UpdateUpdateProperties) => {
        const tab = requiredTab(tabMap, tabId);
        Object.assign(tab, update);
        return clone(tab);
      }),
      create: vi.fn(async (create: browser.tabs._CreateCreateProperties) => {
        const id = Math.max(0, ...tabMap.keys()) + 1;
        const tab = makeTab({ id, url: create.url, active: create.active ?? true });
        tabMap.set(id, tab);
        return clone(tab);
      }),
      onRemoved: eventApi(events.tabRemoved),
      onUpdated: eventApi(events.tabUpdated),
      onActivated: eventApi(events.tabActivated),
      onHighlighted: eventApi(events.tabHighlighted),
      onReplaced: eventApi(events.tabReplaced)
    },
    windows: {
      get: vi.fn(async (windowId: number) => clone(requiredWindow(windowMap, windowId))),
      update: vi.fn(async (windowId: number, update: browser.windows._UpdateUpdateInfo) => {
        const window = requiredWindow(windowMap, windowId);
        Object.assign(window, update);
        return clone(window);
      })
    },
    alarms: {
      create: vi.fn((name: string, alarmInfo: browser.alarms._CreateAlarmInfo) => {
        alarms.set(name, { name, scheduledTime: alarmInfo.when ?? Date.now() });
      }),
      clear: alarmClear,
      getAll: vi.fn(async () => [...alarms.values()].map(clone)),
      onAlarm: eventApi(events.alarm)
    },
    notifications: {
      create: notificationCreate,
      update: notificationUpdate,
      clear: notificationClear,
      getAll: vi.fn(async () => Object.fromEntries(notifications)),
      onClicked: eventApi(events.notificationClicked)
    },
    action: {
      setBadgeText: badgeText,
      setBadgeBackgroundColor: badgeColor,
      setTitle: actionTitle
    },
    webNavigation: {
      getFrame: vi.fn(async ({ tabId }: { tabId: number; frameId: number }) => {
        const tab = requiredTab(tabMap, tabId);
        return { url: tab.url ?? "", parentFrameId: -1 };
      }),
      onCommitted: eventApi(events.committed),
      onCompleted: eventApi(events.completed),
      onErrorOccurred: eventApi(events.errorOccurred),
      onHistoryStateUpdated: eventApi(events.historyStateUpdated)
    }
  } as unknown as typeof browser;

  return {
    browser: fakeBrowser,
    local,
    session,
    tabs: tabMap,
    windows: windowMap,
    grantedOrigins,
    alarms,
    notifications,
    registeredScripts,
    events,
    calls: {
      storageLocalSet,
      storageSessionSet,
      permissionContains,
      permissionGetAll,
      registerContentScripts,
      unregisterContentScripts,
      executeScript,
      tabsSendMessage,
      tabsDiscard,
      tabsReload,
      alarmClear,
      notificationCreate,
      notificationUpdate,
      notificationClear,
      badgeText,
      badgeColor,
      actionTitle
    },
    setContentMessageHandler(
      handler: (
        tabId: number,
        message: unknown,
        options?: browser.tabs._SendMessageOptions
      ) => unknown | Promise<unknown>
    ) {
      contentMessageHandler = handler;
    },
    async dispatchRuntimeMessage<T = unknown>(
      message: unknown,
      sender: browser.runtime.MessageSender = extensionSender()
    ) {
      for (const result of events.runtimeMessage.emit(message, sender)) {
        if (result !== undefined) return (await result) as T;
      }
      return undefined as T;
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
}

export function installFakeBrowser(fake: FakeWebExtension): void {
  Object.defineProperty(globalThis, "browser", {
    configurable: true,
    value: fake.browser,
    writable: true
  });
}

export function extensionSender(): browser.runtime.MessageSender {
  return { url: `${EXTENSION_ORIGIN}ui/popup/index.html` };
}

export function makeTab(overrides: Partial<browser.tabs.Tab> = {}): browser.tabs.Tab {
  return {
    id: 1,
    index: 0,
    windowId: 1,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: false,
    url: "https://example.test/page",
    title: "Example",
    status: "complete",
    discarded: false,
    autoDiscardable: true,
    audible: false,
    attention: false,
    lastAccessed: Date.now() - 10 * 60_000,
    sharingState: { camera: false, microphone: false },
    ...overrides
  };
}

export function makeWindow(overrides: Partial<browser.windows.Window> = {}): browser.windows.Window {
  return {
    id: 1,
    focused: true,
    incognito: false,
    alwaysOnTop: false,
    state: "normal",
    type: "normal",
    ...overrides
  };
}

function eventApi<TListener extends Listener>(event: FakeEvent<TListener>) {
  return {
    addListener: event.addListener,
    removeListener: event.removeListener,
    hasListener: event.hasListener
  };
}

function selectStorage(source: StoredValues, keys: unknown): StoredValues {
  if (keys === undefined || keys === null) return clone(source);
  if (typeof keys === "string") return keys in source ? { [keys]: clone(source[keys]) } : {};
  if (Array.isArray(keys)) {
    return Object.fromEntries(
      keys.filter((key): key is string => typeof key === "string" && key in source).map((key) => [key, clone(source[key])])
    );
  }
  if (typeof keys === "object") {
    const defaults = keys as StoredValues;
    return Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => [key, clone(key in source ? source[key] : fallback)])
    );
  }
  return {};
}

function mergeClone(target: StoredValues, source: StoredValues): void {
  for (const [key, value] of Object.entries(source)) target[key] = clone(value);
}

function removeStorage(target: StoredValues, keys: string | string[]): void {
  for (const key of typeof keys === "string" ? [keys] : keys) delete target[key];
}

function clearStorage(target: StoredValues): void {
  for (const key of Object.keys(target)) delete target[key];
}

function requiredTab(tabs: Map<number, browser.tabs.Tab>, tabId: number): browser.tabs.Tab {
  const tab = tabs.get(tabId);
  if (!tab) throw new Error(`No tab with id ${tabId}`);
  return tab;
}

function requiredWindow(
  windows: Map<number, browser.windows.Window>,
  windowId: number
): browser.windows.Window {
  const window = windows.get(windowId);
  if (!window) throw new Error(`No window with id ${windowId}`);
  return window;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
