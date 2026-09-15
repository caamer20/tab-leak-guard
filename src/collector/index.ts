import { COLLECTOR_MESSAGE_TIMEOUT_MS, PROTOCOL_VERSION } from "../shared/constants";
import {
  type CollectorHelloMessage,
  type CollectorSampleMessage
} from "../shared/types";
import {
  CollectorBudgetController,
  countMutationBatch,
  saturatingAdd
} from "./budget-controller";
import { countNodesBounded } from "./dom-counter";
import { decodeCollectorBootstrap, type CollectorBootstrap } from "./bootstrap";
import {
  parseCollectorControlCommand,
  type BackoffCollectorResponse,
  type RecoveryPreflightResponse,
  type StopCollectorResponse
} from "./control";
import {
  initialUserEditState,
  isLongSchedulingGap,
  isManualSessionExpired,
  nextSampleDelayMs,
  visibleTimerDriftMs,
  type CollectorMode,
  type UserEditState
} from "./scheduler";
import {
  readDroppedEntriesCount,
  ResourceActivityTracker,
  type SignalStatus
} from "./signals";

type CollectorSentinel = {
  stop: () => void;
  readonly protocolVersion: number;
  readonly runtimeVersion: number;
  readonly documentInstanceId: string;
  readonly mode: CollectorMode | "initializing";
  readonly sessionExpiresAtMonotonicMs: number | null;
};

type CollectorGlobal = typeof globalThis & {
  __TAB_LEAK_GUARD_COLLECTOR__?: CollectorSentinel;
};

type CollectorRestartContext = {
  documentInstanceId: string;
  sequence: number;
  segmentStartedAt: number;
  routeKey: string;
  userEditState: UserEditState;
  editObservedDuringStartup: boolean;
};

type PerformanceObserverOptionsWithDrops = {
  droppedEntriesCount?: number;
};

const MAX_REPORTED_NODES = 100_000_000;
const FULL_RECOUNT_INTERVAL_MS = 120_000;
const IDLE_RECOUNT_TIMEOUT_MS = 1_000;
const DOM_RECOUNT_YIELD_TIMEOUT_MS = 50;
const DOM_RECOUNT_SLICE_BUDGET_MS = 8;
const DOM_RECOUNT_TOTAL_BUDGET_MS = 40;
const DOM_RECOUNT_MAX_NODES_PER_SLICE = 1_024;
const DOM_RECOUNT_MAX_SLICES = 64;
const DOM_RECOUNT_MAX_NODES = 100_000;
const DOM_RECOUNT_RETRY_AFTER_SUCCESS_MS = 30_000;
const DELIVERY_DEADLINE_MARGIN_MS = 250;
const COLLECTOR_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
// Bump this whenever an update must replace a collector already running in an
// open document, even if the wire protocol itself remains compatible.
const COLLECTOR_RUNTIME_VERSION = 2;
const collectorGlobal = globalThis as CollectorGlobal;
let collectorRetryAttempt = 0;
let collectorRestartTimer: number | undefined;
let collectorRestartContext: CollectorRestartContext | undefined;

class CollectorRuntime {
  documentInstanceId: string = crypto.randomUUID();
  mode: CollectorMode | null = null;
  sessionExpiresAtMonotonicMs: number | null = null;

  private readonly controller = new AbortController();
  private readonly budgetController = new CollectorBudgetController();
  private readonly injectedWhileLoading = document.readyState === "loading";
  private readonly hostname = location.hostname.toLowerCase();
  private sentinel: CollectorSentinel | null = null;
  private stopped = false;
  private initialized = false;
  private sampling = false;
  private editObservedDuringStartup = false;
  private userEditState: UserEditState = "unknown";
  private timer: number | undefined;
  private expiryTimer: number | undefined;
  private mutationResumeTimer: number | undefined;
  private expectedSampleAt: number | null = null;
  private plannedDelayMs: number | null = null;
  private suppressDriftOnce = true;
  private segmentRequested = false;
  private routeKey = location.href;
  private segmentStartedAt = performance.now();
  private sequence = 0;
  private addedNodes = 0;
  private removedNodes = 0;
  private mutationWorkDurationSinceLastSample = 0;
  private mutationOverflowed = false;
  private mutationSignalFailed = false;
  private mutationSuspended = false;
  private lastSampleWasDegraded = false;
  private lastFullDomCountAt = -Infinity;
  private nextFullDomRecountAt = -Infinity;
  private cachedDomCount: number | null = null;
  private sampleVisibleSeconds = 30;
  private sampleHiddenSeconds = 90;
  private authorityToken: string | null = null;
  private mutationObserver: MutationObserver | undefined;
  private resourceObserver: PerformanceObserver | undefined;
  private resourceActivity = new ResourceActivityTracker(null, false);
  private readonly resumedUserEditState: UserEditState | null;

  constructor(resume?: CollectorRestartContext) {
    this.resumedUserEditState = resume?.userEditState ?? null;
    if (resume) {
      this.documentInstanceId = resume.documentInstanceId;
      this.sequence = resume.sequence;
      this.segmentStartedAt = resume.segmentStartedAt;
      this.routeKey = resume.routeKey;
      this.userEditState = resume.userEditState;
      this.editObservedDuringStartup = resume.editObservedDuringStartup;
      // Reinitializing observers creates a signal gap. Mark the next sample
      // degraded so detector confidence cannot improve across that gap.
      this.mutationOverflowed = true;
    }
    // Install edit protection before the first await. We never inspect values.
    document.addEventListener("beforeinput", this.markEdited, { capture: true, signal: this.controller.signal });
    document.addEventListener("input", this.markEdited, { capture: true, signal: this.controller.signal });
    document.addEventListener("change", this.markEdited, { capture: true, signal: this.controller.signal });
    browser.runtime.onMessage.addListener(this.handleControlMessage);

    document.addEventListener("visibilitychange", this.handleVisibilityChange, {
      signal: this.controller.signal
    });
    window.addEventListener("pagehide", this.handlePageHide, { signal: this.controller.signal });
    window.addEventListener("pageshow", this.handlePageShow, { signal: this.controller.signal });
    window.addEventListener("popstate", this.requestEvidenceSegment, { signal: this.controller.signal });
    window.addEventListener("hashchange", this.requestEvidenceSegment, { signal: this.controller.signal });

  }

  bindSentinel(sentinel: CollectorSentinel): void {
    this.sentinel = sentinel;
  }

  async start(): Promise<void> {
    const bootstrapDelivery = await requestCollectorBootstrap(this.documentInstanceId);
    if (this.stopped) return;
    if (bootstrapDelivery.status !== "accepted") {
      if (bootstrapDelivery.status === "retryable") this.restartAfterTransientFailure();
      else this.stop();
      return;
    }
    const bootstrap = bootstrapDelivery.bootstrap;

    this.mode = bootstrap.mode;
    this.authorityToken = bootstrap.authorityToken;
    this.sampleVisibleSeconds = bootstrap.sampleVisibleSeconds;
    this.sampleHiddenSeconds = bootstrap.sampleHiddenSeconds;
    const initialEditState = initialUserEditState(
      this.mode,
      this.injectedWhileLoading,
      this.editObservedDuringStartup
    );
    this.userEditState = this.resumedUserEditState === null
      ? initialEditState
      : moreConservativeEditState(this.resumedUserEditState, initialEditState);
    this.startMutationObserver();
    this.startResourceActivityObserver();
    this.initialized = true;

    if (this.mode === "manual") {
      const expiresAt = bootstrap.manualSessionExpiresAtEpochMs;
      if (expiresAt === null) {
        this.stop();
        return;
      }
      this.startManualExpiry(expiresAt);
    }
    await this.sendHello();
    if (!this.stopped) this.scheduleNext(true);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.initialized = false;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    if (this.expiryTimer !== undefined) window.clearTimeout(this.expiryTimer);
    if (this.mutationResumeTimer !== undefined) window.clearTimeout(this.mutationResumeTimer);
    this.mutationObserver?.disconnect();
    this.resourceObserver?.disconnect();
    browser.runtime.onMessage.removeListener(this.handleControlMessage);
    this.controller.abort();
    if (collectorGlobal.__TAB_LEAK_GUARD_COLLECTOR__ === this.sentinel) {
      delete collectorGlobal.__TAB_LEAK_GUARD_COLLECTOR__;
    }
  }

  private readonly markEdited = (event: Event): void => {
    if (!isEditableTarget(event.target)) return;
    this.editObservedDuringStartup = true;
    this.userEditState = "edits-observed";
  };

  private readonly handleMutations: MutationCallback = (records): void => {
    if (this.stopped) return;
    if (this.mutationSuspended) {
      this.mutationOverflowed = true;
      return;
    }

    try {
      const result = countMutationBatch(records, walkDomElements);
      this.addedNodes = saturatingAdd(this.addedNodes, result.addedNodes, MAX_REPORTED_NODES);
      this.removedNodes = saturatingAdd(this.removedNodes, result.removedNodes, MAX_REPORTED_NODES);
      this.mutationWorkDurationSinceLastSample = Math.min(
        60_000,
        this.mutationWorkDurationSinceLastSample + result.durationMs
      );
      this.mutationOverflowed ||= result.overflowed;
      if (this.budgetController.recordMutation(result.durationMs, result.overflowed)) {
        this.suspendMutationTracking();
      }
    } catch {
      this.mutationOverflowed = true;
      this.mutationSignalFailed = true;
      this.budgetController.markDegraded();
      this.suspendMutationTracking();
    }
  };

  private observeMutations(): void {
    if (this.stopped || !this.mutationObserver) return;
    try {
      this.mutationObserver.observe(document, { childList: true, subtree: true });
      this.mutationSignalFailed = false;
    } catch {
      this.mutationSignalFailed = true;
      this.budgetController.markDegraded();
    }
  }

  private startMutationObserver(): void {
    try {
      this.mutationObserver = new MutationObserver(this.handleMutations);
      this.observeMutations();
    } catch {
      this.mutationSignalFailed = true;
      this.budgetController.markDegraded();
    }
  }

  private suspendMutationTracking(): void {
    if (this.stopped || this.mutationSuspended) return;
    this.mutationSuspended = true;
    this.mutationOverflowed = true;
    this.mutationObserver?.disconnect();
    if (this.mutationResumeTimer !== undefined) window.clearTimeout(this.mutationResumeTimer);
    this.mutationResumeTimer = window.setTimeout(() => {
      this.mutationResumeTimer = undefined;
      if (this.stopped) return;
      this.mutationSuspended = false;
      this.lastFullDomCountAt = -Infinity;
      this.observeMutations();
      this.scheduleNext(true);
    }, this.budgetController.mutationSuspensionMs);
  }

  private startResourceActivityObserver(): void {
    let supported = false;
    try {
      supported =
        typeof PerformanceObserver !== "undefined" &&
        (PerformanceObserver.supportedEntryTypes ?? []).includes("resource");
    } catch {
      supported = false;
    }
    if (!supported) {
      this.resourceActivity = new ResourceActivityTracker(null, false);
      return;
    }

    let initialCount: number | null = null;
    try {
      initialCount = performance.getEntriesByType("resource").length;
    } catch {
      initialCount = null;
    }
    this.resourceActivity = new ResourceActivityTracker(initialCount, true);

    try {
      const callback = ((
        list: PerformanceObserverEntryList,
        _observer: PerformanceObserver,
        options?: PerformanceObserverOptionsWithDrops
      ) => {
        try {
          const entries = list.getEntries().length;
          const dropped = readDroppedEntriesCount(options);
          this.resourceActivity.record(entries, dropped);
          if (dropped > 0) this.budgetController.markDegraded();
        } catch {
          this.resourceActivity.markFailed();
          this.budgetController.markDegraded();
          this.resourceObserver?.disconnect();
        }
      }) as PerformanceObserverCallback;
      this.resourceObserver = new PerformanceObserver(callback);
      this.resourceObserver.observe({ type: "resource", buffered: false });
    } catch {
      this.resourceObserver?.disconnect();
      this.resourceObserver = undefined;
      this.resourceActivity.markFailed();
      this.budgetController.markDegraded();
    }
  }

  private scheduleNext(immediate = false): void {
    if (this.stopped || !this.initialized || !this.mode) return;
    const now = performance.now();
    if (isManualSessionExpired(this.mode, now, this.sessionExpiresAtMonotonicMs)) {
      this.stop();
      return;
    }
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    const seconds = document.visibilityState === "visible"
      ? this.sampleVisibleSeconds
      : this.sampleHiddenSeconds;
    let delay = nextSampleDelayMs({
      seconds,
      immediate,
      cadenceMultiplier: this.budgetController.snapshot().cadenceMultiplier,
      random: Math.random
    });
    if (this.mode === "manual" && this.sessionExpiresAtMonotonicMs !== null) {
      delay = Math.min(delay, Math.max(0, this.sessionExpiresAtMonotonicMs - now));
    }
    this.plannedDelayMs = delay;
    this.expectedSampleAt = now + delay;
    this.timer = window.setTimeout(() => void this.sample(), delay);
  }

  private async sample(): Promise<void> {
    if (this.stopped || !this.initialized || !this.mode) return;
    if (this.sampling) {
      this.scheduleNext(true);
      return;
    }
    this.sampling = true;
    const sampleWorkStartedAt = performance.now();
    let workPhaseStartedAt = sampleWorkStartedAt;
    let collectorWorkDurationMs = 0;
    let workTimerActive = true;
    const pauseWorkTimer = () => {
      if (!workTimerActive) return;
      collectorWorkDurationMs += Math.max(0, performance.now() - workPhaseStartedAt);
      workTimerActive = false;
    };
    const resumeWorkTimer = () => {
      workPhaseStartedAt = performance.now();
      workTimerActive = true;
    };
    let sampleHealthRecorded = false;
    try {
      if (isManualSessionExpired(this.mode, sampleWorkStartedAt, this.sessionExpiresAtMonotonicMs)) {
        this.stop();
        return;
      }

      const longGap = isLongSchedulingGap(
        sampleWorkStartedAt,
        this.expectedSampleAt,
        this.plannedDelayMs
      );
      if (this.segmentRequested || this.routeKey !== location.href || longGap) {
        this.beginEvidenceSegment();
        pauseWorkTimer();
        await this.sendHello();
        resumeWorkTimer();
        if (this.stopped) return;
      }

      const now = performance.now();
      const drift = visibleTimerDriftMs(
        now,
        this.expectedSampleAt,
        document.visibilityState === "visible",
        this.suppressDriftOnce || longGap,
        this.plannedDelayMs
      );
      this.suppressDriftOnce = false;

      const fullRecountDue =
        now >= this.nextFullDomRecountAt &&
        (this.cachedDomCount === null ||
          now - this.lastFullDomCountAt >= FULL_RECOUNT_INTERVAL_MS ||
          this.mutationOverflowed ||
          this.sequence === 0);
      let recountDurationMs: number | null = null;
      if (fullRecountDue) {
        pauseWorkTimer();
        await waitForIdle(IDLE_RECOUNT_TIMEOUT_MS, this.controller.signal);
        if (this.stopped) return;
        let recountFailed = false;
        try {
          const recount = await countLiveDomBounded(this.controller.signal);
          if (this.stopped) return;
          this.cachedDomCount = recount.count;
          recountDurationMs = Math.min(60_000, recount.activeDurationMs);
          recountFailed = !recount.complete;
          this.mutationOverflowed ||= recountFailed;
        } catch {
          this.cachedDomCount = null;
          recountFailed = true;
          this.mutationOverflowed = true;
        }
        this.lastFullDomCountAt = performance.now();
        this.nextFullDomRecountAt = this.lastFullDomCountAt + (
          recountFailed
            ? FULL_RECOUNT_INTERVAL_MS
            : DOM_RECOUNT_RETRY_AFTER_SUCCESS_MS
        );
        this.budgetController.recordRecount(recountDurationMs ?? 0, recountFailed);
        resumeWorkTimer();
      } else {
        if (this.cachedDomCount !== null && !this.mutationOverflowed) {
          this.cachedDomCount = Math.max(
            0,
            Math.min(
              MAX_REPORTED_NODES,
              this.cachedDomCount + this.addedNodes - this.removedNodes
            )
          );
        }
      }

      const resource = this.resourceActivity.consumeSample();
      const effectiveUserEditState = this.effectiveUserEditState();
      const sampleOverflowed =
        this.mutationOverflowed ||
        this.mutationSuspended ||
        this.mutationSignalFailed ||
        resource.droppedEntriesSinceLastSample > 0 ||
        resource.status === "failed" ||
        resource.status === "overflowed";
      this.lastSampleWasDegraded = sampleOverflowed;
      const sentAt = performance.now();
      pauseWorkTimer();
      collectorWorkDurationMs = Math.min(60_000, collectorWorkDurationMs);
      this.budgetController.recordSample(collectorWorkDurationMs);
      sampleHealthRecorded = true;
      const message: CollectorSampleMessage = {
        protocolVersion: PROTOCOL_VERSION,
        type: "COLLECTOR_SAMPLE",
        sentAtMonotonicMs: sentAt,
        deliveryDeadlineEpochMs:
          Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS - DELIVERY_DEADLINE_MARGIN_MS,
        documentInstanceId: this.documentInstanceId,
        collectorMode: this.mode,
        authorityToken: this.authorityToken,
        payload: {
          sampleSequence: this.sequence,
          documentAgeMs: Math.max(0, sentAt - this.segmentStartedAt),
          visibility: document.visibilityState === "visible" ? "visible" : "hidden",
          liveDomNodes: this.cachedDomCount,
          addedNodesSinceLast: this.addedNodes,
          removedNodesSinceLast: this.removedNodes,
          // Legacy v1 wire name. This is resource activity, never memory retention.
          resourceEntriesSeen: resource.activityCount,
          timerDriftMs: drift,
          // Legacy v1 projection: unknown is conservatively treated as edited.
          dirty: effectiveUserEditState !== "no-edits-observed",
          overflowed: sampleOverflowed,
          userEditState: effectiveUserEditState,
          collectorMode: this.mode,
          collectorHealth: this.currentHealth(),
          resourceActivityCount: resource.activityCount,
          droppedPerformanceEntries: resource.droppedEntriesSinceLastSample,
          sampleDurationMs: collectorWorkDurationMs,
          mutationWorkDurationMs: Math.min(60_000, this.mutationWorkDurationSinceLastSample),
          recountDurationMs,
          sampledAtEpochMs: Date.now(),
          capabilities: {
            resourceObserver: isSuccessfullyCollected(resource.status),
            longTasks: false,
            exactMemory: false
          }
        }
      };

      this.sequence += 1;
      this.addedNodes = 0;
      this.removedNodes = 0;
      this.mutationWorkDurationSinceLastSample = 0;
      this.mutationOverflowed = this.mutationSuspended || this.mutationSignalFailed;
      const delivery = await sendToBackground(message);
      if (delivery === "retryable") this.restartAfterTransientFailure();
      else if (delivery === "rejected") this.stop();
    } catch {
      this.mutationOverflowed = true;
      if (!sampleHealthRecorded) {
        pauseWorkTimer();
        this.budgetController.recordSample(collectorWorkDurationMs, true);
      }
    } finally {
      this.sampling = false;
      if (!this.stopped) this.scheduleNext();
    }
  }

  private beginEvidenceSegment(): void {
    this.documentInstanceId = crypto.randomUUID();
    this.segmentStartedAt = performance.now();
    this.sequence = 0;
    this.addedNodes = 0;
    this.removedNodes = 0;
    this.mutationWorkDurationSinceLastSample = 0;
    this.cachedDomCount = null;
    this.lastFullDomCountAt = -Infinity;
    this.nextFullDomRecountAt = -Infinity;
    this.routeKey = location.href;
    this.segmentRequested = false;
    this.suppressDriftOnce = true;
    this.expectedSampleAt = null;
    this.plannedDelayMs = null;
  }

  private async sendHello(): Promise<void> {
    const hello: CollectorHelloMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "COLLECTOR_HELLO",
      sentAtMonotonicMs: performance.now(),
      deliveryDeadlineEpochMs:
        Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS - DELIVERY_DEADLINE_MARGIN_MS,
      documentInstanceId: this.documentInstanceId,
      collectorMode: this.mode as CollectorMode,
      authorityToken: this.authorityToken,
      payload: { hostname: this.hostname }
    };
    const delivery = await sendToBackground(hello);
    if (delivery === "accepted") collectorRetryAttempt = 0;
    else if (delivery === "retryable") this.restartAfterTransientFailure();
    else this.stop();
  }

  private restartAfterTransientFailure(): void {
    const context: CollectorRestartContext = {
      documentInstanceId: this.documentInstanceId,
      sequence: this.sequence,
      segmentStartedAt: this.segmentStartedAt,
      routeKey: this.routeKey,
      userEditState: this.userEditState,
      editObservedDuringStartup: this.editObservedDuringStartup
    };
    this.stop();
    scheduleCollectorRestart(context);
  }

  private startManualExpiry(expiresAtEpochMs: number): void {
    this.sessionExpiresAtMonotonicMs =
      performance.now() + Math.max(0, expiresAtEpochMs - Date.now());
    const remaining = Math.max(0, this.sessionExpiresAtMonotonicMs - performance.now());
    this.expiryTimer = window.setTimeout(() => this.stop(), remaining);
  }

  private currentHealth(): "healthy" | "degraded" {
    const resourceStatus = this.resourceActivity.snapshot().status;
    return this.budgetController.snapshot().health === "degraded" ||
      this.mutationSignalFailed ||
      this.mutationSuspended ||
      this.lastSampleWasDegraded ||
      resourceStatus === "failed" ||
      resourceStatus === "overflowed"
      ? "degraded"
      : "healthy";
  }

  private effectiveUserEditState(): UserEditState {
    if (this.userEditState === "edits-observed") return "edits-observed";
    try {
      // Top-frame collection cannot observe user edits inside child frames.
      if (document.querySelector("iframe, frame")) return "unknown";
    } catch {
      return "unknown";
    }
    return this.userEditState;
  }

  private readonly handleControlMessage = (
    message: unknown,
    sender: browser.runtime.MessageSender,
    sendResponse: (
      response?: RecoveryPreflightResponse | StopCollectorResponse | BackoffCollectorResponse
    ) => void
  ): boolean | undefined => {
    if (sender.id !== browser.runtime.id) return undefined;
    const command = parseCollectorControlCommand(message);
    if (!command) return undefined;
    if (
      command.expectedDocumentInstanceId !== undefined &&
      command.expectedDocumentInstanceId !== this.documentInstanceId
    ) {
      sendResponse({ ok: false, error: "Collector document identity changed" });
      return false;
    }
    if (command.type === "STOP_COLLECTOR") {
      const documentInstanceId = this.documentInstanceId;
      sendResponse({
        ok: true,
        data: { documentInstanceId, stopped: true, collectorHealth: "stopped" }
      });
      this.stop();
      return false;
    }
    if (!this.initialized || !this.mode || this.stopped) {
      sendResponse({ ok: false, error: "Collector is not ready" });
      return false;
    }
    if (
      command.type === "GET_RECOVERY_PREFLIGHT" &&
      (this.segmentRequested ||
        this.routeKey !== location.href ||
        isLongSchedulingGap(performance.now(), this.expectedSampleAt, this.plannedDelayMs))
    ) {
      this.beginEvidenceSegment();
      void this.sendHello();
      this.scheduleNext(true);
      sendResponse({ ok: false, error: "Collector evidence is stale or changed" });
      return false;
    }
    if (command.type === "GET_RECOVERY_PREFLIGHT") {
      sendResponse({
        ok: true,
        data: {
          documentInstanceId: this.documentInstanceId,
          userEditState: this.effectiveUserEditState(),
          capturedAtMonotonicMs: performance.now(),
          collectorMode: this.mode,
          collectorHealth: this.currentHealth(),
          sessionExpiresAtMonotonicMs: this.sessionExpiresAtMonotonicMs,
          authorityToken: this.authorityToken
        }
      });
      return false;
    }
    if (command.type === "BACKOFF_COLLECTOR") {
      this.budgetController.forceBackoff();
      this.suppressDriftOnce = true;
      this.scheduleNext();
      sendResponse({
        ok: true,
        data: {
          documentInstanceId: this.documentInstanceId,
          backedOff: true,
          collectorHealth: "degraded"
        }
      });
      return false;
    }
    return false;
  };

  private readonly handleVisibilityChange = (): void => {
    this.suppressDriftOnce = true;
    this.scheduleNext(true);
  };

  private readonly handlePageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) {
      this.stop();
      return;
    }
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.expectedSampleAt = null;
    this.plannedDelayMs = null;
  };

  private readonly handlePageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted || !this.mode) return;
    if (isManualSessionExpired(this.mode, performance.now(), this.sessionExpiresAtMonotonicMs)) {
      this.stop();
      return;
    }
    this.requestEvidenceSegment();
  };

  private readonly requestEvidenceSegment = (): void => {
    if (this.stopped) return;
    this.segmentRequested = true;
    this.suppressDriftOnce = true;
    this.scheduleNext(true);
  };
}

// Claim the isolated-world sentinel synchronously before startup performs any
// asynchronous work. Repeated executeScript calls therefore remain idempotent.
function installCollector(resume?: CollectorRestartContext): void {
  const existing = collectorGlobal.__TAB_LEAK_GUARD_COLLECTOR__;
  if (
    existing?.protocolVersion === PROTOCOL_VERSION &&
    existing.runtimeVersion === COLLECTOR_RUNTIME_VERSION
  ) return;
  if (existing) {
    // A signed extension update can inject this build into a document that
    // still owns the previous build's isolated-world sentinel. Stop that
    // document-bound runtime before claiming the sentinel for this build.
    try {
      existing.stop();
    } catch {
      // A malformed legacy sentinel must not prevent a fail-closed takeover.
    }
    if (collectorGlobal.__TAB_LEAK_GUARD_COLLECTOR__ === existing) {
      delete collectorGlobal.__TAB_LEAK_GUARD_COLLECTOR__;
    }
  }
  const runtime = new CollectorRuntime(resume);
  const sentinel: CollectorSentinel = {
    stop: () => runtime.stop(),
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: COLLECTOR_RUNTIME_VERSION,
    get documentInstanceId() {
      return runtime.documentInstanceId;
    },
    get mode() {
      return runtime.mode ?? "initializing";
    },
    get sessionExpiresAtMonotonicMs() {
      return runtime.sessionExpiresAtMonotonicMs;
    }
  };
  collectorGlobal.__TAB_LEAK_GUARD_COLLECTOR__ = sentinel;
  runtime.bindSentinel(sentinel);
  void runtime.start();
}

function scheduleCollectorRestart(context?: CollectorRestartContext): void {
  if (collectorRestartTimer !== undefined) return;
  const delay = COLLECTOR_RETRY_DELAYS_MS[collectorRetryAttempt];
  if (delay === undefined) return;
  collectorRetryAttempt += 1;
  collectorRestartContext = context;
  collectorRestartTimer = window.setTimeout(() => {
    collectorRestartTimer = undefined;
    const resume = collectorRestartContext;
    collectorRestartContext = undefined;
    installCollector(resume);
  }, delay);
}

// Claim the isolated-world sentinel synchronously before startup performs any
// asynchronous work. Repeated executeScript calls therefore remain idempotent.
installCollector();

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function walkDomElements(root: Node, visit: () => boolean): void {
  if (root.nodeType === Node.ELEMENT_NODE && !visit()) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    if (!visit()) return;
  }
}

async function countLiveDomBounded(signal: AbortSignal) {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  return countNodesBounded({
    nextNode: () => walker.nextNode(),
    now: () => performance.now(),
    yieldControl: () => waitForIdle(DOM_RECOUNT_YIELD_TIMEOUT_MS, signal),
    signal,
    sliceBudgetMs: DOM_RECOUNT_SLICE_BUDGET_MS,
    totalBudgetMs: DOM_RECOUNT_TOTAL_BUDGET_MS,
    maxNodesPerSlice: DOM_RECOUNT_MAX_NODES_PER_SLICE,
    maxSlices: DOM_RECOUNT_MAX_SLICES,
    maxNodes: DOM_RECOUNT_MAX_NODES,
    clockCheckEvery: 1
  });
}

function isSuccessfullyCollected(status: SignalStatus): boolean {
  return status === "collected" || status === "overflowed" || status === "stale";
}

function moreConservativeEditState(
  left: UserEditState,
  right: UserEditState
): UserEditState {
  if (left === "edits-observed" || right === "edits-observed") return "edits-observed";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "no-edits-observed";
}

async function waitForIdle(timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  await new Promise<void>((resolve) => {
    let handle: number;
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      if (idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
    handle = idleWindow.requestIdleCallback
      ? idleWindow.requestIdleCallback(finish, { timeout: timeoutMs })
      : window.setTimeout(finish, 0);
  });
}

type BackgroundDelivery = "accepted" | "retryable" | "rejected";

type BootstrapDelivery =
  | { status: "accepted"; bootstrap: CollectorBootstrap }
  | { status: "retryable" | "rejected"; bootstrap: null };

async function sendToBackground(
  message: CollectorHelloMessage | CollectorSampleMessage
): Promise<BackgroundDelivery> {
  let timeout: number | undefined;
  try {
    const response: unknown = await Promise.race([
      browser.runtime.sendMessage(message),
      new Promise<null>((resolve) => {
        timeout = window.setTimeout(() => resolve(null), COLLECTOR_MESSAGE_TIMEOUT_MS);
      })
    ]);
    if (response === null) return "retryable";
    if (isBackgroundAcknowledgement(response)) return "accepted";
    return isRetryableBackgroundFailure(response) ? "retryable" : "rejected";
  } catch {
    return "retryable";
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

async function requestCollectorBootstrap(
  documentInstanceId: string
): Promise<BootstrapDelivery> {
  let response: unknown;
  let timeout: number | undefined;
  try {
    const deliveryDeadlineEpochMs =
      Date.now() + COLLECTOR_MESSAGE_TIMEOUT_MS - DELIVERY_DEADLINE_MARGIN_MS;
    response = await Promise.race([
      browser.runtime.sendMessage({
        type: "GET_COLLECTOR_BOOTSTRAP",
        documentInstanceId,
        deliveryDeadlineEpochMs
      }),
      new Promise<null>((resolve) => {
        timeout = window.setTimeout(() => resolve(null), COLLECTOR_MESSAGE_TIMEOUT_MS);
      })
    ]);
  } catch {
    return { status: "retryable", bootstrap: null };
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
  if (response === null) return { status: "retryable", bootstrap: null };
  const bootstrap = decodeCollectorBootstrap(response);
  if (bootstrap) return { status: "accepted", bootstrap };
  return {
    status: isRetryableBackgroundFailure(response) ? "retryable" : "rejected",
    bootstrap: null
  };
}

function isBackgroundAcknowledgement(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Reflect.get(value, "ok") === true;
}

function isRetryableBackgroundFailure(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Reflect.get(value, "ok") === false &&
    Reflect.get(value, "retryable") === true &&
    typeof Reflect.get(value, "error") === "string";
}
