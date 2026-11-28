import { useState, type FormEvent } from "react";
import { defaultTokenLifeDays, endsOnDay, type SecretKind } from "@boss-man/shared";
import { api, type Company } from "../api";
import { Credentials } from "./settings/Credentials";
import { usePoll } from "../hooks";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { when } from "./Runs";

type Secret = { id: string; name: string; kind: string; hint: string | null; version: number; createdAt: string; updatedAt: string; expiresAt: string | null; lastUsedAt?: string | null; unusedIn30Days?: boolean };
type UseSummary = { total: number; byCompany: { company: string; reads: number }[]; byPurpose: { run: number; deploy: number; merge: number; other: number }; perDay: number[] };
type AccessLog = { entries: Access[]; summary: UseSummary };
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

/** Counts only: reads in the last 30 days per company and purpose, and a 30-cell strip of reads per day. */
/** Status text, not a control: kept out of the components so the owner-control list guard doesn't read it as a button. */
function lastUsedText(at: string | null | undefined): string {
  return at ? `Last used ${when(at)}` : "Never used";
}

function UseSummaryView({ summary }: { summary: UseSummary }) {
  if (summary.total === 0) return <p className="muted">Not read in the last 30 days.</p>;
  const max = Math.max(...summary.perDay, 1);
  const p = summary.byPurpose;
  const purposes = [
    ["run", p.run],
    ["deploy run", p.deploy],
    ["merging approved work", p.merge],
    ["other", p.other],
  ] as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
      <p style={{ margin: 0 }}>
        {summary.total} {summary.total === 1 ? "read" : "reads"}
        {summary.byCompany.length > 0 && <span className="muted"> · {summary.byCompany.map((c) => `${c.company} ${c.reads}`).join(", ")}</span>}
      </p>
      <p className="muted" style={{ margin: 0 }}>
        {purposes.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`).join(" · ")}
      </p>
      <div role="img" aria-label={`Reads per day, last 30 days: ${summary.perDay.join(", ")}`} style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 24 }}>
        {summary.perDay.map((n, i) => (
          <span key={i} title={`${n} ${n === 1 ? "read" : "reads"}`} style={{ flex: 1, height: n ? Math.max(4, Math.round((n / max) * 24)) : 2, background: n ? "var(--accent, #3b82f6)" : "var(--border, #ccc)" }} />
        ))}
      </div>
    </div>
  );
}

function Detail({ secret, onChanged }: { secret: Secret; onChanged: () => void }) {
  const grants = usePoll((signal) => api<Grant[]>(`/api/secrets/${secret.id}/grants`, { signal }), 30_000, `g-${secret.id}`);
  const log = usePoll((signal) => api<AccessLog>(`/api/secrets/${secret.id}/access-log?limit=50`, { signal }), 30_000, `l-${secret.id}`);
  const [value, setValue] = useState("");
  // A new value starts with no end date: the old date belonged to the token being replaced (BOS-2825). The owner gives
  // the date of the token they just made, and can clear it for one that never expires.
  const [endsOn, setEndsOn] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string>) => {
    try {
      setNote({ ok: true, text: await fn() });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const canExpire = defaultTokenLifeDays(secret.kind as SecretKind) !== null;
  const rotate = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ warnings?: string[] }>(`/api/secrets/${secret.id}/value`, { method: "PUT", body: { value, endsOn: endsOn || null } });
      setValue("");
      setEndsOn("");
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
        {canExpire && (
          <div className="field">
            <label htmlFor={`rotate-ends-${secret.id}`}>Ends on</label>
            <input id={`rotate-ends-${secret.id}`} type="date" aria-describedby={`rotate-ends-hint-${secret.id}`} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </div>
        )}
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
      {canExpire && (
        <p id={`rotate-ends-hint-${secret.id}`} className="muted" style={{ fontSize: 13 }}>
          <strong>Ends on</strong> is the day the new token stops working. Leave it empty for one that never expires. A week before it ends, you get one card saying how to replace it.
        </p>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
          {note.text}
        </p>
      )}
      <div>
        <p className="label">Last 30 days</p>
        {log.data && <UseSummaryView summary={log.data.summary} />}
        <p className="label">Recent use</p>
        {log.data?.entries.length ? (
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
                {log.data.entries.map((l) => (
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
                  v{s.version} · updated {when(s.updatedAt)} · {lastUsedText(s.lastUsedAt)}
                </span>
                <span className="mono muted">{s.expiresAt ? `ends ${endsOnDay(s.expiresAt)}` : "no end date"}</span>
                {s.unusedIn30Days && <span className="tag">Not used in 30 days</span>}
              </button>
              {open === s.id && <Detail secret={s} onChanged={list.reload} />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
