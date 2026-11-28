import { useEffect, useState, type FormEvent } from "react";
import { api, usd, type Agent, type Company, type Project } from "../../api";
import { hashQuery, usePoll } from "../../hooks";
import { SaveButton, useSaveState } from "../../components/SaveButton";
import { Loader } from "../../components/Loader";
import { LoadError } from "../../components/LoadError";
import { ProjectReviews } from "../../components/ReviewPolicy";
import { QuickAdd } from "../Board";
import { StarButton } from "../Agents";
import { Section, useAction } from "./shared";
import { buildCsv, download } from "../../csv";
import { POINTS_EXPLAINED } from "@boss-man/shared";

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
            At the monthly cap, no new runs start for this project until next month (UTC) or you raise it. The monthly cap counts API and credit runs only: runs paid from a subscription (such as Claude Max) are left out and it never stops them. The cap per task does count subscription runs, at list prices. Neither cap sees extra usage or top-up bought on a subscription. The Budget tab shows subscription runs' tokens.
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
  watchAlerts: boolean;
  alertsHeldBy: string | null;
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
  const [form, setForm] = useState<{ enabled: boolean; repo: string; intervalMinutes: string; watchAlerts: boolean; watchIssues: boolean; watchDiscussions: boolean; skip: string } | null>(null);
  const act = useAction();
  const sv = useSaveState(form);
  const load = (v: GithubWatchView) => {
    setW(v);
    const f = { enabled: v.enabled, repo: v.repo, intervalMinutes: String(v.intervalMinutes), watchAlerts: v.watchAlerts, watchIssues: v.watchIssues, watchDiscussions: v.watchDiscussions, skip: v.skipLogins.join(", ") };
    setForm(f);
    sv.reset(f);
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchWatch = () => {
    setLoadError(null);
    api<GithubWatchView>(url).then(load).catch((e: Error) => setLoadError(e.message));
  };
  useEffect(fetchWatch, [projectId]);
  if (loadError && !w) return <LoadError what="the GitHub feedback watcher" message={loadError} onRetry={fetchWatch} />;
  if (!w || !form) return <Loader label="Loading the GitHub feedback watcher" />;
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const v = await api<GithubWatchView>(url, {
        method: "PUT",
        body: { enabled: form.enabled, repo: form.repo.trim(), intervalMinutes: Number(form.intervalMinutes), watchAlerts: form.watchAlerts, watchIssues: form.watchIssues, watchDiscussions: form.watchDiscussions, skipLogins: form.skip.split(/[,\s]+/).filter(Boolean) },
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
        Files new issues, discussions and comments from a GitHub repo into the feedback inbox for Support to triage. Off until you switch it on. It changes only two things on GitHub: Support's replies on issues and discussions (and closing them once the outcome is known), and a security alert the security reviewer closes after checking it. It never labels or edits anything. The token is a fine-grained token (Metadata: read; Issues, Discussions, Secret scanning alerts and Dependabot alerts: read and write), saved in Secrets and granted to the company as <span className="mono">{w.tokenName}</span>. {w.hasToken ? "A token is granted." : "No token is granted yet."}
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
        <label>
          <input type="checkbox" checked={form.watchAlerts} onChange={(e) => setForm({ ...form, watchAlerts: e.target.checked })} /> Security alerts (this project owns the repo's alerts)
        </label>
        {w.alertsHeldBy ? <span className="error" style={{ fontSize: 13 }}>Project "{w.alertsHeldBy}" also watches this repo's alerts. Turn alerts off on one of them.</span> : null}
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

/**
 * One project as a collapsed row: name, star, Kanban button and a one-line summary. "Edit settings" opens the form.
 * The form stays mounted while collapsed (just hidden), so unsaved edits are never lost by collapsing.
 */
export type ProjectSummary = { projectId: string; open: number; inReview: number; blocked?: number; pointsLeft: number; unsized: number; finishedLast30Days: number; monthMicros: number; monthlyCapMicros: number | null; lastMergeAt: string | null };

/** The second line of a project row (BOS-2421): open work, points left, finished lately, this month's spend and the last merge. */
export function projectSummaryLine(s: ProjectSummary): string {
  const points = `${s.pointsLeft} point${s.pointsLeft === 1 ? "" : "s"} left${s.unsized ? ` (${s.unsized} unsized)` : ""}`;
  const spend = `${usd(s.monthMicros)} ${s.monthlyCapMicros ? `of ${usd(s.monthlyCapMicros)} this month` : "this month, no cap"}`;
  const merge = s.lastMergeAt ? `last merge ${new Date(s.lastMergeAt).toLocaleDateString()}` : "last merge: never";
  // BOS-2463: said only when something is stuck, so a healthy project's line stays as it was.
  const blocked = s.blocked ? `, ${s.blocked} blocked` : "";
  return `${s.open} open, ${s.inReview} in review${blocked} · ${points} · ${s.finishedLast30Days} done in the last 30 days · ${spend} · ${merge}`;
}

/** The orders of the active project list (BOS-2463), kept in the link as `?sort=`. "name" is the default and is left out of the link. */
export const PROJECT_SORTS = [
  { id: "name", label: "Name" },
  { id: "open", label: "Most open" },
  { id: "blocked", label: "Most blocked" },
  { id: "merge", label: "Latest merge" },
] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number]["id"];

export function readProjectSort(q: URLSearchParams): ProjectSort {
  const v = q.get("sort");
  return PROJECT_SORTS.find((s) => s.id === v)?.id ?? "name";
}

/**
 * `list` comes in name order from the server. Highest first for the figures; a project without figures (or never merged)
 * goes last. Array sort is stable, so ties keep the server's name order, and "name" is the list as it came.
 */
export function sortProjects<P extends { id: string }>(list: P[], sort: ProjectSort, statsFor: (id: string) => ProjectSummary | undefined): P[] {
  if (sort === "name") return list;
  const key = (p: P): number => {
    const s = statsFor(p.id);
    if (!s) return -Infinity;
    if (sort === "open") return s.open;
    if (sort === "blocked") return s.blocked ?? 0;
    return s.lastMergeAt ? Date.parse(s.lastMergeAt) : -Infinity;
  };
  return [...list].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka === kb ? 0 : kb > ka ? 1 : -1;
  });
}

/**
 * The active projects as a CSV (BOS-2502), one row each in the order given (the page passes its chosen sort).
 * Money is plain dollars with two decimals so a spreadsheet sums it; the cap and last merge are blank when there is none.
 * A project whose figures haven't loaded keeps its name with blank figures, rather than a misleading 0.
 */
export function projectsToCsv(list: Array<{ id: string; name: string }>, statsFor: (id: string) => ProjectSummary | undefined): string {
  const dollars = (micros: number) => (micros / 1_000_000).toFixed(2);
  return buildCsv(
    ["project", "open", "in_review", "blocked", "points_left", "unsized", "done_last_30_days", "month_spend_usd", "monthly_cap_usd", "last_merge_at"],
    list.map((p) => {
      const s = statsFor(p.id);
      if (!s) return [p.name, "", "", "", "", "", "", "", "", ""];
      return [p.name, s.open, s.inReview, s.blocked ?? 0, s.pointsLeft, s.unsized, s.finishedLast30Days, dollars(s.monthMicros), s.monthlyCapMicros == null ? "" : dollars(s.monthlyCapMicros), s.lastMergeAt ?? ""];
    }),
  );
}

function ProjectCard({ p, go, agents, onStar, starBusy, onChanged, stats }: { p: Project; go: (to: string) => void; agents: Agent[]; onStar: () => void; starBusy?: boolean; onChanged: () => void; stats?: ProjectSummary }) {
  const [open, setOpen] = useState(false);
  const summary = p.repoUrl ? `Repo set · ${p.landing === "pull_request" ? "opens pull requests" : "merges into the default branch"}` : "Documents and research · work is kept in the wiki and on each task";
  return (
    <div style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <a href={`#/board/${p.id}`} style={{ fontWeight: 600 }}>{p.name}</a>
        <StarButton agent={p} where="Projects" onToggle={onStar} disabled={starBusy} />
        <button type="button" className="btn small" onClick={() => go(`board/${p.id}`)}>
          Open {p.name}'s Kanban
        </button>
        <button type="button" className="btn small" aria-expanded={open} aria-controls={`settings-${p.id}`} onClick={() => setOpen(!open)}>
          {open ? "Hide settings" : "Edit settings"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>{summary}</p>
      {stats && <p className="muted" style={{ fontSize: 13, margin: "2px 0 0" }} title={POINTS_EXPLAINED}>{projectSummaryLine(stats)}</p>}
      <div id={`settings-${p.id}`} hidden={!open} style={{ marginTop: 10 }}>
        <ProjectRow p={p} agents={agents} onChanged={onChanged} />
        <GithubWatch projectId={p.id} />
      </div>
    </div>
  );
}

/** Every project of the chosen company: create one, open its Kanban, set its repo, checks and reviews. */
export function ProjectsPage({ companies, companyId, go, onChanged }: { companies: Company[]; companyId: string | undefined; go: (to: string) => void; onChanged?: () => void }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const projects = usePoll((signal) => (company ? api<Project[]>(`/api/companies/${company.id}/projects`, { signal }) : Promise.resolve([])), 60_000, `projects-${company?.id ?? "none"}`);
  // One read for every project's figures (BOS-2421); a failure keeps today's line and shows Retry.
  const summary = usePoll((signal) => (company ? api<{ projects?: ProjectSummary[] }>(`/api/companies/${company.id}/projects-summary`, { signal }) : Promise.resolve({ projects: [] })), 60_000, `projects-summary-${company?.id ?? "none"}`);
  const statsFor = (id: string) => summary.data?.projects?.find((s) => s.projectId === id);
  const [sort, setSort] = useState<ProjectSort>(() => readProjectSort(hashQuery()));
  const changeSort = (s: ProjectSort) => {
    setSort(s);
    // In the link without a history entry or a re-route, as Plan does, so a reload or a shared link keeps the order.
    const q = hashQuery();
    if (s === "name") q.delete("sort");
    else q.set("sort", s);
    const base = window.location.hash.split("?")[0] || "#/projects";
    const qs = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${base}${qs ? `?${qs}` : ""}`);
  };
  const active = projects.data?.filter((p) => !p.archivedAt) ?? [];
  const act = useAction();
  const patch = (id: string, body: Record<string, boolean>) =>
    void act.run(async () => {
      await api(`/api/projects/${id}`, { method: "PATCH", body });
      projects.reload();
      summary.reload();
      onChanged?.();
    });
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
          <Section id="projects-h" title={`Projects (${active.length})`}>
            {(projects.data ?? []).some((p) => p.repoUrl) && (
              <p className="muted" style={{ fontSize: 14 }}>
                With a repo, each task gets its own branch and its own copy of the code to work in. Approved work is checked, then merged into the default branch or sent as a pull request. The token in <span className="mono">GIT_TOKEN</span> is used to clone, push and open pull requests. Don't put a token in the URL.
              </p>
            )}
            {active.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
                {active.length > 1 && (
                  <div className="field" style={{ maxWidth: 240, marginBottom: 0 }}>
                    <label htmlFor="projects-sort">Sort by</label>
                    <select id="projects-sort" value={sort} onChange={(e) => changeSort(e.target.value as ProjectSort)}>
                      {PROJECT_SORTS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <button
                  type="button"
                  className="btn"
                  onClick={() => download(`projects-${company.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company"}-${new Date().toISOString().slice(0, 10)}.csv`, projectsToCsv(sortProjects(active, sort, statsFor), statsFor))}
                >
                  Download CSV
                </button>
              </div>
            )}
            {projects.data?.length
              ? sortProjects(active, sort, statsFor).map((p) => (
                  <ProjectCard key={p.id} p={p} go={go} agents={company.agents} onStar={() => patch(p.id, { starred: !p.starred })} starBusy={act.busy} stats={statsFor(p.id)} onChanged={() => { projects.reload(); onChanged?.(); }} />
                ))
              : projects.data && <p>No projects yet.</p>}
            {act.view}
            {summary.error && <LoadError what="the project figures" message={summary.error.message} onRetry={summary.reload} />}
            {projects.data?.some((p) => p.archivedAt) && (
              <details>
                <summary>Archived ({projects.data.filter((p) => p.archivedAt).length})</summary>
                {projects.data.filter((p) => p.archivedAt).map((p) => (
                  <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                    <a href={`#/board/${p.id}`}>{p.name}</a>
                    {statsFor(p.id) && <span className="muted" style={{ fontSize: 13 }}>{projectSummaryLine(statsFor(p.id)!)}</span>}
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => patch(p.id, { archived: false })}>
                      {act.busy ? "Saving…" : "Unarchive"}
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
