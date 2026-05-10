/**
 * Rate of Rise (RoR) computation.
 *
 * RoR is the smoothed time-derivative of bean temperature, expressed as °C/min.
 * We use a centered moving-average derivative: for each point, we look at the
 * temperature change over a symmetric time window and convert to per-minute.
 *
 * A centered window avoids the visible phase-lag of a trailing-only SMA while
 * still providing effective noise smoothing at typical ~2s polling intervals.
 */

export interface RoRPoint {
  tSec: number;
  btC: number;
}

/** Minimum time span (seconds) within the window to produce a value. */
const MIN_SPAN_SEC = 3;

/**
 * Compute Rate of Rise for each point in `points`.
 *
 * @param points  Chronologically ordered `{tSec, btC}` readings.
 * @param windowSec  Symmetric window size in seconds (default 30). The window
 *   extends ±windowSec/2 around each point.
 * @returns An array aligned 1:1 with `points`. Each entry is the RoR in °C/min
 *   or `null` if there isn't enough data in the window.
 */
export function computeRoR(
  points: readonly RoRPoint[],
  windowSec = 30,
): (number | null)[] {
  const n = points.length;
  if (n < 2) return points.map(() => null);

  const halfWindow = windowSec / 2;
  const result: (number | null)[] = new Array(n);

  // Two-pointer sweep: maintain [lo, hi) as the window around each center point.
  let lo = 0;
  let hi = 0;

  for (let i = 0; i < n; i++) {
    const center = points[i].tSec;
    const wStart = center - halfWindow;
    const wEnd = center + halfWindow;

    // Advance lo to the first point inside the window.
    while (lo < n && points[lo].tSec < wStart) lo++;
    // Advance hi to just past the last point inside the window.
    while (hi < n && points[hi].tSec <= wEnd) hi++;

    // hi is exclusive, so the window indices are [lo, hi - 1].
    const first = lo;
    const last = hi - 1;

    const span = points[last].tSec - points[first].tSec;

    if (last <= first || span < MIN_SPAN_SEC) {
      result[i] = null;
    } else {
      const deltaC = points[last].btC - points[first].btC;
      // Convert from °C/sec to °C/min.
      result[i] = (deltaC / span) * 60;
    }
  }

  return result;
}
