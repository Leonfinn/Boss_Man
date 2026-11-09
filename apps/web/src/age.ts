/** How long ago something was raised or updated, in the words the Decisions and Plan pages both use
 * (BOS-869): "just now", "4 min ago", "2h ago", "3d ago". */
export function ageLabel(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The age of an ISO timestamp, in the same words. */
export function raisedAgo(iso: string, now = Date.now()) {
  return ageLabel(now - new Date(iso).getTime());
}
