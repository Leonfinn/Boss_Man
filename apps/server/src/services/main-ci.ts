// The main-CI watcher (BOS-1072): when GitHub's CI fails on a project's main branch (a push, or the nightly
// schedule), Boss Man opens one ticket for each distinct failing step, adds later runs of the same failure to
// that ticket instead of opening another, and says so on it when main is green again. It is generic: it reads
// whatever workflows the repo has. It is quiet where it cannot work (no GitHub repo, no token that can read runs,
// no CI): the reason is kept as a status line the Settings page shows, and no ticket or card is sent.
import { and, eq, isNull, ne } from "drizzle-orm";
import { redactForModel, type GitHostKind } from "@boss-man/shared";
import { parseRepoUrl } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, projects, settings, ticketMessages, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { wakeWatchers } from "./watch-triggers.js";
import { tellOnce } from "./tell-once.js";
import { isBackgroundLaneTitle } from "./check-gate.js";
import { errorLines, readFailureLog, MAX_LINE, MAX_LINES, type GitHostConfig, type WorkflowJob, type WorkflowRun, type gitHostService } from "./git-hosts.js";

/** The owner's switch: absent means on. Server-wide, like the other background watchers. */
export const MAIN_CI_SWITCH = "main_ci_watch";
const STATE_KEY = (projectId: string) => `main_ci:${projectId}`;
/** Only these run events are about main itself; a pull request's run is the gate's business. */
/** "workflow_run" (BOS-2299): a workflow that follows main's CI, such as Publish images, is main's business too. */
const EVENTS = new Set(["push", "schedule", "workflow_dispatch", "workflow_run"]);
const BAD = new Set(["failure", "timed_out", "startup_failure"]);
/** How many older runs are read to find the first one that broke. */
const LOOK_BACK = 10;
/** Runs per page, and the most pages read back to the last pass's mark (BOS-2468): 500 runs, many hours of a busy main. */
const PER_PAGE = 100;
const MAX_PAGES = 5;
/** A run still unfinished this long after it was created (stuck in GitHub's queue) stops holding the mark back. */
const STUCK_MS = 24 * 60 * 60_000;
/** How many read gaps are kept, and how long one is named on the Settings line. */
const MAX_GAPS = 10;
const GAP_SHOWN_MS = 7 * 24 * 60 * 60_000;

/** The parent's rule, carried on every ticket this opens. */
export const NEVER_WEAKEN = "Fix the cause. Never make CI green by weakening a test: no skipping, loosening an assertion, raising a time limit or deleting the check just to pass.";

export type MainCiStatus =
  | { state: "off" }
  | { state: "no_github"; detail: string }
  | { state: "no_token"; detail: string }
  | { state: "unreadable"; detail: string }
  | { state: "no_ci"; detail: string }
  | { state: "green"; detail: string }
  | { state: "failing"; detail: string };

/** A commit since the last green run that changed a file the failing job names (BOS-1688): the only revert target worth offering. */
export type Suspect = { sha: string; message: string; reason: string };
/**
 * mainAt/lastGreen/suspects (BOS-1688): where main was, the last green commit of this workflow and the ranked
 * suspects between them. Absent on failures opened before them. R40's quarantine-or-revert wake reads suspects
 * through suspectsFor: an empty list means "no commit to revert".
 */
/**
 * job/step/named/scope (R40, BOS-1685): what the red covers, so a GitHub-only red holds only the merges that touch it
 * and the gate can tell main's known failure from a branch's own. `scope`: repo path prefixes (redScope); null or
 * absent means unknown, and an unknown scope holds every merge, as before R40.
 */
export type OpenFailure = { ticketId: string; workflow: string; runs: string[]; mainAt?: string; lastGreen?: string | null; suspects?: Suspect[]; job?: string; step?: string; named?: string[]; scope?: string[] | null };
/** Runs between two ids that were never read because they fell off the pages read (BOS-2468): the recorded reason they got no ticket. */
export type ReadGap = { afterId: number; beforeId: number; at: string };
/**
 * What has been read (BOS-2468). `low`: every main run with an id at or below it was judged (or came before the
 * watcher's record began). `judged`: run id → the attempt judged, for the runs still on the pages read. GitHub
 * lists runs by when they started, but they finish in any order (main's CI takes 7 to 30 minutes per push), so a run
 * is read when it finishes, whatever finished before it. `seen` is the old single mark per workflow, read once to
 * carry the record over.
 */
type ProjectState = { status: MainCiStatus & { at: string }; seen?: Record<string, string>; open: Record<string, OpenFailure>; low?: number; judged?: Record<string, number>; gaps?: ReadGap[] };

/** The project's open main-CI failures (R40), keyed by failing step. A settings read only. */
export async function mainCiFailures(db: Db, projectId: string): Promise<OpenFailure[]> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, STATE_KEY(projectId)));
  return Object.values((row?.value as ProjectState | undefined)?.open ?? {});
}

/** The part of the repo a path belongs to (R40): `apps/<x>/`, `packages/<x>/`, else its top folder; a file at the root is itself. */
export function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return path;
  if ((parts[0] === "apps" || parts[0] === "packages") && parts.length > 2) return `${parts[0]}/${parts[1]}/`;
  return `${parts[0]}/`;
}

/**
 * The repo areas a red covers (R40): the failing workflow's file, plus the area of every file its error lines name.
 * A logged name is often package-relative (`test/a.test.ts`), so it is matched by suffix against main's tree; a name
 * that matches files in several areas covers all of them. Null (unknown) when nothing is named, a name matches no file,
 * or the tree couldn't be read: an unknown red holds every merge (fail closed).
 */
export function redScope(named: string[], workflowFile: string | null, tree: string[] | null): string[] | null {
  if (!named.length || !tree) return null;
  const out = new Set<string>(workflowFile ? [workflowFile] : []);
  for (const n of named) {
    const hits = tree.filter((p) => sameFile(p, n));
    if (!hits.length) return null;
    for (const p of hits) out.add(areaOf(p));
  }
  return [...out].sort();
}

/** One failing step, found in one run. */
export type Failure = { key: string; workflow: string; job: string; step: string; jobUrl: string; lines: string[] };

const keyOf = (workflow: string, job: string, step: string) => `${workflow} / ${job} / ${step}`.toLowerCase();

// The log trimming lives in git-hosts.ts, shared with the merge gate's CI bounce message (BOS-1667).
export { errorLines };

/** The most commits since the last green run whose files are read one by one (one compare call each). */
const MAX_RANGE = 20;
const FILE_EXT = "[cm]?[jt]sx?|sh|ya?ml|json|py|rs|go|css|vue|svelte|sql|toml";

/**
 * The files a failure's error lines name (BOS-1688), as logged: often relative to a package (`test/a.test.ts`),
 * so they are matched against a commit's repo paths by suffix. A bare name counts only for a test file:
 * `index.ts` alone would match half the repo.
 */
export function namedFiles(lines: string[]): string[] {
  // not state: a per-call local that dedupes the names.
  const out = new Set<string>();
  const re = new RegExp(`(?:^|[\\s(>"'\`\\[])((?:[\\w@.-]+/)*[\\w@.-]+\\.(?:${FILE_EXT}))(?=$|[\\s:)"'\`\\],>])`, "g");
  for (const line of lines)
    for (const m of line.matchAll(re)) {
      const p = m[1]!.replace(/^(\.\/)+/, "");
      if (p.includes("node_modules/") || p.startsWith("../")) continue;
      if (p.includes("/") || /\.(test|spec)\./.test(p)) out.add(p);
    }
  return [...out];
}

/** Whether a repo path is the file a log named (by path suffix, so `test/a.test.ts` finds `apps/server/test/a.test.ts`). */
const sameFile = (repoPath: string, named: string) => repoPath === named || repoPath.endsWith(`/${named}`);

/** One failed job of a branch's merge run, as the gate read it: the files its annotations and log lines name. */
export type BranchFailure = { job: string; step?: string; files: string[] };

/**
 * R40 (BOS-1685): whether every failed job of a branch's GitHub run is main's known red, and which reds. Each failure
 * must match one open red with a known scope exactly: the same job, the same failing step when the gate knows it, and
 * it names at least one file, every one of them a file the red named (so a new failing test is never taken as main's).
 * Null when any failure doesn't match: the gate then goes its usual way. `reds` are already limited to GitHub-only,
 * open reds whose scope the branch doesn't touch; that and the gate's own check passing are the caller's conditions.
 */
export function knownRedOnly(failed: BranchFailure[], reds: OpenFailure[]): OpenFailure[] | null {
  if (!failed.length) return null;
  // not state: a local of one call.
  const matched = new Set<OpenFailure>();
  for (const f of failed) {
    const red = reds.find(
      (r) =>
        !!r.scope?.length &&
        !!r.job &&
        r.job.toLowerCase() === f.job.toLowerCase() &&
        (!f.step || (!!r.step && r.step.toLowerCase() === f.step.toLowerCase())) &&
        f.files.length > 0 &&
        f.files.every((x) => (r.named ?? []).some((n) => sameFile(x, n) || sameFile(n, x))),
    );
    if (!red) return null;
    matched.add(red);
  }
  return [...matched];
}

export function mainCiService(
  db: Db,
  deps: {
    gitHosts: ReturnType<typeof gitHostService>;
    gitToken: (companyId: string) => Promise<string | undefined>;
    /** work.createTicket. */
    createTicket: (projectId: string, input: { title: string; body: string; assigneeAgentId: string | null; urgent?: boolean; risk?: "medium"; state?: "ready" }) => Promise<{ id: string }>;
    /** Wakes the assignee on the new ticket (scheduler.notify). */
    notify?: (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;
    now?: () => Date;
    log?: (msg: string) => void;
  },
) {
  const now = deps.now ?? (() => new Date());

  async function isOn(): Promise<boolean> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MAIN_CI_SWITCH));
    return row?.value !== "off";
  }

  async function readState(projectId: string): Promise<ProjectState | null> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, STATE_KEY(projectId)));
    return (row?.value as ProjectState | undefined) ?? null;
  }

  async function writeState(projectId: string, s: ProjectState) {
    await db.insert(settings).values({ key: STATE_KEY(projectId), value: s }).onConflictDoUpdate({ target: settings.key, set: { value: s } });
  }

  async function say(companyId: string, ticketId: string, text: string) {
    await db.insert(ticketMessages).values({ companyId, ticketId, author: "system", text });
    await db.update(tickets).set({ lastActivityAt: now() }).where(eq(tickets.id, ticketId));
  }

  /** The failing steps of one failed run: from the jobs, with the log's (or the annotations') error lines. */
  async function failuresOf(cfg: GitHostConfig, token: string, run: WorkflowRun): Promise<Failure[]> {
    const jobs: WorkflowJob[] = await deps.gitHosts.runJobs(cfg, token, run.id);
    const out: Failure[] = [];
    let annotations: Awaited<ReturnType<typeof deps.gitHosts.commitAnnotations>> | null = null;
    for (const job of jobs) {
      if (!BAD.has(String(job.conclusion))) continue;
      const steps = job.steps.filter((s) => BAD.has(String(s.conclusion)));
      const log = await readFailureLog(cfg, job.id, () => deps.gitHosts.jobLog(cfg, token, job.id));
      let lines = log.lines;
      if (!log.readable) {
        // The shared reader says why the log is out of reach; the check-run annotations may still carry error lines.
        annotations ??= await deps.gitHosts.commitAnnotations(cfg, token, run.headSha).catch(() => []);
        const fromAnnotations = (annotations.find((a) => a.name === job.name)?.lines ?? []).slice(0, MAX_LINES).map((l) => redactForModel(l.slice(0, MAX_LINE)));
        if (fromAnnotations.length) lines = fromAnnotations;
      }
      // A job that failed without a failing step (cancelled setup, runner lost) is one failure of its own.
      for (const step of steps.length ? steps.map((s) => s.name) : ["(job failed before any step)"])
        out.push({ key: keyOf(run.name, job.name, step), workflow: run.name, job: job.name, step, jobUrl: job.url || run.url, lines });
    }
    return out;
  }

  /** The ticket whose merge produced `sha`: its assignee takes the failure; otherwise the CEO. */
  async function breaker(projectId: string, companyId: string, sha: string): Promise<{ agentId: string | null; ticketTitle: string | null; byCeo: boolean; lead: string | null }> {
    const [t] = await db.select({ assignee: tickets.assigneeAgentId, title: tickets.title }).from(tickets).where(and(eq(tickets.projectId, projectId), eq(tickets.mergeCommit, sha)));
    let lead: string | null = null;
    if (t?.assignee) {
      const [a] = await db.select({ id: agents.id, name: agents.name, title: agents.title }).from(agents).where(and(eq(agents.id, t.assignee), isNull(agents.retiredAt)));
      // A background-lane agent never takes it: Boss Man doesn't interrupt a run, so urgent work would wait behind their long low-priority one (BOS-1635).
      if (a && !isBackgroundLaneTitle(a.title)) return { agentId: a.id, ticketTitle: t.title, byCeo: false, lead: null };
      if (a) lead = a.name;
    }
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    return { agentId: ceo?.id ?? null, ticketTitle: t?.title ?? null, byCeo: true, lead };
  }

  /**
   * The current streak of failures in one workflow: its first failed run (where main was when it started failing,
   * not necessarily what broke it, BOS-1688) and the last green run before it, if one is in reach. A cancelled or
   * skipped run says nothing either way and is stepped over.
   */
  const streak = (runs: WorkflowRun[], from: WorkflowRun) => {
    let first = from;
    let green: WorkflowRun | null = null;
    for (const r of runs.slice(runs.indexOf(from) + 1, runs.indexOf(from) + 1 + LOOK_BACK)) {
      if (r.name !== from.name) continue;
      if (r.status !== "completed") continue;
      if (BAD.has(String(r.conclusion))) first = r;
      else if (r.conclusion === "success") {
        green = r;
        break;
      }
    }
    return { first, green };
  };

  /**
   * The commits on main from the last green run to the first failed one, ranked by whether they changed a file the
   * failing job names or the workflow's own file (BOS-1688). `note` says why there are none, or what limited the search.
   */
  async function suspectsOf(
    cfg: GitHostConfig,
    token: string,
    f: Failure,
    first: WorkflowRun,
    green: WorkflowRun | null,
  ): Promise<{ suspects: Suspect[]; others: Array<{ sha: string; message: string }>; note: string | null }> {
    const none = (note: string) => ({ suspects: [], others: [], note });
    if (!green) return none(`No green run of "${f.workflow}" was found in the last ${LOOK_BACK} runs, so there is no range of commits to search.`);
    if (green.headSha === first.headSha)
      return none(`Main didn't change between the last green run and the first failure (both at ${first.headSha.slice(0, 8)}): no commit broke it. Look at the test itself: flaky, a date or time, or something outside the repo.`);
    let range: Awaited<ReturnType<typeof deps.gitHosts.compareDetail>>;
    try {
      range = await deps.gitHosts.compareDetail(cfg, token, green.headSha, first.headSha);
    } catch (err) {
      return none(`Boss Man couldn't read the commits between them (${(err as Error).message}); on GitHub the token needs Repository permissions → Contents: Read-only for this.`);
    }
    // Main's own commits (each merge), newest first: the first-parent chain back to the green one. A branch's
    // inner commits are part of their merge and are never listed apart.
    const bySha = new Map(range.commits.map((c) => [c.sha, c]));
    const chain: Array<{ sha: string; message: string; parents: string[] }> = [];
    for (let c = bySha.get(first.headSha); c && c.sha !== green.headSha; c = bySha.get(c.parents[0] ?? "")) chain.push(c);
    if (!chain.length) return none(`Boss Man couldn't trace main from ${green.headSha.slice(0, 8)} to ${first.headSha.slice(0, 8)} (was main rewritten?).`);
    const looked = chain.slice(0, MAX_RANGE);
    const named = namedFiles(f.lines);
    const workflowFile = first.path ?? null;
    const scored: Array<Suspect & { score: number }> = [];
    const others: Array<{ sha: string; message: string }> = [];
    for (const c of looked) {
      let files: string[] = [];
      try {
        files = chain.length === 1 ? range.files : c.parents[0] ? (await deps.gitHosts.compareDetail(cfg, token, c.parents[0], c.sha)).files : [];
      } catch {
        // Not readable: listed as checked-and-clear would be wrong, so it stays among the others with a mark.
        others.push({ sha: c.sha, message: `${c.message} (its files couldn't be read)` });
        continue;
      }
      const hits = named.filter((n) => files.some((p) => sameFile(p, n)));
      const touchesWorkflow = !!workflowFile && files.includes(workflowFile);
      if (!hits.length && !touchesWorkflow) {
        others.push({ sha: c.sha, message: c.message });
        continue;
      }
      const reason = [hits.length ? `changed ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ` and ${hits.length - 3} more named in the error lines` : ""}` : "", touchesWorkflow ? `changed the workflow file ${workflowFile}` : ""].filter(Boolean).join("; ");
      // A file the error names outweighs the workflow file; more named files rank higher; ties keep main's order (newest first).
      scored.push({ sha: c.sha, message: c.message, reason, score: hits.length * 10 + (touchesWorkflow ? 1 : 0) });
    }
    const suspects = scored.sort((a, b) => b.score - a.score).map(({ sha, message, reason }) => ({ sha, message, reason }));
    const notes = [
      chain.length > looked.length ? `Only the newest ${looked.length} of ${chain.length} commits since the last green run were checked.` : "",
      !named.length ? `The error lines name no file${workflowFile ? ", so only the workflow file was looked for" : ""}: a commit that changed the failing code itself can't be told apart here.` : "",
    ].filter(Boolean);
    return { suspects, others, note: notes.join(" ") || null };
  }

  const ticketOfCommit = async (projectId: string, sha: string) => {
    const [t] = await db.select({ title: tickets.title }).from(tickets).where(and(eq(tickets.projectId, projectId), eq(tickets.mergeCommit, sha)));
    return t?.title ?? null;
  };
  const short = (sha: string, message?: string) => `${sha.slice(0, 8)}${message ? ` "${message.split("\n")[0]!.slice(0, 120)}"` : ""}`;

  const ticketOpen = async (ticketId: string) => {
    const [t] = await db.select({ s: tickets.systemState }).from(tickets).where(and(eq(tickets.id, ticketId), ne(tickets.systemState, "done")));
    return !!t;
  };

  async function watchProject(p: { id: string; companyId: string; name: string; repoUrl: string | null; gitHost: string | null; gitApiBase: string | null; defaultBranch: string }) {
    const prev: ProjectState = (await readState(p.id)) ?? { status: { state: "green" as const, detail: "", at: "" }, open: {} };
    const state: ProjectState = { status: prev.status, open: { ...prev.open }, judged: { ...prev.judged }, gaps: [...(prev.gaps ?? [])], ...(prev.low !== undefined ? { low: prev.low } : {}), ...(prev.seen ? { seen: prev.seen } : {}) };
    const stamp = now().toISOString();
    const setStatus = (s: MainCiStatus) => (state.status = { ...s, at: stamp });
    const addr = p.repoUrl ? parseRepoUrl(p.repoUrl) : null;
    if (!addr || p.gitHost !== "github" || !p.gitApiBase) {
      setStatus({ state: "no_github", detail: "This project's code isn't on GitHub, so there is no GitHub CI to watch." });
      return writeState(p.id, state);
    }
    const token = await deps.gitToken(p.companyId);
    if (!token) {
      setStatus({ state: "no_token", detail: "No git token is set for this company, so main's GitHub CI can't be read." });
      return writeState(p.id, state);
    }
    const cfg: GitHostConfig = { kind: p.gitHost as GitHostKind, apiBase: p.gitApiBase, owner: addr.owner, repo: addr.repo };
    // The old single mark per workflow (before BOS-2468), carried over once: the lowest of them is the new mark.
    const oldSeen = state.low === undefined && state.seen ? Object.entries(state.seen).map(([w, k]) => ({ workflow: w, id: Number(k.split(":")[0]) })).filter((s) => s.id > 0) : [];
    if (oldSeen.length) state.low = Math.min(...oldSeen.map((s) => s.id));
    const judged = state.judged!;
    let fetched: WorkflowRun[] = [];
    // True when the pages read go back to the mark, or hold main's whole history.
    let reached = state.low === undefined;
    try {
      // not state: a per-pass local that drops a run that moved onto the next page while it was read.
      const ids = new Set<number>();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const rows = await deps.gitHosts.workflowRuns(cfg, token, p.defaultBranch, PER_PAGE, page);
        for (const r of rows) if (!ids.has(r.id)) ids.add(r.id), fetched.push(r);
        if (rows.length < PER_PAGE || (state.low !== undefined && rows.some((r) => r.id <= state.low!))) {
          reached = true;
          break;
        }
        if (state.low === undefined) break;
      }
    } catch (err) {
      setStatus({ state: "unreadable", detail: `The token can't read main's CI runs (${(err as Error).message}).` });
      return writeState(p.id, state);
    }
    fetched = fetched.sort((a, b) => b.id - a.id);
    const runs = fetched.filter((r) => EVENTS.has(r.event));
    if (!runs.length) {
      setStatus({ state: "no_ci", detail: "No CI runs on main were found." });
      return writeState(p.id, state);
    }
    if (oldSeen.length) {
      // What the old mark had judged: each workflow's marked run and every run of it listed below.
      for (const s of oldSeen) for (const r of runs) if (r.name === s.workflow && r.id <= s.id && r.status === "completed") judged[r.id] = r.attempt;
      delete state.seen;
    }
    const oldest = fetched[fetched.length - 1]!;
    if (state.low === undefined) {
      // First pass with no record: only each workflow's newest finished run is read, as before; older finished runs
      // count as judged. A run still going is read when it finishes (BOS-2468).
      // not state: a per-pass local, each workflow's newest finished run id.
      const newestOf = new Map<string, number>();
      for (const r of runs) if (r.status === "completed" && !newestOf.has(r.name)) newestOf.set(r.name, r.id);
      for (const r of runs) if (r.status === "completed" && newestOf.get(r.name) !== r.id) judged[r.id] = r.attempt;
      state.low = oldest.id - 1;
    } else if (!reached) {
      // More runs since the last pass than the pages hold: the ones in between are never read. Said where the owner
      // and the CEO can see it, so a red among them has a recorded reason rather than silence.
      const gap: ReadGap = { afterId: state.low, beforeId: oldest.id, at: stamp };
      state.gaps = [...state.gaps!, gap].slice(-MAX_GAPS);
      deps.log?.(`main CI: runs on ${p.defaultBranch} after ${gap.afterId} and before ${gap.beforeId} were not read: more than ${MAX_PAGES * PER_PAGE} runs since the last pass`);
      await record(db, { companyId: p.companyId, kind: "main_ci_gap", summary: `Main's CI watcher couldn't read every run on ${p.defaultBranch} in ${p.name}: more than ${MAX_PAGES * PER_PAGE} runs since its last pass, so runs started before ${oldest.createdAt} that finished since were not checked.`, detail: gap, at: now() });
      state.low = oldest.id - 1;
    }
    const low = state.low!;

    // The newest finished run of each workflow is what main looks like now.
    const latest = new Map<string, WorkflowRun>();
    for (const r of runs) if (r.status === "completed" && !latest.has(r.name)) latest.set(r.name, r);
    let failing = 0;
    for (const [workflow, newest] of latest) {
      if (BAD.has(String(newest.conclusion))) failing++;
      // Every finished run not judged yet, in the order they finished: a newer run that finished first (green,
      // cancelled or skipped) must not hide an older red one (BOS-1703, BOS-2468). A re-run (a new attempt) of a run
      // still on the pages is read again.
      const pending = runs
        .filter((r) => r.name === workflow && r.status === "completed" && judged[r.id] !== r.attempt && (r.id > low || judged[r.id] !== undefined))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id);
      // Left in the log so the next missed run can be told apart: not polled, not finished, or read and judged.
      if (pending.length) deps.log?.(`main CI: ${workflow}: reading ${pending.map((r) => `${r.id}:${r.conclusion}`).join(", ")} (mark ${low})`);
      for (const run of pending) {
      const bad = BAD.has(String(run.conclusion));
      if (!bad && run.conclusion !== "success") {
        // Cancelled or skipped: says nothing either way.
        judged[run.id] = run.attempt;
        continue;
      }
      let found: Failure[] = [];
      if (bad) {
        try {
          found = await failuresOf(cfg, token, run);
        } catch (err) {
          // Try again next pass: the run isn't marked seen.
          deps.log?.(`main CI: couldn't read run ${run.id}: ${(err as Error).message}`);
          // Stop here: newer pending runs of this workflow wait too, so the order is kept and nothing is marked seen past the unread run.
          break;
        }
        if (!found.length) found = [{ key: keyOf(workflow, "(run)", "(no failing job found)"), workflow, job: "(run)", step: "(no failing job found)", jobUrl: run.url, lines: [] }];
      }
      const current = new Set(found.map((f) => f.key));
      // Failures this workflow no longer shows: green again.
      for (const [key, o] of Object.entries(state.open)) {
        if (o.workflow !== workflow || current.has(key)) continue;
        if (await ticketOpen(o.ticketId)) {
          const [t] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, o.ticketId));
          if (t) await say(t.companyId, o.ticketId, `Main's CI is green again for this: "${workflow}" passed (${run.url}). If your fix is what turned it green, you can close this ticket.`);
        }
        delete state.open[key];
      }
      for (const f of found) {
        const known = state.open[f.key];
        if (known && (await ticketOpen(known.ticketId))) {
          if (!known.runs.includes(run.url)) {
            known.runs.push(run.url);
            const [t] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, known.ticketId));
            if (t) await say(t.companyId, known.ticketId, `Failed again on main: ${run.url} (${f.job} → ${f.step}).`);
          }
          continue;
        }
        const title = `Main's CI is failing: ${f.workflow} / ${f.job} / ${f.step}`.slice(0, 200);
        // A ticket opened by hand for this same failure counts: don't open a second one (BOS-1703).
        // (Tickets this watcher opened carry its closing line in the body; one it called green earlier is not "by hand", so a second break opens a fresh one.)
        const [byHand] = (await db.select({ id: tickets.id, title: tickets.title, body: tickets.body }).from(tickets).where(and(eq(tickets.projectId, p.id), ne(tickets.systemState, "done"))))
          .filter((t) => !(t.body ?? "").includes("Boss Man opens one ticket for each failing step") && t.title.toLowerCase().includes("main's ci is failing") && t.title.toLowerCase().includes(f.job.toLowerCase()) && t.title.toLowerCase().includes(f.step.toLowerCase()));
        if (byHand) {
          state.open[f.key] = { ticketId: byHand.id, workflow, runs: [run.url] };
          continue;
        }
        // BOS-1688: where main was is not what broke it (a scheduled run fails wherever main happens to be). The
        // ticket names both ends of the range and only calls a commit a suspect if it changed the failing job's files.
        const { first, green } = streak(runs, run);
        const blame = await suspectsOf(cfg, token, f, first, green);
        const top = blame.suspects[0];
        const who = await breaker(p.id, p.companyId, top?.sha ?? first.headSha);
        const suspectLines = await Promise.all(
          blame.suspects.map(async (s, i) => {
            const from = await ticketOfCommit(p.id, s.sha);
            return `  ${i + 1}. ${short(s.sha, s.message)}: ${s.reason}${from ? ` (ticket "${from}")` : ""}`;
          }),
        );
        const body = [
          `GitHub CI is failing on ${p.defaultBranch} in ${p.name}.`,
          "",
          `- Run: ${run.url} (${run.event}, ${run.createdAt})`,
          `- Workflow: ${f.workflow}`,
          `- Job: ${f.job}${f.jobUrl ? ` (${f.jobUrl})` : ""}`,
          `- Step: ${f.step}`,
          `- Main was at ${short(run.headSha, run.headMessage)} when this run failed. That is where main was, not what broke it.`,
          ...(first.id !== run.id ? [`- It has failed since main was at ${short(first.headSha, first.headMessage)} (${first.url}).`] : []),
          green ? `- Last green run of "${f.workflow}": main at ${short(green.headSha, green.headMessage)} (${green.url}).` : `- Last green run: none in reach.`,
          ...(top
            ? [`- Suspects (commits since the last green run that changed the failing job's files), most likely first:`, ...suspectLines]
            : [`- No suspect: no commit since the last green run changed a file the error lines name${first.path ? " or the workflow file" : ""}. Don't undo a commit for this.`]),
          ...(blame.others.length ? [`- Also since the last green run (didn't touch those files): ${blame.others.slice(0, 10).map((o) => short(o.sha, o.message)).join("; ")}${blame.others.length > 10 ? ` and ${blame.others.length - 10} more` : ""}.`] : []),
          ...(blame.note ? [`- ${blame.note}`] : []),
          who.ticketTitle
            ? top
              ? `- The top suspect came from the ticket "${who.ticketTitle}".`
              : `- Main's commit at the first failure came from the ticket "${who.ticketTitle}" (that alone doesn't make it the cause).`
            : "- Boss Man couldn't tell which ticket that commit came from.",
          ...(who.lead ? [`- Lead: ${who.lead} merged that ticket (background lane, so this went to the CEO to give to a foreground agent).`] : []),
          "",
          "Error lines (secrets redacted):",
          "```",
          ...f.lines,
          "```",
          "",
          NEVER_WEAKEN,
          "",
          "Boss Man opens one ticket for each failing step and adds later failed runs here. It says here when main is green again.",
        ].join("\n");
        const t = await deps.createTicket(p.id, { title, body, assigneeAgentId: who.agentId, urgent: true, risk: "medium", state: "ready" });
        // R40: what this red covers. One tree read per ticket opened; a failed read leaves the scope unknown (holds all).
        const named = namedFiles(f.lines);
        const tree = named.length ? await Promise.resolve().then(() => deps.gitHosts.treePaths(cfg, token, run.headSha)).catch(() => null) : null;
        const scope = redScope(named, run.path ?? null, tree);
        state.open[f.key] = { ticketId: t.id, workflow, runs: [run.url], mainAt: run.headSha, lastGreen: green?.headSha ?? null, suspects: blame.suspects, job: f.job, step: f.step, named, scope };
        // Saved at once: if a later ticket in this pass fails, the next pass must not open this one again.
        await writeState(p.id, state);
        await record(db, { companyId: p.companyId, ticketId: t.id, kind: "main_ci_failure", summary: `Opened for a failing step on ${p.defaultBranch}`, at: now() });
        // BOS-2632: a failed wake is logged, not retried: the urgent ticket just opened and assigned is itself the backstop
        // (its assignment and the missed-work sweep wake the agent on it).
        const notify = deps.notify;
        const agentId = who.agentId;
        if (agentId && notify) await tellOnce(`main CI ticket ${t.id}`, () => notify(agentId, { ticketId: t.id, reason: "main CI failed", note: `Main's CI failed at ${f.job} → ${f.step}. ${NEVER_WEAKEN}`, priority: 2 }), deps.log);
        await wakeWatchers(db, deps.notify, "github_main_failed", `${f.job} → ${f.step} on ${p.defaultBranch}, ticket ${t.id}`, { exceptTicketId: t.id }).catch(() => undefined);
      }
      judged[run.id] = run.attempt;
      }
    }
    // Move the mark up to just below the oldest run not judged yet (still going, or its jobs couldn't be read), so
    // the next pass pages back to it however many runs start meanwhile. A run stuck unfinished for a day stops holding it.
    const holding = runs.filter((r) => r.id > low && judged[r.id] !== r.attempt && !(r.status !== "completed" && now().getTime() - Date.parse(r.createdAt) > STUCK_MS));
    state.low = holding.length ? Math.min(...holding.map((r) => r.id)) - 1 : Math.max(low, fetched[0]!.id);
    // Only runs still on the pages can come round again (a re-run); older entries are dropped.
    for (const id of Object.keys(judged)) if (Number(id) < oldest.id) delete judged[id];
    const shownGap = [...state.gaps!].reverse().find((g) => now().getTime() - Date.parse(g.at) < GAP_SHOWN_MS);
    const gapNote = shownGap ? ` Some runs on ${p.defaultBranch} weren't checked (more than ${MAX_PAGES * PER_PAGE} runs between two passes, ${shownGap.at.slice(0, 16).replace("T", " ")} UTC).` : "";
    setStatus(failing ? { state: "failing", detail: `Main's CI is failing in ${failing} workflow${failing === 1 ? "" : "s"}.${gapNote}` } : { state: "green", detail: `Main's CI is green.${gapNote}` });
    await writeState(p.id, state);
  }

  return {
    isOn,
    async setOn(on: boolean) {
      await db.insert(settings).values({ key: MAIN_CI_SWITCH, value: on ? "on" : "off" }).onConflictDoUpdate({ target: settings.key, set: { value: on ? "on" : "off" } });
      return on;
    },
    /**
     * The ranked suspects on an open main-CI ticket (BOS-1688), for R40's quarantine-or-revert wake: offer a revert
     * only when this is non-empty. Null when the ticket isn't an open main-CI failure or predates the suspect list.
     */
    async suspectsFor(projectId: string, ticketId: string): Promise<Suspect[] | null> {
      const s = await readState(projectId);
      const o = Object.values(s?.open ?? {}).find((x) => x.ticketId === ticketId);
      return o?.suspects ?? null;
    },
    /** Every project's current line, for Settings: the one plain statement per project. */
    async statuses(): Promise<Array<{ projectId: string; project: string; status: (MainCiStatus & { at?: string }) }>> {
      const rows = await db.select({ id: projects.id, name: projects.name, repoUrl: projects.repoUrl }).from(projects).where(and(isNull(projects.archivedAt)));
      const on = await isOn();
      const out = [];
      for (const p of rows) {
        if (!p.repoUrl) continue;
        const s = await readState(p.id);
        out.push({ projectId: p.id, project: p.name, status: on ? (s?.status ?? { state: "no_ci" as const, detail: "Not checked yet." }) : { state: "off" as const } });
      }
      return out;
    },
    /** One pass over every project that has a repo. A failure on one project never stops the rest. */
    async run(): Promise<{ checked: number }> {
      if (!(await isOn())) return { checked: 0 };
      const rows = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name, repoUrl: projects.repoUrl, gitHost: projects.gitHost, gitApiBase: projects.gitApiBase, defaultBranch: projects.defaultBranch })
        .from(projects)
        .where(isNull(projects.archivedAt));
      let checked = 0;
      for (const p of rows) {
        if (!p.repoUrl) continue;
        try {
          await watchProject(p);
          checked++;
        } catch (err) {
          deps.log?.(`main CI watch failed for ${p.name}: ${(err as Error).message}`);
        }
      }
      return { checked };
    },
  };
}
