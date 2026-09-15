export type Clock = () => number;

export type MutationBatchRecord<T> = {
  addedNodes: Iterable<T>;
  removedNodes: Iterable<T>;
};

export type MutationExhaustionReason = "nodes" | "time" | null;

export type MutationBatchResult = {
  addedNodes: number;
  removedNodes: number;
  processedNodes: number;
  durationMs: number;
  overflowed: boolean;
  exhaustedBy: MutationExhaustionReason;
};

export type MutationBudget = {
  maxNodes: number;
  maxDurationMs: number;
  maximumReportedNodes: number;
};

export type WalkElements<T> = (root: T, visit: () => boolean) => void;

export const DEFAULT_MUTATION_BUDGET: MutationBudget = {
  maxNodes: 5_000,
  maxDurationMs: 4,
  maximumReportedNodes: 100_000_000
};

/**
 * Counts every mutation record against one shared node/time budget. The return
 * value contains only numbers, so page Nodes cannot escape the observer
 * callback through this helper.
 */
export function countMutationBatch<T>(
  records: Iterable<MutationBatchRecord<T>>,
  walkElements: WalkElements<T>,
  budget: MutationBudget = DEFAULT_MUTATION_BUDGET,
  now: Clock = defaultNow
): MutationBatchResult {
  const normalized = normalizeMutationBudget(budget);
  const startedAt = now();
  let addedNodes = 0;
  let removedNodes = 0;
  let processedNodes = 0;
  let exhaustedBy: MutationExhaustionReason = null;

  const consume = (kind: "added" | "removed") => {
    if (processedNodes >= normalized.maxNodes) {
      exhaustedBy = "nodes";
      return false;
    }
    if (now() - startedAt >= normalized.maxDurationMs) {
      exhaustedBy = "time";
      return false;
    }
    processedNodes += 1;
    if (kind === "added") {
      addedNodes = saturatingAdd(addedNodes, 1, normalized.maximumReportedNodes);
    } else {
      removedNodes = saturatingAdd(removedNodes, 1, normalized.maximumReportedNodes);
    }
    return true;
  };

  outer: for (const record of records) {
    for (const root of record.addedNodes) {
      walkElements(root, () => consume("added"));
      if (exhaustedBy) break outer;
    }
    for (const root of record.removedNodes) {
      walkElements(root, () => consume("removed"));
      if (exhaustedBy) break outer;
    }
  }

  const durationMs = Math.max(0, now() - startedAt);
  if (!exhaustedBy && durationMs >= normalized.maxDurationMs) exhaustedBy = "time";
  return {
    addedNodes,
    removedNodes,
    processedNodes,
    durationMs,
    overflowed: exhaustedBy !== null,
    exhaustedBy
  };
}

export function saturatingAdd(current: number, increment: number, maximum: number): number {
  const safeMaximum = Math.max(0, finiteOr(maximum, 0));
  const safeCurrent = clamp(finiteOr(current, 0), 0, safeMaximum);
  const safeIncrement = Math.max(0, finiteOr(increment, 0));
  return Math.min(safeMaximum, safeCurrent + safeIncrement);
}

export type BudgetControllerOptions = {
  mutationDurationBudgetMs: number;
  recountDurationBudgetMs: number;
  sampleDurationBudgetMs: number;
  mutationBreachesBeforeSuspension: number;
  mutationSuspensionMs: number;
};

export type BudgetHealth = "healthy" | "degraded";

export type BudgetHealthSnapshot = {
  health: BudgetHealth;
  cadenceMultiplier: 1 | 2 | 4;
  consecutiveMutationBreaches: number;
  recentBudgetPressure: number;
  mutationCallbacks: number;
  mutationOverflows: number;
  maxMutationDurationMs: number;
  maxRecountDurationMs: number;
  maxSampleDurationMs: number;
};

export const DEFAULT_BUDGET_CONTROLLER_OPTIONS: BudgetControllerOptions = {
  mutationDurationBudgetMs: DEFAULT_MUTATION_BUDGET.maxDurationMs,
  recountDurationBudgetMs: 20,
  sampleDurationBudgetMs: 5,
  mutationBreachesBeforeSuspension: 3,
  mutationSuspensionMs: 30_000
};

/** Tracks bounded local health without retaining page data or DOM references. */
export class CollectorBudgetController {
  readonly mutationSuspensionMs: number;
  private readonly options: BudgetControllerOptions;
  private consecutiveMutationBreaches = 0;
  private recentBudgetPressure = 0;
  private mutationCallbacks = 0;
  private mutationOverflows = 0;
  private maxMutationDurationMs = 0;
  private maxRecountDurationMs = 0;
  private maxSampleDurationMs = 0;

  constructor(options: Partial<BudgetControllerOptions> = {}) {
    this.options = normalizeControllerOptions({
      ...DEFAULT_BUDGET_CONTROLLER_OPTIONS,
      ...options
    });
    this.mutationSuspensionMs = this.options.mutationSuspensionMs;
  }

  recordMutation(durationMs: number, overflowed: boolean): boolean {
    const duration = Math.max(0, finiteOr(durationMs, this.options.mutationDurationBudgetMs));
    const breached = overflowed || duration >= this.options.mutationDurationBudgetMs;
    this.mutationCallbacks += 1;
    this.maxMutationDurationMs = Math.max(this.maxMutationDurationMs, duration);
    if (overflowed) this.mutationOverflows += 1;
    if (breached) {
      this.consecutiveMutationBreaches += 1;
      this.recentBudgetPressure = Math.min(8, this.recentBudgetPressure + 2);
    } else {
      this.consecutiveMutationBreaches = 0;
      this.recentBudgetPressure = Math.max(0, this.recentBudgetPressure - 1);
    }
    if (this.consecutiveMutationBreaches < this.options.mutationBreachesBeforeSuspension) return false;
    this.consecutiveMutationBreaches = 0;
    return true;
  }

  recordRecount(durationMs: number, failed = false): void {
    const duration = Math.max(0, finiteOr(durationMs, this.options.recountDurationBudgetMs));
    this.maxRecountDurationMs = Math.max(this.maxRecountDurationMs, duration);
    this.recordPressure(failed || duration >= this.options.recountDurationBudgetMs);
  }

  recordSample(durationMs: number, failed = false): void {
    const duration = Math.max(0, finiteOr(durationMs, this.options.sampleDurationBudgetMs));
    this.maxSampleDurationMs = Math.max(this.maxSampleDurationMs, duration);
    this.recordPressure(failed || duration >= this.options.sampleDurationBudgetMs);
  }

  markDegraded(): void {
    this.recentBudgetPressure = Math.min(8, this.recentBudgetPressure + 2);
  }

  forceBackoff(): void {
    this.recentBudgetPressure = 8;
    this.consecutiveMutationBreaches = 0;
  }

  snapshot(): BudgetHealthSnapshot {
    return {
      health: this.recentBudgetPressure > 0 ? "degraded" : "healthy",
      cadenceMultiplier: this.recentBudgetPressure >= 6 ? 4 : this.recentBudgetPressure >= 3 ? 2 : 1,
      consecutiveMutationBreaches: this.consecutiveMutationBreaches,
      recentBudgetPressure: this.recentBudgetPressure,
      mutationCallbacks: this.mutationCallbacks,
      mutationOverflows: this.mutationOverflows,
      maxMutationDurationMs: this.maxMutationDurationMs,
      maxRecountDurationMs: this.maxRecountDurationMs,
      maxSampleDurationMs: this.maxSampleDurationMs
    };
  }

  private recordPressure(breached: boolean): void {
    this.recentBudgetPressure = breached
      ? Math.min(8, this.recentBudgetPressure + 2)
      : Math.max(0, this.recentBudgetPressure - 1);
  }
}

function normalizeMutationBudget(value: MutationBudget): MutationBudget {
  return {
    maxNodes: Math.max(1, Math.floor(finiteOr(value.maxNodes, DEFAULT_MUTATION_BUDGET.maxNodes))),
    maxDurationMs: Math.max(0.1, finiteOr(value.maxDurationMs, DEFAULT_MUTATION_BUDGET.maxDurationMs)),
    maximumReportedNodes: Math.max(
      1,
      Math.floor(finiteOr(value.maximumReportedNodes, DEFAULT_MUTATION_BUDGET.maximumReportedNodes))
    )
  };
}

function normalizeControllerOptions(value: BudgetControllerOptions): BudgetControllerOptions {
  return {
    mutationDurationBudgetMs: Math.max(0.1, finiteOr(value.mutationDurationBudgetMs, 4)),
    recountDurationBudgetMs: Math.max(0.1, finiteOr(value.recountDurationBudgetMs, 20)),
    sampleDurationBudgetMs: Math.max(0.1, finiteOr(value.sampleDurationBudgetMs, 5)),
    mutationBreachesBeforeSuspension: Math.max(
      1,
      Math.floor(finiteOr(value.mutationBreachesBeforeSuspension, 3))
    ),
    mutationSuspensionMs: Math.max(1_000, finiteOr(value.mutationSuspensionMs, 30_000))
  };
}

function defaultNow(): number {
  return performance.now();
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
