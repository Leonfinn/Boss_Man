import { useEffect, useState, type FormEvent } from "react";
import { api, type Agent, type Company, type Project } from "../../api";
import { usePoll } from "../../hooks";
import { SaveButton, useSaveState } from "../../components/SaveButton";
import { ProjectReviews } from "../../components/ReviewPolicy";
import { QuickAdd } from "../Board";
import { StarButton } from "../Agents";
import { Section, useAction } from "./shared";

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

type GithubWatchView = {
  enabled: boolean;
  repo: string;
  intervalMinutes: number;
  watchIssues: boolean;
  watchDiscussions: boolean;
  skipLogins: string[];
  status: string;
  lastError: string | null;
  lastRunAt: string | null;
  lastNewNotes: number;
  backoffUntil: string | null;
  hasToken: boolean;
  tokenName: string;
};

/**
 * The GitHub feedback watcher (BOS-1393): off by default. New issues, discussions and comments on a GitHub repo land in
 * the feedback inbox for Support to triage. Read-only: the token only reads. The token itself lives in Secrets.
 */
export function GithubWatch({ projectId }: { projectId: string }) {
  const url = `/api/projects/${projectId}/github-watch`;
  const [w, setW] = useState<GithubWatchView | null>(null);
  const [form, setForm] = useState<{ enabled: boolean; repo: string; intervalMinutes: string; watchIssues: boolean; watchDiscussions: boolean; skip: string } | null>(null);
  const act = useAction();
  const sv = useSaveState(form);
  const load = (v: GithubWatchView) => {
    setW(v);
    const f = { enabled: v.enabled, repo: v.repo, intervalMinutes: String(v.intervalMinutes), watchIssues: v.watchIssues, watchDiscussions: v.watchDiscussions, skip: v.skipLogins.join(", ") };
    setForm(f);
    sv.reset(f);
  };
  useEffect(() => void api<GithubWatchView>(url).then(load).catch(() => {}), [projectId]);
  if (!w || !form) return null;
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const v = await api<GithubWatchView>(url, {
        method: "PUT",
        body: { enabled: form.enabled, repo: form.repo.trim(), intervalMinutes: Number(form.intervalMinutes), watchIssues: form.watchIssues, watchDiscussions: form.watchDiscussions, skipLogins: form.skip.split(/[,\s]+/).filter(Boolean) },
      });
      setW(v);
      sv.markSaved();
      return "Saved.";
    });
  };
  const checkNow = () =>
    void act.run(async () => {
      const v = await api<GithubWatchView>(`${url}/check-now`, { method: "POST" });
      setW(v);
      return v.status === "ok" ? `Checked. ${v.lastNewNotes} new note${v.lastNewNotes === 1 ? "" : "s"} in the feedback inbox.` : undefined;
    });
  return (
    <form onSubmit={save} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", alignItems: "start", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
      <p style={{ gridColumn: "1 / -1", fontWeight: 600 }}>GitHub feedback watcher</p>
      <p className="muted" style={{ gridColumn: "1 / -1", fontSize: 13, margin: 0 }}>
        Files new issues, discussions and comments from a GitHub repo into the feedback inbox for Support to triage. Off until you switch it on. It only reads: it never replies, labels or closes anything on GitHub. The token is a read-only fine-grained token (Issues, Discussions and Metadata: read), saved in Secrets and granted to the company as <span className="mono">{w.tokenName}</span>. {w.hasToken ? "A token is granted." : "No token is granted yet."}
      </p>
      <div className="field" style={{ gridColumn: "1 / -1" }}>
        <label>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Watch this repo
        </label>
      </div>
      <div className="field">
        <label htmlFor={`gw-repo-${projectId}`}>GitHub repo (owner/name)</label>
        <input id={`gw-repo-${projectId}`} className="mono" placeholder="your-name/your-repo" value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`gw-int-${projectId}`}>Check every (minutes, at least 15)</label>
        <input id={`gw-int-${projectId}`} type="number" min={15} max={1440} value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })} />
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={form.watchIssues} onChange={(e) => setForm({ ...form, watchIssues: e.target.checked })} /> Issues
        </label>
        <label>
          <input type="checkbox" checked={form.watchDiscussions} onChange={(e) => setForm({ ...form, watchDiscussions: e.target.checked })} /> Discussions
        </label>
      </div>
      <div className="field" style={{ gridColumn: "1 / -1" }}>
        <label htmlFor={`gw-skip-${projectId}`}>Skip posts by these GitHub logins (yours, Boss Man's account)</label>
        <input id={`gw-skip-${projectId}`} className="mono" placeholder="login-one, login-two" value={form.skip} onChange={(e) => setForm({ ...form, skip: e.target.value })} />
      </div>
      <p style={{ gridColumn: "1 / -1", fontSize: 14, margin: 0 }} className={w.status === "error" ? "error" : "muted"}>
        {w.status === "idle" ? "Not run yet." : w.status === "ok" ? `Working. Last check ${w.lastRunAt ? new Date(w.lastRunAt).toLocaleString() : ""}: ${w.lastNewNotes} new.` : w.lastError}
        {w.status !== "ok" && w.backoffUntil ? ` Next try after ${new Date(w.backoffUntil).toLocaleString()}.` : ""}
      </p>
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
        <SaveButton {...sv} busy={act.busy} />
        <button type="button" className="btn" disabled={act.busy || !w.enabled || sv.dirty} onClick={checkNow}>
          Check now
        </button>
      </div>
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
              With a repo, each task gets its own branch and its own copy of the code to work in. Approved work is checked, then merged into the default branch or sent as a pull request. The token in <span className="mono">GIT_TOKEN</span> is used to clone, push and open pull requests. Don't put a token in the URL.
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
                    <GithubWatch projectId={p.id} />
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
