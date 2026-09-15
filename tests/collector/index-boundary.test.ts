import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeMessageListener = (
  message: unknown,
  sender: { id: string },
  sendResponse: (response?: unknown) => void
) => unknown;

type CollectorSentinelView = {
  stop(): void;
  readonly protocolVersion: number;
  readonly runtimeVersion: number;
  readonly documentInstanceId: string;
  readonly mode: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

type CollectorHarness = {
  browserSendMessage: ReturnType<typeof vi.fn>;
  dispatchDocumentEvent(type: string, target: EventTarget): void;
  listeners: Set<RuntimeMessageListener>;
  sentMessages: unknown[];
};

class FakeInputElement {}
class FakeTextAreaElement {}
class FakeSelectElement {}
class FakeHtmlElement {
  isContentEditable = false;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function continuousBootstrap() {
  return {
    ok: true,
    data: {
      mode: "continuous",
      sampleVisibleSeconds: 30,
      sampleHiddenSeconds: 90,
      manualSessionExpiresAtEpochMs: null,
      authorityToken: null
    }
  };
}

function collectorSentinel(): CollectorSentinelView | undefined {
  return (globalThis as typeof globalThis & {
    __TAB_LEAK_GUARD_COLLECTOR__?: CollectorSentinelView;
  }).__TAB_LEAK_GUARD_COLLECTOR__;
}

function installHarness(
  sendMessage: (message: unknown, callIndex: number) => unknown | Promise<unknown>,
  nextTreeNode: () => Node | null = () => null
): CollectorHarness {
  const documentListeners = new Map<string, Set<(event: Event) => void>>();
  const listeners = new Set<RuntimeMessageListener>();
  const sentMessages: unknown[] = [];
  let sendCallIndex = 0;
  let uuidSequence = 0;

  const browserSendMessage = vi.fn((message: unknown) => {
    sentMessages.push(message);
    const callIndex = sendCallIndex;
    sendCallIndex += 1;
    return Promise.resolve(sendMessage(message, callIndex));
  });

  const fakeDocument = {
    readyState: "loading",
    visibilityState: "visible",
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (typeof listener !== "function") return;
      const registered = documentListeners.get(type) ?? new Set<(event: Event) => void>();
      registered.add(listener);
      documentListeners.set(type, registered);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (typeof listener === "function") documentListeners.get(type)?.delete(listener);
    },
    querySelector: vi.fn(() => null),
    createTreeWalker: vi.fn(() => ({ nextNode: nextTreeNode }))
  };

  const fakeWindow = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestIdleCallback(callback: () => void) {
      callback();
      return 1;
    },
    cancelIdleCallback: vi.fn(),
    setTimeout(handler: TimerHandler, timeout?: number) {
      return globalThis.setTimeout(handler, timeout) as unknown as number;
    },
    clearTimeout(handle: number | undefined) {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    }
  };

  class FakeMutationObserver {
    constructor(_callback: MutationCallback) {}
    observe(): void {}
    disconnect(): void {}
  }

  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("location", { hostname: "example.test", href: "https://example.test/app" });
  vi.stubGlobal("HTMLInputElement", FakeInputElement);
  vi.stubGlobal("HTMLTextAreaElement", FakeTextAreaElement);
  vi.stubGlobal("HTMLSelectElement", FakeSelectElement);
  vi.stubGlobal("HTMLElement", FakeHtmlElement);
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  vi.stubGlobal("PerformanceObserver", undefined);
  vi.stubGlobal("crypto", {
    randomUUID: vi.fn(() => {
      uuidSequence += 1;
      return `11111111-1111-4111-8111-${String(uuidSequence).padStart(12, "0")}`;
    })
  });
  vi.stubGlobal("browser", {
    runtime: {
      id: "test-extension-id",
      onMessage: {
        addListener(listener: RuntimeMessageListener) {
          listeners.add(listener);
        },
        removeListener(listener: RuntimeMessageListener) {
          listeners.delete(listener);
        }
      },
      sendMessage: browserSendMessage
    }
  });

  return {
    browserSendMessage,
    dispatchDocumentEvent(type, target) {
      for (const listener of documentListeners.get(type) ?? []) {
        listener({ target } as Event);
      }
    },
    listeners,
    sentMessages
  };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function readPreflight(harness: CollectorHarness): Record<string, unknown> {
  expect(harness.listeners.size).toBe(1);
  const listener = [...harness.listeners][0];
  expect(listener).toBeDefined();
  const sendResponse = vi.fn();
  listener?.(
    { type: "GET_RECOVERY_PREFLIGHT" },
    { id: "test-extension-id" },
    sendResponse
  );
  expect(sendResponse).toHaveBeenCalledOnce();
  return sendResponse.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("collector runtime replacement and retry boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    vi.resetModules();
  });

  afterEach(() => {
    collectorSentinel()?.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("stops and replaces the exact legacy v1 sentinel before awaiting bootstrap", async () => {
    const pendingBootstrap = new Promise<never>(() => undefined);
    installHarness(() => pendingBootstrap);
    const legacyStop = vi.fn();
    const legacy = {
      stop: legacyStop,
      protocolVersion: 1,
      runtimeVersion: 1,
      documentInstanceId: "legacy-document-instance",
      mode: "continuous",
      sessionExpiresAtMonotonicMs: null
    };
    vi.stubGlobal("__TAB_LEAK_GUARD_COLLECTOR__", legacy);

    await import("../../src/collector/index");

    const installed = collectorSentinel();
    expect(legacyStop).toHaveBeenCalledOnce();
    expect(installed).toBeDefined();
    expect(installed).not.toBe(legacy);
    expect(installed).toMatchObject({
      protocolVersion: 2,
      runtimeVersion: 2,
      mode: "initializing"
    });
  });

  it("retries a transient bootstrap failure with the same document and startup edit state", async () => {
    const firstBootstrap = deferred<unknown>();
    const harness = installHarness((_message, callIndex) => {
      if (callIndex === 0) return firstBootstrap.promise;
      if (callIndex === 1) return continuousBootstrap();
      return { ok: true, data: null };
    });

    await import("../../src/collector/index");
    const firstDocumentInstanceId = collectorSentinel()?.documentInstanceId;
    expect(firstDocumentInstanceId).toBeDefined();
    harness.dispatchDocumentEvent("input", new FakeInputElement() as EventTarget);

    firstBootstrap.resolve({ ok: false, retryable: true, error: "Background is hydrating" });
    await flushMicrotasks();
    expect(collectorSentinel()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(collectorSentinel()).toMatchObject({
      documentInstanceId: firstDocumentInstanceId,
      mode: "continuous"
    });
    expect(readPreflight(harness)).toEqual({
      ok: true,
      data: expect.objectContaining({
        documentInstanceId: firstDocumentInstanceId,
        userEditState: "edits-observed",
        collectorMode: "continuous"
      })
    });
    expect(harness.sentMessages).toHaveLength(3);
  });

  it("retries a transient HELLO rejection without losing document identity or edit state", async () => {
    const firstHello = deferred<unknown>();
    const harness = installHarness((_message, callIndex) => {
      if (callIndex === 0 || callIndex === 2) return continuousBootstrap();
      if (callIndex === 1) return firstHello.promise;
      return { ok: true, data: null };
    });

    await import("../../src/collector/index");
    await flushMicrotasks();
    const firstDocumentInstanceId = collectorSentinel()?.documentInstanceId;
    expect(firstDocumentInstanceId).toBeDefined();
    harness.dispatchDocumentEvent("change", new FakeInputElement() as EventTarget);

    firstHello.resolve({ ok: false, retryable: true, error: "Admission is temporarily fenced" });
    await flushMicrotasks();
    expect(collectorSentinel()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(collectorSentinel()).toMatchObject({
      documentInstanceId: firstDocumentInstanceId,
      mode: "continuous"
    });
    expect(readPreflight(harness)).toEqual({
      ok: true,
      data: expect.objectContaining({
        documentInstanceId: firstDocumentInstanceId,
        userEditState: "edits-observed",
        collectorMode: "continuous"
      })
    });
    expect(harness.sentMessages).toHaveLength(4);
  });

  it("publishes a censored degraded sample when a live DOM exceeds 100,000 nodes", async () => {
    let remainingNodes = 100_001;
    const harness = installHarness(
      (_message, callIndex) => callIndex === 0
        ? continuousBootstrap()
        : { ok: true, data: null },
      () => remainingNodes-- > 0 ? ({} as Node) : null
    );

    await import("../../src/collector/index");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks(200);

    const sample = harness.sentMessages.find((message) =>
      typeof message === "object" && message !== null &&
      Reflect.get(message, "type") === "COLLECTOR_SAMPLE"
    ) as { payload?: Record<string, unknown> } | undefined;
    expect(harness.sentMessages.map((message) =>
      typeof message === "object" && message !== null ? Reflect.get(message, "type") : message
    )).toContain("COLLECTOR_SAMPLE");
    expect(sample?.payload).toMatchObject({
      liveDomNodes: null,
      overflowed: true,
      collectorHealth: "degraded"
    });
    expect(remainingNodes).toBeGreaterThan(0);
  });
});
