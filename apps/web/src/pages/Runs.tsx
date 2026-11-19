import { useState } from "react";
import { runLabel, type RunOrigin } from "@boss-man/shared";
import { api, usd, type Company, type RunRow } from "../api";
import { usePoll } from "../hooks";
import { Loader } from "../components/Loader";

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
 * A run with no ticket: if it has since picked one up a run that found real work sets it (BOS-254),
 * that ticket is the headline with the wake reason underneath. With no ticket it is the shared label.
 */
function WorkOrWhy({ run }: { run: RunRow }) {
  if (run.ticketId) {
    return (
      <>
        <a href={`#/tickets/${run.ticketId}`}>{run.ticket ?? "its ticket"}</a>
        {run.ticket && run.runTicketRef ? <span className="muted"> · {run.runTicketRef}</span> : null}
        <div className="muted" style={{ fontSize: 13 }}>
          {whyRun(run) ? `woken by: ${whyRun(run)}` : ""}
        </div>
      </>
    );
  }
  return <RunLabelLink run={run} />;
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

/**
 * Why a run ended badly, in plain words, or null when it ended well (BOS-1887). The server stores a failure as
 * `error: <reason>`; Interrupted and Lost get a short line of their own.
 */
export function failureReason(outcome: string | null | undefined): string | null {
  if (!outcome) return null;
  if (outcome.startsWith("error")) {
    const reason = outcome.replace(/^error:?\s*/, "").trim();
    return reason ? `Failed: ${reason}` : "Failed, and the run didn't say why.";
  }
  if (outcome === "interrupted") return "Interrupted: it was stopped part-way, for example by a restart, and can be started again.";
  if (outcome.startsWith("lost")) {
    const detail = outcome.replace(/^lost:?\s*/, "").trim();
    return `Lost: Boss Man lost contact with the runner and doesn't know how it ended.${detail ? ` (${detail})` : ""}`;
  }
  return null;
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
                {r.ticketId ? (
                  // What the run is really on comes first; why it was woken is the smaller line under it (BOS-254).
                  <>
                    <a href={`#/tickets/${r.ticketId}`}>{r.ticket ?? "its ticket"}</a>
                    {r.ticket && r.runTicketRef ? <span className="muted"> · {r.runTicketRef}</span> : null}
                    <div className="muted" style={{ fontSize: 13 }}>
                      {whyRun(r) ? `woken by: ${whyRun(r)}` : ""}
                    </div>
                  </>
                ) : (
                  <WorkOrWhy run={r} />
                )}
              </td>
              <td className="mono">{r.model ?? "default"}</td>
              <td>
                {outcomeTag(finished ? r.outcome : null)}
                {finished && failureReason(r.outcome) && (
                  <div className="muted" style={{ fontSize: 13, marginTop: 4, maxWidth: 360, overflowWrap: "anywhere" }}>
                    {failureReason(r.outcome)}
                  </div>
                )}
              </td>
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

/** The owner's emergency stop (BOS-837): ends every run going now, in every company, after a plain confirm. */
function EndAllRuns({ count, onDone }: { count: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const end = async () => {
    const go = window.confirm(
      `End all ${count} running run${count === 1 ? "" : "s"}, in every company? They stop now. Work they haven't committed is lost; commits they've already made are kept.`,
    );
    if (!go) return;
    setBusy(true);
    setSaid(null);
    try {
      const r = await api<{ cancelled: number; failed?: string[] }>("/api/runs/cancel-all", { method: "POST" });
      // An emergency stop must say plainly what it could not do (BOS-862): the runs it failed on stay listed as
      // running, so the owner can open them and stop them one by one.
      const ended = r.cancelled ? `Ended ${r.cancelled} run${r.cancelled === 1 ? "" : "s"}.` : "No runs were running, so nothing was ended.";
      const missed = r.failed?.length ?? 0;
      setSaid({
        ok: !missed,
        text: missed ? `${ended} ${missed} run${missed === 1 ? "" : "s"} could not be ended. Open ${missed === 1 ? "it" : "them"} to stop ${missed === 1 ? "it" : "them"} one by one.` : ended,
      });
      onDone();
    } catch (err) {
      setSaid({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button type="button" className="btn" disabled={busy} onClick={() => void end()} style={{ color: "var(--red-ink)" }}>
        {busy ? "Ending…" : "End all running runs"}
      </button>
      {said && (
        <p role={said.ok ? "status" : "alert"} className={said.ok ? "muted" : "error"} style={{ margin: 0, fontSize: 14 }}>
          {said.text}
        </p>
      )}
    </div>
  );
}

/** A failed load says so and offers Retry, instead of passing for an empty list (BOS-1887). */
function LoadFailed({ what, message, onRetry }: { what: string; message: string; onRetry: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <p role="alert" className="error" style={{ margin: 0 }}>
        Couldn't load {what}: {message}
      </p>
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
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
        {active.data?.length ? (
          <>
            <RunTable rows={active.data} companies={companies} finished={false} />
            <EndAllRuns count={active.data.length} onDone={() => (active.reload(), recent.reload())} />
          </>
        ) : active.data ? (
          <p className="muted">No agents are running.</p>
        ) : active.error ? (
          <LoadFailed what="the running runs" message={active.error.message} onRetry={active.reload} />
        ) : (
          <Loader label="Loading the running runs" />
        )}
      </section>
      <section aria-labelledby="recent-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="recent-h" style={{ fontSize: 18, fontWeight: 600 }}>
          Finished
        </h2>
        {recent.data?.length ? (
          <RunTable rows={recent.data} companies={companies} finished />
        ) : recent.data ? (
          <p className="muted">No runs have finished yet.</p>
        ) : recent.error ? (
          <LoadFailed what="the finished runs" message={recent.error.message} onRetry={recent.reload} />
        ) : (
          <Loader label="Loading the finished runs" />
        )}
      </section>
    </>
  );
}
