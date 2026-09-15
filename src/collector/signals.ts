import { saturatingAdd } from "./budget-controller";

export type SignalStatus = "collected" | "unavailable" | "failed" | "overflowed" | "stale";

export type ResourceActivitySnapshot = {
  activityCount: number | null;
  droppedEntriesSinceLastSample: number;
  status: SignalStatus;
};

const MAX_RESOURCE_ACTIVITY_COUNT = 10_000_000;

/**
 * Resource timing entries are network/resource activity, not retained bytes.
 * This tracker deliberately uses activity terminology and exposes data loss.
 */
export class ResourceActivityTracker {
  private activityCount: number | null;
  private droppedEntriesSinceLastSample = 0;
  private status: SignalStatus;

  constructor(initialCount: number | null, supported: boolean) {
    this.activityCount = supported ? normalizeCount(initialCount) : null;
    this.status = supported ? "collected" : "unavailable";
  }

  record(entryCount: number, droppedEntries = 0): void {
    if (this.status === "unavailable" || this.status === "failed") return;
    const entries = normalizeCount(entryCount) ?? 0;
    const dropped = normalizeCount(droppedEntries) ?? 0;
    this.activityCount = saturatingAdd(this.activityCount ?? 0, entries, MAX_RESOURCE_ACTIVITY_COUNT);
    this.droppedEntriesSinceLastSample = saturatingAdd(
      this.droppedEntriesSinceLastSample,
      dropped,
      MAX_RESOURCE_ACTIVITY_COUNT
    );
    this.status = dropped > 0 ? "overflowed" : "collected";
  }

  markFailed(): void {
    this.activityCount = null;
    this.status = "failed";
  }

  markStale(): void {
    if (this.status === "collected") this.status = "stale";
  }

  consumeSample(): ResourceActivitySnapshot {
    const snapshot = this.snapshot();
    this.droppedEntriesSinceLastSample = 0;
    if (this.status === "overflowed") this.status = "collected";
    return snapshot;
  }

  snapshot(): ResourceActivitySnapshot {
    return {
      activityCount: this.activityCount,
      droppedEntriesSinceLastSample: this.droppedEntriesSinceLastSample,
      status: this.status
    };
  }
}

export function readDroppedEntriesCount(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  try {
    const candidate = Reflect.get(value, "droppedEntriesCount");
    return normalizeCount(candidate) ?? 0;
  } catch {
    return 0;
  }
}

function normalizeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_RESOURCE_ACTIVITY_COUNT, Math.floor(value));
}
