import { useState, type FormEvent } from "react";
import { api, type Company, type Project } from "../../api";
import { usePoll } from "../../hooks";
import { when } from "../Runs";
import { Section, useAction } from "./shared";

type McpServerRow = { id: string; name: string; url: string; transport: "http" | "sse"; secretEnv: string | null; secretGranted: boolean };

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
          <input id="mcp-url" type="url" required placeholder="http://192.0.2.10:30301/mcp" value={form.url} onChange={set("url")} />
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
  const remove = (t: DeployTargetRow) =>
    window.confirm(`Delete the deploy target ${t.name}? Agents can no longer deploy to it, and its deploy history goes with it.`) &&
    void act.run(async () => {
      await api(`/api/deploy-targets/${t.id}`, { method: "DELETE" });
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
      {targets.data?.length ? (
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
                    <span className="muted">{t.kind}</span> <span className="mono">{t.endpoint}</span>
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
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => edit(t)} aria-label={`Edit deploy target ${t.name}`}>
                      Edit
                    </button>{" "}
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => remove(t)} aria-label={`Delete deploy target ${t.name}`}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        targets.data && <p className="muted" style={{ fontSize: 14 }}>No deploy targets yet: agents can't deploy until you add one.</p>
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
              <option value="ssh">SSH host</option>
              <option value="docker">Docker endpoint</option>
              <option value="git">Git remote</option>
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
