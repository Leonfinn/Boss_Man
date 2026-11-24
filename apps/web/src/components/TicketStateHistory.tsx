import { api } from "../api";
import { usePoll } from "../hooks";
import { when } from "../pages/Runs";
import { Loader } from "./Loader";
import { LoadError } from "./LoadError";

export type StateChange = { from: string | null; to: string; at: string };
export type StateHistory = { state: string; complete: boolean; transitions: StateChange[] };

const LABEL: Record<string, string> = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "Review", done: "Done" };
export const stateLabel = (s: string | null) => (s === null ? "New" : (LABEL[s] ?? s));

/** "3 d 4 h", "2 h 5 min", "7 min", "40 s": two units at most. */
export function spanText(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Per transition, how long the ticket stayed in the state it moved into (the last one runs to now). */
export function stays(list: StateChange[], now = Date.now()) {
  return list.map((c, i) => ({ ...c, ms: (i + 1 < list.length ? Date.parse(list[i + 1]!.at) : now) - Date.parse(c.at), last: i + 1 === list.length }));
}

export function totals(list: StateChange[], now = Date.now()) {
  const s = stays(list, now);
  const sum = (...states: string[]) => s.filter((x) => states.includes(x.to)).reduce((a, x) => a + x.ms, 0);
  return {
    waiting: sum("backlog", "ready"),
    inProgress: sum("in_progress"),
    review: sum("review"),
    blocked: sum("blocked"),
    sentBack: list.filter((c) => c.from === "review" && c.to === "in_progress").length,
    started: list.find((c) => c.to === "in_progress")?.at ?? null,
    finished: [...list].reverse().find((c) => c.to === "done")?.at ?? null,
  };
}

/**
 * "State history" (BOS-2419): every state the ticket has been in, how long it stayed, and totals, so the owner can
 * see where a ticket's time went. A ticket older than the records shows where its history starts, not totals.
 */
export function TicketStateHistory({ ticketId }: { ticketId: string }) {
  const res = usePoll((signal) => api<StateHistory>(`/api/tickets/${ticketId}/state-history`, { signal }), 60_000, `state-history-${ticketId}`);
  if (!res.data) {
    if (res.error) return <LoadError what="the ticket's state history" message={res.error.message} onRetry={res.reload} />;
    return <Loader label="Loading state history" size={16} />;
  }
  const list = res.data.transitions;
  if (!Array.isArray(list) || list.length === 0) return null;
  const now = Date.now();
  const rows = stays(list, now);
  const t = totals(list, now);
  return (
    <details className="card" data-testid="ticket-state-history">
      <summary style={{ fontSize: 17, fontWeight: 600, cursor: "pointer" }}>State history</summary>
      {res.data.complete ? (
        <dl data-testid="state-history-totals" style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", margin: "8px 0" }}>
          {(
            [
              ["Backlog / Ready", spanText(t.waiting)],
              ["In progress", spanText(t.inProgress)],
              ["Review", spanText(t.review)],
              ["Blocked", spanText(t.blocked)],
              ["Sent back", `${t.sentBack} time${t.sentBack === 1 ? "" : "s"}`],
              ["First started", t.started ? when(t.started) : "not yet"],
              ["Finished", t.finished ? when(t.finished) : "not yet"],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="muted" style={{ fontSize: 12 }}>
                {k}
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted" data-testid="state-history-partial" style={{ margin: "8px 0" }}>
          History starts on {when(list[0]!.at)}. Earlier changes weren't recorded, so there are no totals.
        </p>
      )}
      <div style={{ overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>When</th>
              <th>Change</th>
              <th>Stayed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-testid="state-history-row">
                <td>{when(r.at)}</td>
                <td>
                  {stateLabel(r.from)} → {stateLabel(r.to)}
                </td>
                <td>{r.last ? `${spanText(r.ms)} so far` : spanText(r.ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
