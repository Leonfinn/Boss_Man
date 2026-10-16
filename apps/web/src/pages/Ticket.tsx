import { useState } from "react";
import { api, ApiError, RISKS, type Risk, type TicketDetail, type WorkspaceDiff } from "../api";
import { TicketLinks } from "../components/TicketLinks";
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
        {diff.commits.length} commit{diff.commits.length === 1 ? "" : "s"} on top of <span className="mono">{diff.baseCommit.slice(0, 7)}</span>; {diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed.
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

export function Ticket({ id }: { id: string }) {
  const ticket = usePoll((signal) => api<TicketDetail>(`/api/tickets/${id}`, { signal }), 15_000, id);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const t = ticket.data;

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api(`/api/tickets/${id}`, { method: "PATCH", body });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const loadDiff = async () => {
    setDiffError(null);
    try {
      setDiff(await api<WorkspaceDiff>(`/api/tickets/${id}/diff`));
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
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">
            <a href={`#/board/${t.projectId}`}>{t.project}</a> · ticket
          </p>
          <h1>{t.title}</h1>
          <p className="sub" style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "center" }}>
            <span className="tag">{t.systemState.replace(/_/g, " ")}</span>
            {t.outcome && <span>{t.outcome}</span>}
            <span>{t.assignee ? `Assigned to ${t.assignee}` : t.assignedToOwner ? "Assigned to you" : "Unassigned"}</span>
            {t.branch && <span className="mono">{t.branch}</span>}
            <span>Last activity {when(t.lastActivityAt)}</span>
          </p>
        </div>
      </header>

      <section className="card" style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }} aria-label="Settings">
        <div className="field">
          <label htmlFor="t-risk">Risk</label>
          <select id="t-risk" value={t.risk ?? "medium"} onChange={(e) => void patch({ risk: e.target.value as Risk })}>
            {RISKS.map((r) => (
              <option key={r} value={r}>
                {r[0]!.toUpperCase() + r.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 44, fontSize: 14 }}>
          <input type="checkbox" checked={t.planFirst} disabled={!!t.planApprovedAt} onChange={(e) => void patch({ planFirst: e.target.checked })} />
          Plan first
        </label>
        <p className="muted" style={{ fontSize: 13, flex: "1 1 260px" }}>
          {t.risk === "high" || t.risk === "critical"
            ? "You review it, the project's deeper check runs before it merges, and it deploys to staging before production."
            : "The CEO reviews it and it merges once the project's check passes."}
        </p>
      </section>

      <TicketLinks t={t} onChanged={ticket.reload} />

      {t.body && (
        <section className="card">
          <p style={{ whiteSpace: "pre-wrap" }}>{t.body}</p>
        </section>
      )}

      {t.plan && (
        <section className="card" aria-labelledby="plan-h" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 id="plan-h" style={{ fontSize: 17, fontWeight: 600, display: "flex", gap: 10, alignItems: "center" }}>
            Plan {t.planApprovedAt ? <span className="tag green">Approved {when(t.planApprovedAt)}</span> : <span className="tag amber">Waiting for approval</span>}
          </h2>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--sans)", overflowWrap: "anywhere" }}>{t.plan}</pre>
          {!t.planApprovedAt && (
            <p className="muted" style={{ fontSize: 14 }}>
              Approve or send it back from <a href="#/decisions">Decisions</a>.
            </p>
          )}
        </section>
      )}

      {t.repoUrl && (
        <section className="card" aria-labelledby="changes-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 id="changes-h" style={{ fontSize: 17, fontWeight: 600 }}>
            Changes
          </h2>
          {diff ? <DiffView diff={diff} /> : <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => void loadDiff()}>Show the changes</button>}
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
        </section>
      )}

      {t.systemState === "review" && (
        <section className="card" aria-labelledby="review-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 id="review-h" style={{ fontSize: 17, fontWeight: 600 }}>
            Review
          </h2>
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
        </section>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
          {note.text}
        </p>
      )}
    </>
  );
}
