// Small pure helpers for the Settings → Devices list (BOS-2478): how long ago a screen was
// recorded, and whether the live window still matches its stored reading.
import type { DeviceMeasures } from "./api";

/** "today", "yesterday" or "N days ago", by calendar day in the viewer's time zone. */
export function recordedAgo(reportedAt: string, now: Date = new Date()): string {
  const then = new Date(reportedAt);
  if (Number.isNaN(then.getTime())) return "";
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.max(0, Math.round((startOf(now) - startOf(then)) / 86_400_000));
  if (days === 0) return "Recorded today";
  if (days === 1) return "Recorded yesterday";
  return `Recorded ${days} days ago`;
}

/**
 * True when the live window differs from the stored tallest reading: width or pixel ratio changed,
 * or height changed by more than 10% (the browser's own bars move the height a little).
 */
export function screenChanged(live: Pick<DeviceMeasures, "width" | "height" | "pixelRatio">, stored: Pick<DeviceMeasures, "width" | "height" | "pixelRatio">): boolean {
  if (live.width !== stored.width) return true;
  if (live.pixelRatio !== stored.pixelRatio) return true;
  return stored.height > 0 ? Math.abs(live.height - stored.height) / stored.height > 0.1 : live.height !== stored.height;
}
