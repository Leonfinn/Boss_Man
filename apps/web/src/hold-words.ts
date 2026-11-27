import type { ReviewHold } from "./api";

/** "12 min", "3 h", "1 d 4 h": how long something has waited, for a "waiting for …" line. */
export function waitedFor(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * The words for a held merge (BOS-2870), said the same way on the ticket's hold banner and its Review box.
 * BOS-2713 showed the owner "Review: waiting for you" with Approve and merge while the CEO's hold was the
 * only thing in the way, and the owner's sign-off wasn't needed. These name who holds it and what it waits
 * for, and once that is done, who has to release it and for how long it has waited.
 */
export function holdWords(hold: ReviewHold, now = Date.now()): { who: string; headline: string; hint: string } {
  const who = hold.system ? "Boss Man" : hold.reviewer ?? "a reviewer";
  if (hold.ready) {
    if (hold.system) return { who, headline: "What it waited for is done; Boss Man releases it by itself.", hint: "Boss Man releases it by itself" };
    const since = hold.readySince ? ` (${waitedFor(now - Date.parse(hold.readySince))} so far)` : "";
    return { who, headline: `Waiting for ${who} to release it${since}. What it waited for is done.`, hint: `waiting for ${who} to release it${since}` };
  }
  const parts = hold.waits.filter((w) => !w.closed).map((w) => (w.kind === "ticket" ? `${w.label} ${hold.system ? "is merged and live" : "merges"}` : `${w.label} is answered`));
  // Every wait must close, or the date come (holdReady on the server): "A and B, or 19 Nov".
  const waits = parts.join(" and ");
  const day = hold.releaseAt ? shortDay(hold.releaseAt) : "";
  const until = [waits, day].filter(Boolean).join(", or ") || "it is re-checked";
  return { who, headline: `Held by ${who} until ${until}.`, hint: `held by ${who} until ${until}` };
}
