import { useState, type FormEvent } from "react";
import { api, type Board as BoardData, type Company, type Project } from "../api";
import { art } from "../brand";
import { State } from "../components/State";
import { usePoll } from "../hooks";

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** A one-field form: the board's onboarding steps and "new ticket" all look like this. */
function QuickAdd({ label, button, onAdd }: { label: string; button: string; onAdd: (value: string) => Promise<unknown> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `quick-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onAdd(value.trim());
      setValue("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
      <div className="field" style={{ flex: "1 1 220px" }}>
        <label htmlFor={id}>{label}</label>
        <input id={id} value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <button className="btn primary" type="submit" disabled={busy}>
        {button}
      </button>
      {error && (
        <p className="error" role="alert" style={{ flexBasis: "100%" }}>
          {error}
        </p>
      )}
    </form>
  );
}

export function Board({ companies, projectId, go, onCompaniesChanged }: { companies: Company[]; projectId: string | undefined; go: (to: string) => void; onCompaniesChanged: () => void }) {
  const projects = usePoll(
    async (signal) => (await Promise.all(companies.map((c) => api<Project[]>(`/api/companies/${c.id}/projects`, { signal })))).flat(),
    60_000,
    companies.map((c) => c.id).join(","),
  );
  const current = projects.data?.find((p) => p.id === projectId) ?? projects.data?.[0];
  const board = usePoll((signal) => (current ? api<BoardData>(`/api/projects/${current.id}/board`, { signal }) : Promise.resolve(null)), 10_000, current?.id ?? "none");
  const agents = new Map(companies.flatMap((c) => c.agents.map((a) => [a.id, a] as const)));

  if (companies.length === 0) {
    return (
      <State img={art.setup} alt="Set up your first company" title="Start your first company">
        <p>A company gets a CEO agent that plans the work, hires agents and asks you when it needs a decision.</p>
        <QuickAdd
          label="Company name"
          button="Create company"
          onAdd={async (name) => {
            await api("/api/companies", { method: "POST", body: { name } });
            onCompaniesChanged();
          }}
        />
      </State>
    );
  }
  if (projects.data && !current) {
    return (
      <State img={art.setup} alt="No projects yet" title="No projects yet">
        <p>Projects hold a board of tickets and, optionally, a git repo the agents work in.</p>
        <QuickAdd
          label={`Project name for ${companies[0]!.name}`}
          button="Create project"
          onAdd={async (name) => {
            const p = await api<Project>(`/api/companies/${companies[0]!.id}/projects`, { method: "POST", body: { name } });
            projects.reload();
            go(`board/${p.id}`);
          }}
        />
      </State>
    );
  }

  const company = companies.find((c) => c.id === current?.companyId);
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">{company ? `${company.name} · project` : "Project"}</p>
          <h1>{current?.name ?? "Board"}</h1>
          {current?.repoUrl && <p className="sub mono" style={{ fontSize: 13 }}>{current.repoUrl}</p>}
        </div>
        {(projects.data?.length ?? 0) > 1 && (
          <div className="field">
            <label htmlFor="project-pick">Project</label>
            <select id="project-pick" value={current?.id} onChange={(e) => go(`board/${e.target.value}`)}>
              {projects.data!.map((p) => (
                <option key={p.id} value={p.id}>
                  {companies.find((c) => c.id === p.companyId)?.name} · {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>
      {current && (
        <QuickAdd
          label="New ticket"
          button="Add to backlog"
          onAdd={async (title) => {
            await api(`/api/projects/${current.id}/tickets`, { method: "POST", body: { title } });
            board.reload();
          }}
        />
      )}
      {board.error && (
        <p className="error" role="alert">
          {board.error.message}
        </p>
      )}
      <p className="muted" style={{ fontSize: 13 }}>
        Column names are this project's own. The grey tag under each name is the fixed state agents see, so renaming a column never confuses them.
      </p>
      <div className="board-scroll">
        <div className="board">
          {board.data?.columns.map((col) => {
            const full = col.wipLimit != null && col.tickets.length >= col.wipLimit;
            return (
              <section className="lane" key={col.id} aria-labelledby={`lane-${col.id}`}>
                <header>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                    <h2 id={`lane-${col.id}`}>{col.name}</h2>
                    {col.wipLimit != null && (
                      <span className="mono" style={{ fontSize: 12, color: full ? "var(--amber-ink)" : "var(--muted)" }}>
                        {col.tickets.length} / {col.wipLimit}
                      </span>
                    )}
                  </div>
                  <span className="state-tag">{col.systemState.replace(/_/g, " ")}</span>
                </header>
                {col.tickets.map((t) => {
                  const who = t.assigneeAgentId ? agents.get(t.assigneeAgentId) : undefined;
                  return (
                    <article className="ticket" key={t.id}>
                      <h3>{t.title}</h3>
                      {t.blockedBy.length > 0 && <span className="tag amber">Blocked by {t.blockedBy.length === 1 ? (t.blockedBy[0]!.decisionId ? "a decision" : t.blockedBy[0]!.engagementId ? "an engagement" : "a ticket") : `${t.blockedBy.length} things`}</span>}
                      {t.outcome === "cancelled" && <span className="tag">Cancelled</span>}
                      <div className="row">
                        <span className="mono">{t.branch ?? (t.dueDate ? `Due ${t.dueDate}` : "")}</span>
                        {who ? (
                          <span className="avatar" title={`${who.name} (${who.agentKind})`} style={{ background: who.role === "ceo" ? "var(--ink)" : "var(--accent)" }}>
                            {initials(who.name)}
                          </span>
                        ) : t.assignedToOwner ? (
                          <span className="tag blue">You</span>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
