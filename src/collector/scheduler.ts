import { MANUAL_SESSION_DURATION_MS } from "../shared/constants";

export type CollectorMode = "manual" | "continuous";
export type UserEditState = "no-edits-observed" | "edits-observed" | "unknown";

export { MANUAL_SESSION_DURATION_MS };
export const LONG_GAP_MINIMUM_MS = 5 * 60_000;

export type SampleDelayOptions = {
  seconds: number;
  immediate: boolean;
  cadenceMultiplier: number;
  random: () => number;
};

export function inferCollectorMode(monitoringEnabled: boolean): CollectorMode {
  return monitoringEnabled ? "continuous" : "manual";
}

export function initialUserEditState(
  mode: CollectorMode,
  injectedWhileLoading: boolean,
  editObservedDuringStartup: boolean
): UserEditState {
  if (editObservedDuringStartup) return "edits-observed";
  return mode === "continuous" && injectedWhileLoading ? "no-edits-observed" : "unknown";
}

export function nextSampleDelayMs(options: SampleDelayOptions): number {
  if (options.immediate) return 500;
  const seconds = clamp(finiteOr(options.seconds, 30), 10, 3_600);
  const multiplier = clamp(finiteOr(options.cadenceMultiplier, 1), 1, 8);
  const baseDelay = seconds * 1_000 * multiplier;
  const random = clamp(finiteOr(options.random(), 0.5), 0, 1);
  const jitter = baseDelay * (random * 0.2 - 0.1);
  return Math.max(250, baseDelay + jitter);
}

export function visibleTimerDriftMs(
  now: number,
  expectedAt: number | null,
  visible: boolean,
  suppressOnce: boolean,
  plannedDelayMs: number | null
): number | null {
  if (!visible || expectedAt === null || suppressOnce) return null;
  const drift = Math.max(0, now - expectedAt);
  const longGapThreshold = Math.max(LONG_GAP_MINIMUM_MS, (plannedDelayMs ?? 0) * 4);
  return drift >= longGapThreshold ? null : drift;
}

export function isLongSchedulingGap(
  now: number,
  expectedAt: number | null,
  plannedDelayMs: number | null
): boolean {
  if (expectedAt === null) return false;
  const drift = Math.max(0, now - expectedAt);
  return drift >= Math.max(LONG_GAP_MINIMUM_MS, (plannedDelayMs ?? 0) * 4);
}

export function isManualSessionExpired(
  mode: CollectorMode,
  now: number,
  expiresAt: number | null
): boolean {
  return mode === "manual" && expiresAt !== null && now >= expiresAt;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
