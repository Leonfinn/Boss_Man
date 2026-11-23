import { useState, type FormEvent } from "react";
import { api, ApiError, type Company, type Project } from "../../api";
import { useOlder, usePoll } from "../../hooks";
import { when } from "../Runs";
import { Section, useAction } from "./shared";
import { Loader } from "../../components/Loader";
import { LoadError } from "../../components/LoadError";

/** Plain words for the codes the server stores. The tables and the add forms both read these, so they can't drift apart. */
const TRANSPORT_LABEL = { http: "Streamable HTTP", sse: "SSE" } as const;
const KIND_LABEL = { ssh: "SSH host", docker: "Docker endpoint", git: "Git remote" } as const;

type McpServerRow = { id: string; name: string; url: string; transport: "http" | "sse"; secretEnv: string | null; headerName: string; headerValue: string; secretGranted: boolean; secretRefused?: boolean };

/** Extra MCP tool servers on the owner's network. Tokens stay in the secret store: only the name of a granted secret is entered here. */
export function ToolServers({ company }: { company: Company }) {
  const servers = usePoll((signal) => api<McpServerRow[]>(`/api/companies/${company.id}/mcp-servers`, { signal }), 30_000, `mcp-${company.id}`);
  const blank = { name: "", url: "", transport: "http", secretEnv: "", headerName: "Authorization", headerValue: "Bearer {secret}" };
  const [form, setForm] = useState(blank);
  const act = useAction();
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  // The row being changed: the form shows its values, and Save sends only what differs.
  const [editing, setEditing] = useState<McpServerRow | null>(null);
  const startEditing = (m: McpServerRow) => {
    setEditing(m);
    setForm({ name: m.name, url: m.url, transport: m.transport, secretEnv: m.secretEnv ?? "", headerName: m.headerName, headerValue: m.headerValue });
    document.getElementById("mcp-url")?.focus();
  };
  const stopEditing = () => {
    setEditing(null);
    setForm(blank);
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (editing) {
      const m = editing;
      const changes: Record<string, string | null> = {};
      if (form.url !== m.url) changes.url = form.url;
      if (form.transport !== m.transport) changes.transport = form.transport;
      if ((form.secretEnv || null) !== m.secretEnv) changes.secretEnv = form.secretEnv || null;
      if (form.headerName !== m.headerName) changes.headerName = form.headerName;
      if (form.headerValue !== m.headerValue) changes.headerValue = form.headerValue;
      if (!Object.keys(changes).length) return void act.run(async () => "Nothing changed.");
      void act.run(async () => {
        await api(`/api/mcp-servers/${m.id}`, { method: "PATCH", body: changes });
        stopEditing();
        servers.reload();
        return `Saved ${m.name}. Agents get the change from their next run.`;
      });
      return;
    }
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
      {!servers.data ? (
        servers.error ? <LoadError what="the tool servers" message={servers.error.message} onRetry={servers.reload} /> : <Loader label="Loading the tool servers" />
      ) : servers.data.length ? (
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
                  <td>{TRANSPORT_LABEL[m.transport] ?? m.transport}</td>
                  <td>
                    <span className="mono">{m.secretEnv ?? "none"}</span>
                    {m.secretRefused && <span className="tag red" style={{ marginLeft: 6 }}>Left out of every run: {m.secretEnv} is the git login, which agents may never hold. Give this server its own token.</span>}
                    {!m.secretRefused && !m.secretGranted && <span className="tag amber" style={{ marginLeft: 6 }}>Not granted to {company.name}: no agent gets this server</span>}
                  </td>
                  <td>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => startEditing(m)} aria-label={`Change tool server ${m.name}`} style={{ marginRight: 6 }}>
                      Change
                    </button>
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
          <input id="mcp-name" className="mono" required disabled={!!editing} pattern="[a-z][a-z0-9-]{0,31}" placeholder="scrapling" value={form.name} onChange={set("name")} />
        </div>
        <div className="field">
          <label htmlFor="mcp-url">Server URL</label>
          <input id="mcp-url" type="url" required placeholder="http://192.0.2.10:30301/mcp" value={form.url} onChange={set("url")} />
        </div>
        <div className="field">
          <label htmlFor="mcp-transport">Transport</label>
          <select id="mcp-transport" value={form.transport} onChange={set("transport")}>
            {(Object.keys(TRANSPORT_LABEL) as (keyof typeof TRANSPORT_LABEL)[]).map((k) => (
              <option key={k} value={k}>
                {TRANSPORT_LABEL[k]}
              </option>
            ))}
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
            {editing ? "Save changes" : "Add tool server"}
          </button>
          {editing && (
            <button className="btn" type="button" style={{ marginLeft: 8 }} disabled={act.busy} onClick={stopEditing}>
              Cancel
            </button>
          )}
        </div>
      </form>
      {act.view}
    </Section>
  );
}

type SecretField = { set: boolean; hint: string | null; secretName: string | null };
type PenpotView = {
  configured: boolean;
  url: string | null;
  urlHint: string | null;
  guardAddress: string | null;
  guardTrustsPrivate: boolean;
  token: SecretField;
  email: SecretField;
  password: SecretField;
  agentIds: string[];
  exportAgentIds: string[];
};

/** Ticks for the agents that get something; none ticked means every agent in the company. */
function AgentTicks({ legend, agents, picked, onChange }: { legend: string; agents: Company["agents"]; picked: string[]; onChange: (ids: string[]) => void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontWeight: 600, fontSize: 14 }}>{legend}</legend>
      <span className="muted" style={{ fontSize: 13 }}>
        Leave all unticked to give it to every agent in this company.
      </span>
      {agents.map((a) => (
        <label key={a.id} style={{ display: "block" }}>
          <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => onChange(e.target.checked ? [...picked, a.id] : picked.filter((id) => id !== a.id))} /> {a.name}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Penpot (BOS-1582): one form for the address, access token and export login agents use for designs (docs/16). It saves
 * the same PENPOT_* secrets the Secrets page shows, so a Penpot set up there by hand appears here as already set. The
 * network guard opens the address by itself, so no .env line is needed. Token, email and password are never shown again.
 */
export function PenpotSettings({ company }: { company: Company }) {
  const q = usePoll((signal) => api<PenpotView>(`/api/companies/${company.id}/penpot`, { signal }), 60_000, `penpot-${company.id}`);
  const act = useAction();
  const [edit, setEdit] = useState<{ url: string; token: string; email: string; password: string; agentIds: string[]; exportAgentIds: string[] } | null>(null);
  const v = q.data;
  if (!v) {
    return (
      <Section id="penpot-h" title="Penpot">
        {q.error ? <LoadError what="the Penpot setting" message={q.error.message} onRetry={q.reload} /> : <Loader label="Loading the Penpot setting" />}
      </Section>
    );
  }
  const start = () => setEdit({ url: v.url ?? "", token: "", email: "", password: "", agentIds: v.agentIds, exportAgentIds: v.exportAgentIds });
  const f = edit;
  const set = (k: "url" | "token" | "email" | "password") => (e: { target: { value: string } }) => f && setEdit({ ...f, [k]: e.target.value });
  const names = (ids: string[]) => (ids.length ? company.agents.filter((a) => ids.includes(a.id)).map((a) => a.name).join(", ") : "every agent");
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!f) return;
    void act.run(async () => {
      await api(`/api/companies/${company.id}/penpot`, { method: "PUT", body: { url: f.url, token: f.token, email: f.email, password: f.password, agentIds: f.agentIds, exportAgentIds: f.exportAgentIds } });
      setEdit(null);
      q.reload();
      return "Saved. Agents get it from their next run, and the network guard opens Penpot's address for this company's runner.";
    });
  };
  const removeExport = () =>
    f &&
    void act.run(async () => {
      await api(`/api/companies/${company.id}/penpot`, { method: "PUT", body: { email: null, password: null, agentIds: f.agentIds, exportAgentIds: [] } });
      setEdit(null);
      q.reload();
      return "Export login removed. Everything else in Penpot still works; export says what is missing.";
    });
  const remove = () =>
    window.confirm(`Stop giving Penpot to ${company.name}'s agents? The network guard closes its address too. The saved values stay under Secrets.`) &&
    void act.run(async () => {
      await api(`/api/companies/${company.id}/penpot`, { method: "DELETE" });
      setEdit(null);
      q.reload();
      return "Penpot removed for this company.";
    });
  const kept = (s: SecretField) => (s.set ? `Saved (${s.hint ?? "hidden"}). Leave blank to keep it.` : "");
  return (
    <Section id="penpot-h" title="Penpot">
      <p className="muted" style={{ fontSize: 14 }}>
        Lets agents read and draw designs in your Penpot. Make the agent account and its access token in Penpot first (the Penpot agent setup guide). Boss Man opens Penpot's address in the network guard by itself: no .env line needed.
      </p>
      {v.configured ? (
        <ul style={{ fontSize: 14 }} data-testid="penpot-summary">
          <li>
            Address: <span className="mono">{v.url ?? v.urlHint}</span>
            {v.guardAddress ? (
              <span className="muted">
                {" "}
                · the network guard opens <span className="mono">{v.guardAddress}</span>
                {!v.guardTrustsPrivate && " (a public name: it stays closed if it ever points at a private address)"}
              </span>
            ) : (
              <span className="error"> · the network guard can't open this address; save Penpot's address again here</span>
            )}
          </li>
          <li>Access token: saved ({v.token.hint ?? "hidden"}), for {names(v.agentIds)}</li>
          <li>{v.password.set ? `Export login: saved, for ${names(v.exportAgentIds)}` : "Export login: not set (PNG export says what is missing)"}</li>
        </ul>
      ) : (
        <p data-testid="penpot-not-set">Penpot isn't set up for {company.name}.</p>
      )}
      {!f ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn" onClick={start}>
            {v.configured ? "Change Penpot" : "Set up Penpot"}
          </button>
          {v.configured && (
            <button type="button" className="btn" disabled={act.busy} onClick={remove}>
              Remove Penpot
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={save} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "start" }}>
          <div className="field">
            <label htmlFor="penpot-url">Penpot address</label>
            <input id="penpot-url" type="url" className="mono" required={!v.configured} placeholder="http://192.168.1.50:9001" value={f.url} onChange={set("url")} aria-describedby="penpot-url-hint" />
            <span id="penpot-url-hint" className="muted" style={{ fontSize: 13 }}>
              The address the runners reach Penpot on, with its port.
            </span>
          </div>
          <div className="field">
            <label htmlFor="penpot-token">Access token</label>
            <input id="penpot-token" type="password" autoComplete="off" className="mono" required={!v.token.set} value={f.token} onChange={set("token")} aria-describedby="penpot-token-hint" />
            <span id="penpot-token-hint" className="muted" style={{ fontSize: 13 }}>
              {kept(v.token) || "From Penpot: Your account → Access tokens, signed in as the agent account."}
            </span>
          </div>
          <div className="field">
            <label htmlFor="penpot-email">Export email (optional)</label>
            <input id="penpot-email" type="email" autoComplete="off" value={f.email} onChange={set("email")} aria-describedby="penpot-email-hint" />
            <span id="penpot-email-hint" className="muted" style={{ fontSize: 13 }}>
              {kept(v.email) || "Only for PNG export, which needs a login. The agent account's email."}
            </span>
          </div>
          <div className="field">
            <label htmlFor="penpot-password">Export password (optional)</label>
            <input id="penpot-password" type="password" autoComplete="new-password" value={f.password} onChange={set("password")} aria-describedby="penpot-password-hint" />
            <span id="penpot-password-hint" className="muted" style={{ fontSize: 13 }}>
              {kept(v.password) || "The agent account's password, used nowhere else."}
            </span>
          </div>
          <AgentTicks legend="Agents who use Penpot" agents={company.agents} picked={f.agentIds} onChange={(ids) => setEdit({ ...f, agentIds: ids })} />
          <AgentTicks legend="Agents who export PNGs" agents={company.agents} picked={f.exportAgentIds} onChange={(ids) => setEdit({ ...f, exportAgentIds: ids })} />
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
            <button className="btn primary" type="submit" disabled={act.busy}>
              Save Penpot
            </button>
            {v.password.set && (
              <button type="button" className="btn" disabled={act.busy} onClick={removeExport}>
                Remove export login
              </button>
            )}
            <button type="button" className="btn" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {act.view}
    </Section>
  );
}

type DeployTargetRow = {
  id: string;
  name: string;
  kind: "ssh" | "docker" | "git";
  endpoint: string;
  isProduction: boolean;
  rules: { requiresApproval?: boolean; liveTag?: { projectId: string; name: string } | null };
  lastDeploy: { id: string; ref: string; commit: string | null; at: string | null; tagName: string | null; tagResult: string | null } | null;
};

const ENDPOINT_HINT = { ssh: "deploy@host or ssh://deploy@host:22", docker: "tcp://socket-proxy:2375", git: "https://git.example.com/you/app.git" } as const;

/** What a deploy tag result means, in plain words. */
function tagResultText(r: string | null) {
  if (!r) return "";
  if (r === "moved") return "tag moved";
  if (r === "unchanged") return "tag already there";
  if (r === "pending") return "moving the tag…";
  return r.replace(/^skipped: /, "tag not moved: ").replace(/^failed: /, "tag move failed: ");
}

type DeployHistoryRow = {
  id: string;
  deploy: { id: string; ref: string; commit: string | null; notes: string | null; status: string; outcome: string | null; ticketId: string | null; tagName: string | null; tagResult: string | null; createdAt: string };
  agentName: string | null;
  ticketRef: string | null;
};

const DEPLOY_PAGE = 20;
const DEPLOY_STATUS_TEXT: Record<string, string> = {
  pending_approval: "waiting for you",
  approved: "approved, starting",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  rejected: "refused",
};

/** A target's deploys, newest first, in a fold under its row (BOS-2318). Loads only once opened. */
function DeployHistory({ targetId, name }: { targetId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} style={{ marginTop: 6 }}>
      <summary>Deploys</summary>
      {open && <DeployHistoryList targetId={targetId} name={name} />}
    </details>
  );
}

function DeployHistoryList({ targetId, name }: { targetId: string; name: string }) {
  const first = usePoll((signal) => api<{ deploy: DeployHistoryRow["deploy"]; agentName: string | null; ticketRef: string | null }[]>(`/api/deploys?targetId=${targetId}&limit=${DEPLOY_PAGE}`, { signal }).then((rows) => rows.map((r) => ({ ...r, id: r.deploy.id }))), 30_000, `deploy-history-${targetId}`);
  const older = useOlder<DeployHistoryRow>(first.data ?? null, DEPLOY_PAGE, (before) => api<Omit<DeployHistoryRow, "id">[]>(`/api/deploys?targetId=${targetId}&limit=${DEPLOY_PAGE}&before=${before}`).then((rows) => rows.map((r) => ({ ...r, id: r.deploy.id }))), `deploy-history-${targetId}`);
  if (!older.rows) return first.error ? <LoadError what={`the deploys of ${name}`} message={first.error.message} onRetry={first.reload} /> : <Loader label="Loading the deploys" />;
  if (!older.rows.length) return <p className="muted" style={{ fontSize: 13 }}>No deploys to {name} yet.</p>;
  return (
    <>
      <ul style={{ listStyle: "none", padding: 0, margin: "6px 0", display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
        {older.rows.map(({ deploy: d, agentName, ticketRef }) => (
          <li key={d.id}>
            <span className={d.status === "failed" || d.status === "rejected" ? "error" : undefined}>{DEPLOY_STATUS_TEXT[d.status] ?? d.status}</span> <span className="muted">{when(d.createdAt)}</span>{" "}
            <span className="mono">{d.ref}</span>
            {d.commit && <span className="mono muted"> ({d.commit.slice(0, 7)})</span>}
            <span className="muted"> · asked by {agentName ?? "you"}</span>
            {d.ticketId && (
              <>
                {" "}
                · <a href={`#/tickets/${d.ticketId}`}>{ticketRef ?? "ticket"}</a>
              </>
            )}
            {d.notes && <div className="muted">{d.notes}</div>}
            {d.outcome && d.status !== "succeeded" && <div className="muted">{d.outcome}</div>}
            {d.tagResult && <div className={d.tagResult.startsWith("failed") ? "error" : "muted"}>{tagResultText(d.tagResult)}</div>}
          </li>
        ))}
      </ul>
      {older.error && <LoadError what="older deploys" message={older.error} onRetry={() => void older.more()} />}
      {older.canMore && (
        <button type="button" className="btn small" disabled={older.busy} onClick={() => void older.more()}>
          Show older
        </button>
      )}
    </>
  );
}

/**
 * Deploy targets (R14, R15, DR-033): where agents ship work, which deploys wait for you, and the tag
 * Boss Man moves after a successful deploy. Owner-only: agents can list targets but never edit them.
 */
export function DeployTargets({ company }: { company: Company }) {
  const targets = usePoll((signal) => api<DeployTargetRow[]>(`/api/companies/${company.id}/deploy-targets`, { signal }), 30_000, `deploy-targets-${company.id}`);
  const projects = usePoll((signal) => api<Project[]>(`/api/companies/${company.id}/projects`, { signal }), 120_000, `projects-${company.id}`);
  const repoProjects = (projects.data ?? []).filter((p) => p.repoUrl && !p.archivedAt);
  const blank = { name: "", kind: "ssh" as DeployTargetRow["kind"], endpoint: "", isProduction: false, requiresApproval: false, tagOn: false, tagProject: "", tagName: "" };
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const act = useAction();
  const edit = (t: DeployTargetRow) => {
    setEditing(t.id);
    const lt = t.rules.liveTag;
    setForm({ name: t.name, kind: t.kind, endpoint: t.endpoint, isProduction: t.isProduction, requiresApproval: !!t.rules.requiresApproval, tagOn: !!lt, tagProject: lt?.projectId ?? "", tagName: lt?.name ?? "" });
  };
  const cancel = () => {
    setEditing(null);
    setForm(blank);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const tagProject = form.tagProject || repoProjects[0]?.id || "";
      const body = {
        name: form.name,
        kind: form.kind,
        endpoint: form.endpoint,
        isProduction: form.isProduction,
        requiresApproval: form.requiresApproval,
        liveTag: form.tagOn ? { projectId: tagProject, name: form.tagName.trim() } : null,
      };
      if (editing) await api(`/api/deploy-targets/${editing}`, { method: "PATCH", body });
      else await api(`/api/companies/${company.id}/deploy-targets`, { method: "POST", body });
      const what = editing ? "Saved" : "Added";
      cancel();
      targets.reload();
      return `${what}.${form.tagOn ? ` After each successful deploy to ${form.name}, Boss Man moves the tag ${form.tagName.trim()}.` : ""}`;
    });
  };
  // BOS-2158: the target the server said has past deploys; "Remove anyway" is offered only for that. A live deploy only shows the message.
  const [askAnyway, setAskAnyway] = useState<{ id: string; message: string } | null>(null);
  const remove = (t: DeployTargetRow, force = false) =>
    (force || window.confirm(`Delete the deploy target ${t.name}? Agents can no longer deploy to it.`)) &&
    void act.run(async () => {
      setAskAnyway(null);
      try {
        await api(`/api/deploy-targets/${t.id}${force ? "?force=true" : ""}`, { method: "DELETE" });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.field === "has_history") {
          setAskAnyway({ id: t.id, message: err.message });
          return;
        }
        throw err;
      }
      if (editing === t.id) cancel();
      targets.reload();
      return `Deleted ${t.name}.`;
    });
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "a project";
  return (
    <Section id="deploy-targets-h" title="Deploy targets">
      <p className="muted" style={{ fontSize: 14 }}>
        Where agents ship work. A deploy to a production target, or to one that requires approval, waits for you in Decisions. Only the run carrying out an approved deploy gets the target's secrets (grant them on the Secrets page, "only for deploys to …").
      </p>
      {!targets.data ? (
        targets.error ? <LoadError what="the deploy targets" message={targets.error.message} onRetry={targets.reload} /> : <Loader label="Loading the deploy targets" />
      ) : targets.data.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Where</th>
                <th scope="col">Approval</th>
                <th scope="col">Tag after deploy</th>
                <th scope="col">Last successful deploy</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {targets.data.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.name}
                    {t.isProduction && <span className="tag amber" style={{ marginLeft: 6 }}>production</span>}
                  </td>
                  <td>
                    <span className="muted">{KIND_LABEL[t.kind] ?? t.kind}</span> <span className="mono">{t.endpoint}</span>
                  </td>
                  <td>{t.isProduction || t.rules.requiresApproval ? "You approve each deploy" : "Starts straight away"}</td>
                  <td>
                    {t.rules.liveTag ? <span className="mono">{t.rules.liveTag.name}</span> : <span className="muted">none</span>}
                    {t.rules.liveTag && <span className="muted"> in {projectName(t.rules.liveTag.projectId)}</span>}
                  </td>
                  <td>
                    {t.lastDeploy ? (
                      <>
                        <span className="mono">{t.lastDeploy.commit ? t.lastDeploy.commit.slice(0, 7) : t.lastDeploy.ref}</span>
                        {t.lastDeploy.at && <span className="muted"> {when(t.lastDeploy.at)}</span>}
                        {t.lastDeploy.tagResult && (
                          <div className={t.lastDeploy.tagResult.startsWith("failed") ? "error" : "muted"} style={{ fontSize: 13 }}>
                            {tagResultText(t.lastDeploy.tagResult)}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="muted">none yet</span>
                    )}
                    <DeployHistory targetId={t.id} name={t.name} />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => edit(t)} aria-label={`Edit deploy target ${t.name}`}>
                      Edit
                    </button>{" "}
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => remove(t)} aria-label={`Delete deploy target ${t.name}`}>
                      Delete
                    </button>
                    {askAnyway?.id === t.id && (
                      <div role="alert" className="error" style={{ fontSize: 14, whiteSpace: "normal" }}>
                        {askAnyway.message}{" "}
                        <button type="button" className="btn small" disabled={act.busy} onClick={() => remove(t, true)}>
                          Remove anyway
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 14 }}>No deploy targets yet: agents can't deploy until you add one.</p>
      )}
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby="deploy-target-form-h">
        <h3 id="deploy-target-form-h" style={{ fontSize: 15, fontWeight: 600 }}>
          {editing ? `Edit ${form.name || "deploy target"}` : "Add a deploy target"}
        </h3>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            Name
            <input required maxLength={80} value={form.name} placeholder="Production" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            Kind
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as DeployTargetRow["kind"] })}>
              {(Object.keys(KIND_LABEL) as DeployTargetRow["kind"][]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 260px" }}>
            Address
            <input required maxLength={500} className="mono" value={form.endpoint} placeholder={ENDPOINT_HINT[form.kind]} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} />
          </label>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={form.isProduction} onChange={(e) => setForm({ ...form, isProduction: e.target.checked })} />
          Production (you approve every deploy, and high-risk work must deploy to staging first)
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={form.requiresApproval || form.isProduction} disabled={form.isProduction} onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })} />
          Requires approval (you approve each deploy here too)
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={form.tagOn} onChange={(e) => setForm({ ...form, tagOn: e.target.checked, tagProject: form.tagProject || repoProjects[0]?.id || "" })} />
          After a successful deploy, move tag
        </label>
        {form.tagOn && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 26 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                Tag name
                <input required maxLength={100} className="mono" value={form.tagName} placeholder="live-deployed" onChange={(e) => setForm({ ...form, tagName: e.target.value })} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                In the repo of
                <select required value={form.tagProject} onChange={(e) => setForm({ ...form, tagProject: e.target.value })}>
                  {!repoProjects.length && <option value="">No project has a git repo yet</option>}
                  {repoProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              After each deploy to this target reports success, Boss Man moves this tag on the project's git host to the exact commit that was deployed, using the company's git token. It only moves the tag to work already merged into the main branch, and never deletes it. <strong>Moving this tag can start pipelines on your git host</strong> (for example a GitHub Actions, GitLab CI, Gitea or Woodpecker job that runs when a tag is pushed), so only turn this on for a tag you want to follow the deploy. Deploy scripts must not push this tag themselves. The name can't contain "/" or be the name of a branch.
            </p>
            <details>
              <summary style={{ fontSize: 13 }}>If the git host protects the tag</summary>
              <ul className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                <li>GitHub: the token needs Contents read and write (the same as merges). A tag ruleset that blocks updates will refuse the move: allow updates to this tag, or exempt the token's user.</li>
                <li>GitLab: the token needs write_repository. A protected tag can't be moved, so don't protect this tag, or pick a name that isn't protected.</li>
                <li>Gitea or Forgejo: the token needs repository write. If the tag is protected, allow the token's user to push it under the repo's Settings → Tags.</li>
                <li>Others (Bitbucket, plain git over https): set GIT_USERNAME as you would for merges. A repo reached only over ssh isn't supported.</li>
              </ul>
            </details>
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" className="btn primary" disabled={act.busy || (form.tagOn && (!form.tagName.trim() || !(form.tagProject || repoProjects[0])))}>
            {editing ? "Save" : "Add target"}
          </button>
          {editing && (
            <button type="button" className="btn" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
      {act.view}
    </Section>
  );
}
