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
import { isBackgroundLaneTitle } from "./check-gate.js";
import { GitHostError, type GitHostConfig, type WorkflowJob, type WorkflowRun, type gitHostService } from "./git-hosts.js";

/** The owner's switch: absent means on. Server-wide, like the other background watchers. */
export const MAIN_CI_SWITCH = "main_ci_watch";
const STATE_KEY = (projectId: string) => `main_ci:${projectId}`;
/** Only these run events are about main itself; a pull request's run is the gate's business. */
const EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);
const BAD = new Set(["failure", "timed_out", "startup_failure"]);
/** How many older runs are read to find the first one that broke. */
const LOOK_BACK = 10;
const MAX_LINES = 15;
const MAX_LINE = 300;

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

type OpenFailure = { ticketId: string; workflow: string; runs: string[] };
type ProjectState = { status: MainCiStatus & { at: string }; seen: Record<string, string>; open: Record<string, OpenFailure> };

/** One failing step, found in one run. */
export type Failure = { key: string; workflow: string; job: string; step: string; jobUrl: string; lines: string[] };

const keyOf = (workflow: string, job: string, step: string) => `${workflow} / ${job} / ${step}`.toLowerCase();

/** The lines of a log that most likely say what went wrong: error-looking ones, timestamps and colour codes removed, secrets redacted. */
export function errorLines(log: string, max = MAX_LINES): string[] {
  const clean = log
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/\u001b\[[0-9;]*m/g, "").replace(/^##\[(error|warning|group|endgroup)\]/, "$1: ").trim())
    .filter(Boolean);
  const hits = clean.filter((l) => /(^error\b|\berror[: ]|\bfail(ed|ure|ing)?\b|✗|✕|×|assert|exception|\bFAIL\b|exit code|cannot find|not found|expected)/i.test(l));
  // The last ones are nearest the failure.
  return (hits.length ? hits : clean).slice(-max).map((l) => redactForModel(l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l));
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
      let lines: string[] = [];
      try {
        lines = errorLines(await deps.gitHosts.jobLog(cfg, token, job.id));
      } catch {
        annotations ??= await deps.gitHosts.commitAnnotations(cfg, token, run.headSha).catch(() => []);
        lines = (annotations.find((a) => a.name === job.name)?.lines ?? []).slice(0, MAX_LINES).map((l) => redactForModel(l.slice(0, MAX_LINE)));
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

  /** The first run of the current streak of failures in one workflow: the change that broke it. */
  const firstBad = (runs: WorkflowRun[], from: WorkflowRun) => {
    let first = from;
    for (const r of runs.slice(runs.indexOf(from) + 1, runs.indexOf(from) + 1 + LOOK_BACK)) {
      if (r.name !== from.name) continue;
      if (r.status !== "completed") continue;
      if (BAD.has(String(r.conclusion))) first = r;
      else break;
    }
    return first;
  };

  const ticketOpen = async (ticketId: string) => {
    const [t] = await db.select({ s: tickets.systemState }).from(tickets).where(and(eq(tickets.id, ticketId), ne(tickets.systemState, "done")));
    return !!t;
  };

  async function watchProject(p: { id: string; companyId: string; name: string; repoUrl: string | null; gitHost: string | null; gitApiBase: string | null; defaultBranch: string }) {
    const prev = (await readState(p.id)) ?? { status: { state: "green" as const, detail: "", at: "" }, seen: {}, open: {} };
    const state: ProjectState = { status: prev.status, seen: { ...prev.seen }, open: { ...prev.open } };
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
    let runs: WorkflowRun[];
    try {
      runs = (await deps.gitHosts.workflowRuns(cfg, token, p.defaultBranch)).filter((r) => EVENTS.has(r.event));
    } catch (err) {
      const hint = err instanceof GitHostError && [401, 403, 404].includes(err.status) ? " On GitHub a fine-grained token needs Repository permissions → Actions: Read-only." : "";
      setStatus({ state: "unreadable", detail: `The token can't read main's CI runs (${(err as Error).message}).${hint}` });
      return writeState(p.id, state);
    }
    if (!runs.length) {
      setStatus({ state: "no_ci", detail: "No CI runs on main were found." });
      return writeState(p.id, state);
    }

    // The newest finished run of each workflow is what main looks like now.
    const latest = new Map<string, WorkflowRun>();
    for (const r of runs) if (r.status === "completed" && !latest.has(r.name)) latest.set(r.name, r);
    let failing = 0;
    for (const [workflow, run] of latest) {
      const seenKey = `${run.id}:${run.attempt}`;
      const bad = BAD.has(String(run.conclusion));
      if (bad) failing++;
      if (state.seen[workflow] === seenKey) continue;
      if (!bad && run.conclusion !== "success") {
        // Cancelled or skipped: says nothing either way.
        state.seen[workflow] = seenKey;
        continue;
      }
      let found: Failure[] = [];
      if (bad) {
        try {
          found = await failuresOf(cfg, token, run);
        } catch (err) {
          // Try again next pass: the run isn't marked seen.
          deps.log?.(`main CI: couldn't read run ${run.id}: ${(err as Error).message}`);
          continue;
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
        const first = firstBad(runs, run);
        const who = await breaker(p.id, p.companyId, first.headSha);
        const title = `Main's CI is failing: ${f.workflow} / ${f.job} / ${f.step}`.slice(0, 200);
        const body = [
          `GitHub CI is failing on ${p.defaultBranch} in ${p.name}.`,
          "",
          `- Run: ${run.url} (${run.event}, ${run.createdAt})`,
          `- Workflow: ${f.workflow}`,
          `- Job: ${f.job}${f.jobUrl ? ` (${f.jobUrl})` : ""}`,
          `- Step: ${f.step}`,
          `- First failing commit: ${first.headSha.slice(0, 8)}${first.headMessage ? ` — ${first.headMessage.split("\n")[0]!.slice(0, 120)}` : ""} (${first.url})`,
          who.ticketTitle ? `- That commit came from the ticket "${who.ticketTitle}".` : "- Boss Man couldn't tell which ticket that commit came from.",
          ...(who.lead ? [`- Lead: ${who.lead} merged that ticket (background lane, so this went to the CEO to give to a foreground agent).`] : []),
          "",
          "Error lines (secrets redacted):",
          "```",
          ...(f.lines.length ? f.lines : ["(the log and annotations gave no error lines: open the run)"]),
          "```",
          "",
          NEVER_WEAKEN,
          "",
          "Boss Man opens one ticket for each failing step and adds later failed runs here. It says here when main is green again.",
        ].join("\n");
        const t = await deps.createTicket(p.id, { title, body, assigneeAgentId: who.agentId, urgent: true, risk: "medium", state: "ready" });
        state.open[f.key] = { ticketId: t.id, workflow, runs: [run.url] };
        // Saved at once: if a later ticket in this pass fails, the next pass must not open this one again.
        await writeState(p.id, state);
        await record(db, { companyId: p.companyId, ticketId: t.id, kind: "main_ci_failure", summary: `Opened for a failing step on ${p.defaultBranch}`, at: now() });
        if (who.agentId && deps.notify) await deps.notify(who.agentId, { ticketId: t.id, reason: "main CI failed", note: `Main's CI failed at ${f.job} → ${f.step}. ${NEVER_WEAKEN}`, priority: 2 }).catch(() => undefined);
      }
      state.seen[workflow] = seenKey;
    }
    setStatus(failing ? { state: "failing", detail: `Main's CI is failing in ${failing} workflow${failing === 1 ? "" : "s"}.` } : { state: "green", detail: "Main's CI is green." });
    await writeState(p.id, state);
  }

  return {
    isOn,
    async setOn(on: boolean) {
      await db.insert(settings).values({ key: MAIN_CI_SWITCH, value: on ? "on" : "off" }).onConflictDoUpdate({ target: settings.key, set: { value: on ? "on" : "off" } });
      return on;
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
