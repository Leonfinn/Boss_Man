import { api } from "../api";
import { usePoll } from "../hooks";
import { when } from "../pages/Runs";
import { Loader } from "./Loader";
import { LoadError } from "./LoadError";

export type TicketCheck = {
  id: string;
  what: "quick" | "full" | "merge";
  state: string;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  machine: string | null;
  firstLine: string | null;
};

/** How long a check took, or has been running; blank for one that never started. */
export function checkLength(c: Pick<TicketCheck, "startedAt" | "endedAt">, now = Date.now()) {
  if (!c.startedAt) return "";
  const secs = Math.max(0, Math.round(((c.endedAt ? Date.parse(c.endedAt) : now) - Date.parse(c.startedAt)) / 1000));
  if (secs < 60) return `${secs} s`;
  const m = Math.floor(secs / 60);
  return m < 60 ? `${m} min ${secs % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const WHAT = { quick: "Quick check", full: "Full check", merge: "Merge check" } as const;
const SHOWN = 10;

function Row({ c }: { c: TicketCheck }) {
  return (
    <tr data-testid="ticket-check-row">
      <td>{when(c.endedAt ?? c.startedAt ?? c.queuedAt)}</td>
      <td>{WHAT[c.what] ?? c.what}</td>
      <td>{c.state}</td>
      <td>{checkLength(c)}</td>
      <td>{c.machine ?? ""}</td>
      <td style={{ overflowWrap: "anywhere" }}>{c.firstLine ? <code>{c.firstLine}</code> : ""}</td>
    </tr>
  );
}

function Table({ rows }: { rows: TicketCheck[] }) {
  return (
    <table className="table" style={{ width: "100%" }}>
      <thead>
        <tr>
          <th>When</th>
          <th>What</th>
          <th>Result</th>
          <th>How long</th>
          <th>Where it ran</th>
          <th>First failing line</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <Row key={c.id} c={c} />
        ))}
      </tbody>
    </table>
  );
}

/**
 * "Checks" (BOS-2371): every quick, full and merge check the ticket has had, newest first, so the owner can read
 * why a ticket keeps bouncing without asking an agent. Hidden when the ticket has had none. Read-only.
 */
export function TicketChecks({ ticketId }: { ticketId: string }) {
  const res = usePoll((signal) => api<{ checks: TicketCheck[] }>(`/api/tickets/${ticketId}/checks`, { signal }), 60_000, `checks-${ticketId}`);
  if (!res.data) {
    if (res.error) return <LoadError what="the ticket's checks" message={res.error.message} onRetry={res.reload} />;
    return <Loader label="Loading checks" size={16} />;
  }
  const checks = res.data.checks;
  if (!Array.isArray(checks) || checks.length === 0) return null;
  const older = checks.slice(SHOWN);
  return (
    <section className="card" aria-label="Checks" data-testid="ticket-checks">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Checks</h2>
      <div style={{ overflowX: "auto" }}>
        <Table rows={checks.slice(0, SHOWN)} />
      </div>
      {older.length > 0 && (
        <details data-testid="ticket-checks-older">
          <summary>
            {older.length} older check{older.length === 1 ? "" : "s"}
          </summary>
          <div style={{ overflowX: "auto" }}>
            <Table rows={older} />
          </div>
        </details>
      )}
    </section>
  );
}
