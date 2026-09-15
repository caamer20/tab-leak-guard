import { evaluateSamples } from "../detector/score";
import {
  isCompatibleDetectorEvaluation,
  resolveDetectorConfiguration
} from "../detector/model";
import {
  EVIDENCE_FRESHNESS_MS,
  MAX_SAMPLES_PER_DOCUMENT,
  MAX_TAB_RECORDS,
  MAX_RESET_RECEIPTS,
  MAX_RECOVERY_OPERATIONS,
  RESET_COOLDOWN_MS,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION
} from "../shared/constants";
import { sanitizePreferences, sanitizePreparedRecoveries, sanitizeReceipts } from "../shared/schemas";
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  type PreparedRecovery,
  type ResetReceipt,
  type TabPolicyState,
  type TabRecord,
  type TabSafety
} from "../shared/types";
import { normalizeHostname } from "../shared/url-policy";
import { isFiniteNumber, isRecord, isSampleSummary } from "../shared/validation";

function isIssuedOperation(operation: PreparedRecovery): boolean {
  return (
    operation.state === "executing" ||
    operation.state === "requested" ||
    operation.state === "terminal"
  );
}

export class StateRepository {
  readonly records = new Map<number, TabRecord>();
  readonly tabPolicies = new Map<number, TabPolicyState>();
  readonly operations = new Map<string, PreparedRecovery>();
  preferences: Preferences = { ...DEFAULT_PREFERENCES };
  receipts: ResetReceipt[] = [];
  monitoringEpoch = 0;
  readonly ready: Promise<void>;
  #localWrite = Promise.resolve();
  #sessionWrite = Promise.resolve();
  #receiptMutation = Promise.resolve();
  #recordCheckpointTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.ready = this.#hydrate();
  }

  async #hydrate(): Promise<void> {
    const [local, session] = await Promise.all([
      browser.storage.local.get([
        STORAGE_KEYS.preferences,
        STORAGE_KEYS.receipts,
        STORAGE_KEYS.operations,
        STORAGE_KEYS.schemaVersion
      ]),
      browser.storage.session.get([
        STORAGE_KEYS.records,
        STORAGE_KEYS.tabPolicies,
        STORAGE_KEYS.operations,
        STORAGE_KEYS.monitoringEpoch
      ])
    ]);

    const previousVersion = Number.isInteger(local[STORAGE_KEYS.schemaVersion])
      ? Number(local[STORAGE_KEYS.schemaVersion])
      : 1;
    this.preferences = sanitizePreferences(local[STORAGE_KEYS.preferences]);
    this.receipts = sanitizeReceipts(
      local[STORAGE_KEYS.receipts],
      Date.now(),
      this.preferences.historyRetentionHours
    );
    this.monitoringEpoch = Number.isInteger(session[STORAGE_KEYS.monitoringEpoch])
      ? Math.max(0, Number(session[STORAGE_KEYS.monitoringEpoch]))
      : 0;

    const migrating = previousVersion !== STORAGE_SCHEMA_VERSION;
    if (migrating) {
      // Schema changes invalidate all previously prepared action authority.
      this.monitoringEpoch += 1;
    }

    // Never carry document evidence or temporary manual authority across a
    // schema boundary. A migration preserves only issued recovery journals,
    // which are reconciliation evidence and cannot issue a second action.
    const canReadRuntimeState = !migrating;
    const storedRecords = session[STORAGE_KEYS.records];
    if (canReadRuntimeState && storedRecords && isRecord(storedRecords)) {
      let inspected = 0;
      for (const key in storedRecords) {
        if (inspected++ >= MAX_TAB_RECORDS * 4) break;
        const value = storedRecords[key];
        const record = decodeTabRecord(value, this.preferences, this.monitoringEpoch);
        if (record) this.records.set(record.tabId, record);
        if (this.records.size >= MAX_TAB_RECORDS) break;
      }
    }

    const storedPolicies = session[STORAGE_KEYS.tabPolicies];
    if (canReadRuntimeState && storedPolicies && isRecord(storedPolicies)) {
      let inspected = 0;
      for (const key in storedPolicies) {
        if (inspected++ >= MAX_TAB_RECORDS * 4) break;
        const value = storedPolicies[key];
        const policy = decodeTabPolicy(value, Date.now());
        if (policy) this.tabPolicies.set(policy.tabId, policy);
        if (this.tabPolicies.size >= MAX_TAB_RECORDS) break;
      }
    }

    if (previousVersion <= STORAGE_SCHEMA_VERSION) {
      const candidates = [
        ...sanitizePreparedRecoveries(local[STORAGE_KEYS.operations]),
        ...sanitizePreparedRecoveries(session[STORAGE_KEYS.operations])
      ];
      const merged = new Map<string, PreparedRecovery>();
      for (const operation of candidates) {
        const existing = merged.get(operation.operationId);
        const issued = isIssuedOperation(operation);
        if (!existing || (issued && !isIssuedOperation(existing))) {
          merged.set(operation.operationId, operation);
        }
      }
      for (const operation of merged.values()) {
        const issued = isIssuedOperation(operation);
        // Issued journals survive a full browser/process restart even though
        // session epochs and schema migrations do not; they are evidence for
        // reconciliation, never authority to issue another action.
        if (
          issued ||
          (!migrating &&
            operation.initiator === "manual" &&
            operation.monitoringEpoch === this.monitoringEpoch)
        ) {
          this.operations.set(operation.operationId, operation);
        }
      }
    }

    // Durable success/unknown receipts are also recovery-authority fences.
    // Reconstruct their tab cooldowns before ready resolves so collector
    // bootstrap and UI commands cannot race startup reconciliation.
    const now = Date.now();
    for (const receipt of this.receipts) {
      if (receipt.outcome !== "success" && receipt.outcome !== "unknown") continue;
      const cooldownUntil = receipt.occurredAt + RESET_COOLDOWN_MS;
      if (cooldownUntil <= now) continue;
      const existingPolicy = this.tabPolicies.get(receipt.tabId) ?? { tabId: receipt.tabId };
      this.tabPolicies.set(receipt.tabId, {
        ...existingPolicy,
        cooldownUntil: Math.max(existingPolicy.cooldownUntil ?? 0, cooldownUntil)
      });
      const record = this.records.get(receipt.tabId);
      if (record) {
        record.cooldownUntil = Math.max(record.cooldownUntil ?? 0, cooldownUntil);
        record.recovery = { status: "cooldown" };
      }
    }

    // Commit the durable journal before clearing the legacy session copy. On
    // migration the schema marker is intentionally omitted until session
    // authority has been invalidated; a crash at either earlier write causes
    // the migration to run again rather than accepting stale runtime state.
    await this.#queueLocalWrite({
      [STORAGE_KEYS.preferences]: this.preferences,
      [STORAGE_KEYS.receipts]: this.receipts,
      [STORAGE_KEYS.operations]: [...this.operations.values()],
      ...(migrating ? {} : { [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION })
    });
    await this.#queueSessionWrite({
      [STORAGE_KEYS.monitoringEpoch]: this.monitoringEpoch,
      [STORAGE_KEYS.records]: Object.fromEntries(
        [...this.records].map(([tabId, record]) => [String(tabId), record])
      ),
      [STORAGE_KEYS.tabPolicies]: Object.fromEntries(
        [...this.tabPolicies].map(([tabId, policy]) => [String(tabId), policy])
      ),
      // Migrate prototype-era operation journals out of memory-only storage.
      [STORAGE_KEYS.operations]: []
    });
    if (migrating) {
      // This is the migration commit marker. Publish it last so a current
      // local schema can never coexist with pre-migration session authority.
      await this.#queueLocalWrite({
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION
      });
    }
  }

  async updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
    const compatiblePatch: Partial<Preferences> = { ...patch };
    if (patch.monitoringEnabled !== undefined && patch.monitoringIntent === undefined) {
      compatiblePatch.monitoringIntent = patch.monitoringEnabled ? "continuous" : "paused";
    }
    let committed = this.preferences;
    await this.#withLocalWriteLock(async () => {
      const next = sanitizePreferences({ ...this.preferences, ...compatiblePatch });
      await browser.storage.local.set({
        [STORAGE_KEYS.preferences]: next,
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION
      });
      // Retention and recovery transactions may execute concurrently. They
      // must never observe a preference that its own durable write rejected.
      this.preferences = next;
      committed = next;
    });
    return committed;
  }

  async incrementMonitoringEpoch(): Promise<number> {
    this.monitoringEpoch += 1;
    await this.#queueSessionWrite({
      [STORAGE_KEYS.monitoringEpoch]: this.monitoringEpoch
    });
    return this.monitoringEpoch;
  }

  persistRecords(): Promise<void> {
    if (this.#recordCheckpointTimer !== undefined) {
      clearTimeout(this.#recordCheckpointTimer);
      this.#recordCheckpointTimer = undefined;
    }
    const snapshot = Object.fromEntries(
      [...this.records.entries()].map(([id, record]) => [String(id), record])
    );
    return this.#queueSessionWrite({ [STORAGE_KEYS.records]: snapshot });
  }

  scheduleRecordCheckpoint(delayMs = 15_000): void {
    if (this.#recordCheckpointTimer !== undefined) return;
    this.#recordCheckpointTimer = setTimeout(() => {
      this.#recordCheckpointTimer = undefined;
      void this.persistRecords();
    }, Math.max(1_000, delayMs));
  }

  async upsertTabPolicy(policy: TabPolicyState): Promise<void> {
    this.tabPolicies.set(policy.tabId, policy);
    await this.persistTabPolicies();
  }

  async removeTabPolicy(tabId: number): Promise<void> {
    this.tabPolicies.delete(tabId);
    await this.persistTabPolicies();
  }

  persistTabPolicies(): Promise<void> {
    return this.#queueSessionWrite({
      [STORAGE_KEYS.tabPolicies]: Object.fromEntries(
        [...this.tabPolicies].map(([tabId, policy]) => [String(tabId), policy])
      )
    });
  }

  putOperation(operation: PreparedRecovery): Promise<void> {
    this.#localWrite = this.#localWrite.catch(() => undefined).then(async () => {
      const next = new Map(this.operations);
      let evicted: PreparedRecovery | undefined;
      if (!next.has(operation.operationId) && next.size >= MAX_RECOVERY_OPERATIONS) {
        evicted = [...next.values()]
          .filter((candidate) => !isIssuedOperation(candidate))
          .sort((a, b) => a.expiresAt - b.expiresAt)[0];
        if (!evicted) throw new Error("Too many recovery operations are active");
        next.delete(evicted.operationId);
      }
      next.set(operation.operationId, operation);
      await browser.storage.local.set({
        [STORAGE_KEYS.operations]: [...next.values()]
      });
      // Publish only this mutation. A different tab can synchronously revoke
      // one of the other operations while Firefox's storage promise is
      // pending; replacing the whole map here would resurrect that revoked
      // authority before its queued corrective checkpoint runs.
      if (
        evicted &&
        this.operations.get(evicted.operationId) === evicted &&
        !isIssuedOperation(evicted)
      ) {
        this.operations.delete(evicted.operationId);
      }
      this.operations.set(operation.operationId, operation);
    });
    return this.#localWrite;
  }

  /**
   * Durably publish the point-of-no-return journal before exposing it through
   * the shared in-memory object. Earlier queued writers therefore see the old
   * prepared state, and a rejected transition cannot be resurrected as a
   * requested/unknown action by one of their late snapshots.
   */
  markOperationRequested(
    operation: PreparedRecovery,
    requestedAt: number,
    acknowledgedUserEditRisk: boolean
  ): Promise<void> {
    this.#localWrite = this.#localWrite.catch(() => undefined).then(async () => {
      if (this.operations.get(operation.operationId) !== operation) {
        throw new Error("Recovery operation authority changed before journaling");
      }
      const requested: PreparedRecovery = {
        ...operation,
        state: "requested",
        requestedAt,
        acknowledgedUserEditRisk
      };
      const snapshot = [...this.operations.values()].map((candidate) =>
        candidate === operation ? requested : candidate
      );
      await browser.storage.local.set({
        [STORAGE_KEYS.operations]: snapshot
      });
      operation.state = "requested";
      operation.requestedAt = requestedAt;
      operation.acknowledgedUserEditRisk = acknowledgedUserEditRisk;
    });
    return this.#localWrite;
  }

  async removeOperation(operationId: string): Promise<void> {
    this.operations.delete(operationId);
    await this.persistOperations();
  }

  persistOperations(): Promise<void> {
    // Resolve the snapshot only when this write reaches the queue. This
    // prevents an earlier caller's stale snapshot from resurrecting an
    // operation removed by a later atomic receipt commit.
    this.#localWrite = this.#localWrite.catch(() => undefined).then(() =>
      browser.storage.local.set({
        [STORAGE_KEYS.operations]: [...this.operations.values()]
      })
    );
    return this.#localWrite;
  }

  commitReceiptAndRemoveOperation(receipt: ResetReceipt): Promise<void> {
    const mutation = this.#receiptMutation.catch(() => undefined).then(async () => {
      await this.#withLocalWriteLock(async () => {
        const nextReceipts = this.receipts.some(
          (candidate) => candidate.operationId === receipt.operationId
        )
          ? [...this.receipts]
          : sanitizeReceipts(
              [receipt, ...this.receipts],
              Date.now(),
              this.preferences.historyRetentionHours
            ).slice(0, MAX_RESET_RECEIPTS);
        const nextOperations = [...this.operations.values()].filter(
          (operation) => operation.operationId !== receipt.operationId
        );
        // Compute and commit both snapshots while holding the same local-write
        // lock. A prepared operation published by an earlier queued writer can
        // therefore never be omitted by this cross-key transaction.
        await browser.storage.local.set({
          [STORAGE_KEYS.receipts]: nextReceipts,
          [STORAGE_KEYS.operations]: nextOperations
        });
        this.receipts = nextReceipts;
        if (receipt.operationId) this.operations.delete(receipt.operationId);
      });
    });
    this.#receiptMutation = mutation;
    return mutation;
  }

  addReceipt(receipt: ResetReceipt): Promise<void> {
    const mutation = this.#receiptMutation.catch(() => undefined).then(async () => {
      await this.#withLocalWriteLock(async () => {
        const next = sanitizeReceipts(
          [receipt, ...this.receipts],
          Date.now(),
          this.preferences.historyRetentionHours
        ).slice(0, MAX_RESET_RECEIPTS);
        await browser.storage.local.set({ [STORAGE_KEYS.receipts]: next });
        this.receipts = next;
      });
    });
    this.#receiptMutation = mutation;
    return mutation;
  }

  purgeExpiredReceipts(now = Date.now()): Promise<void> {
    const mutation = this.#receiptMutation.catch(() => undefined).then(async () => {
      await this.#withLocalWriteLock(async () => {
        const next = sanitizeReceipts(
          this.receipts,
          now,
          this.preferences.historyRetentionHours
        );
        if (next.length === this.receipts.length) return;
        const retainedReceiptIds = new Set(
          next.flatMap((receipt) => (receipt.operationId ? [receipt.operationId] : []))
        );
        const removedReceiptIds = new Set(
          this.receipts.flatMap((receipt) =>
            receipt.operationId && !retainedReceiptIds.has(receipt.operationId)
              ? [receipt.operationId]
              : []
          )
        );
        const nextOperations = [...this.operations.values()].filter(
          (operation) => !removedReceiptIds.has(operation.operationId)
        );
        await browser.storage.local.set({
          [STORAGE_KEYS.receipts]: next,
          [STORAGE_KEYS.operations]: nextOperations
        });
        this.receipts = next;
        for (const operationId of removedReceiptIds) this.operations.delete(operationId);
      });
    });
    this.#receiptMutation = mutation;
    return mutation;
  }

  clearReceipts(): Promise<void> {
    const mutation = this.#receiptMutation.catch(() => undefined).then(async () => {
      await this.#withLocalWriteLock(async () => {
        const receiptOperationIds = new Set(
          this.receipts.flatMap((receipt) => (receipt.operationId ? [receipt.operationId] : []))
        );
        const nextOperations = [...this.operations.values()].filter(
          (operation) => !receiptOperationIds.has(operation.operationId)
        );
        await browser.storage.local.set({
          [STORAGE_KEYS.receipts]: [],
          [STORAGE_KEYS.operations]: nextOperations
        });
        this.receipts = [];
        for (const operationId of receiptOperationIds) this.operations.delete(operationId);
      });
    });
    this.#receiptMutation = mutation;
    return mutation;
  }

  async clearAllRuntimeState(): Promise<void> {
    if (this.#recordCheckpointTimer !== undefined) {
      clearTimeout(this.#recordCheckpointTimer);
      this.#recordCheckpointTimer = undefined;
    }
    this.records.clear();
    this.tabPolicies.clear();
    this.operations.clear();
    this.receipts = [];
    this.preferences = { ...DEFAULT_PREFERENCES };
    this.monitoringEpoch += 1;
    // Drain every earlier write before clearing so no stale checkpoint can
    // repopulate storage after the user-requested deletion.
    await Promise.all([
      this.#localWrite.catch(() => undefined),
      this.#sessionWrite.catch(() => undefined),
      this.#receiptMutation.catch(() => undefined)
    ]);
    // A receipt mutation publishes its in-memory snapshot only after its
    // queued write. Re-clear after draining so an older mutation cannot make
    // erased history observable or persistable again.
    this.records.clear();
    this.tabPolicies.clear();
    this.operations.clear();
    this.receipts = [];
    this.preferences = { ...DEFAULT_PREFERENCES };
    await Promise.all([
      browser.storage.local.clear(),
      browser.storage.session.clear()
    ]);
    await Promise.all([
      this.#queueLocalWrite({
        [STORAGE_KEYS.preferences]: this.preferences,
        [STORAGE_KEYS.receipts]: [],
        [STORAGE_KEYS.operations]: [],
        [STORAGE_KEYS.schemaVersion]: STORAGE_SCHEMA_VERSION
      }),
      this.#queueSessionWrite({
        [STORAGE_KEYS.records]: {},
        [STORAGE_KEYS.tabPolicies]: {},
        [STORAGE_KEYS.monitoringEpoch]: this.monitoringEpoch
      })
    ]);
  }

  #queueLocalWrite(value: Record<string, unknown>): Promise<void> {
    return this.#withLocalWriteLock(() => browser.storage.local.set(value));
  }

  #withLocalWriteLock(task: () => Promise<void>): Promise<void> {
    this.#localWrite = this.#localWrite.catch(() => undefined).then(task);
    return this.#localWrite;
  }

  #queueSessionWrite(value: Record<string, unknown>): Promise<void> {
    this.#sessionWrite = this.#sessionWrite
      .catch(() => undefined)
      .then(() => browser.storage.session.set(value));
    return this.#sessionWrite;
  }
}

function decodeTabPolicy(value: unknown, now: number): TabPolicyState | null {
  if (!isRecord(value) || !Number.isInteger(value.tabId) || (value.tabId as number) < 0) {
    return null;
  }
  const snoozedUntil = futureTimestamp(value.snoozedUntil, now);
  const cooldownUntil = futureTimestamp(value.cooldownUntil, now);
  const lastAutomaticAttemptAt = isFiniteNumber(value.lastAutomaticAttemptAt, 0)
    ? value.lastAutomaticAttemptAt
    : undefined;
  const candidateManualSessionExpiresAt = futureTimestamp(value.manualSessionExpiresAt, now);
  const candidateManualSessionDocumentInstanceId =
    typeof value.manualSessionDocumentInstanceId === "string" &&
    value.manualSessionDocumentInstanceId.length >= 8 &&
    value.manualSessionDocumentInstanceId.length <= 128
      ? value.manualSessionDocumentInstanceId
      : undefined;
  const candidateManualSessionDocumentId =
    typeof value.manualSessionDocumentId === "string" &&
    value.manualSessionDocumentId.length >= 8 &&
    value.manualSessionDocumentId.length <= 128
      ? value.manualSessionDocumentId
      : undefined;
  const manualSessionToken =
    candidateManualSessionExpiresAt !== undefined &&
    // An unbound token can exist briefly before a fresh collector bootstraps,
    // but it must never survive a worker restart and authorize a later document.
    candidateManualSessionDocumentInstanceId !== undefined &&
    typeof value.manualSessionToken === "string" &&
    value.manualSessionToken.length >= 16 &&
    value.manualSessionToken.length <= 128
      ? value.manualSessionToken
      : undefined;
  const manualSessionExpiresAt =
    manualSessionToken === undefined ? undefined : candidateManualSessionExpiresAt;
  const manualSessionStartedAt =
    manualSessionExpiresAt !== undefined && isFiniteNumber(value.manualSessionStartedAt, 0, now)
      ? value.manualSessionStartedAt
      : undefined;
  const manualSessionDocumentInstanceId =
    manualSessionToken !== undefined
      ? candidateManualSessionDocumentInstanceId
      : undefined;
  const manualSessionDocumentId =
    manualSessionToken !== undefined
      ? candidateManualSessionDocumentId
      : undefined;
  if (
    snoozedUntil === undefined &&
    cooldownUntil === undefined &&
    lastAutomaticAttemptAt === undefined &&
    manualSessionExpiresAt === undefined
  ) {
    return null;
  }
  return {
    tabId: value.tabId as number,
    ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
    ...(lastAutomaticAttemptAt === undefined ? {} : { lastAutomaticAttemptAt }),
    ...(manualSessionStartedAt === undefined ? {} : { manualSessionStartedAt }),
    ...(manualSessionExpiresAt === undefined ? {} : { manualSessionExpiresAt }),
    ...(manualSessionToken === undefined ? {} : { manualSessionToken }),
    ...(manualSessionDocumentInstanceId === undefined
      ? {}
      : { manualSessionDocumentInstanceId }),
    ...(manualSessionDocumentId === undefined ? {} : { manualSessionDocumentId })
  };
}

function decodeTabRecord(
  value: unknown,
  preferences: Preferences,
  monitoringEpoch: number
): TabRecord | null {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.tabId) ||
    (value.tabId as number) < 0 ||
    !Number.isInteger(value.windowId) ||
    !Number.isInteger(value.monitoringEpoch) ||
    (value.monitoringEpoch as number) !== monitoringEpoch ||
    typeof value.documentInstanceId !== "string" ||
    value.documentInstanceId.length < 8 ||
    value.documentInstanceId.length > 128 ||
    typeof value.hostname !== "string"
  ) {
    return null;
  }
  const hostname = normalizeHostname(value.hostname);
  if (!hostname) return null;
  const samples = Array.isArray(value.samples)
    ? value.samples.filter(isSampleSummary).slice(-MAX_SAMPLES_PER_DOCUMENT)
    : [];
  const now = Date.now();
  const createdAt = safeTimestamp(value.createdAt, now);
  const updatedAt = safeTimestamp(value.updatedAt, createdAt);
  const dirty = isRecord(value.safety) && value.safety.dirty === true;
  const storedRecovery = isRecord(value.recovery) ? value.recovery : {};
  const cooldownUntil = futureTimestamp(value.cooldownUntil, now);
  const snoozedUntil = futureTimestamp(value.snoozedUntil, now);
  const safety = migrateSafety(value.safety, dirty, now);
  const detectorConfiguration = resolveDetectorConfiguration({
    confirmationScore: preferences.confirmationScore,
    evaluatedAtEpochMs: now
  });
  const storedDetector = isRecord(value.detector)
    ? (value.detector as unknown as TabRecord["detector"])
    : undefined;
  const compatibleDetector = isCompatibleDetectorEvaluation(
    storedDetector,
    detectorConfiguration.configurationVersion
  )
    ? storedDetector
    : undefined;
  const detector = evaluateSamples(samples, compatibleDetector, {
    confirmationScore: preferences.confirmationScore,
    evaluatedAtEpochMs: now
  });

  return {
    tabId: value.tabId as number,
    windowId: value.windowId as number,
    documentInstanceId: value.documentInstanceId,
    documentId:
      typeof value.documentId === "string" &&
      value.documentId.length >= 8 &&
      value.documentId.length <= 128
        ? value.documentId
        : null,
    revision: Number.isInteger(value.revision) ? Math.max(0, value.revision as number) : 0,
    hostname,
    title: safeText(value.title, hostname, 160),
    createdAt,
    updatedAt,
    lastAccessedAt: safeTimestamp(value.lastAccessedAt, updatedAt),
    samples,
    detector,
    safety,
    recovery: {
      status:
        cooldownUntil !== undefined
          ? "cooldown"
          : storedRecovery.automaticSuppressedForDocument === true || typeof value.blockedReason === "string"
            ? "suppressed"
            : "idle",
      automaticSuppressedForDocument:
        storedRecovery.automaticSuppressedForDocument === true || typeof value.blockedReason === "string",
      ...(typeof value.blockedReason === "string"
        ? { blockedReason: safeText(value.blockedReason, "Recovery was blocked", 512) }
        : {})
    },
    evidenceExpiresAt: Math.min(
      safeTimestamp(value.evidenceExpiresAt, updatedAt + EVIDENCE_FRESHNESS_MS),
      updatedAt + EVIDENCE_FRESHNESS_MS
    ),
    monitoringEpoch,
    monitoringMode:
      value.monitoringMode === "continuous" || value.monitoringMode === "manual"
        ? value.monitoringMode
        : samples.at(-1)?.collectorMode ?? "manual",
    ...(isFiniteNumber(value.manualSessionStartedAt, 0, now)
      ? { manualSessionStartedAt: value.manualSessionStartedAt }
      : {}),
    ...(futureTimestamp(value.manualSessionExpiresAt, now) === undefined
      ? {}
      : { manualSessionExpiresAt: value.manualSessionExpiresAt as number }),
    ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
    ...(isFiniteNumber(value.notifiedAt, 0) ? { notifiedAt: value.notifiedAt } : {})
  };
}

function migrateSafety(value: unknown, dirty: boolean, now: number): TabSafety {
  const candidate = isRecord(value) ? value : {};
  return {
    active: candidate.active === true,
    highlighted: candidate.highlighted === true,
    audible: candidate.audible === true,
    pinned: candidate.pinned === true,
    attention: candidate.attention === true,
    dirty,
    userEditState: dirty ? "edits-observed" : "unknown",
    discarded: candidate.discarded === true,
    loading: candidate.loading === true,
    recentlyAccessed: candidate.recentlyAccessed !== false,
    autoDiscardable: candidate.autoDiscardable === true,
    sharingCamera: candidate.sharingCamera === true,
    sharingMicrophone: candidate.sharingMicrophone === true,
    sharingScreen: candidate.sharingScreen === true,
    fullscreen: candidate.fullscreen === true,
    safetyComplete: false,
    evaluatedAt: safeTimestamp(candidate.evaluatedAt, now)
  };
}

function safeTimestamp(value: unknown, fallback: number): number {
  return isFiniteNumber(value, 0, 31_536_000_000_000) ? value : fallback;
}

function futureTimestamp(value: unknown, now: number): number | undefined {
  return isFiniteNumber(value, now, now + 31_536_000_000) ? value : undefined;
}

function safeText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  return (normalized || fallback).slice(0, max);
}
