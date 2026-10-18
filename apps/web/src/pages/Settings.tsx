import { useState, type FormEvent, type ReactNode } from "react";
import { api, type Company, type FundingSource, type Project } from "../api";
import { copyMessage, copyText } from "../clipboard";
import { usePoll } from "../hooks";
import { when } from "./Runs";

/** The runner's container when the launcher runs it (R55); null when the launcher is off. */
type Launched = { slug: string; container: { state: string; status: string; image: string } | null; error?: string } | null;
type RunnerStatus = ({ registered: false } | { registered: true; runnerId: string; connected: boolean; lastSeenAt: string | null; imageVersion: string | null; diskUsedBytes: number | null }) & { launcher?: Launched };
type Grant = { id: string; envName: string; secretId: string; secretName: string; hint: string | null; deployTargetId: string | null };
type Secret = { id: string; name: string; kind: string; hint: string | null };

/** What each kind of credential is called inside an agent's environment by default. */
const CREDENTIALS = [
  { kind: "claude_oauth_token", label: "Claude setup-token", env: "CLAUDE_CODE_OAUTH_TOKEN", help: "Run `claude setup-token` on your own computer and paste the token it prints." },
  { kind: "generic", label: "GitHub token", env: "GIT_TOKEN", help: "A fine-grained token for the company's repos, with Contents and Pull requests read and write." },
  { kind: "anthropic_api_key", label: "Anthropic API key", env: "ANTHROPIC_API_KEY", help: "From the Anthropic Console. Runs on it are billed to your API credit." },
  { kind: "openai_api_key", label: "OpenAI API key", env: "OPENAI_API_KEY", help: "For Codex agents." },
  { kind: "generic", label: "Other", env: "", help: "Any other value an agent needs, under the variable name you choose." },
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={id} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 id={id} style={{ fontSize: 17, fontWeight: 600 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const msg = await fn();
      setNote(msg ? { ok: true, text: msg } : null);
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const view = note && (
    <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
      {note.text}
    </p>
  );
  return { busy, run, view };
}

function Runner({ company }: { company: Company }) {
  const status = usePoll((signal) => api<RunnerStatus>(`/api/companies/${company.id}/runner`, { signal }), 10_000, company.id);
  const [token, setToken] = useState<string | null>(null);
  const act = useAction();
  const s = status.data;
  const issue = () =>
    act.run(async () => {
      if (s?.registered && !window.confirm("Issuing a new token disconnects the runner using the old one until you update it. Continue?")) return;
      setToken((await api<{ token: string }>(`/api/companies/${company.id}/runner`, { method: "POST" })).token);
      status.reload();
    });
  // The compose file's first runner reads this file; R55's launcher replaces the copying.
  const file = "secrets/runner-app-co.token";
  const launched = s?.launcher;
  const launch = (method: "POST" | "DELETE", what: "launch" | "restart", done: string) =>
    act.run(async () => {
      await api(`/api/companies/${company.id}/runner/${what}`, { method });
      status.reload();
      return done;
    });
  if (launched) {
    const c = launched.container;
    const connected = s?.registered && s.connected;
    return (
      <Section id="runner-h" title="Runner">
        <p className="muted" style={{ fontSize: 14 }}>
          Boss Man's launcher runs this company's runner as the container <code className="mono">boss-man-runner-{launched.slug}</code>, locked down, with its files under <code className="mono">companies/{launched.slug}</code> in your data folder.
        </p>
        <p style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "center" }} role="status">
          {connected ? (
            <span className="tag green">Connected</span>
          ) : c?.state === "running" ? (
            <span className="tag amber">Starting…</span>
          ) : c ? (
            <span className="tag amber">{c.state[0]!.toUpperCase() + c.state.slice(1)}</span>
          ) : (
            <span className="tag">Not started</span>
          )}
          {c && <span className="muted">{c.status}</span>}
          {s?.registered && s.lastSeenAt && <span className="muted">Last seen {when(s.lastSeenAt)}</span>}
          {s?.registered && s.imageVersion && <span className="mono muted">Image {s.imageVersion}</span>}
        </p>
        {launched.error && (
          <p className="error" role="alert">
            {launched.error}
          </p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button
            type="button"
            className="btn primary"
            disabled={act.busy}
            onClick={() => (!c || window.confirm("Reconnect the runner? It gets a new token and a fresh container; work in progress resumes from its journal.")) && void launch("POST", "launch", c ? "Reconnecting…" : "Starting…")}
          >
            {c ? "Reconnect runner" : "Start runner"}
          </button>
          {c && (
            <>
              <button type="button" className="btn" disabled={act.busy} onClick={() => void launch("POST", "restart", "Restarting…")}>
                Restart
              </button>
              <button type="button" className="btn" disabled={act.busy} onClick={() => window.confirm("Stop and remove the runner? Its workspaces and sessions stay on disk; agents can't run until it's started again.") && void launch("DELETE", "launch", "Stopped.")}>
                Stop
              </button>
            </>
          )}
        </div>
        {act.view}
      </Section>
    );
  }
  return (
    <Section id="runner-h" title="Runner">
      {s && !s.registered && <p>This company has no runner yet. A runner is the container its agents work in; it connects out to this server, so it needs no open ports.</p>}
      {s?.registered && (
        <p style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "center" }}>
          {s.connected ? <span className="tag green">Connected</span> : <span className="tag amber">Offline</span>}
          {s.lastSeenAt && <span className="muted">Last seen {when(s.lastSeenAt)}</span>}
          {s.imageVersion && <span className="mono muted">Image {s.imageVersion}</span>}
          {s.diskUsedBytes != null && <span className="muted">Workspaces use {(s.diskUsedBytes / 1024 ** 3).toFixed(1)} GB</span>}
        </p>
      )}
      {token ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p>
            <strong>Copy this token now; it isn't shown again.</strong> On the server, save it as <code className="mono">{file}</code> next to <code className="mono">docker-compose.yml</code>, readable only by uid 1000, then start the runner.
          </p>
          <pre className="mono codebox">{token}</pre>
          <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => void act.run(async () => copyMessage(await copyText(token), "Token"))}>
            Copy token
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn primary"
          style={{ alignSelf: "flex-start" }}
          disabled={act.busy}
          onClick={() => (!s?.registered || window.confirm("Issue a new token? The current one stops working at once, and the runner stays offline until you save the new token and restart it.")) && void issue()}
        >
          {s?.registered ? "Issue a new runner token" : "Register a runner"}
        </button>
      )}
      {act.view}
    </Section>
  );
}

function Credentials({ company }: { company: Company }) {
  const grants = usePoll((signal) => api<Grant[]>(`/api/companies/${company.id}/grants`, { signal }), 30_000, `grants-${company.id}`);
  const secrets = usePoll((signal) => api<Secret[]>("/api/secrets", { signal }), 30_000, "secrets");
  const [choice, setChoice] = useState(0);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [env, setEnv] = useState<string>(CREDENTIALS[0].env);
  const [existing, setExisting] = useState("");
  const act = useAction();
  const c = CREDENTIALS[choice]!;
  const describe = (r: { problems?: string[]; live: { ok: boolean; message: string } | null }) => {
    const problems = r.problems?.length ? ` ${r.problems.join(" ")}` : "";
    if (r.live) {
      if (!r.live.ok) throw new Error(`${r.live.message}${problems}`);
      return `${r.live.message}${problems}`;
    }
    if (problems) throw new Error(problems.trim());
    return c.kind === "claude_oauth_token" ? "The format looks right. A setup-token can only be fully checked by Claude Code itself, which a later check will do through the runner." : "The format looks right. Boss Man can't ask a provider about this kind of value.";
  };
  const check = () =>
    void act.run(async () => describe(await api<{ problems: string[]; live: { ok: boolean; message: string } | null }>("/api/secrets/check", { method: "POST", body: { kind: c.kind, value } })));
  const checkSaved = (g: Grant) =>
    void act.run(async () => {
      const r = await api<{ live: { ok: boolean; message: string } | null }>(`/api/secrets/${g.secretId}/check`, { method: "POST" });
      if (!r.live) return `${g.secretName}: Boss Man can't ask a provider about this kind of value.`;
      if (!r.live.ok) throw new Error(`${g.secretName}: ${r.live.message}`);
      return `${g.secretName}: ${r.live.message}`;
    });

  const add = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      let secretId = existing;
      let warnings: string[] = [];
      if (!secretId) {
        const created = await api<{ secret: { id: string }; warnings: string[] }>("/api/secrets", { method: "POST", body: { name: name || `${company.name} ${c.label}`, kind: c.kind, value } });
        secretId = created.secret.id;
        warnings = created.warnings;
      }
      await api(`/api/secrets/${secretId}/grants`, { method: "POST", body: { companyId: company.id, envName: env } });
      setValue("");
      setName("");
      setExisting("");
      grants.reload();
      secrets.reload();
      return `Saved. ${company.name}'s agents now get it as ${env}.${warnings.length ? ` Note: ${warnings.join(" ")}` : ""}`;
    });
  };

  return (
    <Section id="creds-h" title="Credentials">
      <p className="muted" style={{ fontSize: 14 }}>
        Values are encrypted on the server and never shown again; agents get them as environment variables. Each value is checked when saved, e.g. for stray spaces.
      </p>
      {grants.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Variable</th>
                <th scope="col">Secret</th>
                <th scope="col">Ends in</th>
                <th scope="col">Used for</th>
                <th scope="col">
                  <span className="sr-only">Check</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.data.map((g) => (
                <tr key={g.id}>
                  <td className="mono">{g.envName}</td>
                  <td>{g.secretName}</td>
                  <td className="mono muted">{g.hint ?? ""}</td>
                  <td>{g.deployTargetId ? "One deploy target" : "Every run"}</td>
                  <td>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => checkSaved(g)}>
                      Check
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No credentials yet. Agents need at least a Claude setup-token or an API key to run.</p>
      )}
      <form onSubmit={add} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
        <div className="field">
          <label htmlFor="cred-kind">Add</label>
          <select
            id="cred-kind"
            value={choice}
            onChange={(e) => {
              const i = Number(e.target.value);
              setChoice(i);
              setEnv(CREDENTIALS[i]!.env);
            }}
          >
            {CREDENTIALS.map((k, i) => (
              <option key={k.label} value={i}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        {(secrets.data?.length ?? 0) > 0 && (
          <div className="field">
            <label htmlFor="cred-existing">Value</label>
            <select id="cred-existing" value={existing} onChange={(e) => setExisting(e.target.value)}>
              <option value="">A new value</option>
              {secrets.data!.map((s) => (
                <option key={s.id} value={s.id}>
                  Reuse {s.name}
                  {s.hint ? ` (${s.hint})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        {!existing && (
          <>
            <div className="field">
              <label htmlFor="cred-name">Name</label>
              <input id="cred-name" placeholder={`${company.name} ${c.label}`} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="cred-value">Value</label>
              <input id="cred-value" type="password" autoComplete="off" spellCheck={false} required value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="cred-env">Variable name</label>
          <input id="cred-env" className="mono" required pattern="[A-Z_][A-Z0-9_]*" value={env} onChange={(e) => setEnv(e.target.value.toUpperCase())} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!existing && (
            <button className="btn" type="button" disabled={act.busy || !value.trim()} onClick={check}>
              Check
            </button>
          )}
          <button className="btn primary" type="submit" disabled={act.busy}>
            Save
          </button>
        </div>
      </form>
      <p className="muted" style={{ fontSize: 13 }}>
        {c.help.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
      </p>
      {act.view}
    </Section>
  );
}

function Funding({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 30_000, "sources");
  const [form, setForm] = useState({ name: "", kind: "subscription", provider: "anthropic", grant: "", anchor: "" });
  const act = useAction();
  const add = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      await api("/api/funding-sources", {
        method: "POST",
        body: {
          name: form.name,
          kind: form.kind,
          provider: form.provider,
          ...(form.kind === "api_credit" && form.grant ? { monthlyGrantUsd: Number(form.grant) } : {}),
          ...(form.kind === "api_credit" && form.anchor ? { cycleAnchor: form.anchor } : {}),
        },
      });
      setForm({ ...form, name: "", grant: "", anchor: "" });
      sources.reload();
      return "Added.";
    });
  };
  return (
    <Section id="funding-h" title="Funding sources">
      <p className="muted" style={{ fontSize: 14 }}>
        The subscriptions and API accounts agents run on, so their cost and quota are tracked. Choose each agent's model and funding source on the <a href="#/agents">Agents</a> page.
      </p>
      {sources.data && sources.data.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {sources.data.map((s) => (
            <li key={s.id}>
              {s.name} <span className="muted">· {s.kind.replace(/_/g, " ")} · {s.provider}</span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", alignItems: "end" }}>
        <div className="field">
          <label htmlFor="fs-name">New funding source</label>
          <input id="fs-name" required placeholder="Claude Max" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="fs-kind">Kind</label>
          <select id="fs-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="subscription">Subscription (setup-token)</option>
            <option value="api_credit">API credit, monthly grant</option>
            <option value="api_payg">API, pay as you go</option>
            <option value="usage_credits">Usage credits</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="fs-provider">Provider</label>
          <select id="fs-provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        {form.kind === "api_credit" && (
          <>
            <div className="field">
              <label htmlFor="fs-grant">Monthly grant (USD)</label>
              <input id="fs-grant" type="number" min="0" step="0.01" value={form.grant} onChange={(e) => setForm({ ...form, grant: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="fs-anchor">Cycle starts on</label>
              <input id="fs-anchor" type="date" value={form.anchor} onChange={(e) => setForm({ ...form, anchor: e.target.value })} />
            </div>
          </>
        )}
        <button className="btn primary" type="submit" disabled={act.busy}>
          Add
        </button>
      </form>
      {act.view}
    </Section>
  );
}

function ProjectRow({ p }: { p: Project }) {
  const [form, setForm] = useState({ repoUrl: p.repoUrl ?? "", defaultBranch: p.defaultBranch, verifyCommand: p.verifyCommand ?? "", deepVerifyCommand: p.deepVerifyCommand ?? "", landing: p.landing });
  const [host, setHost] = useState(p.gitHost);
  const act = useAction();
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const saved = await api<Project>(`/api/projects/${p.id}`, {
        method: "PATCH",
        body: { repoUrl: form.repoUrl || null, defaultBranch: form.defaultBranch, verifyCommand: form.verifyCommand || null, deepVerifyCommand: form.deepVerifyCommand || null, landing: form.landing },
      });
      setHost(saved.gitHost);
      if (form.landing === "pull_request" && form.repoUrl && !saved.gitHost) return "Saved, but Boss Man couldn't tell which git host this is, so pull requests won't open. Check the address, and that the host is reachable from the Boss Man server.";
      return saved.gitHost ? `Saved. Git host: ${saved.gitHost === "gitea" ? "Gitea" : "GitHub"} (${saved.gitApiBase}).` : "Saved.";
    });
  };
  return (
    <form onSubmit={save} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", alignItems: "end", paddingTop: 12, borderTop: "1px solid #e3e8ef" }}>
      <p style={{ gridColumn: "1 / -1", fontWeight: 600 }}>{p.name}</p>
      <div className="field" style={{ gridColumn: "1 / -1" }}>
        <label htmlFor={`repo-${p.id}`}>Git repo</label>
        <input id={`repo-${p.id}`} className="mono" placeholder="https://github.com/you/repo.git" value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} />
        <small className="muted">
          https, or http:// for a LAN host such as a Gitea on 192.168.x.x.{host ? ` Host: ${host === "gitea" ? "Gitea" : "GitHub"}.` : ""}
        </small>
      </div>
      <div className="field">
        <label htmlFor={`branch-${p.id}`}>Default branch</label>
        <input id={`branch-${p.id}`} className="mono" required value={form.defaultBranch} onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`verify-${p.id}`}>Check before merging</label>
        <input id={`verify-${p.id}`} className="mono" placeholder="pnpm install && pnpm test" value={form.verifyCommand} onChange={(e) => setForm({ ...form, verifyCommand: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`landing-${p.id}`}>When work is approved</label>
        <select id={`landing-${p.id}`} value={form.landing} onChange={(e) => setForm({ ...form, landing: e.target.value as Project["landing"] })}>
          <option value="merge">Merge into the default branch</option>
          <option value="pull_request">Open a pull request</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`deep-${p.id}`}>Deeper check for high-risk work</label>
        <input id={`deep-${p.id}`} className="mono" placeholder="pnpm test:e2e" value={form.deepVerifyCommand} onChange={(e) => setForm({ ...form, deepVerifyCommand: e.target.value })} />
      </div>
      <button className="btn" type="submit" disabled={act.busy}>
        Save
      </button>
      <div style={{ gridColumn: "1 / -1" }}>{act.view}</div>
    </form>
  );
}

function Projects({ company }: { company: Company }) {
  const projects = usePoll((signal) => api<Project[]>(`/api/companies/${company.id}/projects`, { signal }), 60_000, `projects-${company.id}`);
  return (
    <Section id="projects-h" title="Projects">
      <p className="muted" style={{ fontSize: 14 }}>
        With a repo, each ticket gets its own branch and worktree. Approved work is checked, then merged into the default branch or sent as a pull request. The token in <span className="mono">GIT_TOKEN</span> is used to clone, push and open pull requests. Don't put a token in the URL.
      </p>
      {projects.data?.length ? projects.data.map((p) => <ProjectRow key={p.id} p={p} />) : <p>No projects yet: create one on the Kanban.</p>}
    </Section>
  );
}

type Chapter = {
  id: string;
  number: number;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  contextUsed: number | null;
  contextSize: number | null;
  rollRequestedAt: string | null;
  closing: boolean;
  directive: string;
  handoffIn: string | null;
  handoff: string | null;
  handoffBy: string | null;
  runs: number;
};

const ENDED: Record<string, string> = { context: "when its context was 70% full", age: "after 7 days", owner: "when you asked", closed: "early" };

/** CEO continuity: the CEO's current chapter, and the handoffs between chapters. */
function Chapters({ company }: { company: Company }) {
  const list = usePoll((signal) => api<Chapter[]>(`/api/companies/${company.id}/chapters`, { signal }), 30_000, `ch-${company.id}`);
  const act = useAction();
  const chapters = list.data ?? [];
  const current = chapters.find((c) => !c.endedAt);
  const past = chapters.filter((c) => c.endedAt);
  const pct = current?.contextUsed != null && current.contextSize ? current.contextUsed / current.contextSize : null;
  const days = current ? Math.floor((Date.now() - new Date(current.startedAt).getTime()) / 86_400_000) : 0;
  return (
    <Section id="chapters-h" title="CEO chapters">
      <p className="muted" style={{ fontSize: 14 }}>
        The CEO works in chapters: one continuing conversation that starts from the mission and objectives as they were then. A chapter closes when its context is 70% full, after 7 days, or when you ask, and the CEO writes a handoff for the next one. Start a new chapter after changing the mission or objectives so the CEO picks them up.
      </p>
      {current ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p>
            <strong>Chapter {current.number}</strong>, started {when(current.startedAt)} ({days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}), {current.runs} run{current.runs === 1 ? "" : "s"}.{" "}
            {current.closing ? <span className="tag amber">Writing its handoff</span> : current.rollRequestedAt ? <span className="tag amber">Closes at the next run</span> : null}
          </p>
          {pct !== null && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", maxWidth: 420 }}>
              <span className={`bar ${pct >= 0.7 ? "warn" : ""}`} style={{ flex: 1 }} aria-label={`Context ${Math.round(pct * 100)}% full`}>
                <span style={{ width: `${Math.min(100, pct * 100)}%` }} />
              </span>
              <span className="mono muted" style={{ fontSize: 13 }}>
                {Math.round(pct * 100)}% context
              </span>
            </div>
          )}
          <details>
            <summary>Its directive</summary>
            <pre className="chapter-text">{current.directive}</pre>
          </details>
          {current.handoffIn && (
            <details>
              <summary>The handoff it started from</summary>
              <pre className="chapter-text">{current.handoffIn}</pre>
            </details>
          )}
          {!current.rollRequestedAt && !current.closing && (
            <button
              type="button"
              className="btn"
              style={{ alignSelf: "flex-start" }}
              disabled={act.busy}
              onClick={() =>
                window.confirm("Close this chapter? At its next run the CEO writes a handoff, and the run after that starts a new chapter with the current mission and objectives.") &&
                void act.run(async () => {
                  await api(`/api/companies/${company.id}/chapters/roll`, { method: "POST" });
                  list.reload();
                  return "The chapter closes at the CEO's next run.";
                })
              }
            >
              Start a new chapter
            </button>
          )}
        </div>
      ) : (
        list.data && <p>No chapter yet. The first starts the next time the CEO is woken.</p>
      )}
      {past.length > 0 && (
        <div>
          <p className="label">Earlier chapters</p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {past.map((c) => (
              <li key={c.id}>
                <details>
                  <summary>
                    Chapter {c.number}: {when(c.startedAt)} to {when(c.endedAt)}, {c.runs} run{c.runs === 1 ? "" : "s"}, ended {ENDED[c.endReason ?? "closed"] ?? c.endReason}
                    {c.handoffBy === "boss_man" ? " (handoff by Boss Man)" : ""}
                  </summary>
                  <pre className="chapter-text">{c.handoff ?? "No handoff."}</pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
      {act.view}
    </Section>
  );
}

export function Settings({ companies, companyId, go, onChanged }: { companies: Company[]; companyId: string | undefined; go: (to: string) => void; onChanged: () => void }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">What each company needs to run: a runner, credentials, funding and its repos.</p>
        </div>
      </header>
      {!company ? (
        <p>Create a company on the Kanban first.</p>
      ) : (
        <div key={company.id} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Runner company={company} />
          <Credentials company={company} />
          <Funding company={company} onChanged={onChanged} />
          <Chapters company={company} />
          <Projects company={company} />
        </div>
      )}
    </>
  );
}
