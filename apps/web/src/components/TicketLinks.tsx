import { useState, type FormEvent } from "react";
import { api, type TicketDetail, type TicketLinks as Links } from "../api";
import { usePoll } from "../hooks";

type Tree = Array<{ id: string; title: string; status: string; milestones: Array<{ id: string; title: string; targetDate: string | null }> }>;
type OpenTicket = { id: string; title: string; state: string; project: string };

/** A ticket's milestone, what it waits on and what waits on it. */
export function TicketLinks({ t, onChanged }: { t: TicketDetail; onChanged: () => void }) {
  const links = usePoll((signal) => api<Links>(`/api/tickets/${t.id}/links`, { signal }), 30_000, `links-${t.id}`);
  const tree = usePoll((signal) => api<Tree>(`/api/companies/${t.companyId}/objectives`, { signal }), 120_000, `tree-${t.companyId}`);
  const [candidates, setCandidates] = useState<OpenTicket[] | null>(null);
  const [blocker, setBlocker] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fail = (err: Error) => setError(err.message);

  const setMilestone = (milestoneId: string) =>
    void api(`/api/tickets/${t.id}`, { method: "PATCH", body: { milestoneId: milestoneId || null } }).then(() => (setError(null), onChanged()), fail);
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!blocker) return;
    void api(`/api/tickets/${t.id}/dependencies`, { method: "POST", body: { ticketId: blocker } }).then(() => (setBlocker(""), setError(null), links.reload(), onChanged()), fail);
  };
  const remove = (dependencyId: string) => void api(`/api/dependencies/${dependencyId}`, { method: "DELETE" }).then(() => (setError(null), links.reload(), onChanged()), fail);
  const loadCandidates = () => {
    if (!candidates) void api<OpenTicket[]>(`/api/companies/${t.companyId}/open-tickets`).then(setCandidates, fail);
  };
  const taken = new Set([t.id, ...(links.data?.waitsOn.map((w) => w.id) ?? [])]);
  const objectives = (tree.data ?? []).filter((o) => o.milestones.length);

  return (
    <section className="card" aria-labelledby="links-h" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 id="links-h" style={{ fontSize: 17, fontWeight: 600 }}>
        Roadmap and dependencies
      </h2>
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="t-milestone">Milestone</label>
        <select id="t-milestone" value={t.milestoneId ?? ""} onChange={(e) => setMilestone(e.target.value)}>
          <option value="">None</option>
          {objectives.map((o) => (
            <optgroup key={o.id} label={o.title}>
              {o.milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                  {m.targetDate ? ` (${m.targetDate})` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {tree.data && !objectives.length && (
          <small className="muted">
            Add milestones on the <a href="#/roadmap">Roadmap</a>.
          </small>
        )}
      </div>

      <div>
        <p className="label">Waits on</p>
        {links.data?.waitsOn.length ? (
          <ul className="link-list">
            {links.data.waitsOn.map((w) => (
              <li key={w.dependencyId}>
                <span className={`tag ${w.open ? "red" : "green"}`}>{w.open ? "Open" : "Done"}</span>
                <span className="muted">{w.kind}</span>
                <a href={w.link}>{w.title}</a>
                {w.kind === "decision" ? (
                  <span className="muted">Answer it to release this ticket.</span>
                ) : (
                  <button type="button" className="btn small" onClick={() => remove(w.dependencyId)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          links.data && <p className="muted">Nothing.</p>
        )}
        <form onSubmit={add} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}>
          <div className="field" style={{ flex: "1 1 280px" }}>
            <label htmlFor="t-blocker">Make it wait on</label>
            <select id="t-blocker" value={blocker} onFocus={loadCandidates} onPointerDown={loadCandidates} onChange={(e) => setBlocker(e.target.value)}>
              <option value="">Choose a ticket</option>
              {(candidates ?? [])
                .filter((c) => !taken.has(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.project}: {c.title} ({c.state.replace(/_/g, " ")})
                  </option>
                ))}
            </select>
          </div>
          <button className="btn" type="submit" disabled={!blocker}>
            Add
          </button>
        </form>
      </div>

      {links.data && links.data.blocks.length > 0 && (
        <div>
          <p className="label">Waiting on this</p>
          <ul className="link-list">
            {links.data.blocks.map((b) => (
              <li key={b.dependencyId}>
                <span className="tag">{b.state.replace(/_/g, " ")}</span>
                <a href={b.link}>{b.title}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted" style={{ fontSize: 13 }}>
        See every chain on the <a href={`#/plan/${t.companyId}`}>Plan</a>.
      </p>
    </section>
  );
}
