import { useState } from "react";
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
      {(lines.length > MAX_DIFF_LINES || diff.truncated) && <p className="muted">The diff is longer than shown here; the full patch is in the ticket's branch.</p>}
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

const STATE_LABEL: Record<string, string> = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "In review", done: "Done" };
const STATE_TONE: Record<string, string> = { backlog: "", ready: "amber", in_progress: "blue", blocked: "red", review: "purple", done: "green" };

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
      setDiffError(err instanceof ApiError && err.status === 409 ? `${err.message} The diff comes from the runner that holds the ticket's worktree.` : (err as Error).message);
    }
  };
  const review = async (verdict: "approved" | "changes_requested") => {
    setBusy(true);
    try {
      const r = await api<{ outcome?: string; delivered?: string | null }>(`/api/tickets/${id}/review`, { method: "POST", body: { verdict, ...(summary.trim() ? { summary: summary.trim() } : {}) } });
      setSummary("");
      setNote({
        ok: true,
        text:
          verdict === "changes_requested"
            ? `Sent back: ${r.delivered ?? "done"}.`
            : r.outcome === "merged" || r.outcome === "done"
              ? "Approved and merged; the ticket is done."
              : `Approved, but it couldn't merge yet (${(r.outcome ?? "").replace(/_/g, " ")}); it's gone back to the assignee with what to fix.`,
      });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (ticket.error) return <p className="error" role="alert">{ticket.error.status === 404 ? "There's no such ticket." : ticket.error.message}</p>;
  if (!t) return null;
  const made = outputs.data ?? [];
  // Plan first only matters before anyone starts; once work has begun it's history (R76).
  const notStarted = t.systemState === "backlog" || t.systemState === "ready";
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">
            <a href={`#/board/${t.projectId}`}>{t.project}</a> · ticket
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

          {t.systemState === "review" && (
            <Fold title="Review" hint="waiting for you">
              <div className="field">
                <label htmlFor="review-summary">Comments for the agent (needed to send it back)</label>
                <textarea id="review-summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void review("approved")}>
                  {t.repoUrl ? "Approve and merge" : "Approve"}
                </button>
                <button type="button" className="btn" disabled={busy || !summary.trim()} onClick={() => void review("changes_requested")}>
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
              <select id="t-risk" value={t.risk ?? "medium"} onChange={(e) => void patch({ risk: e.target.value as Risk })}>
                {RISKS.map((r) => (
                  <option key={r} value={r}>
                    {r[0]!.toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </select>
              <RiskHelp tiers={tiers} current={t.risk ?? "medium"} />
            </dd>
            {notStarted && !t.planApprovedAt && (
              <>
                <dt>Plan first</dt>
                <dd>
                  <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 14 }}>
                    <input type="checkbox" checked={t.planFirst} onChange={(e) => void patch({ planFirst: e.target.checked })} style={{ marginTop: 3 }} />
                    <span>The agent writes a plan and waits for your approval in Decisions before it changes anything.</span>
                  </label>
                </dd>
              </>
            )}
            <dt>Project</dt>
            <dd>
              <a href={`#/board/${t.projectId}`}>{t.project}</a>
            </dd>
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
