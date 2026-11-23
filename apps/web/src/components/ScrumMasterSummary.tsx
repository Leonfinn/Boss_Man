import { WATCHDOG_ACTION_LABEL } from "@boss-man/shared";
import type { SmAction } from "./ScrumMasterLog";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** How many actions the page asks for; a full load that stops short of 7 days is said to be partial. */
export const SUMMARY_LIMIT = 500;

export type SmSummary = {
  total: number;
  kinds: Array<{ label: string; count: number }>;
  tickets: Array<{ ref: string; ticketId: string | null; count: number }>;
  agents: Array<{ name: string; count: number }>;
  undone: number;
  /** Set when the loaded actions are a full page that doesn't reach back 7 days: the oldest one's date. */
  partialBack: string | null;
};

/** Counts of the last 7 days of loaded actions (newest first, as the feed comes). */
export function summarizeActions(actions: SmAction[], now: Date = new Date(), limit: number = SUMMARY_LIMIT): SmSummary {
  const since = now.getTime() - WEEK_MS;
  const inWeek = actions.filter((a) => new Date(a.createdAt).getTime() >= since);
  const kinds = new Map<string, number>();
  const tickets = new Map<string, { ref: string; ticketId: string | null; count: number }>();
  const agents = new Map<string, number>();
  let undone = 0;
  for (const a of inWeek) {
    const label = (WATCHDOG_ACTION_LABEL as Record<string, string | undefined>)[a.kind] ?? "Something happened";
    kinds.set(label, (kinds.get(label) ?? 0) + 1);
    if (a.ticketRef) {
      const t = tickets.get(a.ticketRef) ?? { ref: a.ticketRef, ticketId: a.ticketId, count: 0 };
      t.count++;
      tickets.set(a.ticketRef, t);
    }
    const who = a.targetName?.trim();
    if (who) agents.set(who, (agents.get(who) ?? 0) + 1);
    if (a.undoneAt) undone++;
  }
  const byCount = <T extends { count: number }>(l: T[]) => l.sort((x, y) => y.count - x.count);
  let partialBack: string | null = null;
  if (actions.length >= limit) {
    const oldest = actions.reduce((m, a) => (a.createdAt < m ? a.createdAt : m), actions[0]!.createdAt);
    if (new Date(oldest).getTime() > since) partialBack = oldest;
  }
  return {
    total: inWeek.length,
    kinds: byCount([...kinds].map(([label, count]) => ({ label, count }))),
    tickets: byCount([...tickets.values()]).slice(0, 5),
    agents: byCount([...agents].map(([name, count]) => ({ name, count }))).slice(0, 5),
    undone,
    partialBack,
  };
}

/** "Last 7 days" fold above the Scrum Master log: what the watchdog mostly did, who it poked, and how much you undid. */
export function ScrumMasterSummary({ actions, now }: { actions: SmAction[]; now?: Date }) {
  if (!actions.length) return null;
  const s = summarizeActions(actions, now);
  const share = s.total ? Math.round((s.undone / s.total) * 100) : 0;
  return (
    <details open className="card" style={{ padding: "10px 14px", marginBottom: 12 }}>
      <summary className="fold-title" style={{ cursor: "pointer" }}>Last 7 days</summary>
      {s.partialBack && <p className="muted">Based on the newest {SUMMARY_LIMIT} actions (back to {new Date(s.partialBack).toLocaleDateString(undefined, { day: "numeric", month: "short" })}).</p>}
      {!s.total ? (
        <p className="muted">No actions in the last 7 days.</p>
      ) : (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 14 }}>
          <div>
            <p className="label" style={{ margin: 0 }}>Actions ({s.total})</p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {s.kinds.map((k) => (
                <li key={k.label}>{k.count} × {k.label}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="label" style={{ margin: 0 }}>Most acted-on tickets</p>
            {s.tickets.length ? (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {s.tickets.map((t) => (
                  <li key={t.ref}>
                    {t.ticketId ? <a href={`#/tickets/${t.ticketId}`}>{t.ref}</a> : t.ref} · {t.count}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None.</p>
            )}
          </div>
          <div>
            <p className="label" style={{ margin: 0 }}>Most acted-on agents</p>
            {s.agents.length ? (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {s.agents.map((a) => (
                  <li key={a.name}>{a.name} · {a.count}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">None.</p>
            )}
          </div>
          <div>
            <p className="label" style={{ margin: 0 }}>Undone</p>
            <p style={{ margin: 0 }}>{s.undone} undone by you ({share}% of all actions)</p>
          </div>
        </div>
      )}
    </details>
  );
}
