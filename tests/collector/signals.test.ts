import { describe, expect, it } from "vitest";
import {
  readDroppedEntriesCount,
  ResourceActivityTracker
} from "../../src/collector/signals";

describe("resource activity signal", () => {
  it("uses activity terminology and reports unavailable collectors", () => {
    const tracker = new ResourceActivityTracker(null, false);
    expect(tracker.snapshot()).toEqual({
      activityCount: null,
      droppedEntriesSinceLastSample: 0,
      status: "unavailable"
    });
  });

  it("surfaces dropped observations for exactly the affected sample", () => {
    const tracker = new ResourceActivityTracker(10, true);
    tracker.record(4, 3);

    expect(tracker.consumeSample()).toEqual({
      activityCount: 14,
      droppedEntriesSinceLastSample: 3,
      status: "overflowed"
    });
    expect(tracker.consumeSample()).toEqual({
      activityCount: 14,
      droppedEntriesSinceLastSample: 0,
      status: "collected"
    });
  });

  it("fails closed when observer processing fails", () => {
    const tracker = new ResourceActivityTracker(10, true);
    tracker.markFailed();
    tracker.record(100, 0);
    expect(tracker.snapshot()).toMatchObject({ activityCount: null, status: "failed" });
  });

  it("marks only a healthy collected signal stale", () => {
    const collected = new ResourceActivityTracker(10, true);
    collected.markStale();
    expect(collected.snapshot().status).toBe("stale");

    const overflowed = new ResourceActivityTracker(10, true);
    overflowed.record(1, 1);
    overflowed.markStale();
    expect(overflowed.snapshot().status).toBe("overflowed");

    const unavailable = new ResourceActivityTracker(null, false);
    unavailable.record(100, 100);
    unavailable.markStale();
    expect(unavailable.snapshot()).toEqual({
      activityCount: null,
      droppedEntriesSinceLastSample: 0,
      status: "unavailable"
    });
  });

  it("normalizes hostile counts and saturates activity rather than overflowing", () => {
    const tracker = new ResourceActivityTracker(Number.NaN, true);
    expect(tracker.snapshot().activityCount).toBeNull();

    tracker.record(-10, Number.POSITIVE_INFINITY);
    expect(tracker.snapshot()).toEqual({
      activityCount: 0,
      droppedEntriesSinceLastSample: 0,
      status: "collected"
    });

    tracker.record(20_000_000.9, 20_000_000.9);
    expect(tracker.consumeSample()).toEqual({
      activityCount: 10_000_000,
      droppedEntriesSinceLastSample: 10_000_000,
      status: "overflowed"
    });
  });

  it("validates droppedEntriesCount without trusting callback objects", () => {
    expect(readDroppedEntriesCount({ droppedEntriesCount: 8.9 })).toBe(8);
    expect(readDroppedEntriesCount({ droppedEntriesCount: -1 })).toBe(0);
    expect(readDroppedEntriesCount({ droppedEntriesCount: "8" })).toBe(0);
    expect(readDroppedEntriesCount(null)).toBe(0);
    expect(readDroppedEntriesCount("not an observer list")).toBe(0);
    expect(
      readDroppedEntriesCount(
        new Proxy({}, { get: () => { throw new Error("hostile getter"); } })
      )
    ).toBe(0);
  });
});
