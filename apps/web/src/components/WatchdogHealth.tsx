import { api } from "../api";
import { ageLabel } from "../age";
import { usePoll } from "../hooks";

export type WatchdogHealthData = { settings: { enabled: boolean; recordOnly?: boolean }; lastSweepAt: string | null; trippedAt: string | null; pausedUntil?: string | null; trippedReason: string | null; openFlags: number };

const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** The one-line state of the watchdog, and whether it needs the owner's attention. */
export function healthLine(h: WatchdogHealthData, now = Date.now()): { text: string; tone: "" | "green" | "amber" | "red" } {
  if (!h.settings.enabled) return h.trippedAt ? { text: "Watchdog: stopped itself (safety cap hit). Turn it back on in Settings.", tone: "red" } : { text: "Watchdog: off", tone: "" };
  if (h.pausedUntil && new Date(h.pausedUntil).getTime() > now) return { text: `Watchdog: paused after hitting its hourly limit, back in ${mins(new Date(h.pausedUntil).getTime() - now)} min. Nothing to do.`, tone: "amber" };
  // A sweep runs every 5 minutes; a quarter of an hour without one means it isn't running.
  const lastSweep = h.lastSweepAt ? new Date(h.lastSweepAt).getTime() : null;
  const late = lastSweep !== null && now - lastSweep > 15 * 60_000;
  const check = lastSweep === null ? "no check yet" : ageLabel(now - lastSweep) === "just now" ? "last check just now" : `last check ${ageLabel(now - lastSweep)}`;
  const handled = h.openFlags === 0 ? "no open issues" : `${h.openFlags} issue${h.openFlags === 1 ? "" : "s"} being handled`;
  // Record only (BOS-166): it is watching, but it reaches nobody, so the line says so.
  if (h.settings.recordOnly) return { text: `Watchdog: record only (not acting) · ${check} · ${handled}`, tone: late ? "amber" : "" };
  return { text: `Watchdog: ${check} · ${handled}`, tone: late ? "amber" : "green" };
}

/** The watchdog's health on the board; links to the Scrum Master's activity. */
export function WatchdogHealth({ companyId }: { companyId: string }) {
  const s = usePoll((signal) => api<WatchdogHealthData>(`/api/companies/${companyId}/watchdog`, { signal }), 30_000, `watchdog-health-${companyId}`);
  // The board must never fail because the health line did.
  if (!s.data?.settings) return null;
  const h = healthLine(s.data);
  return (
    <a
      href={`#/scrum-master/${companyId}`}
      className={`tag ${h.tone}`}
      aria-label="Watchdog health"
      style={{ textDecoration: "none" }}
      onClick={() => setTimeout(() => document.getElementById("open-now")?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 100)}
    >
      {h.text}
    </a>
  );
}
