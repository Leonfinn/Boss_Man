import { runLabel, type RunOrigin } from "@boss-man/shared";
import { api, usd, type Company, type RunRow } from "../api";
import { usePoll } from "../hooks";

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

const REASON_LABEL: Record<string, string> = {
  assigned: "Was given the task",
  "woken by owner": "You woke it",
  message: "Your message",
  owner_chat: "Chat with you",
  chat: "Chat with you",
  decision: "Answering a decision",
  "decision answered": "Your answer to its question",
  feedback: "New feedback to triage",
  chased: "Chased: something is waiting on it",
  unblocked: "Its task was unblocked",
  resume: "Picking up after a restart",
  engagement: "Another company's request",
  "deploy rejected": "You rejected its deploy",
  review: "Review feedback",
  reviewer: "Asked to review",
  "changes requested": "Changes requested",
  "verify failed": "Its merge check failed",
  "deploy approved": "You approved its deploy",
};

/**
 * Why a run started, in words, from the wake that launched it. A run with a ticket shows its
 * ticket above this; a run without one uses the shared label (BOS-118).
 */
export function whyRun(r: RunRow) {
  if (r.ticketId) {
    if (r.purpose === "chat") return r.endedAt ? "Answered the owner in chat" : "Answering the owner in chat";
    if (!r.reason) return "";
    return REASON_LABEL[r.reason] ?? r.reason[0]!.toUpperCase() + r.reason.slice(1);
  }
  return runLabel(r).text;
}

/**
 * What a run without a ticket was doing: the shared label, linking the run it started and the
 * ticket it was about when one was named (BOS-118).
 */
export function RunLabelLink({ run, className, title }: { run: Pick<RunRow, "id" | "ticketId" | "note"> & RunOrigin; className?: string; title?: string }) {
  const label = runLabel(run);
  return (
    <>
      <a href={`#/runs/${run.id}`} className={className} title={title ?? run.note ?? undefined}>
        {label.text}
      </a>
      {label.ticketId && label.ticketId !== run.ticketId && (
        <>
          {" · "}
          <a href={`#/tickets/${label.ticketId}`}>its ticket</a>
        </>
      )}
    </>
  );
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". */
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** On a subscription a run costs allowance, not money, so it shows tokens; API credit shows cost (R67). */
export function usage(r: RunRow) {
  if (r.fundingKind !== "subscription") return { text: usd(r.costMicros ?? 0), title: undefined };
  // Runs from before token counts were recorded (R67) still show what paid for them.
  if (r.inputTokens == null || r.outputTokens == null) return { text: "Subscription", title: "Paid by the subscription. This run's token use wasn't recorded." };
  return {
    text: `${tokens(r.inputTokens)} in · ${tokens(r.outputTokens)} out`,
    title: `${r.inputTokens.toLocaleString()} input and ${r.outputTokens.toLocaleString()} output tokens; ${(r.cachedReadTokens ?? 0).toLocaleString()} read from the cache and ${(r.cachedWriteTokens ?? 0).toLocaleString()} written to it.`,
  };
}

/** A run's result in a few words: errors and interruptions stand out. */
export function outcomeTag(outcome: string | null | undefined) {
  if (!outcome) return <span className="tag blue">Running</span>;
  if (outcome.startsWith("error")) return <span className="tag red">Failed</span>;
  if (outcome === "interrupted") return <span className="tag amber">Interrupted</span>;
  if (outcome === "cancelled" || outcome.startsWith("stopped")) return <span className="tag">Stopped</span>;
  if (outcome.startsWith("lost")) return <span className="tag amber">Lost</span>;
  return <span className="tag green">Finished</span>;
}

function RunTable({ rows, companies, finished }: { rows: RunRow[]; companies: Company[]; finished: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{finished ? "Ended" : "Started"}</th>
            <th scope="col">Agent</th>
            <th scope="col">What for</th>
            <th scope="col">Model</th>
            <th scope="col">Result</th>
            {finished && <th scope="col" style={{ textAlign: "right" }}>Used</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono muted">
                <a href={`#/runs/${r.id}`}>{when(finished ? r.endedAt : r.startedAt)}</a>
              </td>
              <td>
                {r.agent ?? "An agent"}
                <span className="muted"> · {companies.find((c) => c.id === r.companyId)?.name}</span>
              </td>
              <td>
                {r.ticket && r.ticketId ? <a href={`#/tickets/${r.ticketId}`}>{r.ticket}</a> : null}
                <div className="muted" style={{ fontSize: 13 }}>
                  {r.ticketId ? whyRun(r) : <RunLabelLink run={r} />}
                </div>
              </td>
              <td className="mono">{r.model ?? "default"}</td>
              <td>{outcomeTag(finished ? r.outcome : null)}</td>
              {finished && (
                <td className="mono" style={{ textAlign: "right", whiteSpace: "nowrap" }} title={usage(r).title}>
                  {usage(r).text}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Runs({ companies }: { companies: Company[] }) {
  const active = usePoll((signal) => api<RunRow[]>("/api/runs", { signal }), 5_000, "active");
  const recent = usePoll((signal) => api<RunRow[]>("/api/runs/recent?limit=50", { signal }), 15_000, "recent");
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Runs</h1>
          <p className="sub">Each time an agent is started, why, and what it cost. Open one to read along, send it a message or stop it.</p>
        </div>
      </header>
      <section aria-labelledby="running-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="running-h" style={{ fontSize: 18, fontWeight: 600 }}>
          Running now
        </h2>
        {active.data?.length ? <RunTable rows={active.data} companies={companies} finished={false} /> : <p className="muted">No agents are running.</p>}
      </section>
      <section aria-labelledby="recent-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="recent-h" style={{ fontSize: 18, fontWeight: 600 }}>
          Finished
        </h2>
        {recent.data?.length ? <RunTable rows={recent.data} companies={companies} finished /> : <p className="muted">No runs have finished yet.</p>}
      </section>
    </>
  );
}
