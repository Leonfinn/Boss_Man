import { useEffect, useState } from "react";
import { runLabel, type RunOrigin } from "@boss-man/shared";
import { api, usd, type Company, type RunRow } from "../api";
import { hashQuery, usePoll } from "../hooks";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { buildCsv, download } from "../csv";

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

/** A run's result as plain words for a file: the same wording as the tag, with the failure reason when there is one. */
function resultText(outcome: string | null | undefined) {
  if (!outcome) return "Running";
  const why = failureReason(outcome);
  if (why) return why;
  return outcome === "cancelled" || outcome.startsWith("stopped") ? "Stopped" : "Finished";
}

/** The finished runs as a spreadsheet: the table's columns, times in ISO format, cost in dollars to four places as a number. */
export function runsToCsv(rows: RunRow[], companies: Company[]): string {
  return buildCsv(
    ["ended", "company", "agent", "what_for", "woken_by", "model", "paid_from", "result", "cost_usd", "input_tokens", "output_tokens"],
    rows.map((r) => [
      r.endedAt ? new Date(r.endedAt).toISOString() : "",
      companies.find((c) => c.id === r.companyId)?.name ?? "",
      r.agent ?? "An agent",
      r.ticketId ? (r.ticket ?? "its ticket") : runLabel(r).text,
      r.ticketId ? whyRun(r) : "",
      r.model ?? "default",
      r.account ?? "none",
      resultText(r.outcome),
      ((r.costMicros ?? 0) / 1e6).toFixed(4),
      r.inputTokens ?? "",
      r.outputTokens ?? "",
    ]),
  );
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
            <th scope="col">Paid from</th>
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
              <td>{r.account ?? <span className="muted">none</span>}</td>
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

type WaitingWake = {
  id: string;
  agentId: string;
  agent: string | null;
  ticketId: string | null;
  ticket: string | null;
  ticketRef: string | null;
  reason: string;
  status: "queued" | "deferred";
  statusReason: string | null;
  notBefore: string | null;
  createdAt: string;
  companyId: string;
};

/** "waiting 12 min", "waiting 2 h 5 min": how long a wake has been queued (BOS-2320). */
export function waitingFor(iso: string, now = Date.now()) {
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "waiting less than a minute";
  if (min < 60) return `waiting ${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `waiting ${h} h ${min % 60} min` : `waiting ${h} h`;
}

const reasonText = (reason: string) => REASON_LABEL[reason] ?? reason[0]!.toUpperCase() + reason.slice(1);

/** Agents woken but not started yet: which agent, for what, why, and since when (BOS-2320). Read-only. */
function WaitingTable({ rows, companies }: { rows: WaitingWake[]; companies: Company[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">What for</th>
            <th scope="col">Waiting</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.id}>
              <td>
                {w.agent ?? "An agent"}
                {companies.length > 1 && <span className="muted"> · {companies.find((c) => c.id === w.companyId)?.name}</span>}
              </td>
              <td>
                {w.ticketId ? (
                  <>
                    <a href={`#/tickets/${w.ticketId}`}>{w.ticket ?? "its ticket"}</a>
                    {w.ticketRef ? <span className="muted"> · {w.ticketRef}</span> : null}
                  </>
                ) : (
                  <span className="muted">No ticket</span>
                )}
                <div className="muted" style={{ fontSize: 13 }}>
                  woken by: {reasonText(w.reason)}
                </div>
              </td>
              <td>
                {waitingFor(w.createdAt)}
                {w.status === "deferred" && (
                  <div className="muted" style={{ fontSize: 13 }}>
                    Held{w.statusReason ? `: ${w.statusReason}` : ""}
                    {w.notBefore ? ` until ${when(w.notBefore)}` : ""}
                  </div>
                )}
              </td>
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

const PAGE = 50;
const FILTER_KEY = "bm.runs.filter";
type Filter = { companyId: string; agentId: string; result: "" | "finished" | "failed" | "interrupted"; q: string };
const NO_FILTER: Filter = { companyId: "", agentId: "", result: "", q: "" };

/** The owner's last filter, so a reload (or coming back later) keeps it. */
function savedFilter(): Filter {
  let base = NO_FILTER;
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") as Partial<Filter>;
    base = { companyId: f.companyId ?? "", agentId: f.agentId ?? "", result: f.result ?? "", q: typeof f.q === "string" ? f.q.slice(0, 100) : "" };
  } catch {
    /* no usable saved filter */
  }
  // A link such as #/runs?result=failed wins over the saved filter and is saved like a click.
  const link = hashQuery();
  const result = link.get("result");
  const q = link.get("q");
  if (result === null && q === null) return base;
  const next: Filter = { ...base };
  if (result !== null) next.result = result === "finished" || result === "failed" || result === "interrupted" ? result : "";
  if (q !== null) next.q = q.slice(0, 100);
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the filter still applies for this visit */
  }
  return next;
}

function Chips({ label, value, options, onPick }: { label: string; value: string; options: Array<{ id: string; name: string }>; onPick: (id: string) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label} style={{ flexWrap: "wrap" }}>
      {[{ id: "", name: "All" }, ...options].map((o) => (
        <button key={o.id} type="button" className="chip" aria-pressed={value === o.id} onClick={() => onPick(o.id)}>
          {o.name}
        </button>
      ))}
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
  const [filter, setFilter] = useState<Filter>(savedFilter);
  // Older runs loaded by "Show more", for the filter they were loaded under.
  const [older, setOlder] = useState<{ key: string; rows: RunRow[]; done: boolean }>({ key: "", rows: [], done: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const company = companies.find((c) => c.id === filter.companyId);
  const filterKey = JSON.stringify(filter);
  // What is typed in the search box; it joins the filter after a short pause.
  const [typed, setTyped] = useState(filter.q);
  const change = (patch: Partial<Filter>) => {
    setFilter((cur) => {
      const next = { ...cur, ...patch };
      // An agent belongs to one company, so changing company clears the agent.
      if (patch.companyId !== undefined) next.agentId = "";
      localStorage.setItem(FILTER_KEY, JSON.stringify(next));
      return next;
    });
  };
  useEffect(() => {
    const q = typed.trim();
    if (q === filter.q) return;
    const t = setTimeout(() => change({ q }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);
  const query = (extra = "") => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    // A saved company that no longer exists is ignored, not sent (it would show an empty list with no way out).
    if (company) p.set("companyId", filter.companyId);
    if (company && filter.agentId) p.set("agentId", filter.agentId);
    if (filter.result) p.set("result", filter.result);
    if (filter.q) p.set("q", filter.q);
    return `/api/runs/recent?${p.toString()}${extra}`;
  };
  const active = usePoll((signal) => api<RunRow[]>("/api/runs", { signal }), 5_000, "active");
  const recent = usePoll((signal) => api<RunRow[]>(query(), { signal }), 15_000, `recent:${filterKey}`);
  // Waiting to start (BOS-2320): one request per company shown, merged in launch order (the server sorts each company's own).
  const waitingIds = (company ? [company] : companies).map((c) => c.id);
  const waiting = usePoll(
    async (signal) => {
      const lists = await Promise.all(waitingIds.map(async (id) => (await api<Omit<WaitingWake, "companyId">[]>(`/api/companies/${id}/wakes/waiting`, { signal })).map((w) => ({ ...w, companyId: id }))));
      return lists.flat();
    },
    10_000,
    `waiting:${waitingIds.join(",")}`,
  );
  const olderRows = older.key === filterKey ? older.rows : [];
  const seen = new Set((recent.data ?? []).map((r) => r.id));
  const shown = recent.data ? [...recent.data, ...olderRows.filter((r) => !seen.has(r.id))] : null;
  const canMore = !!shown && (recent.data?.length ?? 0) >= PAGE && !(older.key === filterKey && older.done);
  const showMore = async () => {
    const last = shown?.[shown.length - 1];
    if (!last?.endedAt) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const rows = await api<RunRow[]>(query(`&before=${encodeURIComponent(last.endedAt)}`));
      setOlder({ key: filterKey, rows: [...olderRows, ...rows], done: rows.length < PAGE });
    } catch (err) {
      setMoreError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };
  const filtered = !!(filter.companyId || filter.agentId || filter.result || filter.q);
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
      <section aria-labelledby="waiting-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="waiting-h" style={{ fontSize: 18, fontWeight: 600 }}>
          Waiting to start
        </h2>
        {waiting.data?.length ? (
          <WaitingTable rows={waiting.data} companies={companies} />
        ) : waiting.data ? (
          <p className="muted">No agents are waiting to start.</p>
        ) : waiting.error ? (
          <LoadError what="the agents waiting to start" message={waiting.error.message} onRetry={waiting.reload} />
        ) : (
          <Loader label="Loading the agents waiting to start" />
        )}
      </section>
      <section aria-labelledby="recent-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="recent-h" style={{ fontSize: 18, fontWeight: 600 }}>
          Finished
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {companies.length > 1 && <Chips label="Company" value={filter.companyId} options={companies} onPick={(id) => change({ companyId: id })} />}
          {company && company.agents.length > 0 && <Chips label="Agent" value={filter.agentId} options={company.agents} onPick={(id) => change({ agentId: id })} />}
          <Chips
            label="Result"
            value={filter.result}
            options={[
              { id: "finished", name: "Finished" },
              { id: "failed", name: "Failed" },
              { id: "interrupted", name: "Interrupted" },
            ]}
            onPick={(id) => change({ result: id as Filter["result"] })}
          />
          <label className="label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            Search by ticket
            <input type="search" value={typed} maxLength={100} placeholder="BOS-2250 or words in the title" onChange={(e) => setTyped(e.target.value)} />
          </label>
        </div>
        {shown?.length ? (
          <RunTable rows={shown} companies={companies} finished />
        ) : shown ? (
          <p className="muted">{filtered ? "No finished runs match these filters." : "No runs have finished yet."}</p>
        ) : recent.error ? (
          <LoadFailed what="the finished runs" message={recent.error.message} onRetry={recent.reload} />
        ) : (
          <Loader label="Loading the finished runs" />
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {canMore && (
            <button type="button" className="btn" disabled={loadingMore} onClick={() => void showMore()}>
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={!shown?.length}
            onClick={() => shown && download(`runs-${new Date().toISOString().slice(0, 10)}.csv`, runsToCsv(shown, companies))}
          >
            Download CSV
          </button>
        </div>
        {moreError && (
          <p role="alert" className="error">
            {moreError}
          </p>
        )}
      </section>
    </>
  );
}
