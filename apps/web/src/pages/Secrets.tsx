import { useState, type FormEvent } from "react";
import { api, type Company } from "../api";
import { Credentials } from "./settings/Credentials";
import { usePoll } from "../hooks";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { when } from "./Runs";

type Secret = { id: string; name: string; kind: string; hint: string | null; version: number; createdAt: string; updatedAt: string };
type Grant = { id: string; envName: string; companyId: string; company: string; deployTargetId: string | null; deployTarget: string | null; agentIds: string[] };
type Access = { id: string; at: string; company: string | null; runId: string | null; purpose: string };

const KIND: Record<string, string> = {
  claude_oauth_token: "Claude setup-token",
  anthropic_api_key: "Anthropic API key",
  anthropic_admin_key: "Anthropic admin key",
  openai_api_key: "OpenAI API key",
  ssh_private_key: "SSH key",
  generic: "Other",
};

function Detail({ secret, onChanged }: { secret: Secret; onChanged: () => void }) {
  const grants = usePoll((signal) => api<Grant[]>(`/api/secrets/${secret.id}/grants`, { signal }), 30_000, `g-${secret.id}`);
  const log = usePoll((signal) => api<Access[]>(`/api/secrets/${secret.id}/access-log?limit=50`, { signal }), 30_000, `l-${secret.id}`);
  const [value, setValue] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string>) => {
    try {
      setNote({ ok: true, text: await fn() });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const rotate = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ warnings?: string[] }>(`/api/secrets/${secret.id}/value`, { method: "PUT", body: { value } });
      setValue("");
      onChanged();
      return `Rotated. Every grant uses the new value from the next run.${r.warnings?.length ? ` Note: ${r.warnings.join(" ")}` : ""}`;
    });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "4px 0 8px" }}>
      <div>
        <p className="label">Granted to</p>
        {grants.data?.length ? (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
            {grants.data.map((g) => (
              <li key={g.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span>{g.company}</span>
                <span className="mono muted">as {g.envName}</span>
                {g.deployTarget && <span className="tag">only for deploys to {g.deployTarget}</span>}
                {g.agentIds.length > 0 && <span className="tag">{g.agentIds.length === 1 ? "1 agent only" : `${g.agentIds.length} agents only`}</span>}
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    window.confirm(`Stop giving ${secret.name} to ${g.company}?`) &&
                    void run(async () => {
                      await api(`/api/grants/${g.id}`, { method: "DELETE" });
                      grants.reload();
                      return `${g.company} no longer gets it.`;
                    })
                  }
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        ) : grants.data ? (
          <p className="muted">Not granted to any company. Grant it above, under the company's variables.</p>
        ) : grants.error ? (
          <LoadError what="who gets this secret" message={grants.error.message} onRetry={grants.reload} />
        ) : (
          <Loader label="Loading who gets this secret" size={16} />
        )}
      </div>
      <form onSubmit={rotate} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
        <div className="field" style={{ flex: "1 1 260px" }}>
          <label htmlFor={`rotate-${secret.id}`}>Rotate: new value</label>
          <input id={`rotate-${secret.id}`} type="password" autoComplete="off" spellCheck={false} required value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <button className="btn primary" type="submit">
          Rotate
        </button>
        <button
          className="btn"
          type="button"
          style={{ color: "var(--red-ink)" }}
          onClick={() =>
            window.confirm(`Delete ${secret.name}? Companies it's granted to lose it from their next run.`) &&
            void run(async () => {
              await api(`/api/secrets/${secret.id}`, { method: "DELETE" });
              onChanged();
              return "Deleted.";
            })
          }
        >
          Delete
        </button>
      </form>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
          {note.text}
        </p>
      )}
      <div>
        <p className="label">Recent use</p>
        {log.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Company</th>
                  <th scope="col">For</th>
                </tr>
              </thead>
              <tbody>
                {log.data.map((l) => (
                  <tr key={l.id}>
                    <td className="mono muted">{when(l.at)}</td>
                    <td>{l.company ?? "A deleted company"}</td>
                    <td>{l.runId ? <a href={`#/runs/${l.runId}`}>{l.purpose === "deploy" ? "A deploy run" : "A run"}</a> : l.purpose === "merge" ? "Merging approved work" : l.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : log.data ? (
          <p className="muted">No run has been given it yet.</p>
        ) : log.error ? (
          <LoadError what="the recent use" message={log.error.message} onRetry={log.reload} />
        ) : (
          <Loader label="Loading the recent use" size={16} />
        )}
      </div>
    </div>
  );
}

/** The one place for credentials: the chosen company's variables (add, grant, check), then every stored secret. */
export function Secrets({ companies, companyId, onChanged }: { companies: Company[]; companyId: string | undefined; onChanged?: () => void }) {
  const list = usePoll((signal) => api<Secret[]>("/api/secrets", { signal }), 60_000, "secrets");
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Secrets</h1>
          <p className="sub">Every stored credential, who gets it, and when it was used. Values are encrypted and never shown.</p>
        </div>
      </header>
      {company && <Credentials key={company.id} company={company} title={`${company.name}'s variables`} onChanged={() => (list.reload(), onChanged?.())} />}
      <h2 style={{ fontSize: 17, fontWeight: 600 }}>All stored secrets</h2>
      {!list.data && list.error && <LoadError what="the stored secrets" message={list.error.message} onRetry={list.reload} />}
      {!list.data && !list.error && <Loader label="Loading the stored secrets" size={16} />}
      {!list.data ? null : list.data.length === 0 ? (
        <p className="muted">No secrets yet. Add one above.</p>
      ) : (
        <ul className="secret-list">
          {list.data?.map((s) => (
            <li key={s.id} className="card">
              <button type="button" className="secret-head" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span style={{ fontWeight: 600 }}>{s.name}</span>
                <span className="muted">{KIND[s.kind] ?? s.kind}</span>
                <span className="mono muted">{s.hint ?? ""}</span>
                <span className="muted">
                  v{s.version} · updated {when(s.updatedAt)}
                </span>
              </button>
              {open === s.id && <Detail secret={s} onChanged={list.reload} />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
