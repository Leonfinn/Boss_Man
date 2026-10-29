import { api } from "../api";
import { usePoll } from "../hooks";

export type WatchdogHealthData = { settings: { enabled: boolean }; lastSweepAt: string | null; trippedAt: string | null; trippedReason: string | null; openFlags: number };

const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** The one-line state of the watchdog, and whether it needs the owner's attention. */
export function healthLine(h: WatchdogHealthData, now = Date.now()): { text: string; tone: "" | "green" | "amber" | "red" } {
  if (h.trippedAt) return { text: `Watchdog: stopped itself (safety cap hit). Turn it back on in Settings.`, tone: "red" };
  if (!h.settings.enabled) return { text: "Watchdog: off", tone: "" };
  // A sweep runs every 5 minutes; a quarter of an hour without one means it isn't running.
  const ago = h.lastSweepAt ? mins(now - new Date(h.lastSweepAt).getTime()) : null;
  const check = ago === null ? "no check yet" : ago < 1 ? "last check just now" : `last check ${ago} min ago`;
  const handled = h.openFlags === 0 ? "no open issues" : `${h.openFlags} issue${h.openFlags === 1 ? "" : "s"} being handled`;
  return { text: `Watchdog: ${check} · ${handled}`, tone: ago !== null && ago > 15 ? "amber" : "green" };
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
