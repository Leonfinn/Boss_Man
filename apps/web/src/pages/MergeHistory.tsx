// Merge history (BOS-2379): the merges of the last 14 days, newest first, with how long each waited, how long its
// check ran, any wait for GitHub CI and, for a bounce, the first failing line. Read-only.
import { useState } from "react";
import type { Company } from "../api";
import { api } from "../api";
import { usePoll } from "../hooks";
import { Loader } from "../components/Loader";

type Result = "landed" | "bounced" | "cancelled";
type Row = {
  ticketId: string; ref: string | null; title: string; result: Result; queuedAt: string; endedAt: string;
  totalMs: number | null; slotWaitMs: number | null; checkMs: number | null; ranOn: string | null; ciWaitMs: number | null;
  bounceReason: string | null; firstFailingLine: string | null; bounces: number;
};
type Day = { day: string; landed: number; bounced: number; medianMs: number | null };
type Data = { days: number; rows: Row[]; perDay: Day[] };

/** "45s", "12m", "1h 20m". */
export function duration(ms: number | null): string {
  if (ms === null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const RESULT_LABEL: Record<Result, string> = { landed: "Landed", bounced: "Bounced", cancelled: "Cancelled" };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function MergeHistory({ companies, companyId }: { companies: Company[]; companyId: string | undefined }) {
  const company = companies.find((c) => c.id === companyId);
  const [result, setResult] = useState<"all" | Result>("all");
  const [repeat, setRepeat] = useState(false);
  const poll = usePoll((signal) => (companyId ? api<Data>(`/api/companies/${companyId}/merge-history`, { signal }) : Promise.resolve(null)), 60_000, `merge-history-${companyId}`);
  if (!companyId) return <p className="muted">Pick a company to see its merge history.</p>;
  const data = poll.data;
  const rows = data ? data.rows.filter((r) => (result === "all" || r.result === result) && (!repeat || r.bounces > 1)) : [];
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Merge history</h1>
          {company && <p className="sub">{company.name}: every merge of the last {data?.days ?? 14} days.</p>}
          <p><a href={`#/merge-queue/${companyId}`}>Back to the Merge queue</a></p>
        </div>
      </header>
      {poll.error && !data ? <p className="banner" role="alert">Couldn't load the merge history. It will try again shortly.</p> : !data ? <Loader label="Loading the merge history" /> : (
        <>
          {data.perDay.length > 0 && (
            <ul aria-label="Per day">
              {data.perDay.map((d) => (
                <li key={d.day}>{d.day}: {d.landed} landed, {d.bounced} bounced{d.medianMs !== null ? `, median ${duration(d.medianMs)} from queued to landed` : ""}</li>
              ))}
            </ul>
          )}
          <div className="filters">
            <label>Result{" "}
              <select aria-label="Result" value={result} onChange={(e) => setResult(e.target.value as "all" | Result)}>
                <option value="all">All</option>
                <option value="landed">Landed</option>
                <option value="bounced">Bounced</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>{" "}
            <label><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Only tickets that bounced more than once</label>
          </div>
          {rows.length === 0 ? <p className="muted">No merges match.</p> : (
            <table>
              <thead>
                <tr><th>Ticket</th><th>Result</th><th>Queued</th><th>Waited for a slot</th><th>Check</th><th>Waited for GitHub CI</th><th>Why it bounced</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.ticketId}-${r.queuedAt}`}>
                    <td><a href={`#/tickets/${r.ticketId}`}>{r.ref ? `${r.ref}: ` : ""}{r.title}</a></td>
                    <td>{RESULT_LABEL[r.result]}{r.result === "landed" && r.totalMs !== null ? ` (${duration(r.totalMs)} in all)` : ""}</td>
                    <td>{when(r.queuedAt)}</td>
                    <td>{duration(r.slotWaitMs)}</td>
                    <td>{r.checkMs !== null ? `${duration(r.checkMs)}${r.ranOn ? ` on ${r.ranOn}` : ""}` : "-"}</td>
                    <td>{r.ciWaitMs !== null ? duration(r.ciWaitMs) : "-"}</td>
                    <td>{r.result === "bounced" ? (r.firstFailingLine ?? r.bounceReason ?? "-") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
