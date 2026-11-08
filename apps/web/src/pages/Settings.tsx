import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { RUNNER_ADDONS, SECOND_OPINION_PRESETS, WATCHDOG_RULE_LABEL, tallestReading, type AddonReport, type WatchdogRule, type WatchdogSettings } from "@boss-man/shared";
import { api, ApiError, type Agent, type Company, type DeviceProfile, type FundingSource, type Project } from "../api";
import { collect } from "../devices";
import { CompanyReviews, ProjectReviews } from "../components/ReviewPolicy";
import { copyMessage, copyText } from "../clipboard";
import { usePoll } from "../hooks";
import { when } from "./Runs";
import { SaveButton, useSaveState } from "../components/SaveButton";
import { QuickAdd } from "./Board";
import { StarButton } from "./Agents";
import { toBase64 } from "./Skills";

/** The runner's container when the launcher runs it (R55); null when the launcher is off. */
type Launched = { slug: string; container: { state: string; status: string; image: string } | null; error?: string } | null;
type CompanyReport = { live: { ok: boolean; text: string }; last: UpdateRow | null };
type RunnerStatus = ({ registered: false; report?: CompanyReport | null } | { registered: true; runnerId: string; connected: boolean; lastSeenAt: string | null; imageVersion: string | null; diskUsedBytes: number | null; addons: AddonReport[] | null; report?: CompanyReport | null }) & { launcher?: Launched };
type Grant = { id: string; envName: string; secretId: string; secretName: string; hint: string | null; deployTargetId: string | null; agentIds: string[] };
type McpServerRow = { id: string; name: string; url: string; transport: "http" | "sse"; secretEnv: string | null; secretGranted: boolean };
type Secret = { id: string; name: string; kind: string; hint: string | null };

/** What each kind of credential is called inside an agent's environment by default. */
const CREDENTIALS = [
  { kind: "claude_oauth_token", label: "Claude setup-token", env: "CLAUDE_CODE_OAUTH_TOKEN", help: "Run `claude setup-token` on your own computer and paste the token it prints." },
  { kind: "generic", label: "Git token (GitHub or Gitea)", env: "GIT_TOKEN", help: "GitHub: a fine-grained token for the company's repos, with Contents, Pull requests and Workflows read and write. Gitea: a token with the write:repository scope." },
  { kind: "anthropic_api_key", label: "Anthropic API key", env: "ANTHROPIC_API_KEY", help: "From the Anthropic Console. Runs on it are billed to your API credit." },
  { kind: "openai_api_key", label: "OpenAI API key", env: "OPENAI_API_KEY", help: "For Codex agents." },
  { kind: "generic", label: "OpenRouter API key", env: "OPENROUTER_API_KEY", help: "For OpenCode agents. Models are named openrouter/<model>." },
  { kind: "generic", label: "Ollama Cloud API key", env: "OLLAMA_API_KEY", help: "For OpenCode agents. Models are named ollama-cloud/<model>." },
  { kind: "generic", label: "Synthetic API key", env: "SYNTHETIC_API_KEY", help: "For OpenCode agents. Models are named synthetic/<model>, e.g. synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017" },
  { kind: "generic", label: "Other", env: "", help: "Any other value an agent needs, under the variable name you choose." },
] as const;

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={id} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 id={id} style={{ fontSize: 17, fontWeight: 600 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function useAction() {
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

/** Optional add-ons baked into the runner image (docs/12), and how the runner last said they were. */
function RunnerAddons({ report }: { report: AddonReport[] | null }) {
  return (
    <div>
      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Add-ons</h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {RUNNER_ADDONS.map((a) => {
          const r = report?.find((x) => x.id === a.id);
          return (
            <li key={a.id}>
              <strong>{a.title}</strong> {r?.ok ? <span className="tag green">Working, {r.version}</span> : r ? <span className="tag red">Not working</span> : <span className="tag">Not installed</span>}
              <p className="muted" style={{ fontSize: 14, margin: "2px 0 0" }}>
                {a.summary}{" "}
                <a href={a.homepage} target="_blank" rel="noopener noreferrer">
                  About it
                </a>
              </p>
              {r && !r.ok && r.detail && <p className="error" style={{ fontSize: 13, margin: "2px 0 0" }}>{r.detail}</p>}
              {!r && (
                <p className="muted" style={{ fontSize: 13, margin: "2px 0 0" }}>
                  To add it, put <code className="mono">RUNNER_ADDONS={a.id}</code> in <code className="mono">.env</code> on the server, then run <code className="mono">scripts/update-runner.sh</code> as root (on TrueNAS, in the root shell). Skills that need it stay out of runs until then.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The runner's last hello: while connected that is when this connection began. */
function Since({ connected, at }: { connected: boolean; at: string | null }) {
  if (!at) return null;
  return <span className="muted">{connected ? `since ${when(at)}` : `last connected ${when(at)}`}</span>;
}

export function Runner({ company, onChanged }: { company: Company; onChanged?: () => void }) {
  const status = usePoll((signal) => api<RunnerStatus>(`/api/companies/${company.id}/runner`, { signal }), 10_000, company.id);
  const [token, setToken] = useState<string | null>(null);
  const act = useAction();
  const s = status.data;
  const issue = () =>
    act.run(async () => {
      if (s?.registered && !window.confirm("Issuing a new token disconnects the runner using the old one until you update it. Continue?")) return;
      setToken((await api<{ token: string }>(`/api/companies/${company.id}/runner`, { method: "POST" })).token);
      status.reload();
      onChanged?.();
    });
  // The compose file's first runner reads this file; R55's launcher replaces the copying.
  const file = "secrets/runner-app-co.token";
  const launched = s?.launcher;
  const launch = (method: "POST" | "DELETE", what: "launch" | "restart", done: string) =>
    act.run(async () => {
      await api(`/api/companies/${company.id}/runner/${what}`, { method });
      status.reload();
      onChanged?.();
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
        <dl className="facts" role="status">
          <dt>Now</dt>
          <dd data-testid="runner-now">
            {s?.report ? (
              <span className={s.report.live.ok ? undefined : "tag red"}>{s.report.live.text}</span>
            ) : (
              <>
                {connected ? (
                  <span className="tag green">Connected</span>
                ) : c?.state === "running" ? (
                  <span className="tag amber">Starting…</span>
                ) : c ? (
                  <span className="tag amber">{c.state[0]!.toUpperCase() + c.state.slice(1)}</span>
                ) : (
                  <span className="tag">Not started</span>
                )}{" "}
                {s?.registered && <Since connected={!!connected} at={s.lastSeenAt} />}
              </>
            )}
          </dd>
          {/* Docker's own words, e.g. "Up 14 hours (healthy)": how long the container has run, not the connection. */}
          {c && (
            <>
              <dt>Container</dt>
              <dd>{c.status}</dd>
            </>
          )}
          {s?.registered && s.imageVersion && (
            <>
              <dt>Image</dt>
              <dd className="mono">{s.imageVersion}</dd>
            </>
          )}
        </dl>
        {s?.report?.last && (
          <div data-testid="company-update-history">
            <UpdateHistory r={s.report.last} />
          </div>
        )}
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
        {s?.registered && <RunnerAddons report={s.addons} />}
        {act.view}
      </Section>
    );
  }
  return (
    <Section id="runner-h" title="Runner">
      {s && !s.registered && <p>This company has no runner yet. A runner is the container its agents work in; it connects out to this server, so it needs no open ports.</p>}
      {s?.registered && (
        <dl className="facts" role="status">
          <dt>Now</dt>
          <dd data-testid="runner-now">
            {s.report ? (
              <span className={s.report.live.ok ? undefined : "tag red"}>{s.report.live.text}</span>
            ) : (
              <>
                {s.connected ? <span className="tag green">Connected</span> : <span className="tag amber">Offline</span>} <Since connected={s.connected} at={s.lastSeenAt} />
              </>
            )}
          </dd>
          {s.imageVersion && (
            <>
              <dt>Image</dt>
              <dd className="mono">{s.imageVersion}</dd>
            </>
          )}
          {s.diskUsedBytes != null && (
            <>
              <dt>Workspaces</dt>
              <dd>{(s.diskUsedBytes / 1024 ** 3).toFixed(1)} GB</dd>
            </>
          )}
        </dl>
      )}
      {s?.registered && s.report?.last && (
        <div data-testid="company-update-history">
          <UpdateHistory r={s.report.last} />
        </div>
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
      {s?.registered && <RunnerAddons report={s.addons} />}
      {act.view}
    </Section>
  );
}

/** A setup-token can only be proved by Claude Code, so its check runs on the runner (R58). */
const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** Which of the company's agents get a key; none ticked means all of them. */
function GrantAgents({ grant, agents, busy, onSave }: { grant: Grant; agents: Agent[]; busy: boolean; onSave: (ids: string[]) => void }) {
  const [picked, setPicked] = useState(grant.agentIds);
  const names = agents.filter((a) => grant.agentIds.includes(a.id)).map((a) => a.name);
  return (
    <details onToggle={(e) => e.currentTarget.open && setPicked(grant.agentIds)}>
      <summary aria-label={`Agents for ${grant.envName}`}>
        {names.length ? `Only ${names.join(", ")}` : "Every agent"} <span className="muted">({names.length ? "change" : "limit to some"})</span>
      </summary>
      <fieldset style={{ border: 0, padding: 0, margin: "6px 0" }}>
        <legend className="muted" style={{ fontSize: 13 }}>Leave all unticked to give the key to every agent in this company.</legend>
        {agents.map((a) => (
          <label key={a.id} style={{ display: "block" }}>
            <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((id) => id !== a.id))} /> {a.name}
          </label>
        ))}
      </fieldset>
      <button type="button" className="btn small" disabled={busy} onClick={() => onSave(picked)} aria-label={`Save agents for ${grant.envName}`}>
        Save
      </button>
    </details>
  );
}

export function Credentials({ company, onChanged, title = "Credentials" }: { company: Company; onChanged?: () => void; title?: string }) {
  const grants = usePoll((signal) => api<Grant[]>(`/api/companies/${company.id}/grants`, { signal }), 30_000, `grants-${company.id}`);
  const secrets = usePoll((signal) => api<Secret[]>("/api/secrets", { signal }), 30_000, "secrets");
  // No default kind: a value checked as the wrong kind fails confusingly, so the owner always picks.
  const [choice, setChoice] = useState(-1);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [env, setEnv] = useState("");
  const [existing, setExisting] = useState("");
  const act = useAction();
  const sv = useSaveState({ choice, name, value, env, existing });
  const c = CREDENTIALS[choice];
  // A pasted key file (e.g. a Google service-account JSON) only fits "Other".
  const looksLikeJson = !!c && c.kind !== "generic" && value.trim().startsWith("{");
  // The name is only the label in the secret store; left blank it follows the variable for "Other".
  const defaultName = !c ? "" : c.env ? `${company.name} ${c.label}` : env;
  const describe = (r: { problems?: string[]; live: { ok: boolean; message: string } | null }) => {
    const problems = r.problems?.length ? ` ${r.problems.join(" ")}` : "";
    if (r.live) {
      if (!r.live.ok) throw new Error(`${r.live.message}${problems}`);
      return `${r.live.message}${problems}`;
    }
    if (problems) throw new Error(problems.trim());
    return c?.kind === "claude_oauth_token" ? "The format looks right. A setup-token can only be fully checked by Claude Code itself: save it, then choose Check with Claude." : "The format looks right. Boss Man can't ask a provider about this kind of value.";
  };
  const check = () =>
    void act.run(async () => describe(await api<{ problems: string[]; live: { ok: boolean; message: string } | null }>("/api/secrets/check", { method: "POST", body: { kind: c!.kind, value } })));
  const checkSaved = (g: Grant) =>
    void act.run(async () => {
      if (g.envName === CLAUDE_TOKEN_ENV) {
        const r = await api<{ ok: boolean; message: string }>(`/api/companies/${company.id}/check-claude`, { method: "POST" });
        if (!r.ok) throw new Error(`${g.secretName}: ${r.message}`);
        return `${g.secretName}: ${r.message}`;
      }
      const r = await api<{ live: { ok: boolean; message: string } | null }>(`/api/secrets/${g.secretId}/check`, { method: "POST" });
      if (!r.live) return `${g.secretName}: Boss Man can't ask a provider about this kind of value.`;
      if (!r.live.ok) throw new Error(`${g.secretName}: ${r.live.message}`);
      return `${g.secretName}: ${r.live.message}`;
    });

  // Stops this company getting the value; the secret itself stays, for other companies or to grant again.
  const remove = (g: Grant) =>
    window.confirm(`Stop giving ${g.secretName} to ${company.name} as ${g.envName}? The secret itself is kept.`) &&
    void act.run(async () => {
      await api(`/api/grants/${g.id}`, { method: "DELETE" });
      grants.reload();
      onChanged?.();
      return `${company.name}'s agents no longer get ${g.envName} (from the next run). ${g.secretName} is still stored; delete it under All stored secrets if nothing else uses it.`;
    });

  const setAgents = (g: Grant, ids: string[]) =>
    void act.run(async () => {
      await api(`/api/grants/${g.id}/agents`, { method: "PUT", body: { agentIds: ids } });
      grants.reload();
      return ids.length ? `${g.envName} now goes only to the agents you ticked (from the next run).` : `${g.envName} goes to every agent in ${company.name} (from the next run).`;
    });

  const add = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      let secretId = existing;
      let warnings: string[] = [];
      if (!secretId) {
        const created = await api<{ secret: { id: string }; warnings: string[] }>("/api/secrets", { method: "POST", body: { name: name.trim() || defaultName, kind: c!.kind, value } });
        secretId = created.secret.id;
        warnings = created.warnings;
      }
      await api(`/api/secrets/${secretId}/grants`, { method: "POST", body: { companyId: company.id, envName: env } });
      // Each new credential starts from a blank form, so nothing carries over from the last one.
      setValue("");
      setName("");
      setExisting("");
      setChoice(-1);
      setEnv("");
      sv.markSaved({ choice: -1, name: "", value: "", env: "", existing: "" });
      grants.reload();
      secrets.reload();
      onChanged?.();
      return `Saved. ${company.name}'s agents now get it as ${env}.${warnings.length ? ` Note: ${warnings.join(" ")}` : ""}`;
    });
  };

  return (
    <Section id="creds-h" title={title}>
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
                <th scope="col">Agents</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
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
                    <GrantAgents key={g.agentIds.join()} grant={g} agents={company.agents} busy={act.busy} onSave={(ids) => setAgents(g, ids)} />
                  </td>
                  <td>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => checkSaved(g)} style={{ whiteSpace: "nowrap" }} title={g.envName === CLAUDE_TOKEN_ENV ? "Runs one tiny prompt on the company's runner, using a little of the subscription allowance" : undefined}>
                      {g.envName === CLAUDE_TOKEN_ENV ? "Check with Claude" : "Check"}
                    </button>{" "}
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => remove(g)} aria-label={`Remove ${g.envName} from ${company.name}`}>
                      Remove
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
      {grants.data?.some((g) => g.envName === CLAUDE_TOKEN_ENV) && (
        <p className="muted" style={{ fontSize: 13 }}>
          <strong>Check with Claude</strong> runs one tiny prompt on the company's runner, so it uses a little of the subscription allowance and can take a minute.
        </p>
      )}
      <form onSubmit={add} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
        <div className="field">
          <label htmlFor="cred-kind">Add</label>
          <select
            id="cred-kind"
            required={!existing}
            value={choice < 0 ? "" : choice}
            onChange={(e) => {
              const i = Number(e.target.value);
              setChoice(i);
              setEnv(CREDENTIALS[i]!.env);
            }}
          >
            <option value="" disabled>
              Choose what you're adding
            </option>
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
              <input id="cred-name" autoComplete="off" aria-describedby="cred-name-hint" placeholder={defaultName} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="cred-value">Value</label>
              <input id="cred-value" type="password" autoComplete="off" spellCheck={false} required value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="cred-env">Variable name</label>
          <input id="cred-env" className="mono" autoComplete="off" required pattern="[A-Z_][A-Z0-9_]*" value={env} onChange={(e) => setEnv(e.target.value.toUpperCase())} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!existing && (
            <button className="btn" type="button" disabled={act.busy || !value.trim() || !c} onClick={check}>
              Check
            </button>
          )}
          <SaveButton {...sv} busy={act.busy} />
        </div>
      </form>
      {!existing && (
        <p id="cred-name-hint" className="muted" style={{ fontSize: 13 }}>
          <strong>Name</strong> is optional: it's how the value is listed under Secrets, and lets you reuse it in another company under a different variable name. Leave it blank to use the one shown. <strong>Variable name</strong> is what agents see.
        </p>
      )}
      {looksLikeJson && (
        <p role="alert" className="error" style={{ fontSize: 14 }}>
          This looks like a JSON key file (such as a Google service-account key), not a {c!.label}. Choose <strong>Other</strong> under Add, and keep the whole file as the value.
        </p>
      )}
      {c && (
        <p className="muted" style={{ fontSize: 13 }}>
          {c.help.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
        </p>
      )}
      {act.view}
    </Section>
  );
}

/** Extra MCP tool servers on the owner's network. Tokens stay in the secret store: only the name of a granted secret is entered here. */
export function ToolServers({ company }: { company: Company }) {
  const servers = usePoll((signal) => api<McpServerRow[]>(`/api/companies/${company.id}/mcp-servers`, { signal }), 30_000, `mcp-${company.id}`);
  const blank = { name: "", url: "", transport: "http", secretEnv: "", headerName: "Authorization", headerValue: "Bearer {secret}" };
  const [form, setForm] = useState(blank);
  const act = useAction();
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const add = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const { secretEnv, ...rest } = form;
      await api(`/api/companies/${company.id}/mcp-servers`, { method: "POST", body: { ...rest, secretEnv: secretEnv || null } });
      setForm(blank);
      servers.reload();
      return "Added. Agents get it from their next run.";
    });
  };
  const remove = (m: McpServerRow) =>
    window.confirm(`Remove the tool server ${m.name}? Agents stop getting it from their next run.`) &&
    void act.run(async () => {
      await api(`/api/mcp-servers/${m.id}`, { method: "DELETE" });
      servers.reload();
      return `Removed ${m.name}.`;
    });
  return (
    <Section id="mcp-h" title="Tool servers (MCP)">
      <p className="muted" style={{ fontSize: 14 }}>
        Servers apply from the next run. An agent only gets a server if it has been given the server's token secret.
      </p>
      {servers.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">URL</th>
                <th scope="col">Transport</th>
                <th scope="col">Token secret</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.data.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{m.name}</td>
                  <td className="mono">{m.url}</td>
                  <td>{m.transport}</td>
                  <td>
                    <span className="mono">{m.secretEnv ?? "none"}</span>
                    {!m.secretGranted && <span className="tag amber" style={{ marginLeft: 6 }}>Not granted to {company.name}: no agent gets this server</span>}
                  </td>
                  <td>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => remove(m)} aria-label={`Remove tool server ${m.name}`}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No tool servers yet.</p>
      )}
      <form onSubmit={add} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
        <div className="field">
          <label htmlFor="mcp-name">Server name</label>
          <input id="mcp-name" className="mono" required pattern="[a-z][a-z0-9-]{0,31}" placeholder="scrapling" value={form.name} onChange={set("name")} />
        </div>
        <div className="field">
          <label htmlFor="mcp-url">Server URL</label>
          <input id="mcp-url" type="url" required placeholder="http://192.168.68.67:30301/mcp" value={form.url} onChange={set("url")} />
        </div>
        <div className="field">
          <label htmlFor="mcp-transport">Transport</label>
          <select id="mcp-transport" value={form.transport} onChange={set("transport")}>
            <option value="http">Streamable HTTP</option>
            <option value="sse">SSE</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="mcp-secret">Token secret</label>
          <input id="mcp-secret" className="mono" pattern="[A-Z][A-Z0-9_]{0,63}" placeholder="SCRAPLING_MCP_TOKEN" aria-describedby="mcp-secret-hint" value={form.secretEnv} onChange={set("secretEnv")} />
          <span id="mcp-secret-hint" className="muted" style={{ fontSize: 13 }}>
            The name of a secret granted to this company, e.g. SCRAPLING_MCP_TOKEN. Leave empty for a server with no token.
          </span>
        </div>
        <details style={{ gridColumn: "1 / -1" }}>
          <summary>Advanced</summary>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginTop: 8 }}>
            <div className="field">
              <label htmlFor="mcp-header">Header name</label>
              <input id="mcp-header" className="mono" value={form.headerName} onChange={set("headerName")} />
            </div>
            <div className="field">
              <label htmlFor="mcp-header-value">Header value</label>
              <input id="mcp-header-value" className="mono" value={form.headerValue} onChange={set("headerValue")} />
              <span className="muted" style={{ fontSize: 13 }}>{"{secret}"} is replaced by the token when the run starts.</span>
            </div>
          </div>
        </details>
        <div>
          <button className="btn" type="submit" disabled={act.busy}>
            Add tool server
          </button>
        </div>
      </form>
      {act.view}
    </Section>
  );
}

const PROVIDERS: Array<[string, string]> = [
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["bedrock", "Amazon Bedrock"],
  ["foundry", "Microsoft Foundry"],
  ["gateway", "LLM gateway"],
  ["openrouter", "OpenRouter"],
  ["ollama", "Ollama"],
  ["synthetic", "Synthetic"],
];
/** Mirrors the server's rule: a subscription is only a Claude, ChatGPT, Ollama Cloud or Synthetic plan. */
const providerFits = (kind: string, provider: string) => kind !== "subscription" || provider === "anthropic" || provider === "openai" || provider === "ollama" || provider === "synthetic";

export function Funding({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 30_000, "sources");
  const [form, setForm] = useState({ name: "", kind: "subscription", provider: "anthropic", grant: "", anchor: "" });
  const [editing, setEditing] = useState<FundingSource | null>(null);
  const act = useAction();
  const blank = { name: "", kind: "subscription", provider: "anthropic", grant: "", anchor: "" };
  const edit = (s: FundingSource) => {
    setEditing(s);
    setForm({ name: s.name, kind: s.kind, provider: s.provider, grant: s.monthlyGrantMicros != null ? String(s.monthlyGrantMicros / 1e6) : "", anchor: s.cycleAnchor?.slice(0, 10) ?? "" });
  };
  const remove = (s: FundingSource) => {
    if (!window.confirm(`Delete the funding source "${s.name}"? Agents using it will have no funding source until you choose one.`)) return;
    void act.run(async () => {
      const r = await api<{ agentsUnlinked: number }>(`/api/funding-sources/${s.id}`, { method: "DELETE" });
      sources.reload();
      onChanged?.();
      return `Deleted. ${r.agentsUnlinked} agent${r.agentsUnlinked === 1 ? " was" : "s were"} using it.`;
    });
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      await api(editing ? `/api/funding-sources/${editing.id}` : "/api/funding-sources", {
        method: editing ? "PATCH" : "POST",
        body: {
          name: form.name,
          kind: form.kind,
          provider: form.provider,
          ...(form.kind === "api_credit" && form.grant ? { monthlyGrantUsd: Number(form.grant) } : {}),
          ...(form.kind === "api_credit" && form.anchor ? { cycleAnchor: form.anchor } : {}),
        },
      });
      setForm(editing ? blank : { ...form, name: "", grant: "", anchor: "" });
      setEditing(null);
      sources.reload();
      onChanged?.();
      return editing ? "Saved." : "Added.";
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
              {s.name} <span className="muted">· {s.kind.replace(/_/g, " ")} · {s.provider}</span>{" "}
              <button type="button" className="btn small" aria-label={`Edit ${s.name}`} onClick={() => edit(s)}>
                Edit
              </button>{" "}
              <button type="button" className="btn small" aria-label={`Delete ${s.name}`} disabled={act.busy} onClick={() => remove(s)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", alignItems: "end" }}>
        <div className="field">
          <label htmlFor="fs-name">{editing ? `Editing ${editing.name}` : "New funding source"}</label>
          <input id="fs-name" required placeholder="Claude Max" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="fs-kind">Kind</label>
          <select id="fs-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, provider: providerFits(e.target.value, form.provider) ? form.provider : "anthropic" })}>
            <option value="subscription">Subscription (setup-token)</option>
            <option value="api_credit">API credit, monthly grant</option>
            <option value="api_payg">API, pay as you go</option>
            <option value="usage_credits">Usage credits</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="fs-provider">Provider</label>
          <select id="fs-provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            {PROVIDERS.filter(([id]) => providerFits(form.kind, id)).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <details style={{ gridColumn: "1 / -1" }}>
          <summary>What the provider controls</summary>
          <div className="muted" style={{ fontSize: 14, display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            <p>
              The provider decides which service lists models for an API-key source (Anthropic, OpenAI and LLM gateways such as OpenRouter; Bedrock and Foundry use the list Claude Code reports from the runner) and labels the quota readings. It doesn't deliver the credential: agents get that from the Secrets page, as environment variables.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>Subscription + Anthropic: a Claude Pro or Max plan, run with a setup-token (<code>CLAUDE_CODE_OAUTH_TOKEN</code>).</li>
              <li>Subscription + OpenAI: a ChatGPT plan, used by Codex agents.</li>
              <li>Subscription + Ollama or Synthetic: an Ollama Cloud or Synthetic plan, used by OpenCode agents.</li>
              <li>API kinds: a key from that provider (Anthropic, OpenAI).</li>
              <li>
                Amazon Bedrock (API kinds only): add three credentials with "Other": <code>CLAUDE_CODE_USE_BEDROCK</code> = 1, <code>AWS_REGION</code> and <code>AWS_BEARER_TOKEN_BEDROCK</code> (a Bedrock API key). Name models as Bedrock IDs, e.g. <code>us.anthropic.claude-sonnet-4-6</code>.
              </li>
              <li>
                Microsoft Foundry (API kinds only): <code>CLAUDE_CODE_USE_FOUNDRY</code> = 1, <code>ANTHROPIC_FOUNDRY_RESOURCE</code> (the resource name) and <code>ANTHROPIC_FOUNDRY_API_KEY</code>. Model names are your deployment names.
              </li>
              <li>
                LLM gateway (API kinds only): <code>ANTHROPIC_BASE_URL</code> and <code>ANTHROPIC_AUTH_TOKEN</code>, for a gateway that serves Claude models in the Anthropic format. For OpenRouter: <code>https://openrouter.ai/api</code>, and the OpenRouter key on this funding source; the model list then comes from OpenRouter. Claude Code is only supported on Claude models, so others are marked "may not work".
              </li>
            </ul>
            <p>Claude agents only: Codex runs on OpenAI.</p>
            <p>
              OpenCode agents (pick "OpenCode" when hiring) read <code>OPENROUTER_API_KEY</code>, <code>OLLAMA_API_KEY</code> (Ollama Cloud), <code>SYNTHETIC_API_KEY</code> (Synthetic), <code>OPENAI_API_KEY</code> and <code>ANTHROPIC_API_KEY</code> by themselves; models are named <code>provider/model</code>. A local Ollama has no key: add a credential with "Other" named <code>OPENCODE_CONFIG_CONTENT</code>, whose value is JSON such as{" "}
              <code>{`{"provider":{"ollama":{"npm":"@ai-sdk/openai-compatible","name":"Ollama","options":{"baseURL":"http://host.docker.internal:11434/v1"},"models":{"qwen3:8b":{"name":"Qwen3 8B"}}}}}`}</code>.
            </p>
          </div>
        </details>
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
        {editing && <p className="muted" style={{ gridColumn: "1 / -1", fontSize: 14 }}>Spend already recorded stays, but it's counted by this source's current kind, so changing the kind changes how past spend counts too (for example, a subscription's spend never counts toward money caps).</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" type="submit" disabled={act.busy}>
            {editing ? "Save" : "Add"}
          </button>
          {editing && (
            <button className="btn" type="button" onClick={() => (setEditing(null), setForm(blank))}>
              Cancel
            </button>
          )}
        </div>
      </form>
      {act.view}
    </Section>
  );
}

type CheckPreset = { id: string; label: string; command: string | null; plain: string; needs: string[] };
type Presets = { detected: CheckPreset[]; standard: CheckPreset[]; none: CheckPreset; tools: Record<string, boolean> | null; error: string | null };
const CUSTOM = "custom";

/**
 * "Before merging, Boss Man will…" (R57): the check as a choice in plain words, with the
 * command underneath. Custom keeps today's text box for anything else.
 */
function CheckPicker({ id, label, value, onChange, presets }: { id: string; label: string; value: string; onChange: (v: string) => void; presets: Presets | null }) {
  const all = presets ? [...presets.detected, ...presets.standard] : [];
  const match = !value ? "none" : (all.find((x) => x.command === value)?.id ?? CUSTOM);
  // Only an explicit "Custom command…" sticks; otherwise the saved command finds its preset once the list loads.
  const [custom, setCustom] = useState(false);
  const chosen = custom ? CUSTOM : match;
  const preset = chosen === "none" ? presets?.none : all.find((x) => x.id === chosen);
  const missing = preset?.needs.filter((t) => presets?.tools && presets.tools[t] === false) ?? [];
  return (
    <div className="field" style={{ gridColumn: "1 / -1", maxWidth: 720 }}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={chosen}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) return setCustom(true);
          setCustom(false);
          onChange(v === "none" ? "" : (all.find((x) => x.id === v)?.command ?? ""));
        }}
      >
        {presets?.detected.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}: {x.plain}
          </option>
        ))}
        {presets?.standard.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
        <option value="none">Nothing: merge after review only</option>
        <option value={CUSTOM}>Custom command…</option>
      </select>
      {chosen === CUSTOM ? (
        <input aria-label={`${label}: custom command`} className="mono" placeholder="pnpm install && pnpm test" value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        preset?.command && (
          <small className="muted">
            {preset.plain}: <code className="mono">{preset.command}</code>
          </small>
        )
      )}
      {missing.length > 0 && <small className="error">The runner doesn't have {missing.join(" or ")}, so this check would fail there. Add it to the runner image, or pick another check.</small>}
    </div>
  );
}

/** `only`: "repo" hides the check pickers (detection needs the runner and git token), "checks" shows just them. */
/** Archive hides a finished project from menus and agents; its tasks and history stay, and it can come back. */
export function ArchiveProject({ p, onChanged }: { p: Project; onChanged: () => void }) {
  const act = useAction();
  const archived = !!p.archivedAt;
  return (
    <Section id={`archive-${p.id}-h`} title={archived ? "Archived" : "Archive this project"}>
      <p className="muted" style={{ fontSize: 14 }}>
        {archived
          ? `${p.name} is archived: it's hidden from the menus and from agents, and takes no new tasks. Its tasks and history are kept.`
          : `Hides ${p.name} from the menus and from agents, and stops new tasks being added. Its tasks and history are kept, and you can unarchive it. Finish or cancel its open tasks first.`}
      </p>
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/projects/${p.id}`, { method: "PATCH", body: { archived: !archived } });
              onChanged();
              return archived ? "Unarchived." : "Archived.";
            })
          }
        >
          {archived ? `Unarchive ${p.name}` : `Archive ${p.name}`}
        </button>
      </div>
      {act.view}
    </Section>
  );
}

export function ProjectRow({ p, only, onChanged, agents }: { p: Project; only?: "repo" | "checks"; onChanged?: () => void; agents?: Agent[] }) {
  const showRepo = only !== "checks";
  const showChecks = only !== "repo";
  const [form, setForm] = useState({ name: p.name, capUsd: p.ticketCostCapMicros ? String(p.ticketCostCapMicros / 1e6) : "", monthlyUsd: p.monthlyCapMicros ? String(p.monthlyCapMicros / 1e6) : "", repoUrl: p.repoUrl ?? "", defaultBranch: p.defaultBranch, verifyCommand: p.verifyCommand ?? "", deepVerifyCommand: p.deepVerifyCommand ?? "", landing: p.landing });
  const [host, setHost] = useState(p.gitHost);
  const act = useAction();
  const sv = useSaveState(form);
  const [presets, setPresets] = useState<Presets | null>(null);
  const detect = async () => setPresets(await api<Presets>(`/api/projects/${p.id}/check-presets`, { method: "POST" }).catch(() => null));
  // Detected once per project; Re-detect asks again.
  useEffect(() => void (showChecks && detect()), [p.id, showChecks]);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const saved = await api<Project>(`/api/projects/${p.id}`, {
        method: "PATCH",
        body: { ...(only ? {} : { name: form.name.trim() || p.name, ticketCostCapUsd: form.capUsd ? Number(form.capUsd) : null, monthlyCapUsd: form.monthlyUsd ? Number(form.monthlyUsd) : null }), repoUrl: form.repoUrl || null, defaultBranch: form.defaultBranch, verifyCommand: form.verifyCommand || null, deepVerifyCommand: form.deepVerifyCommand || null, landing: form.landing },
      });
      setHost(saved.gitHost);
      sv.markSaved();
      onChanged?.();
      if (form.landing === "pull_request" && form.repoUrl && !saved.gitHost) return "Saved, but Boss Man couldn't tell which git host this is, so pull requests won't open. Check the address, and that the host is reachable from the Boss Man server.";
      return saved.gitHost ? `Saved. Git host: ${saved.gitHost === "gitea" ? "Gitea" : "GitHub"} (${saved.gitApiBase}).` : "Saved.";
    });
  };
  return (
    <form onSubmit={save} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", alignItems: "start", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
      <p style={{ gridColumn: "1 / -1", fontWeight: 600 }}>{p.name}</p>
      {!only && (
        <>
          <div className="field">
            <label htmlFor={`name-${p.id}`}>Name</label>
            <input id={`name-${p.id}`} required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`cap-${p.id}`}>Cost cap per task (USD)</label>
            <input id={`cap-${p.id}`} type="number" min="0.01" step="0.01" placeholder="No cap" value={form.capUsd} onChange={(e) => setForm({ ...form, capUsd: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`monthly-${p.id}`}>Monthly spend cap (USD)</label>
            <input id={`monthly-${p.id}`} type="number" min="0.01" step="0.01" placeholder="No cap" value={form.monthlyUsd} onChange={(e) => setForm({ ...form, monthlyUsd: e.target.value })} />
          </div>
          <p className="muted" style={{ gridColumn: "1 / -1", fontSize: 13, margin: 0 }}>
            At the monthly cap, no new runs start for this project until next month (UTC) or you raise it. Both caps count money only: runs paid from a subscription (such as Claude Max) cost nothing extra, so they don't count and a cap never stops them; the Budget tab shows their tokens.
          </p>
        </>
      )}
      {showRepo && (<>
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
        <label htmlFor={`landing-${p.id}`}>When work is approved</label>
        <select id={`landing-${p.id}`} value={form.landing} onChange={(e) => setForm({ ...form, landing: e.target.value as Project["landing"] })}>
          <option value="merge">Merge into the default branch</option>
          <option value="pull_request">Open a pull request</option>
        </select>
      </div>
      </>)}
      {showChecks && (<>
      <CheckPicker id={`verify-${p.id}`} label="Before merging, Boss Man will" value={form.verifyCommand} onChange={(verifyCommand) => setForm({ ...form, verifyCommand })} presets={presets} />
      <CheckPicker id={`deep-${p.id}`} label="For high-risk work, also" value={form.deepVerifyCommand} onChange={(deepVerifyCommand) => setForm({ ...form, deepVerifyCommand })} presets={presets} />
      <p className="muted" style={{ gridColumn: "1 / -1", fontSize: 13, margin: 0 }}>
        {presets?.error ?? (presets ? "The runner looked at the repo's default branch for these." : "Looking at the repo…")}{" "}
        {form.repoUrl && (
          <button type="button" className="linkish" onClick={() => void detect()}>
            Re-detect
          </button>
        )}
      </p>
      </>)}
      {!only && agents && <ProjectReviews projectId={p.id} companyId={p.companyId} agents={agents} />}
      <SaveButton {...sv} busy={act.busy} />
      <div style={{ gridColumn: "1 / -1" }}>{act.view}</div>
    </form>
  );
}

/** The project's brief page (a map of the code the CEO writes for other agents), and the button that asks for it. */
export function ProjectBrief({ p }: { p: Project }) {
  const brief = usePoll((signal) => api<{ slug: string; exists: boolean; commit: string | null; branch: string | null; updatedAt: string | null; ticketId: string | null }>(`/api/projects/${p.id}/brief`, { signal }), 30_000, `brief-${p.id}`);
  const act = useAction();
  const b = brief.data;
  const ask = () =>
    act.run(async () => {
      await api(`/api/projects/${p.id}/brief`, { method: "POST" });
      brief.reload();
    });
  return (
    <section aria-labelledby={`brief-${p.id}`} style={{ display: "grid", gap: 8 }}>
      <h3 id={`brief-${p.id}`}>Project brief</h3>
      {b && (
        <p>
          {b.exists ? (
            <>
              <a href={`#/wiki/${p.companyId}/${b.slug}`}>{p.name} project brief</a>
              {b.commit && ` Describes commit ${b.commit.slice(0, 7)} on ${b.branch}, updated ${new Date(b.updatedAt!).toLocaleDateString()}.`}
            </>
          ) : (
            "No brief yet."
          )}
        </p>
      )}
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        Agents on this project read the brief instead of exploring the whole codebase.
      </p>
      {b &&
        (b.ticketId ? (
          <p>
            <a href={`#/tickets/${b.ticketId}`}>The CEO is writing it: open the ticket</a>
          </p>
        ) : (
          <button type="button" disabled={act.busy} onClick={() => void ask()}>
            {b.exists ? "Refresh brief" : "Write brief"}
          </button>
        ))}
      {act.view}
    </section>
  );
}

/** Every project of the chosen company: create one, open its Kanban, set its repo, checks and reviews. */
export function ProjectsPage({ companies, companyId, go, onChanged }: { companies: Company[]; companyId: string | undefined; go: (to: string) => void; onChanged?: () => void }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const projects = usePoll((signal) => (company ? api<Project[]>(`/api/companies/${company.id}/projects`, { signal }) : Promise.resolve([])), 60_000, `projects-${company?.id ?? "none"}`);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="sub">{company ? `${company.name}'s projects. Each has its own Kanban and, optionally, a git repo the agents work in.` : "Create a company first."}</p>
        </div>
      </header>
      {company && (
        <div key={company.id} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Section id="new-project-h" title="New project">
            <QuickAdd
              label="Project name"
              button="Create project"
              onAdd={async (name) => {
                await api<Project>(`/api/companies/${company.id}/projects`, { method: "POST", body: { name } });
                projects.reload();
              }}
            />
          </Section>
          <Section id="projects-h" title={`Projects (${projects.data?.filter((p) => !p.archivedAt).length ?? 0})`}>
            <p className="muted" style={{ fontSize: 14 }}>
              With a repo, each task gets its own branch and worktree. Approved work is checked, then merged into the default branch or sent as a pull request. The token in <span className="mono">GIT_TOKEN</span> is used to clone, push and open pull requests. Don't put a token in the URL.
            </p>
            {projects.data?.length
              ? projects.data.filter((p) => !p.archivedAt).map((p) => (
                  <div key={p.id}>
                    <a href={`#/board/${p.id}`} style={{ fontWeight: 600, marginRight: 8 }}>{p.name}</a>
                    <StarButton agent={p} where="Projects" onToggle={() => void api(`/api/projects/${p.id}`, { method: "PATCH", body: { starred: !p.starred } }).then(() => { projects.reload(); onChanged?.(); })} />
                    <button type="button" className="btn small" onClick={() => go(`board/${p.id}`)}>
                      Open {p.name}'s Kanban
                    </button>
                    <ProjectRow p={p} agents={company.agents} />
                  </div>
                ))
              : projects.data && <p>No projects yet.</p>}
            {projects.data?.some((p) => p.archivedAt) && (
              <details>
                <summary>Archived ({projects.data.filter((p) => p.archivedAt).length})</summary>
                {projects.data.filter((p) => p.archivedAt).map((p) => (
                  <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                    <a href={`#/board/${p.id}`}>{p.name}</a>
                    <button type="button" className="btn small" onClick={() => void api(`/api/projects/${p.id}`, { method: "PATCH", body: { archived: false } }).then(() => { projects.reload(); onChanged?.(); })}>
                      Unarchive
                    </button>
                  </div>
                ))}
              </details>
            )}
          </Section>
        </div>
      )}
    </>
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

/** The prefix in ticket references (HOL-12). Changing it renames every reference; the numbers stay. */
function TicketPrefix({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [prefix, setPrefix] = useState(company.ticketPrefix ?? "");
  const act = useAction();
  const value = prefix.trim().toUpperCase();
  const valid = /^[A-Z0-9]{1,10}$/.test(value);
  return (
    <Section id="ticket-prefix-h" title="Ticket references">
      <p className="muted" style={{ fontSize: 14 }}>
        Every ticket in {company.name} has a number, shown as {value || "PREFIX"}-{company.nextTicketNumber ?? 1} for the next one. Numbers carry on across all its projects. Changing the prefix changes how every ticket is shown; the numbers stay.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="ticket-prefix">Prefix</label>
        <input id="ticket-prefix" className="mono" maxLength={10} value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ width: 120, textTransform: "uppercase" }} />
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid || value === company.ticketPrefix}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { ticketPrefix: value } });
              onChanged();
              return "Saved.";
            })
          }
        >
          Save
        </button>
      </div>
      {act.view}
    </Section>
  );
}

type WatchdogStatus = {
  settings: WatchdogSettings;
  scrumMaster: { id: string; name: string; paused: boolean } | null;
  lastSweepAt: string | null;
  trippedAt: string | null;
  pausedUntil?: string | null;
  trippedReason: string | null;
  openFlags: number;
};
type Backtest = { from: string; to: string; flags: Array<{ ticketId: string; ref: string; title: string; rule: WatchdogRule; firstAt: string; handOffs: number; verdict: string }>; scrumMasterWakes: number; busiestHourWakes: number; wouldTripCap: boolean; caveats: string[] };

/** The limits the owner edits, with their labels and units. */
const WATCHDOG_LIMITS: Array<{ key: keyof WatchdogSettings; label: string; unit: string }> = [
  { key: "inProgressHours", label: "No movement in progress", unit: "hours" },
  { key: "reviewHours", label: "No movement in review", unit: "hours" },
  { key: "blockedHours", label: "Blocked with no movement", unit: "hours" },
  { key: "unassignedMinutes", label: "Unassigned work", unit: "minutes" },
  { key: "blockedUntilGraceHours", label: "Grace after 'blocked until'", unit: "hours" },
  { key: "ownerDecisionHours", label: "Remind me about a decision after", unit: "hours" },
  { key: "reviewBounces", label: "Review loop after more than", unit: "send-backs" },
  { key: "maxSmRunsPerHour", label: "Most Scrum Master runs per hour", unit: "runs" },
  { key: "maxNudgesPerHour", label: "Most Scrum Master actions per hour", unit: "actions" },
  { key: "alertMinutes", label: "Move an alert up a level after", unit: "minutes" },
  { key: "maxCeoAlertsPerHour", label: "Most alerts sent to the CEO per hour", unit: "alerts" },
  { key: "silentSteerMinutes", label: "Ask a silent run for a status after", unit: "minutes" },
  { key: "silentFlagMinutes", label: "Flag a silent run to the Scrum Master after", unit: "minutes" },
  { key: "unprovenHours", label: "Flag an unproven cause ('likely') after", unit: "hours" },
  { key: "idleAgentMinutes", label: "Re-wake an agent whose in-progress work has no run for", unit: "minutes" },
  { key: "spareCapacityMinutes", label: "Tell the CEO the company is under-used after", unit: "minutes" },
];

/** The Scrum Master watchdog (BOS-58): who it wakes, its limits, its safety cap, and a test against past days. */
export function Watchdog({ company }: { company: Company }) {
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [sm, setSm] = useState("");
  const [bt, setBt] = useState<Backtest | null>(null);
  const act = useAction();
  const test = useAction();
  const load = async () => {
    const s = await api<WatchdogStatus>(`/api/companies/${company.id}/watchdog`);
    setStatus(s);
    setDraft(Object.fromEntries(WATCHDOG_LIMITS.map((l) => [l.key, String(s.settings[l.key])])));
    setSm(s.scrumMaster?.id ?? "");
  };
  useEffect(() => {
    void load().catch(() => setStatus(null));
  }, [company.id]);
  if (!status) return null;
  const candidates = company.agents.filter((a) => a.role !== "ceo" && (!a.duty || a.duty === "scrum_master"));
  const save = (extra: Record<string, unknown>) =>
    act.run(async () => {
      const limits = Object.fromEntries(WATCHDOG_LIMITS.map((l) => [l.key, Number(draft[l.key])]));
      await api(`/api/companies/${company.id}/watchdog`, { method: "PATCH", body: { ...limits, scrumMasterAgentId: sm || null, ...extra } });
      await load();
      return "Saved.";
    });
  const on = status.settings.enabled;
  const recordOnly = status.settings.recordOnly;
  return (
    <Section id="watchdog-h" title="Watchdog">
      <p className="muted" style={{ fontSize: 14 }}>
        Every few minutes Boss Man checks the board with simple rules (no AI, no cost) and wakes the Scrum Master only when something looks stuck. The Scrum Master can only nudge, assign unassigned work, re-wake, chase a review, snooze, escalate to the CEO or ask you; every action is logged and can be undone.
      </p>
      <p role="status" style={{ fontSize: 14 }}>
        {status.pausedUntil
          ? `Paused after hitting its hourly limit (${status.trippedReason}). It resumes by itself ${when(status.pausedUntil)}; nothing to do.`
          : status.trippedAt && !on
          ? `Switched itself off ${when(status.trippedAt)}: ${status.trippedReason}. Look at its recent actions, then switch it back on.`
          : on
            ? `On${recordOnly ? " (record only: it writes down what it would do and reaches nobody)" : ""}. Last check ${status.lastSweepAt ? when(status.lastSweepAt) : "not yet"} · ${status.openFlags} open issue${status.openFlags === 1 ? "" : "s"}.`
            : "Off."}
      </p>
      {/* Record-only mode (BOS-166): a rehearsal day, written down and sent to nobody. */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <input id="wd-record" type="checkbox" checked={recordOnly} onChange={(e) => void save({ recordOnly: e.target.checked })} style={{ marginTop: 4 }} />
        <label htmlFor="wd-record" style={{ maxWidth: 720 }}>
          <strong>Record only (rehearse)</strong>:{" "}
          <span className="muted">
            The watchdog still checks the board and keeps its warnings up to date, but it writes down what it would have done and reaches nobody: no wake, nudge, assignment, escalation or reminder to you, and its hourly limits aren’t used. The log and the daily summary mark these as not sent. Untick this to let it act again from the next check.
          </span>
        </label>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="wd-sm">Scrum Master</label>
        <select id="wd-sm" value={sm} onChange={(e) => setSm(e.target.value)}>
          <option value="">Nobody</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "max-content 90px max-content", gap: "8px 10px", alignItems: "center" }}>
        {WATCHDOG_LIMITS.map((l) => (
          <div key={l.key} style={{ display: "contents" }}>
            <label htmlFor={`wd-${l.key}`}>{l.label}</label>
            <input id={`wd-${l.key}`} type="number" min={0} value={draft[l.key] ?? ""} onChange={(e) => setDraft({ ...draft, [l.key]: e.target.value })} />
            <span className="muted">{l.unit}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={act.busy} onClick={() => void save({})}>
          Save
        </button>
        <button type="button" className="btn" disabled={act.busy || (!on && !sm)} onClick={() => void save({ enabled: !on })}>
          {on ? "Switch off" : status.trippedAt ? "Switch back on" : "Switch on"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={test.busy}
          onClick={() =>
            void test.run(async () => {
              setBt(await api<Backtest>(`/api/companies/${company.id}/watchdog/backtest?days=2`));
            })
          }
        >
          Test on the past 48 hours
        </button>
      </div>
      {act.view}
      {test.view}
      {bt && (
        <div style={{ fontSize: 14 }}>
          <p>
            It would have raised {bt.flags.length} flag{bt.flags.length === 1 ? "" : "s"} and woken the Scrum Master {bt.scrumMasterWakes} time{bt.scrumMasterWakes === 1 ? "" : "s"} (at most {bt.busiestHourWakes} in one hour{bt.wouldTripCap ? ", which would have tripped the safety cap" : ""}).{" "}
            {bt.flags.filter((f) => f.verdict === "cleared within 30 min").length} cleared by themselves within 30 minutes, so may not have needed it.
          </p>
          {bt.flags.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Problem</th>
                  <th>First seen</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {bt.flags.map((f) => (
                  <tr key={`${f.ticketId}-${f.rule}-${f.firstAt}`}>
                    <td>
                      <a href={`#/tickets/${f.ticketId}`}>{f.ref}</a> {f.title}
                    </td>
                    <td>{WATCHDOG_RULE_LABEL[f.rule]}</td>
                    <td>{when(f.firstAt)}</td>
                    <td>{f.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ul className="muted">
            {bt.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/** CEO continuity: the CEO's current chapter, and the handoffs between chapters. */
function GoalCheck({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [days, setDays] = useState(String(company.goalCheckDays ?? 14));
  const act = useAction();
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 365;
  return (
    <Section id="goal-check-h" title="Did it move the goal?">
      <p className="muted" style={{ fontSize: 14 }}>
        After a feature linked to a key result is released, Boss Man asks you once whether it moved that goal: keep it, change it or drop it.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="goal-days">Ask after (days)</label>
        <input id="goal-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 80 }} />
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { goalCheckDays: n } });
              onChanged();
              return "Saved.";
            })
          }
        >
          Save
        </button>
      </div>
      {act.view}
    </Section>
  );
}

type RetroStatus = { agentId: string | null; runner: { id: string; name: string; source: "chosen" | "default" | "ceo" } | null; last: { startedAt: string; doneCount: number; savedAt: string | null } | null; doneSince: number };

/** Workflow retros (docs/19): who runs the team's look-back, when it last ran, and a button to run one now. */
function WorkflowRetros({ company }: { company: Company }) {
  const [status, setStatus] = useState<RetroStatus | null>(null);
  const act = useAction();
  const load = async () => setStatus(await api<RetroStatus>(`/api/companies/${company.id}/retro-settings`));
  useEffect(() => {
    void load().catch(() => setStatus(null));
  }, [company.id]);
  if (!status) return null;
  const hasPm = company.agents.some((a) => a.template === "product-manager" && !a.paused);
  return (
    <Section id="retro-h" title="Workflow retros">
      <p className="muted" style={{ fontSize: 14 }}>
        Every 20 finished tickets, or after 7 days if anything was finished, one agent looks back over how the team worked and suggests small changes. It never changes anything without approval: the CEO approves playbooks and brief lessons, and you approve the rest.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="retro-agent">Who runs it</label>
        <select
          id="retro-agent"
          value={status.agentId ?? ""}
          disabled={act.busy}
          onChange={(e) =>
            void act.run(async () => {
              setStatus(await api<RetroStatus>(`/api/companies/${company.id}/retro-settings`, { method: "PUT", body: { agentId: e.target.value || null } }));
              return "Saved.";
            })
          }
        >
          <option value="">{hasPm ? "Product Manager (default)" : "CEO (no Product Manager)"}</option>
          {company.agents
            .filter((a) => a.duty !== "assistant")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </div>
      <p style={{ fontSize: 14 }}>
        {status.last ? `Last ran ${when(status.last.startedAt)}, over ${status.last.doneCount} finished tickets.` : "It has not run yet. The first one waits for 5 finished tickets."} {status.doneSince} finished since.
      </p>
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy || status.doneSince < 1}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}/retro`, { method: "POST" });
              await load();
              return `${status.runner?.name ?? "The agent"} has been asked to run a retro.`;
            })
          }
        >
          Run a retro now
        </button>
      </div>
      {act.view}
    </Section>
  );
}

/** How long the CEO has to act on a decision the owner asked for advice on. */
function AdviceTimeout({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [minutes, setMinutes] = useState(String(company.adviceTimeoutMinutes ?? 120));
  const act = useAction();
  const n = Number(minutes);
  const valid = Number.isInteger(n) && n >= 5 && n <= 1440;
  return (
    <Section id="advice-timeout-h" title="Asking the CEO for advice">
      <p className="muted" style={{ fontSize: 14 }}>
        When you press "Ask the CEO for advice" on a decision, the CEO has this long to rewrite or settle it. After that it goes back to you as it was.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="advice-timeout">Minutes the CEO has</label>
        <input id="advice-timeout" type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 80 }} />
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { adviceTimeoutMinutes: n } });
              onChanged();
              return "Saved.";
            })
          }
        >
          Save
        </button>
      </div>
      {act.view}
    </Section>
  );
}

/** Standing rules (BOS-353): what every agent reads at the start of every run. The owner can edit, clear or undo them here; agents cannot. */
function StandingRules({ company, onChanged }: { company: Company; onChanged: () => void }) {
  type Rules = { text: string; by: string | null; at: string | null; max: number };
  const [rules, setRules] = useState<Rules | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const act = useAction();
  useEffect(() => {
    let live = true;
    void api<Rules>(`/api/companies/${company.id}/standing-rules`)
      .then((r) => live && setRules(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [company.id]);
  const url = `/api/companies/${company.id}/standing-rules`;
  return (
    <Section id="standing-rules-h" title="Standing rules">
      <p className="muted" style={{ fontSize: 14 }}>
        The rules every agent reads at the start of every run. Your CEO can set them, and so can you; no other agent can change them. They are capped at {rules?.max ?? 2000} characters.
      </p>
      {failed ? (
        <p className="muted">Couldn't load the standing rules.</p>
      ) : !rules ? (
        <p className="muted">Loading…</p>
      ) : draft !== null ? (
        <>
          <textarea aria-label="Standing rules" value={draft} onChange={(e) => setDraft(e.target.value)} rows={8} style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 14 }} />
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={act.busy}
              onClick={() =>
                void act.run(async () => {
                  const saved = await api<Rules>(url, { method: "PUT", body: { text: draft } });
                  setRules(saved);
                  setDraft(null);
                  onChanged();
                  return "Saved.";
                })
              }
            >
              Save
            </button>
            <button type="button" className="btn" disabled={act.busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {rules.text ? (
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", fontSize: 14, padding: 12, background: "var(--panel, #f6f6f6)", borderRadius: 6 }}>{rules.text}</pre>
          ) : (
            <p className="muted">No standing rules are set yet.</p>
          )}
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {rules.text ? "Last changed by " : "Last cleared by "}
            {rules.by === "undo" ? "an undo" : (rules.by ?? "no one")}
            {rules.at ? ` on ${when(rules.at)}` : ""}.
          </p>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
            <button type="button" className="btn" disabled={act.busy} onClick={() => setDraft(rules.text)}>
              Edit
            </button>
            {rules.text ? (
              <button
                type="button"
                className="btn"
                disabled={act.busy}
                onClick={() => {
                  if (!confirm("Clear the standing rules? Agents will stop reading them from the next run.")) return;
                  void act.run(async () => {
                    const saved = await api<Rules>(url, { method: "PUT", body: { text: "" } });
                    setRules(saved);
                    onChanged();
                    return "Cleared.";
                  });
                }}
              >
                Clear
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={act.busy || !rules.at}
              onClick={() =>
                void act.run(async () => {
                  const saved = await api<Rules>(`${url}/undo`, { method: "POST" });
                  setRules(saved);
                  onChanged();
                  return "Undone.";
                })
              }
            >
              Undo last change
            </button>
          </div>
        </>
      )}
      {act.view}
    </Section>
  );
}

/** How the rules judge advises on permission cards (BOS-337). It only picks the suggested button; it never answers a card. */
function PermissionJudgeSetting({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const act = useAction();
  const mode = company.permissionJudge ?? "watch";
  return (
    <Section id="permission-judge-h" title="Advice on permission cards">
      <p className="muted" style={{ fontSize: 14 }}>
        Boss Man can look at where a command reaches (its own folder, secrets, other agents, the network) and suggest Allow or Deny with a one-line reason. It only suggests: you or the CEO still press the button, and pushes to main, publishing, deploys, secrets and other agents' work stay decided by fixed rules.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="permission-judge">Advice</label>
        <select
          id="permission-judge"
          value={mode}
          disabled={act.busy}
          onChange={(e) =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { permissionJudge: e.target.value } });
              onChanged();
              return "Saved.";
            })
          }
        >
          <option value="advise">Advise: suggest a button and say why</option>
          <option value="watch">Watch: only record what it would suggest next to your answer</option>
          <option value="off">Off: use the older text rules</option>
        </select>
      </div>
      {act.view}
    </Section>
  );
}

type FenceStatus = { registered: boolean; sandbox?: { level: "full" | "partial" | "unavailable"; missing: string[]; probe: boolean | null } | null; sandboxCheckedAt?: string | null };

/** The agent fence (BOS-325): off, watch or enforce, with this host's fence level. A refusal by the fence is wording on the card, never a decision. */
function FenceSetting({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const act = useAction();
  const status = usePoll((signal) => api<FenceStatus>(`/api/companies/${company.id}/runner`, { signal }), 30_000, `fence-${company.id}`);
  const mode = company.fenceMode ?? "off";
  const sb = status.data?.sandbox ?? null;
  const hostLine = !status.data?.registered
    ? "This company has no runner yet."
    : !sb
      ? "This host hasn't reported its fence level yet. It reports each time the runner starts."
      : sb.level === "unavailable"
        ? "This host can't fence agents (its kernel doesn't offer Landlock, or the container blocks it). Agents run as before."
        : `This host fences agents ${sb.level === "full" ? "fully" : "partly"}${sb.missing.length ? ` (not covered: ${sb.missing.join(", ")})` : ""}.${sb.probe === false ? " Its self-test did not see a write outside the agent's folders refused." : ""} Last checked ${status.data?.sandboxCheckedAt ? when(status.data.sandboxCheckedAt) : "never"}.`;
  return (
    <Section id="fence-h" title="Agent fence">
      <p className="muted" style={{ fontSize: 14 }}>
        The fence is a kernel limit on what an agent's commands can touch: its own folders and nothing else. It doesn't ask you anything and doesn't change which permission cards appear. When it refuses something the agent just sees "Permission denied", and Boss Man writes that to its permission log.
      </p>
      <p style={{ fontSize: 14 }}>{hostLine}</p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="fence-mode">Fence</label>
        <select
          id="fence-mode"
          value={mode}
          disabled={act.busy}
          onChange={(e) =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { fenceMode: e.target.value } });
              onChanged();
              return "Saved. It applies to runs that start from now on.";
            })
          }
        >
          <option value="off">Off: agents run as before</option>
          <option value="watch">Watch: agents run inside the fence and every refusal is logged</option>
          <option value="enforce" disabled>
            Enforce: not available yet (waiting for a security fix, BOS-323)
          </option>
        </select>
      </div>
      <details style={{ marginTop: 10 }}>
        <summary>Setting up a host</summary>
        <ul style={{ fontSize: 14 }}>
          <li>The fence needs a Linux kernel with Landlock (5.13 or newer, and 6.x for full cover). Most current Docker hosts have it; TrueNAS, a Proxmox VM and a plain Linux machine all work if the kernel does.</li>
          <li>The runner tests the fence each time it starts. If this page says "can't fence", update the host's kernel, or check that the container's security profile doesn't block Landlock, then restart the runner.</li>
          <li>A fenced agent has its own temporary folder for each run and can't write to the shared /tmp. A skill that hard-codes /tmp needs to use the folder in $TMPDIR instead.</li>
          <li>Start with Watch on one company, look at the permission log after a few days, and fix what it shows before anything stricter.</li>
        </ul>
      </details>
      {act.view}
    </Section>
  );
}

type SecondOpinion = { enabled: boolean; baseUrl: string; model: string; secretId: string | null };

/** The optional model second opinion on permission cards (BOS-338): off by default. The key is a secret from the encrypted store. */
function SecondOpinionSetting({ company }: { company: Company }) {
  const cur = usePoll((signal) => api<SecondOpinion>(`/api/companies/${company.id}/second-opinion`, { signal }), 600_000, `second-${company.id}`);
  const secrets = usePoll((signal) => api<Array<{ id: string; name: string }>>("/api/secrets", { signal }), 600_000, "secrets");
  const [v, setV] = useState<SecondOpinion | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sv = useSaveState(v);
  // Only the first load fills the form, so a background refresh never overwrites an edit in progress.
  useEffect(() => {
    if (!cur.data || v) return;
    setV(cur.data);
    sv.reset(cur.data);
  }, [cur.data]);
  if (!v) return null;
  const judgeOff = (company.permissionJudge ?? "watch") === "off";
  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    api(`/api/companies/${company.id}/second-opinion`, { method: "PUT", body: v })
      .then(
        () => (sv.markSaved(), setMsg("Saved.")),
        (err: Error) => setMsg(err.message),
      )
      .finally(() => setBusy(false));
  };
  const test = () => {
    setBusy(true);
    setMsg("Asking the model…");
    api<{ ok: boolean; message: string }>(`/api/companies/${company.id}/second-opinion/test`, { method: "POST", body: v })
      .then(
        (r) => setMsg(r.message),
        (err: Error) => setMsg(err.message),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Section id="second-opinion-h" title="Second opinion from a model (optional)">
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ fontSize: 14 }}>
          Off by default. When it's on, a card the rules above would suggest allowing is also shown to a model you pick. It can only make the advice stricter: a card is suggested Allow only when both agree. If the model is slow (over 5 seconds), down, out of credit or gives an answer Boss Man can't read, the rules decide alone. It never presses a button. The card's text is sent to the provider, with tokens, keys and passwords removed first.
        </p>
        {judgeOff && <p className="muted" style={{ fontSize: 14 }}>Advice on permission cards is off, so the model isn't asked. Set it to Watch or Advise first.</p>}
        <label>
          <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Ask a model for a second opinion
        </label>
        <div>
          <strong style={{ fontSize: 14 }}>Suggested models</strong> <span className="muted" style={{ fontSize: 14 }}>(from our test on 203 real cards; click one to fill in the fields)</span>
          <ul style={{ margin: "6px 0", paddingLeft: 20, fontSize: 14 }}>
            {SECOND_OPINION_PRESETS.map((p) => (
              <li key={p.label}>
                <button type="button" className="linkish" onClick={() => setV({ ...v, baseUrl: p.baseUrl, model: p.model })}>
                  {p.label}
                </button>{" "}
                <span className="muted">— {p.note}</span>
              </li>
            ))}
          </ul>
          <small className="muted">Decision models such as Jev, d3 and the others that only return a score don't work for this: they can't tell safe from unsafe reliably and give no reason. Use a chat model.</small>
        </div>
        <div className="field">
          <label htmlFor="second-url">Provider address</label>
          <input id="second-url" value={v.baseUrl} placeholder="https://openrouter.ai/api/v1" onChange={(e) => setV({ ...v, baseUrl: e.target.value })} />
          <small className="muted">Any OpenAI-compatible service (it must accept /chat/completions): OpenRouter, Synthetic, or your own server such as Ollama.</small>
        </div>
        <div className="field">
          <label htmlFor="second-model">Model</label>
          <input id="second-model" value={v.model} placeholder="openai/gpt-oss-safeguard-20b" onChange={(e) => setV({ ...v, model: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="second-key">API key</label>
          <select id="second-key" value={v.secretId ?? ""} onChange={(e) => setV({ ...v, secretId: e.target.value || null })}>
            <option value="">None (a local server)</option>
            {(secrets.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          {!v.secretId && <small className="muted">Add the key under Secrets first, then pick it here.</small>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <SaveButton {...sv} busy={busy} />
          <button type="button" className="btn" disabled={busy || !v.baseUrl || !v.model} onClick={test}>
            Test
          </button>
        </div>
        {msg && <p role="status">{msg}</p>}
      </form>
    </Section>
  );
}

/** The company's hourly nudge limit (BOS-73). */
function NudgeCap({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [cap, setCap] = useState(String(company.nudgesPerHour ?? 30));
  const act = useAction();
  const n = Number(cap);
  const valid = Number.isInteger(n) && n >= 1 && n <= 1000;
  return (
    <Section id="nudge-cap-h" title="Nudges">
      <p className="muted" style={{ fontSize: 14 }}>
        Agents nudge each other to hand over work or ask a question, and each nudge wakes the colleague. Past this many in an hour, they write on the ticket instead. The Scrum Master's nudges have their own limit under Watchdog.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="nudge-cap">Nudges per hour</label>
        <input id="nudge-cap" type="number" min={1} max={1000} value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 80 }} />
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { nudgesPerHour: n } });
              onChanged();
              return "Saved.";
            })
          }
        >
          Save
        </button>
      </div>
      {act.view}
    </Section>
  );
}

/** The company's workspace disk cap (R54, BOS-274): over it, the owner hears once a day; nothing is stopped. */
export function WorkspaceDisk({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [gb, setGb] = useState(company.diskCapBytes != null ? String(+(company.diskCapBytes / 1024 ** 3).toFixed(1)) : "");
  const act = useAction();
  const n = Number(gb);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100_000;
  return (
    <Section id="workspace-disk-h" title="Workspace disk">
      <p className="muted" style={{ fontSize: 14 }}>
        Each ticket keeps its working files on the runner's disk until it has been done for a while. When the company's workspaces grow past this cap, Boss Man tells you once a day with the biggest ones named. It is a warning only: it never stops runs or refuses new workspaces. Worktrees of tickets done more than 7 days ago are released automatically.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="disk-cap">Disk cap (GB)</label>
        <input id="disk-cap" type="number" min={1} max={100000} step={1} placeholder="20" value={gb} onChange={(e) => setGb(e.target.value)} style={{ width: 100 }} />
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { diskCapGb: n } });
              onChanged();
              return "Saved. It applies at the next hourly clean-up.";
            })
          }
        >
          Save
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {company.diskCapBytes != null ? `Currently ${(company.diskCapBytes / 1024 ** 3).toFixed(1)} GB.` : "Currently the server default, 20 GB."}
      </p>
      {act.view}
    </Section>
  );
}

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

type SelfDeployView = {
  enabled: boolean;
  pending: boolean;
  status: { result: string; message: string; target: string; to_commit: string; ended: string; started: string } | null;
  available: { tip: string; deployed: string; checkedAt: string; commits: unknown[] } | null;
};

/** A server update waiting for a quiet machine (BOS-420). */
type DeployWaitView =
  | { on: false }
  | { on: true; phase: "waiting" | "sent" | "window" | "handover"; origin: "approve" | "hand"; commit: string; deadline: string; windowUntil?: string; quiet?: { ready: boolean; runs: number; checks: number; freeMb: number | null; needMb: number | null; why: string[] } };

const gbOf = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

/** The plain-words line for a waiting update: what it waits for, and what is held back meanwhile. */
function waitLine(w: Extract<DeployWaitView, { on: true }>): string {
  const q = w.quiet;
  const mem = q?.freeMb != null && q.needMb != null ? ` ${gbOf(q.freeMb)} free of the ${gbOf(q.needMb)} it needs.` : "";
  const held = " Meanwhile new merge checks wait and fewer runs start.";
  if (w.phase === "waiting")
    return w.origin === "hand"
      ? q?.ready
        ? `Ready: the machine is quiet. Apply the update to ${w.commit.slice(0, 8)} by hand now.${mem}${held}`
        : `Making room before you apply the update to ${w.commit.slice(0, 8)} by hand: ${q?.why.join("; ") || "checking"}.${mem}${held}`
      : `The update to ${w.commit.slice(0, 8)} is waiting for a quiet machine: ${q?.why.join("; ") || "checking"}.${mem} You'll be asked at ${when(w.deadline)} if it is still waiting.${held}`;
  if (w.phase === "sent") return `The update to ${w.commit.slice(0, 8)} has gone to the machine.${held}`;
  if (w.phase === "window") return `The update is live; its standby window runs until ${when(w.windowUntil ?? w.deadline)}.${held}`;
  return `The update is live; waiting for the runner update to start.${held}`;
}

/** What the host deployer last did, and a button to ask for the newest main (docs/09-self-deploy.md). Hidden when self-deploy is off. */
function SelfDeploy({ go }: { go: (to: string) => void }) {
  const view = usePoll((signal) => api<SelfDeployView>("/api/self-deploy", { signal }), 10_000, "self-deploy");
  const wait = usePoll((signal) => api<DeployWaitView>("/api/self-deploy/wait", { signal }), 10_000, "self-deploy-wait");
  const act = useAction();
  const v = view.data;
  const w = wait.data?.on ? wait.data : null;
  if (!v?.enabled) return null;
  const s = v.status;
  // Right after a deploy the host's offer still names the old commit for a few minutes.
  const waiting = v.available && v.available.tip && v.available.tip !== v.available.deployed && !(s?.result === "deployed" && s.to_commit === v.available.tip);
  return (
    <Section id="deploy-h" title="Updates">
      <p style={{ fontSize: 14 }}>
        {s ? `Last deploy: ${s.result.replace(/_/g, " ")}, ${s.target} ${s.to_commit.slice(0, 8)}, ${when(s.ended || s.started)}. ${s.message}` : "No deploy yet."}
      </p>
      <p className="muted" style={{ fontSize: 14 }}>
        {v.pending ? "A request is waiting for the host (it checks every minute)." : v.available ? (waiting ? `Main is ahead: ${v.available.deployed.slice(0, 8)} to ${v.available.tip.slice(0, 8)}.` : `Up to date as of ${when(v.available.checkedAt)}.`) : "The host deployer has not reported yet."}
      </p>
      {w && (
        <p style={{ fontSize: 14 }}>
          {waitLine(w)}{" "}
          <button
            type="button"
            className="btn"
            disabled={act.busy}
            onClick={() =>
              act.run(async () => {
                try {
                  await api("/api/self-deploy/wait/cancel", { method: "POST", body: {} });
                } catch (err) {
                  if (err instanceof ApiError && err.status === 409) return err.message;
                  throw err;
                }
              })
            }
          >
            {w.phase === "waiting" && w.origin === "hand" ? "Stop making room" : w.phase === "waiting" || w.phase === "sent" ? "Cancel the update" : "Lift the hold now"}
          </button>
        </p>
      )}
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy || v.pending || s?.result === "running"}
          onClick={() =>
            act.run(async () => {
              try {
                await api("/api/self-deploy/deploy-latest", { method: "POST", body: {} });
              } catch (err) {
                // Nothing new is not a failure: the server says so, and has asked the host to look at main again.
                if (err instanceof ApiError && err.status === 409) return err.message;
                throw err;
              }
              go("decisions");
            })
          }
        >
          Deploy latest
        </button>{" "}
        <button
          type="button"
          className="btn"
          disabled={act.busy || v.pending || s?.result === "running"}
          title="Builds a new runner image from the deployed code (for example new tools in apps/runner/Dockerfile), checks it, then swaps each runner when its company is idle."
          onClick={() =>
            act.run(async () => {
              await api("/api/self-deploy/update-runners", { method: "POST", body: {} });
              go("decisions");
            })
          }
        >
          Build and update runners
        </button>
      </div>
      {act.view}
    </Section>
  );
}

type LastUpdate = { at: string; startedAt: string | null; ok: boolean; title: string; body: string } | null;

/** How many agents may run at once, in total and per company; the per-agent limit is fixed at one. */
function RunLimits() {
  const view = usePoll((signal) => api<{ instance: number; company: number; defaults: { instance: number; company: number } }>("/api/run-limits", { signal }), 30_000, "run-limits");
  const act = useAction();
  const [edit, setEdit] = useState<{ instance: string; company: string } | null>(null);
  const d = view.data;
  if (!d) return null;
  const v = edit ?? { instance: String(d.instance), company: String(d.company) };
  const [i, c] = [Number(v.instance), Number(v.company)];
  const valid = Number.isInteger(i) && i >= 1 && i <= 32 && Number.isInteger(c) && c >= 1 && c <= 16 && c <= i;
  return (
    <Section id="run-limits-h" title="How many agents run at once">
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="limit-instance">Across all companies (1 to 32)</label>
        <input id="limit-instance" type="number" min={1} max={32} value={v.instance} onChange={(e) => setEdit({ ...v, instance: e.target.value })} style={{ width: 80 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          Agents running at once, across all companies (default {d.defaults.instance}). Each running agent uses memory and CPU on this machine and spends from its funding source. Higher: more work happens in parallel, but more spend at once and more load on the server. Lower: work queues for longer (you'll see "at a concurrency limit: all companies"). When a slot frees, a company with nothing running gets it first, so one busy company can't keep the others waiting.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor="limit-company">In one company (1 to 16, no more than the number above)</label>
        <input id="limit-company" type="number" min={1} max={16} value={v.company} onChange={(e) => setEdit({ ...v, company: e.target.value })} style={{ width: 80 }} />
        <p className="muted" style={{ fontSize: 14 }}>
          Agents running at once in one company (default {d.defaults.company}). Stops one busy company from using every slot. Higher: that company's tickets and reviews start sooner; spend can rise faster. Lower: tickets wait in the queue (you'll see "at a concurrency limit: this company").
        </p>
      </div>
      <p className="muted" style={{ fontSize: 14 }}>
        Each agent always does one piece of work at a time (it has one working folder), plus one chat with you. Your chats are never held by these limits.
      </p>
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy || !valid}
          onClick={() =>
            void act.run(async () => {
              await api("/api/run-limits", { method: "PUT", body: { instance: i, company: c } });
              setEdit(null);
              view.reload();
              return "Saved.";
            })
          }
        >
          Save
        </button>
      </div>
      {act.view}
    </Section>
  );
}

type UpdateRow = { at: string; title: string; body: string; state: "ok" | "resolved" | "problem"; todo: string | null };
type LiveRow = { slug: string; name: string; registered: boolean; connected: boolean; at: string | null; imageVersion: string | null; fault: string | null };
type Report = { live: LiveRow[]; update: UpdateRow | null };
type MaintenanceView = ({ on: false } | { on: true; deadline: string; runs: number; companies: number }) & { last?: LastUpdate };

/** The last update as history: grey and "Resolved" once the runner has come back on its image, red only for something wrong now (BOS-465). */
function UpdateHistory({ r }: { r: UpdateRow }) {
  if (r.state === "ok")
    return (
      <p style={{ fontSize: 14 }} data-testid="update-history">
        <span className="tag">OK</span> Last update {when(r.at)}: {r.title}. {r.body}
      </p>
    );
  if (r.state === "resolved")
    return (
      <p style={{ fontSize: 14 }} data-testid="update-history">
        <span className="tag grey">Resolved</span> Last update {when(r.at)}: it finished with problems ({r.body}), but the runner has since reconnected on the new image.
      </p>
    );
  return (
    <p style={{ fontSize: 14 }} data-testid="update-history">
      <span className="tag red">PROBLEM</span> Last update {when(r.at)}: {r.title}. {r.body} <strong>{r.todo}</strong>
    </p>
  );
}

/** The live state of one company's runner, leading the panel: connected or not, and since when. */
function LiveState({ r }: { r: LiveRow }) {
  const connected = r.registered && r.connected;
  return (
    <li style={{ listStyle: "none" }}>
      <strong>{r.name}</strong>{" "}
      {connected ? <span className="tag green">Connected</span> : <span className="tag red">Not connected</span>}{" "}
      <span className="muted">
        {connected ? "since" : r.at ? "last seen" : ""} {r.at ? when(r.at) : ""}
        {connected && r.imageVersion ? ` · image ${r.imageVersion}` : ""}
        {r.fault ? ` · ${r.fault}` : ""}
      </span>
    </li>
  );
}

/** Drain-then-swap for runner updates: start it by hand (after scripts/update-runner.sh built the image) or cancel one that is running. */
export function RunnerUpdate() {
  const view = usePoll((signal) => api<MaintenanceView>("/api/maintenance", { signal }), 5_000, "maintenance-settings");
  const report = usePoll((signal) => api<Report>("/api/runner-report", { signal }), 5_000, "runner-report");
  const act = useAction();
  const m = view.data;
  if (!m) return null;
  const r = report.data;
  return (
    <Section id="drain-h" title="Runner update">
      {r && (
        <div role="status" data-testid="runner-live">
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Now</h3>
          {r.live.length ? (
            <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {r.live.map((l) => (
                <LiveState key={l.slug} r={l} />
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ fontSize: 14 }}>No company has a runner yet.</p>
          )}
        </div>
      )}
      <p className="muted" style={{ fontSize: 14 }}>
        {m.on
          ? `Update pending: ${m.runs > 0 ? `waiting for ${m.runs} run${m.runs === 1 ? "" : "s"} in ${m.companies} ${m.companies === 1 ? "company" : "companies"}; you are asked at ${when(m.deadline)} if some are still going` : "swapping the runners now"}. Nothing new starts until it is done.`
          : "Puts every company's runner on the newest image: nothing new starts, runs in progress finish, and each runner is swapped as its company goes idle. Build the image first with Build and update runners under Updates, which also starts this; use this button only after scripts/update-runner.sh."}
      </p>
      <div>
        {r?.update ? (
          <UpdateHistory r={r.update} />
        ) : (
          <p className="muted" style={{ fontSize: 14 }}>
            No runner update has finished here yet.
          </p>
        )}
      </div>
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy}
          onClick={() =>
            act.run(async () => {
              await api(m.on ? "/api/maintenance/cancel" : "/api/maintenance/start", { method: "POST", body: {} });
              view.reload();
            })
          }
        >
          {m.on ? "Cancel the update" : "Update runners (finish runs first)"}
        </button>
      </div>
      {act.view}
    </Section>
  );
}

type Health = { role: "leader" | "standby" | "single"; version: string; commit: string; colour: "blue" | "green" | null; startedAt: string };
type Colour = { colour: "blue" | "green"; up: boolean; role: string | null; commit: string | null; startedAt: string | null };
type BlueGreen = { enabled: false } | { enabled: true; self: "blue" | "green"; colours: Colour[] };
const ROLE_NOTE = { leader: "", standby: " (another copy is in charge; changes here are refused)", single: " (no leader lock)" };

/** This copy of the server ("leader" runs the work, "standby" only serves reads; docs/09-self-deploy.md) and, when blue/green is on, both colours. */
type HostFactsView = {
  hostName: string | null;
  reportedAt: string | null;
  ownerFacts: string[];
  facts: Record<string, { value: string; source: "host" | "owner"; at: string; conflict?: { confirmed: string; reported: string } }>;
};
const OWNER_FACT_LABELS: Record<string, string> = {
  "network.publicAddress": "Address you reach Boss Man at from outside",
  "repo.deployKeyAdded": "Deploy key added to the code host (yes or no)",
};

/** Settings → This host (BOS-419): what the host deployer reported, and the facts only the owner can confirm. */
export function ThisHost() {
  const facts = usePoll((signal) => api<HostFactsView>("/api/host-facts", { signal }), 30_000, "host-facts");
  const act = useAction();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const d = facts.data;
  if (!d) return null;
  const keys = Object.keys(d.facts).sort();
  const save = (key: string) =>
    act.run(async () => {
      await api("/api/host-facts", { method: "PUT", body: { key, value: draft[key] ?? "" } });
      facts.reload();
      return "Saved.";
    });
  return (
    <Section id="this-host-h" title="This host">
      <p className="muted" style={{ fontSize: 14 }}>
        {d.reportedAt
          ? `What the host${d.hostName ? ` ${d.hostName}` : ""} last told Boss Man about itself, ${when(d.reportedAt)}. Agents' cards use these facts, so a card can't be raised while one it needs is missing.`
          : "The host hasn't reported yet. Once its deployer runs, its facts show up here."}
      </p>
      {keys.length > 0 && (
        <dl data-testid="host-facts" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", fontSize: 14 }}>
          {keys.map((k) => {
            const f = d.facts[k]!;
            return (
              <Fragment key={k}>
                <dt className="mono">{k}</dt>
                <dd>
                  <span className="mono">{f.value}</span> <span className="muted">({f.source === "host" ? "reported by the host" : "confirmed by you"})</span>
                  {f.conflict && (
                    <span className="error" role="alert">
                      {" "}
                      You confirmed "{f.conflict.confirmed}" but the host reports "{f.conflict.reported}". The host's value is used.
                    </span>
                  )}
                </dd>
              </Fragment>
            );
          })}
        </dl>
      )}
      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Facts only you can give</h3>
      {d.ownerFacts.map((k) => (
        <div key={k} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor={`hf-${k}`}>{OWNER_FACT_LABELS[k] ?? k}</label>
          <input id={`hf-${k}`} className="mono" maxLength={500} placeholder={d.facts[k]?.value ?? ""} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          <button type="button" className="btn" disabled={act.busy || !(draft[k] ?? "").trim() || d.facts[k]?.source === "host"} onClick={() => void save(k)}>
            Confirm
          </button>
        </div>
      ))}
      {act.view}
    </Section>
  );
}

function ServerPanel() {
  const h = usePoll((signal) => api<Health>("/api/health", { signal }), 10_000, "server-role");
  const bg = usePoll((signal) => api<BlueGreen>("/api/bluegreen", { signal }), 10_000, "bluegreen");
  if (!h.data) return null;
  const { role, version, commit, startedAt } = h.data;
  const b = bg.data;
  return (
    <Section id="server-h" title="Server">
      <dl className="facts" data-testid="server-role">
        <dt>Role</dt>
        <dd>
          <strong>{role}</strong>
          {ROLE_NOTE[role]}
        </dd>
        <dt>Version</dt>
        <dd>
          {version} · <span className="mono">{commit.slice(0, 7)}</span>
        </dd>
        <dt>Running since</dt>
        <dd>{when(startedAt)}</dd>
        {b?.enabled && (
          <>
            <dt>Blue/green</dt>
            <dd>
              On. This page comes from <span className={`tag ${b.self}`}>{b.self}</span>
            </dd>
            {b.colours.map((c) => (
              <ColourRow key={c.colour} c={c} />
            ))}
            {b.colours.some((c) => !c.up) && (
              <>
                <dt>Note</dt>
                <dd data-testid="colour-down-note">
                  {b.colours.find((c) => c.colour === b.self)?.role === "leader"
                    ? "One colour is not running, so there is nothing to switch back to. This is normal after a finished update (the old copy is stopped on purpose); if it is not, check the last update's result."
                    : "This copy is not leading and the other colour is not running, so nothing is in charge. Start the live colour on the host and send it SIGUSR2; the update's alert lists the exact commands. If both colours are stopped this page cannot load at all, so use that alert."}
                </dd>
              </>
            )}
          </>
        )}
      </dl>
    </Section>
  );
}

function ColourRow({ c }: { c: Colour }) {
  const state = !c.up ? "Not running" : c.role === "leader" ? "Live" : c.role === "standby" ? "Standby" : (c.role ?? "Up");
  return (
    <>
      <dt>
        <span className={`tag ${c.colour}`}>{c.colour}</span>
      </dt>
      <dd>
        <span className={c.up ? undefined : "muted"}>{state}</span>
        {c.up && c.commit && (
          <span className="muted">
            {" "}
            · <span className="mono">{c.commit.slice(0, 7)}</span>
            {c.startedAt ? ` · running since ${when(c.startedAt)}` : ""}
          </span>
        )}
      </dd>
    </>
  );
}

const TABS = [
  { id: "system", label: "Server and runner", help: "This install's server and updates, and the company's runner." },
  { id: "access", label: "Access and funding", help: "Where agents get their keys, tools and model accounts." },
  { id: "workflow", label: "Reviews and CEO", help: "Who approves and reviews work at each risk level, and the CEO's chapters." },
  { id: "transfer", label: "Import and export", help: "Move a company in or out of Boss Man as one file: a backup, a copy for another Boss Man, or a template." },
  // These three are pages of their own (#/funding, #/rules, #/secrets), shown inside Settings.
  { id: "funding", label: "Funding", help: "Where agent work is paid from, and how much is left this cycle." },
  { id: "rules", label: "Rules", help: "What happens when an agent asks to use a tool." },
  { id: "secrets", label: "Secrets", help: "Every stored credential, who gets it, and when it was used." },
] as const;
const OWN_PAGE = new Set<string>(["funding", "rules", "secrets"]);

type ImportPreview = {
  company: { name: string; nameTaken: boolean };
  counts: Record<"agents" | "skills" | "projects" | "objectives" | "features" | "toolServers" | "wikiPages" | "tickets", number>;
  agents: Array<{ name: string; role: string; title: string | null; agentKind: string; model: string | null; instructions: string | null }>;
  skills: Array<{ name: string; renamedFrom: string | null; description: string; scripts: string[] }>;
  secrets: Array<{ name: string; envName: string; agents: string[] }>;
  warnings: string[];
};

/** Downloads the company as one zip (docs/11). Secret values are never in it. */
export function ExportCompany({ company }: { company: Company }) {
  const [wiki, setWiki] = useState(true);
  const [tickets, setTickets] = useState<"none" | "open" | "all">("open");
  return (
    <Section id="export-h" title={`Export ${company.name}`}>
      <p className="muted" style={{ fontSize: 14 }}>
        One zip with the company's agents and their instructions, skills, projects, plan and tool servers. Secrets are listed by name and who has them; their values never leave Boss Man.
      </p>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={wiki} onChange={(e) => setWiki(e.target.checked)} /> Include the wiki
      </label>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <label htmlFor="export-tickets">Tickets</label>
        <select id="export-tickets" value={tickets} onChange={(e) => setTickets(e.target.value as typeof tickets)}>
          <option value="none">None</option>
          <option value="open">Open ones only</option>
          <option value="all">All, including done</option>
        </select>
        <a className="btn" href={`/api/companies/${company.id}/export?wiki=${wiki ? 1 : 0}&tickets=${tickets}`} download>
          Download
        </a>
      </div>
    </Section>
  );
}

/** Reads a package, shows what it holds, then creates it as a new company (docs/11). */
export function ImportCompany({ go, onChanged }: { go: (to: string) => void; onChanged: () => void }) {
  const [zip, setZip] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [name, setName] = useState("");
  const [funding, setFunding] = useState("");
  const [done, setDone] = useState<{ companyId: string; name: string; checklist: string[] } | null>(null);
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 60_000, "sources");
  const act = useAction();
  const look = async (z: string, n?: string) => {
    const p = await api<ImportPreview>("/api/companies/import/preview", { method: "POST", body: { zip: z, ...(n ? { name: n } : {}) } });
    setPreview(p);
    setName(p.company.name);
  };
  const pick = (f: File | undefined) => {
    setPreview(null);
    setDone(null);
    if (!f) return;
    void act.run(async () => {
      const z = toBase64(new Uint8Array(await f.arrayBuffer()));
      setZip(z);
      await look(z);
    });
  };
  // A new name is checked again before Import is offered, so a clash is caught here, not by the server.
  const nameChanged = !!preview && name.trim() !== preview.company.name;
  const scripts = preview?.skills.filter((s) => s.scripts.length) ?? [];
  return (
    <Section id="import-h" title="Import a company">
      <p className="muted" style={{ fontSize: 14 }}>
        Pick a zip of either a Boss Man export (<code>.bossman.zip</code>) or a <strong>Paperclip company export</strong>. For Paperclip, put <code>paperclip-issues.json</code> next to <code>COMPANY.md</code> first to bring its tickets, comments and documents too (see docs/14-paperclip-migration.md). Nothing is created until you press Import. It becomes a new company with every agent paused and no secrets: you add those yourself.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="import-file">Package</label>
        <input id="import-file" type="file" accept=".zip,application/zip" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {preview && !done && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          <p style={{ fontSize: 14 }}>
            {preview.counts.agents} agents, {preview.counts.skills} skills, {preview.counts.projects} projects, {preview.counts.objectives} objectives, {preview.counts.features} features, {preview.counts.toolServers} tool servers, {preview.counts.wikiPages} wiki pages and {preview.counts.tickets} tickets.
          </p>
          {preview.warnings.map((w) => (
            <p key={w} className="error" style={{ fontSize: 14 }}>
              {w}
            </p>
          ))}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label htmlFor="import-name">Company name</label>
            <input id="import-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            {nameChanged && (
              <button type="button" className="btn" disabled={act.busy || !zip || !name.trim()} onClick={() => zip && void act.run(() => look(zip, name.trim()))}>
                Check name
              </button>
            )}
          </div>
          {preview.company.nameTaken && !nameChanged && (
            <p className="error" style={{ fontSize: 14 }}>
              There's already a company called {preview.company.name}. Give this one another name.
            </p>
          )}
          <details>
            <summary>Agents ({preview.agents.length}) and their instructions</summary>
            <ul>
              {preview.agents.map((a) => (
                <li key={a.name}>
                  <strong>{a.name}</strong>: {a.title ?? a.role}, {a.agentKind}
                  {a.model ? `, ${a.model}` : ""}
                  {a.instructions && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{a.instructions}</pre>}
                </li>
              ))}
            </ul>
          </details>
          {scripts.length > 0 && (
            <div style={{ fontSize: 14 }}>
              <strong>Skills that ship scripts.</strong> Read these before an agent uses them:
              <ul>
                {scripts.map((s) => (
                  <li key={s.name}>
                    {s.name}: {s.scripts.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.secrets.length > 0 && (
            <div style={{ fontSize: 14 }}>
              <strong>Secrets to add afterwards</strong>
              <ul>
                {preview.secrets.map((s) => (
                  <li key={s.envName}>
                    {s.name} as {s.envName}
                    {s.agents.length ? ` for ${s.agents.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label htmlFor="import-funding">Funding for every agent</label>
            <select id="import-funding" value={funding} onChange={(e) => setFunding(e.target.value)}>
              <option value="">Set later</option>
              {(sources.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button
              type="button"
              className="btn primary"
              disabled={act.busy || !zip || !name.trim() || nameChanged || preview.company.nameTaken}
              onClick={() =>
                void act.run(async () => {
                  const r = await api<{ companyId: string; name: string; checklist: string[] }>("/api/companies/import", { method: "POST", body: { zip, name: name.trim(), fundingSourceId: funding || null } });
                  setDone(r);
                  onChanged();
                })
              }
            >
              Import as a new company
            </button>
          </div>
        </div>
      )}
      {done && (
        <div role="status" style={{ marginTop: 12 }}>
          <p>{done.name} was imported. What's left (also on the Decisions page):</p>
          <ul>
            {done.checklist.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <button type="button" className="btn" onClick={() => go(`settings/${done.companyId}/system`)}>
            Open {done.name}'s settings
          </button>
        </div>
      )}
      {act.view}
    </Section>
  );
}

export function Devices() {
  const list = usePoll((signal) => api<DeviceProfile[]>("/api/devices", { signal }), 60_000, "devices");
  const act = useAction();
  const [names, setNames] = useState<Record<string, string>>({});
  const record = () =>
    void act.run(async () => {
      const report = await collect(window, document, navigator);
      const saved = await api<DeviceProfile>("/api/devices", { method: "POST", body: report });
      list.reload();
      return `${saved.label} recorded. Layout tickets that name this device are checked at these figures.`;
    });
  const rename = (p: DeviceProfile) =>
    void act.run(async () => {
      const label = (names[p.id] ?? p.label).trim();
      if (!label || label === p.label) return "No change.";
      const saved = await api<DeviceProfile>(`/api/devices/${p.id}`, { method: "PATCH", body: { label } });
      list.reload();
      return `Renamed to ${saved.label}.`;
    });
  const remove = (p: DeviceProfile) =>
    window.confirm(`Forget "${p.label}"? A layout ticket that names it will fall back to the normal phone and desktop checks.`) &&
    void act.run(async () => {
      await api(`/api/devices/${p.id}`, { method: "DELETE" });
      list.reload();
      return `Forgot ${p.label}.`;
    });
  const rows = list.data ?? [];
  return (
    <Section id="devices-h" title="Your devices">
      <p className="muted" style={{ fontSize: 14 }}>
        This browser can measure its own screen so a layout fix is checked at the real thing, not a guessed size. Open this page on each device you use, press Record, and the figures are kept here: width and height, pixel ratio, touch, standalone mode, and the real 100vh, 100dvh, 100svh and 100lvh heights. Only screen facts are stored; your devices are listed under Server and runner.
      </p>
      <button type="button" className="btn primary" onClick={record} disabled={act.busy} style={{ alignSelf: "flex-start" }}>
        {act.busy ? "Measuring…" : "Record this device"}
      </button>
      {act.view}
      {list.error ? <p className="error" style={{ fontSize: 14 }}>{list.error.message}</p> : null}
      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>No devices recorded yet. Record this one, then the others you use.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((p) => {
            const t = tallestReading(p);
            return (
              <div key={p.id} style={{ border: "1px solid var(--line, #333)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input value={names[p.id] ?? p.label} onChange={(e) => setNames((n) => ({ ...n, [p.id]: e.target.value }))} style={{ flex: "1 1 220px" }} aria-label={`Name for ${p.label}`} />
                  <button type="button" className="btn" onClick={() => rename(p)} disabled={act.busy}>Rename</button>
                  <button type="button" className="btn" onClick={() => remove(p)} disabled={act.busy}>Forget</button>
                </div>
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  {p.browser} · {t.width}×{t.height} CSS px · pixel ratio {t.pixelRatio} · {t.coarsePointer ? "touch" : "mouse"} · {t.displayMode}. 100vh {t.units.vh}, 100dvh {t.units.dvh}, 100svh {t.units.svh}, 100lvh {t.units.lvh}, visual viewport {t.units.visual} px. Reported {new Date(p.reportedAt).toLocaleString()}.
                </p>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

export function Settings({ companies, companyId, tab, go, onChanged, children }: { companies: Company[]; companyId: string | undefined; tab: string | undefined; go: (to: string) => void; onChanged: () => void; children?: ReactNode }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">What each company needs to run: a runner, credentials and funding. Repos are set per project on the Projects page.</p>
        </div>
        <button type="button" className="btn" onClick={() => go("setup")}>
          Run the setup wizard
        </button>
      </header>
      <div className="tabs" role="tablist" aria-label="Settings pages">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`set-tab-${t.id}`} aria-selected={current.id === t.id} aria-controls="set-panel" onClick={() => go(OWN_PAGE.has(t.id) ? t.id : company ? `settings/${company.id}/${t.id}` : "settings")}>
            {t.label}
          </button>
        ))}
      </div>
      <div id="set-panel" role="tabpanel" aria-labelledby={`set-tab-${current.id}`} style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: 16 }}>
        <p className="muted" style={{ fontSize: 13 }}>
          {current.help}
        </p>
        {OWN_PAGE.has(current.id) ? <div className="embedded-page">{children}</div> : null}
        {current.id === "system" && (
          <>
            <ServerPanel />
            <SelfDeploy go={go} />
            <ThisHost />
            <RunLimits />
          </>
        )}
        {current.id === "transfer" && <ImportCompany go={go} onChanged={onChanged} />}
        {OWN_PAGE.has(current.id) ? null : !company ? (
          current.id === "transfer" ? null : (
          <p>
            Create a company on the Kanban first, or{" "}
            <button type="button" className="linkish" onClick={() => go("setup")}>
              run the setup wizard
            </button>
            .
          </p>
          )
        ) : current.id === "system" ? (
          <div key={company.id} style={{ display: "contents" }}>
            <Runner company={company} />
            <RunnerUpdate />
            <Devices />
          </div>
        ) : current.id === "transfer" ? (
          <ExportCompany key={company.id} company={company} />
        ) : current.id === "access" ? (
          <div key={company.id} style={{ display: "contents" }}>
            <section className="card">
              <h2 style={{ fontSize: 17, fontWeight: 600 }}>Credentials</h2>
              <p className="muted" style={{ fontSize: 14 }}>
                Credentials are added, granted and rotated on the{" "}
                <button type="button" className="linkish" onClick={() => go("secrets")}>
                  Secrets
                </button>{" "}
                page.
              </p>
            </section>
            <ToolServers company={company} />
            <Funding company={company} onChanged={onChanged} />
          </div>
        ) : (
          <div key={company.id} style={{ display: "contents" }}>
            <Section id="reviews-h" title="Reviews">
              <p className="muted" style={{ fontSize: 14 }}>
                For each risk level, choose who approves a task's plan, who reviews its code, and whether you sign off before it merges. A project can override this on the Projects page.
              </p>
              <CompanyReviews companyId={company.id} agents={company.agents} />
            </Section>
            <TicketPrefix company={company} onChanged={onChanged} />
            <GoalCheck company={company} onChanged={onChanged} />
            <NudgeCap company={company} onChanged={onChanged} />
            <WorkspaceDisk company={company} onChanged={onChanged} />
            <AdviceTimeout company={company} onChanged={onChanged} />
            <StandingRules company={company} onChanged={onChanged} />
            <PermissionJudgeSetting company={company} onChanged={onChanged} />
            <FenceSetting company={company} onChanged={onChanged} />
            <SecondOpinionSetting company={company} />
            <Watchdog company={company} />
            <WorkflowRetros company={company} />
            <Chapters company={company} />
          </div>
        )}
      </div>
    </>
  );
}
