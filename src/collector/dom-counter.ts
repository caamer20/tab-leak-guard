export type BoundedNodeCount = {
  count: number | null;
  visitedNodes: number;
  activeDurationMs: number;
  complete: boolean;
};

export type BoundedNodeCountOptions = {
  nextNode: () => Node | null;
  now: () => number;
  yieldControl: () => Promise<void>;
  signal: AbortSignal;
  sliceBudgetMs: number;
  totalBudgetMs: number;
  maxNodesPerSlice: number;
  maxSlices: number;
  maxNodes: number;
  clockCheckEvery?: number;
};

/**
 * Cooperatively count a DOM-like cursor without retaining visited nodes.
 * Incomplete work is deliberately censored (`count: null`) so downstream
 * detection cannot mistake a lower bound for an exact live-node count.
 */
export async function countNodesBounded(
  options: BoundedNodeCountOptions
): Promise<BoundedNodeCount> {
  const clockCheckEvery = Math.max(1, options.clockCheckEvery ?? 32);
  let visitedNodes = 0;
  let activeDurationMs = 0;
  let slices = 0;

  while (
    !options.signal.aborted &&
    slices < options.maxSlices &&
    visitedNodes < options.maxNodes &&
    activeDurationMs < options.totalBudgetMs
  ) {
    const sliceStartedAt = options.now();
    let sliceNodes = 0;
    while (sliceNodes < options.maxNodesPerSlice) {
      if (options.signal.aborted) return incomplete(visitedNodes, activeDurationMs);
      const node = options.nextNode();
      if (node === null) {
        activeDurationMs += Math.max(0, options.now() - sliceStartedAt);
        return {
          count: visitedNodes,
          visitedNodes,
          activeDurationMs,
          complete: true
        };
      }
      visitedNodes += 1;
      sliceNodes += 1;
      if (visitedNodes >= options.maxNodes) {
        activeDurationMs += Math.max(0, options.now() - sliceStartedAt);
        return incomplete(visitedNodes, activeDurationMs);
      }
      if (
        sliceNodes % clockCheckEvery === 0 &&
        options.now() - sliceStartedAt >= options.sliceBudgetMs
      ) break;
    }
    activeDurationMs += Math.max(0, options.now() - sliceStartedAt);
    slices += 1;
    if (
      options.signal.aborted ||
      activeDurationMs >= options.totalBudgetMs ||
      slices >= options.maxSlices
    ) break;
    await options.yieldControl();
  }

  return incomplete(visitedNodes, activeDurationMs);
}

function incomplete(visitedNodes: number, activeDurationMs: number): BoundedNodeCount {
  return { count: null, visitedNodes, activeDurationMs, complete: false };
}
