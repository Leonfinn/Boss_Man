import { useEffect, useState } from "react";
import { api, ApiError, RISKS, type Company, type Risk, type TicketDetail, type WorkspaceDiff } from "../api";
import { RiskHelp, useRiskTiers } from "../components/RiskHelp";
import { Markdown } from "../components/Markdown";
import { TicketActivity } from "../components/TicketActivity";
import { TicketLinks } from "../components/TicketLinks";
import { TicketOutputs, type Artifact } from "../components/TicketOutputs";
import { usePoll } from "../hooks";
import { when } from "./Runs";

/** At most this many diff lines are drawn; the rest is summarised. */
const MAX_DIFF_LINES = 4000;

function DiffView({ diff }: { diff: WorkspaceDiff }) {
  const lines = diff.diff.split("\n");
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const cls = (l: string) => (l.startsWith("diff --git") ? "file" : l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p className="muted" style={{ fontSize: 14 }}>
        {diff.turn ? "" : <>{diff.commits.length} commit{diff.commits.length === 1 ? "" : "s"} on top of <span className="mono">{diff.baseCommit.slice(0, 7)}</span>; </>}
        {diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed.
      </p>
      {diff.files.length > 0 && (
        <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {diff.files.map((f) => (
            <li key={f.path}>
              {f.path} <span style={{ color: "var(--green-ink)" }}>+{f.added}</span> <span style={{ color: "var(--red-ink)" }}>-{f.removed}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="diff" role="region" aria-label="Changes">
        {shown.map((l, i) => (
          <div key={i} className={cls(l)}>
            {l || " "}
          </div>
        ))}
      </div>
      {(lines.length > MAX_DIFF_LINES || diff.truncated) && <p className="muted">The diff is longer than shown here; the full patch is in the task's branch.</p>}
    </div>
  );
}

/** A section that folds away behind an arrow (R76); closed unless it's asked to start open. */
function Fold({ title, hint, open, children }: { title: string; hint?: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="card fold" open={open || undefined}>
      <summary>
        <span className="fold-title">{title}</span>
        {hint && <small className="muted">{hint}</small>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

type Landing = { state: "running"; startedAt: string; command: string | null } | { state: "finished"; outcome: string; text: string; url: string | null; finishedAt: string };
const elapsed = (ms: number) => `${Math.floor(Math.max(0, ms) / 60_000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, "0")}`;
const STATE_LABEL: Record<string, string> = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "In review", done: "Done" };
const STATE_TONE: Record<string, string> = { backlog: "", ready: "amber", in_progress: "blue", blocked: "red", review: "purple", done: "green" };

/** How often a watcher reports (R80). */
const WATCH_EVERY: Array<[number, string]> = [
  [15, "Every 15 minutes"],
  [30, "Every 30 minutes"],
  [60, "Every hour"],
  [120, "Every 2 hours"],
  [240, "Every 4 hours"],
  [1440, "Once a day"],
];

export function Ticket({ id, companies }: { id: string; companies: Company[] }) {
  const ticket = usePoll((signal) => api<TicketDetail>(`/api/tickets/${id}`, { signal }), 15_000, id);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The description being edited; null while it isn't, so polling doesn't overwrite typing.
  const [draft, setDraft] = useState<string | null>(null);
  const tiers = useRiskTiers();
  const outputs = usePoll((signal) => api<Artifact[]>(`/api/tickets/${id}/artifacts`, { signal }), 20_000, id);
  const t = ticket.data;
  const agents = companies.find((c) => c.id === t?.companyId)?.agents ?? [];

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api(`/api/tickets/${id}`, { method: "PATCH", body });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  /** The watcher (R80): an agent that posts a short status update every so often. */
  const watch = async (agentId: string | null, everyMinutes?: number) => {
    try {
      await api(`/api/tickets/${id}/watcher`, { method: "PUT", body: { agentId, ...(everyMinutes ? { everyMinutes } : {}) } });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const saveDraft = async () => {
    if (draft === null) return;
    await patch({ body: draft.trim() || null });
    setDraft(null);
  };
  const assign = (value: string) =>
    patch(value === "owner" ? { assigneeAgentId: null, assignedToOwner: true } : { assigneeAgentId: value || null, assignedToOwner: false });
  const [range, setRange] = useState<"base" | "last_turn">("base");
  const loadDiff = async (which: "base" | "last_turn" = range) => {
    setDiffError(null);
    setRange(which);
    try {
      setDiff(null);
      setDiff(await api<WorkspaceDiff>(`/api/tickets/${id}/diff${which === "last_turn" ? "?range=last_turn" : ""}`));
    } catch (err) {
      setDiffError(err instanceof ApiError && err.status === 409 ? `${err.message} The diff comes from the runner that holds the task's worktree.` : (err as Error).message);
    }
  };
  // Approval lands in the background; poll its status quickly while it runs.
  const [landing, setLanding] = useState<Landing | null>(null);
  const [now, setNow] = useState(Date.now());
  const running = landing?.state === "running";
  useEffect(() => {
    api<{ landing: Landing | null }>(`/api/tickets/${id}/landing`).then((r) => setLanding(r.landing), () => undefined);
  }, [id]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      api<{ landing: Landing | null }>(`/api/tickets/${id}/landing`).then((r) => {
        if (r.landing && r.landing.state !== "running") ticket.reload();
        setLanding(r.landing);
      }, () => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [running, id]);
  const review = async (verdict: "approved" | "changes_requested") => {
    setBusy(true);
    try {
      const r = await api<{ outcome?: string; delivered?: string | null; landing?: Landing }>(`/api/tickets/${id}/review`, { method: "POST", body: { verdict, ...(summary.trim() ? { summary: summary.trim() } : {}) } });
      setSummary("");
      if (r.landing) {
        setNow(Date.now());
        setLanding(r.landing);
        setNote(null);
      } else setNote({ ok: true, text: `Sent back: ${r.delivered ?? "done"}.` });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const mergeNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ outcome: string }>(`/api/tickets/${id}/pull-request/merge`, { method: "POST" });
      setNote({ ok: true, text: r.outcome === "merged" ? "Merged; the task is done." : "Still waiting on the host." });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (ticket.error) return <p className="error" role="alert">{ticket.error.status === 404 ? "There's no such task." : ticket.error.message}</p>;
  if (!t) return null;
  const made = outputs.data ?? [];
  // Plan first only matters before anyone starts; once work has begun it's history (R76).
  const notStarted = t.systemState === "backlog" || t.systemState === "ready";
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">
            <a href={`#/board/${t.projectId}`}>{t.project}</a> · task
          </p>
          <h1>{t.title}</h1>
        </div>
      </header>

      <div className="ticket-layout">
        <div className="ticket-main">
          <section className="card" aria-labelledby="desc-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <h2 id="desc-h" style={{ fontSize: 17, fontWeight: 600 }}>
                Description
              </h2>
              {draft === null && (
                <button type="button" className="btn" style={{ minHeight: 32, padding: "4px 12px" }} onClick={() => setDraft(t.body ?? "")}>
                  Edit
                </button>
              )}
            </div>
            {draft === null ? (
              t.body ? <Markdown text={t.body} /> : <p className="muted">No description yet. Say what should be done and what counts as finished.</p>
            ) : (
              <>
                <label htmlFor="t-body" className="sr-only">
                  Description, in Markdown
                </label>
                <textarea
                  id="t-body"
                  rows={12}
                  maxLength={20_000}
                  autoFocus
                  placeholder="What should be done, and what counts as finished."
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit", width: "100%" }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn primary" disabled={draft === (t.body ?? "")} onClick={() => void saveDraft()}>
                    Save description
                  </button>
                  <button type="button" className="btn" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </section>

          <Fold title="What it produced" hint={made.length ? `${made.length} item${made.length === 1 ? "" : "s"}` : "nothing yet"}>
            <TicketOutputs items={made} companyId={t.companyId} onChanged={outputs.reload} />
          </Fold>

          {t.plan && (
            <Fold title="Plan" hint={t.planApprovedAt ? `approved ${when(t.planApprovedAt)}` : "waiting for your approval"}>
              <Markdown text={t.plan} />
              {!t.planApprovedAt && (
                <p className="muted" style={{ fontSize: 14 }}>
                  Approve or send it back from <a href="#/decisions">Decisions</a>.
                </p>
              )}
            </Fold>
          )}

          <Fold title="Roadmap, feature and dependencies">
            <TicketLinks t={t} onChanged={ticket.reload} bare />
          </Fold>

          {t.repoUrl && (
            <Fold title="Changes" hint={t.mergeCommit ? `merged as ${t.mergeCommit.slice(0, 7)}` : t.branch ? `on ${t.branch}` : undefined}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Which changes">
                <button type="button" className="btn" aria-pressed={!!diff && range === "base"} onClick={() => void loadDiff("base")}>
                  {diff && range === "base" ? "Refresh all changes" : "All changes"}
                </button>
                <button type="button" className="btn" aria-pressed={!!diff && range === "last_turn"} onClick={() => void loadDiff("last_turn")}>
                  {diff && range === "last_turn" ? "Refresh the last turn" : "The last turn"}
                </button>
              </div>
              {diff && range === "last_turn" && diff.turn && <p className="muted" style={{ fontSize: 14 }}>What the agent's last turn that changed anything did: checkpoint {diff.turn.number}, {when(diff.turn.at)}.</p>}
              {diff && <DiffView diff={diff} />}
              {diffError && (
                <p className="error" role="alert">
                  {diffError}
                </p>
              )}
              {t.mergeCommit && (
                <p className="muted">
                  Merged into {t.defaultBranch} as <span className="mono">{t.mergeCommit.slice(0, 7)}</span>.
                </p>
              )}
            </Fold>
          )}

          {landing && (
            <div className="banner" role="status" aria-live="polite" style={{ flexWrap: "wrap" }}>
              {landing.state === "running" ? (
                <span>
                  Approved. Running the pre-merge check{landing.command ? ` (${landing.command})` : ""}; this can take several minutes. Elapsed: {elapsed(now - Date.parse(landing.startedAt))}.
                </span>
              ) : (
                <span>
                  {landing.url && landing.text.includes(landing.url) ? (
                    <>
                      {landing.text.split(landing.url)[0]}
                      <a href={landing.url} target="_blank" rel="noreferrer">
                        {landing.url}
                      </a>
                      {landing.text.split(landing.url).slice(1).join(landing.url)}
                    </>
                  ) : (
                    landing.text
                  )}
                </span>
              )}
            </div>
          )}
          {t.systemState === "review" && (
            <Fold title="Review" hint={t.pullRequestNumber && t.pullRequestNote ? "waiting on the pull request" : "waiting for you"}>
              {t.pullRequestNumber && t.pullRequestNote && (
                <div className="banner" role="status" style={{ flexWrap: "wrap" }}>
                  <span>
                    Approved, and waiting on{" "}
                    {t.pullRequestUrl ? (
                      <a href={t.pullRequestUrl} target="_blank" rel="noreferrer">
                        pull request #{t.pullRequestNumber}
                      </a>
                    ) : (
                      `pull request #${t.pullRequestNumber}`
                    )}
                    . The host says: {t.pullRequestNote}
                  </span>
                  <button type="button" className="btn" disabled={busy} onClick={() => void mergeNow()}>
                    Try merging now
                  </button>
                </div>
              )}
              <div className="field">
                <label htmlFor="review-summary">Comments for the agent (needed to send it back)</label>
                <textarea id="review-summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn primary" disabled={busy || running} onClick={() => void review("approved")}>
                  {!t.repoUrl ? "Approve" : t.landing === "pull_request" ? "Approve and open a pull request" : "Approve and merge"}
                </button>
                <button type="button" className="btn" disabled={busy || running || !summary.trim()} onClick={() => void review("changes_requested")}>
                  Request changes
                </button>
              </div>
            </Fold>
          )}
          {note && (
            <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
              {note.text}
            </p>
          )}

          <TicketActivity ticketId={t.id} assignee={t.assignee} />
        </div>

        <aside className="card ticket-props" aria-label="Properties">
          <h2 className="section-label">Work</h2>
          <dl>
            <dt>Status</dt>
            <dd>
              <span className={`tag ${STATE_TONE[t.systemState] ?? ""}`}>{t.systemState === "done" && t.outcome === "cancelled" ? "Cancelled" : (STATE_LABEL[t.systemState] ?? t.systemState)}</span>
            </dd>
            <dt>
              <label htmlFor="t-assignee">Assigned to</label>
            </dt>
            <dd>
              <select id="t-assignee" value={t.assigneeAgentId ?? (t.assignedToOwner ? "owner" : "")} disabled={t.systemState === "done"} onChange={(e) => void assign(e.target.value)}>
                <option value="">Nobody</option>
                <option value="owner">You</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              {notStarted && <small className="muted">Assigning an agent starts it straight away.</small>}
            </dd>
            <dt>
              <label htmlFor="t-risk">Risk</label>
            </dt>
            <dd>
              <select id="t-risk" value={t.risk ?? ""} onChange={(e) => e.target.value && void patch({ risk: e.target.value as Risk })}>
                {!t.risk && <option value="">Not rated yet</option>}
                {RISKS.map((r) => (
                  <option key={r} value={r}>
                    {r[0]!.toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </select>
              {!t.risk && <small className="muted" style={{ display: "block" }}>Not rated yet — the CEO rates it when it reviews the task (treated as medium until then).</small>}
              <RiskHelp tiers={tiers} current={t.risk} />
            </dd>
            <dt>
              <label htmlFor="t-watcher">Watcher</label>
            </dt>
            <dd>
              <select id="t-watcher" value={t.watcherAgentId ?? ""} onChange={(e) => void watch(e.target.value || null, t.watchEveryMinutes ?? 30)}>
                <option value="">Off</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              {t.watcherAgentId ? (
                <>
                  <select aria-label="How often the watcher reports" value={t.watchEveryMinutes ?? 30} onChange={(e) => void watch(t.watcherAgentId, Number(e.target.value))} style={{ marginTop: 6 }}>
                    {WATCH_EVERY.map(([m, label]) => (
                      <option key={m} value={m}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <small className="muted">{t.watchedAt ? `Last asked for a report ${when(t.watchedAt)}.` : "A first report is on its way."} Updates appear in Activity and your notifications.</small>
                </>
              ) : (
                <small className="muted">An agent, such as a scrum master, that posts a short status update on this task and what it depends on.</small>
              )}
            </dd>
            <dt>Project</dt>
            <dd>
              <a href={`#/board/${t.projectId}`}>{t.project}</a>
            </dd>
            {t.pullRequestNumber && (
              <>
                <dt>Pull request</dt>
                <dd>
                  {t.pullRequestUrl ? (
                    <a href={t.pullRequestUrl} target="_blank" rel="noreferrer">
                      #{t.pullRequestNumber}
                    </a>
                  ) : (
                    `#${t.pullRequestNumber}`
                  )}
                  {t.systemState === "done" && t.mergeCommit ? " · merged" : ""}
                </dd>
              </>
            )}
            {t.branch && (
              <>
                <dt>Branch</dt>
                <dd className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                  {t.branch}
                </dd>
              </>
            )}
          </dl>
          <h2 className="section-label">About</h2>
          <dl>
            <dt>Created</dt>
            <dd>{when(t.createdAt)}</dd>
            <dt>Last activity</dt>
            <dd>{when(t.lastActivityAt)}</dd>
          </dl>
        </aside>
      </div>
    </>
  );
}
