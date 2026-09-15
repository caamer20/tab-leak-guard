export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Returns the median absolute deviation (MAD), a robust measure of spread.
 * Unlike standard deviation it is not dominated by one short-lived spike,
 * which makes it useful when deciding whether recent DOM growth settled.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function robustSlopePerMinute(points: readonly { timeMs: number; value: number }[]): number {
  if (points.length < 2) return 0;
  const slopes: number[] = [];
  for (let left = 0; left < points.length - 1; left += 1) {
    const a = points[left];
    if (!a) continue;
    for (let right = left + 1; right < points.length; right += 1) {
      const b = points[right];
      if (!b) continue;
      const elapsedMinutes = (b.timeMs - a.timeMs) / 60_000;
      if (elapsedMinutes > 0) slopes.push((b.value - a.value) / elapsedMinutes);
    }
  }
  return median(slopes);
}
