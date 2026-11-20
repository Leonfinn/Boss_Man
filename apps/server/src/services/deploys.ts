// Deploy targets and deploys (R14, R15). A target is a named connection (an SSH host, a
// Docker endpoint or a git repo) with its own secrets. An agent asks to deploy a ref to a
// target; production targets wait for the owner. Only the run that carries out an approved
// deploy receives the target's secrets, and only while the deploy is running.
//
// A target may name a deploy tag (DR-033, rules.liveTag): after a deploy to it reports success,
// the runner's daemon moves that tag on the project's remote to the commit the deploy was asked
// for, with the merge token. No agent ever names the tag, the refspec or the commit pushed.
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { DEPLOY_REF, deployTagNameProblem, findCredential, riskOf, stagingFirst, type ResolveResult, type RUNNER_FEATURES, type RunnerCommand, type TagResult } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, decisions, deploys, deployTargets, projects, runners as runnersTable, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { readyUrgentFor } from "./priority-group.js";
import type { AlertInput } from "./alert-ladder.js";
import { ownerActed } from "./stale-requests.js";
import { withStagingLock } from "./staging-lock.js";

export class DeployError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Target = typeof deployTargets.$inferSelect;
type Deploy = typeof deploys.$inferSelect;
/** The deploy tag a target moves after a successful deploy (DR-033): one tag in one project's repo. */
export type LiveTag = { projectId: string; name: string };
export type TargetRules = { requiresApproval?: boolean; liveTag?: LiveTag | null; /** BOS-1472: the host deployer's staging lane. Such a target carries no secrets and wakes no run: the request goes to the host. */ hostStaging?: boolean };
/** The name of the target Boss Man lists for the host's staging lane, and the sentinel endpoint it carries (nothing connects to it). */
export const HOST_STAGING_NAME = "staging";
export const HOST_STAGING_ENDPOINT = "host-deployer:staging";
/** What the deploys service needs of the host's staging lane (selfDeployService.stagingLane / writeStagingRequest / stagingStatus). */
export type StagingLane = {
  on: () => Promise<boolean>;
  submit: (id: string, commit: string, by: "agent-request") => Promise<void>;
  /** The repository the staging checkout follows, as the host reports it; null when it didn't say. */
  origin: () => Promise<string | null>;
  status: () => Promise<{ id: string; result: string; message: string; to_commit: string; smoke?: string; failed_checks?: string; runner_image?: string; [k: string]: string | undefined } | null>;
  /** A request is still waiting in the host's inbox (held, or not taken yet). */
  pending: () => Promise<boolean>;
};
/**
 * Whether two git remote addresses are the same repository: https, ssh:// and git@host:path forms, with or without .git,
 * any credentials and any capital letters ignored. The staging lane belongs to the company whose project is the repository
 * the host's staging checkout follows; a fork or any other repository is a different one.
 */
export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (u: string | null | undefined) => {
    if (!u) return "";
    let s = u.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
    s = s.replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]*@/, "");
    return s.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  };
  const x = norm(a);
  return x !== "" && x === norm(b);
}
/** A staging deploy the host never answers (the lane was switched off, the host is down) is failed after this long. */
const STAGING_GIVE_UP_MS = 3 * 60 * 60_000;
/** A staging status still "running" this long after it was written is stale: the host's limit is 30 minutes (STAGING_TIMEOUT_SECONDS). */
const STAGING_RUNNING_STALE_MS = 60 * 60_000;
export type TargetInput = { name: string; kind: Target["kind"]; endpoint: string; isProduction?: boolean; requiresApproval?: boolean; liveTag?: LiveTag | null };
type WakeHook = (input: { agentId: string; reason: string; note: string; ticketId?: string | null; priority?: number; deployId?: string; causedByRunId?: string | null }) => Promise<unknown>;

/** What the deploys service needs of the runner hub (services/runners.ts), for resolving refs and moving tags. */
export type DeployRunners = {
  isConnected(runnerId: string): boolean;
  waitConnected(runnerId: string, maxMs: number): Promise<boolean>;
  can(runnerId: string, feature: (typeof RUNNER_FEATURES)[number]): boolean;
  request<T>(runnerId: string, build: (requestId: string) => RunnerCommand, timeoutMs?: number): Promise<T>;
};

const RAW_DOCKER_SOCKET = /(^|:\/\/)\/?(var\/)?run\/docker\.sock$/;
/** How long resolving a ref may take at request time: a fetch, then two rev-parses. */
const RESOLVE_TIMEOUT_MS = 2 * 60_000;
/** How long a tag push may take once the runner has it. */
const TAG_TIMEOUT_MS = 5 * 60_000;
/** The runner is waited for this long before the CEO hears the tag hasn't moved yet (DR-033), as a merge waits. */
export const TAG_RUNNER_ALERT_MS = 30 * 60_000;
/** After the alert, the job waits this much longer before it records the tag as not moved. */
const TAG_RUNNER_GIVE_UP_MS = 24 * 60 * 60_000;
const UPDATE_RUNNER = "The company's runner needs an update before it can do this (Settings → Server and runner → Updates → Build and update runners).";

export const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "none");

/** The target's deploy tag, when its rules name a well-formed one. */
export function liveTagOf(t: Pick<Target, "rules">): LiveTag | null {
  const lt = (t.rules as TargetRules | null)?.liveTag;
  return lt && typeof lt.projectId === "string" && typeof lt.name === "string" && lt.name ? { projectId: lt.projectId, name: lt.name } : null;
}

/** Rejects endpoints that would hand an agent root on the host, or that carry a credential. */
export function endpointProblem(kind: Target["kind"], endpoint: string): string | null {
  const e = endpoint.trim();
  if (RAW_DOCKER_SOCKET.test(e)) {
    return "The raw Docker socket gives root on the host. Put a Docker socket proxy in front of it (for example tecnativa/docker-socket-proxy) and use its tcp:// address.";
  }
  const cred = findCredential(e);
  if (cred) return `The endpoint looks like it contains ${cred}. Store credentials as secrets and grant them to the target instead.`;
  const ok =
    kind === "ssh" ? /^(ssh:\/\/)?[a-z_][a-z0-9_.-]*@[A-Za-z0-9.-]+(:\d+)?$/.test(e) : kind === "docker" ? /^(tcp|https?):\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(e) : /^(https:\/\/\S+|ssh:\/\/\S+|git@[A-Za-z0-9.-]+:\S+)$/.test(e);
  if (!ok) {
    return kind === "ssh"
      ? "Give an SSH target as user@host or ssh://user@host:port, with a restricted deploy user."
      : kind === "docker"
        ? "Give a Docker endpoint as tcp://host:port or https://host:port, such as a socket proxy."
        : "Give a git remote as an https://, ssh:// or git@host:repo address.";
  }
  return null;
}

export function deploysService(
  db: Db,
  deps: {
    now?: () => Date;
    /** A production deploy of this task succeeded: its feature may be released. */
    onShipped?: (ticketId: string) => Promise<unknown>;
    /** The runner hub, to resolve a deploy's commit and move its tag (DR-033). Without it neither happens. */
    runners?: DeployRunners;
    /** Raises a Boss Man alert (the alert ladder). */
    alert?: (input: AlertInput) => Promise<unknown>;
    log?: (message: string) => void;
    /** The host deployer's staging lane (BOS-1472). Without it a staging target can be listed but not used. */
    staging?: StagingLane;
    /** Test hooks: how long the tag job waits for an offline runner before the CEO alert, and before giving up. */
    tagRunnerAlertMs?: number;
    tagRunnerGiveUpMs?: number;
  } = {},
) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let wake: WakeHook | null = null;

  const needsApproval = (t: Target) => t.isProduction || (t.rules as TargetRules).requiresApproval === true;

  async function load(id: string) {
    const [d] = await db.select().from(deploys).where(eq(deploys.id, id));
    if (!d) throw new DeployError(404, "No such deploy.");
    return d;
  }

  async function target(id: string) {
    const [t] = await db.select().from(deployTargets).where(eq(deployTargets.id, id));
    if (!t) throw new DeployError(404, "No such deploy target.");
    return t;
  }

  async function companyRunner(companyId: string): Promise<string | null> {
    const [r] = await db.select({ id: runnersTable.id }).from(runnersTable).where(eq(runnersTable.companyId, companyId));
    return r?.id ?? null;
  }

  /** A connected runner that can resolve refs and move tags, or why there isn't one. */
  async function tagRunner(companyId: string): Promise<{ id: string } | { problem: string }> {
    const id = await companyRunner(companyId);
    if (!id || !deps.runners) return { problem: "The company has no runner." };
    if (!deps.runners.isConnected(id)) return { problem: "The company's runner isn't connected." };
    if (!deps.runners.can(id, "deploy-tag")) return { problem: UPDATE_RUNNER };
    return { id };
  }

  /**
   * Checks a deploy tag setting before it is saved (DR-033): a single, well-formed name, a project of this
   * company with a repo, and not the name of any branch on that repo's remote (asked of the runner).
   */
  async function checkLiveTag(companyId: string, input: LiveTag): Promise<LiveTag> {
    const name = input.name.trim();
    const problem = deployTagNameProblem(name);
    if (problem) throw new DeployError(422, problem);
    const [p] = await db.select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, companyId)));
    if (!p) throw new DeployError(422, "Pick one of this company's projects for the tag.");
    if (!p.repoUrl) throw new DeployError(422, `The project ${p.name} has no git repo set.`);
    if (name === p.defaultBranch) throw new DeployError(422, `${name} is the project's main branch, so it can't be the deploy tag.`);
    const runner = await tagRunner(companyId);
    if ("problem" in runner) throw new DeployError(409, `${runner.problem} It has to check the tag name against the repo's branches before the setting can be saved.`);
    let r: ResolveResult;
    try {
      r = await deps.runners!.request<ResolveResult>(runner.id, (requestId) => ({ type: "workspace.resolve", requestId, projectId: p.id, repoUrl: p.repoUrl!, ref: p.defaultBranch, baseRef: p.defaultBranch }), RESOLVE_TIMEOUT_MS);
    } catch (err) {
      throw new DeployError(409, `The runner couldn't read the repo's branches: ${(err as Error).message}`);
    }
    if (r.branches.includes(name)) throw new DeployError(422, `${name} is also a branch in ${p.name}'s repo. Pick a tag name that isn't a branch.`);
    return { projectId: p.id, name };
  }

  async function rulesWith(companyId: string, rules: TargetRules, patch: Pick<Partial<TargetInput>, "requiresApproval" | "liveTag">): Promise<TargetRules> {
    const next: TargetRules = { ...rules };
    if (patch.requiresApproval != null) next.requiresApproval = patch.requiresApproval;
    if (patch.liveTag === null) delete next.liveTag;
    else if (patch.liveTag) {
      const same = rules.liveTag && rules.liveTag.projectId === patch.liveTag.projectId && rules.liveTag.name === patch.liveTag.name.trim();
      next.liveTag = same ? rules.liveTag! : await checkLiveTag(companyId, patch.liveTag);
    }
    return next;
  }

  /**
   * The commit a deploy's ref names (DR-033), read by the runner after a fetch. For a target with a deploy tag
   * it also decides whether the tag will follow the deploy: only a commit on the project's base branch may.
   * Never throws: a ref it can't resolve leaves the deploy as it was, with the reason on the tag result.
   */
  async function resolveFor(t: Target, ref: string, ticketProjectId: string | null): Promise<{ commit: string | null; tagName: string | null; tagResult: string | null }> {
    const lt = liveTagOf(t);
    const skip = (why: string) => (lt ? { tagName: lt.name, tagResult: `skipped: ${why}` } : { tagName: null, tagResult: null });
    const projectId = lt?.projectId ?? ticketProjectId;
    if (!projectId) return { commit: null, ...skip("the deploy names no project") };
    if (!DEPLOY_REF.test(ref)) return { commit: null, ...skip(`${ref} isn't a git branch, tag or commit`) };
    const [p] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, t.companyId)));
    if (!p?.repoUrl) return { commit: null, ...skip("the project has no git repo") };
    const runner = await tagRunner(t.companyId);
    if ("problem" in runner) return { commit: null, ...skip(`couldn't read the commit: ${runner.problem}`) };
    try {
      const r = await deps.runners!.request<ResolveResult>(runner.id, (requestId) => ({ type: "workspace.resolve", requestId, projectId: p.id, repoUrl: p.repoUrl!, ref, baseRef: p.defaultBranch }), RESOLVE_TIMEOUT_MS);
      if (!r.commit) return { commit: null, ...skip(r.error ?? `${ref} doesn't name a commit`) };
      if (!lt) return { commit: r.commit, tagName: null, tagResult: null };
      if (!r.onBase) return { commit: r.commit, ...skip(`${short(r.commit)} isn't on ${p.defaultBranch}`) };
      return { commit: r.commit, tagName: lt.name, tagResult: null };
    } catch (err) {
      return { commit: null, ...skip(`couldn't read the commit: ${(err as Error).message}`) };
    }
  }

  async function startWhenApproved(d: Deploy, t: Target, causedByRunId?: string | null) {
    const [row] = await db.update(deploys).set({ status: "approved" }).where(eq(deploys.id, d.id)).returning();
    if (d.agentId && wake) {
      const tag = d.tagName && !d.tagResult ? ` Boss Man moves the tag ${d.tagName} to ${short(d.commit)} once you report success: don't push tags yourself.` : "";
      await wake({
        agentId: d.agentId,
        ticketId: d.ticketId,
        reason: "deploy approved",
        priority: 3,
        deployId: d.id,
        causedByRunId,
        note: `Deploy ${d.id} is approved: ship ${d.ref}${d.commit ? ` (commit ${d.commit})` : ""} to ${t.name} (${t.kind} ${t.endpoint}). This run has the target's secrets in its environment, and only this run. When you've finished, report the result with the deploy tool (action "report", outcome succeeded or failed).${tag}`,
      });
    }
    return row!;
  }

  // ---------- The tag job (DR-033) ----------

  /** One tag job at a time per target, in the order the reports came in. */
  // shortcut: the queue lives in this process; lost on restart, harmless because the deploy row stays
  // tag_result "pending" and resumeTags re-queues it at startup (the job re-checks the row first).
  const chains = new Map<string, Promise<unknown>>();
  const inFlight = new Set<string>();

  async function finishTag(d: Deploy, t: Target, r: { result: string; from?: string | null; to?: string | null; error?: string }) {
    const at = now();
    const tagResult = r.result === "moved" || r.result === "unchanged" ? r.result : `${r.result === "skipped" ? "skipped" : "failed"}: ${(r.error ?? "unknown error").slice(0, 1000)}`;
    await db
      .update(deploys)
      .set({ tagFrom: r.from ?? null, tagTo: r.result === "moved" || r.result === "unchanged" ? (r.to ?? d.commit) : null, tagAt: at, tagResult })
      .where(eq(deploys.id, d.id));
    const name = d.tagName ?? "the deploy tag";
    const summary =
      r.result === "moved"
        ? `Moved ${name} ${short(r.from)} → ${short(r.to)} after deploy ${d.id}`
        : r.result === "unchanged"
          ? `${name} already pointed at ${short(r.to)} after deploy ${d.id}`
          : `Tag ${name} not moved after deploy ${d.id} to ${t.name}: ${r.error ?? "unknown error"}`;
    await record(db, { companyId: d.companyId, ticketId: d.ticketId, kind: "deploy_tag", summary, detail: { deployId: d.id, tag: d.tagName, from: r.from ?? null, to: r.to ?? null, result: tagResult }, at });
    if (r.result !== "moved" && r.result !== "unchanged" && r.result !== "skipped") {
      await deps
        .alert?.({
          companyId: d.companyId,
          ticketId: d.ticketId,
          kind: "deploy_tag",
          from: "ceo",
          why: "only the CEO or the owner can fix the git host's settings",
          dedupeKey: `deploy-tag:${d.id}`,
          question: `Deploy ${d.id} of ${d.ref} to ${t.name} succeeded and stays succeeded, but Boss Man couldn't move the tag ${name} to ${short(d.commit)}. The git host said: ${(r.error ?? "unknown error").slice(0, 1500)}. This is usually the git host's tag protection or the git token's permissions; see the per-host notes on the deploy target's tag setting.`,
        })
        .catch((err) => log(`Couldn't raise the deploy tag alert for ${d.id}: ${(err as Error).message}`));
    }
  }

  async function runTag(deployId: string) {
    const d = await load(deployId);
    if (d.tagResult !== "pending" || !d.tagName || !d.commit) return;
    const t = await target(d.targetId);
    const lt = liveTagOf(t);
    if (!lt || lt.name !== d.tagName) return finishTag(d, t, { result: "skipped", error: "the target's tag setting changed after the deploy was asked for" });
    const [p] = await db.select().from(projects).where(eq(projects.id, lt.projectId));
    if (!p?.repoUrl) return finishTag(d, t, { result: "failed", error: "the project has no git repo" });
    const runnerId = await companyRunner(d.companyId);
    if (!runnerId || !deps.runners) return finishTag(d, t, { result: "failed", error: "the company has no runner" });
    const hub = deps.runners;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!hub.isConnected(runnerId)) {
        if (!(await hub.waitConnected(runnerId, deps.tagRunnerAlertMs ?? TAG_RUNNER_ALERT_MS))) {
          await deps
            .alert?.({
              companyId: d.companyId,
              ticketId: d.ticketId,
              kind: "deploy_tag",
              from: "ceo",
              dedupeKey: `deploy-tag-offline:${d.id}`,
              clearWhen: [{ kind: "runnerConnected", companyId: d.companyId }],
              question: `The tag ${d.tagName} hasn't been moved to ${short(d.commit)} yet after deploy ${d.id} to ${t.name}: the company's runner has been offline for 30 minutes. The deploy itself stands; the tag moves once the runner is back.`,
            })
            .catch((err) => log(`Couldn't raise the deploy tag offline alert for ${d.id}: ${(err as Error).message}`));
          if (!(await hub.waitConnected(runnerId, deps.tagRunnerGiveUpMs ?? TAG_RUNNER_GIVE_UP_MS))) return finishTag(d, t, { result: "failed", error: "the company's runner stayed offline" });
        }
      }
      if (!hub.can(runnerId, "deploy-tag")) return finishTag(d, t, { result: "failed", error: UPDATE_RUNNER });
      try {
        const r = await hub.request<TagResult>(runnerId, (requestId) => ({ type: "workspace.tag", requestId, projectId: p.id, repoUrl: p.repoUrl!, name: d.tagName!, commit: d.commit!, baseRef: p.defaultBranch }), TAG_TIMEOUT_MS);
        return finishTag(d, t, { result: r.result === "refused" ? "failed" : r.result, from: r.from, to: r.to, error: r.error });
      } catch (err) {
        // The runner went away mid-request: wait for it and ask again. Any other error is the answer.
        if (hub.isConnected(runnerId) || attempt === 2) return finishTag(d, t, { result: "failed", error: (err as Error).message });
      }
    }
  }

  function queueTag(deployId: string, targetId: string): Promise<unknown> {
    if (inFlight.has(deployId)) return chains.get(targetId) ?? Promise.resolve();
    inFlight.add(deployId);
    const next = (chains.get(targetId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => runTag(deployId))
      .catch((err) => log(`The deploy tag job for ${deployId} failed: ${(err as Error).message}`))
      .finally(() => inFlight.delete(deployId));
    chains.set(targetId, next);
    return next;
  }

  // ---------- The host's staging lane (BOS-1472) ----------

  /**
   * A request for the host deployer's staging lane. Not production, so no approval; and no run holds secrets, because the
   * host does the work: the request file is written, the deploy row is "running", and sync (below) records the host's answer
   * and wakes the requester. Staging takes merged commits only; the host checks that again.
   */
  async function requestHostStaging(actor: { companyId: string; agentId: string | null }, t: Target, input: { ref: string; notes?: string; ticketId?: string }, commit: string | null) {
    const lane = deps.staging;
    if (!lane || !(await lane.on())) throw new DeployError(409, "Staging isn't set up on this host yet (the host deployer's staging lane is off). The owner's one-time setup is in docs/22-staging.md. Don't wait for it: say 'not checked' and check live.");
    if (!commit) throw new DeployError(422, `Couldn't read the commit that ${input.ref} names, so it can't go to staging. Name a merged commit or main.`);
    // One writer at a time (staging-lock.ts): the check and the request-file write must not interleave with another request.
    const d = await withStagingLock(async () => {
      const busy = await db
        .select({ id: deploys.id })
        .from(deploys)
        .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
        .where(and(eq(deploys.status, "running"), sql`${deployTargets.rules}->>'hostStaging' = 'true'`))
        .limit(1);
      if (busy.length || (await lane.pending())) throw new DeployError(409, "A staging deploy is already queued or running. Staging does one at a time; ask again when you're woken with its result.");
      const [row0] = await db
        .insert(deploys)
        .values({ companyId: actor.companyId, targetId: t.id, agentId: actor.agentId, ticketId: input.ticketId ?? null, ref: input.ref, notes: input.notes ?? null, status: "running", createdAt: now(), commit })
        .returning();
      try {
        await lane.submit(row0!.id, commit, "agent-request");
      } catch (err) {
        const [row] = await db.update(deploys).set({ status: "failed", outcome: `Couldn't hand the request to the host: ${(err as Error).message}`, finishedAt: now() }).where(eq(deploys.id, row0!.id)).returning();
        throw new DeployError(502, row!.outcome!);
      }
      return row0;
    });
    return { deploy: d!, note: `Sent to the host's staging lane for ${short(commit)} (main commits only). No approval is needed and no secrets are involved. You'll be woken with the result and each smoke check; don't wait in this turn.` };
  }

  /** The smoke checks in a staging status, in a line: "address pass; signin skipped (not set up); ...". */
  function checksLine(st: NonNullable<Awaited<ReturnType<StagingLane["status"]>>>): string {
    const names = Object.keys(st).filter((k) => k.startsWith("check_")).map((k) => k.slice(6));
    return names.map((n) => `${n} ${st[`check_${n}`]}${st[`check_${n}`] !== "pass" && st[`why_${n}`] ? ` (${st[`why_${n}`]})` : ""}`).join("; ");
  }

  /**
   * One pass: records the host's answer for the staging deploy that is running, and wakes whoever asked. Only a request
   * this server wrote (its id is a deploy row) is matched; an answer for anything else (the Settings button) is ignored here.
   * A deploy the host never answers is failed after a few hours, so it can't stay "running" for ever.
   */
  async function syncHostStaging() {
    const lane = deps.staging;
    if (!lane) return 0;
    const running = await db
      .select({ d: deploys, t: deployTargets })
      .from(deploys)
      .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
      .where(and(eq(deploys.status, "running"), sql`${deployTargets.rules}->>'hostStaging' = 'true'`));
    if (!running.length) return 0;
    const st = await lane.status();
    let done = 0;
    for (const { d, t } of running) {
      let outcome: string | null = null;
      let ok = false;
      if (st && st.id === d.id && (st.result === "deployed" || st.result === "failed" || st.result === "rejected")) {
        ok = st.result === "deployed" && st.smoke !== "failed";
        const checks = checksLine(st);
        outcome = `${st.message}${st.result === "deployed" ? ` Smoke checks: ${st.smoke ?? "not run"}${checks ? ` (${checks})` : ""}.` : ""}${st.runner_image ? ` Runner image ${st.runner_image}.` : ""}`.slice(0, 4000);
      } else if (now().getTime() - d.createdAt.getTime() > STAGING_GIVE_UP_MS && !(await lane.pending()) && (!st || st.id !== d.id)) {
        outcome = "The host never answered this staging request (the staging lane may have been switched off or the host deployer isn't running).";
      } else if (st && st.id === d.id && st.result === "running" && now().getTime() - Date.parse(st.at ?? "") > STAGING_RUNNING_STALE_MS) {
        // The host marks a cut-off run failed itself when it restarts; this is the backstop if that never happens
        // (the deployer is off for good), so a "running" that outlived the host's own 30-minute limit can't wedge the lane.
        outcome = "The staging deploy has said \"running\" for far longer than the host allows, so it was cut off (the host restarted or the deployer stopped). Check what staging runs, then ask again.";
      }
      if (outcome === null) continue;
      const [row] = await db.update(deploys).set({ status: ok ? "succeeded" : "failed", outcome, finishedAt: now() }).where(and(eq(deploys.id, d.id), eq(deploys.status, "running"))).returning();
      if (!row) continue;
      done++;
      if (d.agentId && wake) {
        await wake({ agentId: d.agentId, ticketId: d.ticketId, reason: "staging deploy finished", priority: 3, deployId: d.id, note: `Staging deploy ${d.id} of ${short(d.commit)} to ${t.name} ${ok ? "passed" : "did not pass"}. ${outcome}` });
      }
    }
    return done;
  }

  /** A deploy that didn't succeed leaves the tag alone; say why on the record. */
  const skipTagUpdate = (reason: string) => ({ tagResult: `skipped: ${reason}` });

  return {
    setWakeHook(hook: WakeHook) {
      wake = hook;
    },

    syncHostStaging,

    /**
     * The poller's pass (main.ts): offers the staging target only to a company with a project that is the repository the host's
     * staging checkout follows (never to another company, whatever its project is, so a fork can't use the lane) and takes it
     * away from any other company, then records the host's answer.
     */
    async syncStaging() {
      if (!deps.staging) return;
      const origin = (await deps.staging.origin()) ?? null;
      const rows = await db.select({ companyId: projects.companyId, repoUrl: projects.repoUrl }).from(projects).where(and(isNotNull(projects.repoUrl), isNull(projects.archivedAt)));
      const own = [...new Set(rows.filter((r) => sameRepo(r.repoUrl, origin)).map((r) => r.companyId))];
      await this.ensureHostStagingTargets(own);
      // An unreadable origin (one bad tick of the host's git call) must not look like "nobody owns it": that would delete every
      // staging target, and deploys.targetId cascades, so every deploy row would go with them (BOS-1796).
      if (origin && (await deps.staging.on())) {
        const stale = await db.select({ id: deployTargets.id, companyId: deployTargets.companyId }).from(deployTargets).where(sql`${deployTargets.rules}->>'hostStaging' = 'true'`);
        for (const t of stale) {
          if (own.includes(t.companyId)) continue;
          // A target with a deploy still running keeps its row (and the deploy's history) until the deploy is recorded.
          const live = await db.select({ id: deploys.id }).from(deploys).where(and(eq(deploys.targetId, t.id), eq(deploys.status, "running"))).limit(1);
          if (live.length) continue;
          await db.delete(deployTargets).where(eq(deployTargets.id, t.id));
        }
      }
      await syncHostStaging();
    },

    /**
     * BOS-1472: lists a non-production "staging" target, backed by the host's staging lane, for each of `companyIds` (the caller
     * passes only companies that own the repository staging follows), once the host says the lane is on. It is not offered while
     * the lane is off, and it never replaces a target the owner already made with that name. Returns how many it added.
     */
    async ensureHostStagingTargets(companyIds: string[]) {
      if (!deps.staging || !(await deps.staging.on())) return 0;
      let added = 0;
      for (const companyId of companyIds) {
        const existing = await db.select({ id: deployTargets.id }).from(deployTargets).where(and(eq(deployTargets.companyId, companyId), sql`lower(${deployTargets.name}) = ${HOST_STAGING_NAME}`));
        if (existing.length) continue;
        await db.insert(deployTargets).values({ companyId, name: HOST_STAGING_NAME, kind: "docker", endpoint: HOST_STAGING_ENDPOINT, isProduction: false, rules: { hostStaging: true } satisfies TargetRules });
        added++;
      }
      return added;
    },

    async createTarget(companyId: string, input: TargetInput) {
      const problem = endpointProblem(input.kind, input.endpoint);
      if (problem) throw new DeployError(422, problem);
      const rules = await rulesWith(companyId, {}, { requiresApproval: input.requiresApproval ?? false, liveTag: input.liveTag });
      const [t] = await db
        .insert(deployTargets)
        .values({ companyId, name: input.name, kind: input.kind, endpoint: input.endpoint.trim(), isProduction: input.isProduction ?? false, rules })
        .returning();
      // BOS-2100: the owner can see when a target appeared. Name only; the endpoint can hold a user name, so it stays out.
      await record(db, { companyId, kind: "settings", summary: `Owner added deploy target ${t!.name}` });
      return t!;
    },

    async updateTarget(id: string, patch: Partial<TargetInput>) {
      const t = await target(id);
      const kind = patch.kind ?? t.kind;
      const endpoint = patch.endpoint ?? t.endpoint;
      const problem = endpointProblem(kind, endpoint);
      if (problem) throw new DeployError(422, problem);
      const rules = await rulesWith(t.companyId, t.rules as TargetRules, patch);
      const [row] = await db
        .update(deployTargets)
        .set({
          ...(patch.name ? { name: patch.name } : {}),
          kind,
          endpoint: endpoint.trim(),
          ...(patch.isProduction != null ? { isProduction: patch.isProduction } : {}),
          rules,
        })
        .where(eq(deployTargets.id, id))
        .returning();
      // BOS-2100: name each of the three settings that really changed. Values are never written, only the fact (an
      // endpoint can carry a user name); the target's secrets are not part of this row.
      const approval = (r: unknown) => !!(r as TargetRules | null)?.requiresApproval;
      const changed: string[] = [];
      if (row!.isProduction !== t.isProduction) changed.push(`production turned ${row!.isProduction ? "on" : "off"}`);
      if (approval(row!.rules) !== approval(t.rules)) changed.push(`approval needed turned ${approval(row!.rules) ? "on" : "off"}`);
      if (row!.endpoint !== t.endpoint) changed.push("endpoint changed");
      if (row!.name !== t.name) changed.push(`renamed (was ${t.name})`);
      if (changed.length) await record(db, { companyId: t.companyId, kind: "settings", summary: `Owner changed deploy target ${row!.name}: ${changed.join(", ")}` });
      return row!;
    },

    async deleteTarget(id: string) {
      const rows = await db.delete(deployTargets).where(eq(deployTargets.id, id)).returning({ id: deployTargets.id, companyId: deployTargets.companyId, name: deployTargets.name });
      if (rows[0]) await record(db, { companyId: rows[0].companyId, kind: "settings", summary: `Owner removed deploy target ${rows[0].name}` });
      return rows.length > 0;
    },

    async listTargets(companyId: string) {
      return db.select().from(deployTargets).where(eq(deployTargets.companyId, companyId)).orderBy(asc(deployTargets.name));
    },

    /** Each target's last successful deploy (DR-033): what is live there, for agents and the owner's screen. */
    async lastSucceeded(companyId: string): Promise<Map<string, Deploy>> {
      const rows = await db
        .select()
        .from(deploys)
        .where(and(eq(deploys.companyId, companyId), eq(deploys.status, "succeeded")))
        .orderBy(desc(deploys.finishedAt));
      const last = new Map<string, Deploy>();
      for (const r of rows) if (!last.has(r.targetId)) last.set(r.targetId, r);
      return last;
    },

    /** An agent asks to ship a ref. Production (or a target that asks for it) waits for the owner (R15). */
    async request(actor: { companyId: string; agentId: string | null; runId?: string | null }, input: { target: string; ref: string; notes?: string; ticketId?: string }) {
      const all = await db.select().from(deployTargets).where(eq(deployTargets.companyId, actor.companyId));
      const t = all.find((x) => x.id === input.target || x.name.toLowerCase() === input.target.toLowerCase());
      if (!t) throw new DeployError(404, all.length ? `No deploy target called "${input.target}". Targets: ${all.map((x) => x.name).join(", ")}.` : "Your company has no deploy targets; ask the owner to add one.");
      const cred = findCredential(`${input.ref} ${input.notes ?? ""}`);
      if (cred) throw new DeployError(422, `That looks like it contains ${cred}. Deploy requests never carry credentials.`);
      let ticketProjectId: string | null = null;
      if (input.ticketId) {
        const [tk] = await db.select({ id: tickets.id, risk: tickets.risk, projectId: tickets.projectId }).from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, actor.companyId)));
        if (!tk) throw new DeployError(422, "No ticket with that ID in your company.");
        ticketProjectId = tk.projectId;
        // High and critical work goes to staging first (R48): the same ref must have deployed
        // successfully to a non-production target for this ticket.
        if (t.isProduction && stagingFirst(tk.risk)) {
          const staged = await db
            .select({ id: deploys.id })
            .from(deploys)
            .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
            .where(and(eq(deploys.ticketId, tk.id), eq(deploys.ref, input.ref), eq(deploys.status, "succeeded"), eq(deployTargets.isProduction, false)));
          if (!staged.length) {
            const stagingTargets = all.filter((x) => !x.isProduction).map((x) => x.name);
            throw new DeployError(
              409,
              `This ticket is rated ${riskOf(tk.risk)} risk, so ${input.ref} has to deploy to staging first.${stagingTargets.length ? ` Deploy it to ${stagingTargets.join(" or ")}, then ask for production again.` : " Your company has no staging target yet; ask the owner to add one."}`,
            );
          }
        }
      }
      // The commit is fixed now (DR-033): the tag goes to what was approved, never to the ref read again later.
      // A staging request with no ticket reads the ref from the company's oldest project that has a repo.
      // Only a project that is the repository the host's staging checkout follows may use the lane: another company's fork can't.
      if ((t.rules as TargetRules).hostStaging === true) {
        const origin = (await deps.staging?.origin()) ?? null;
        const mine = (await db.select({ id: projects.id, repoUrl: projects.repoUrl }).from(projects).where(and(eq(projects.companyId, actor.companyId), isNotNull(projects.repoUrl), isNull(projects.archivedAt))).orderBy(asc(projects.createdAt))).filter((p) => sameRepo(p.repoUrl, origin));
        if (!mine.length || (ticketProjectId && !mine.some((p) => p.id === ticketProjectId))) throw new DeployError(403, "Staging is for the repository this install deploys from, and this ticket's project isn't it.");
        ticketProjectId = ticketProjectId ?? mine[0]!.id;
      }
      const resolved = await resolveFor(t, input.ref, ticketProjectId);
      if ((t.rules as TargetRules).hostStaging === true) return requestHostStaging(actor, t, input, resolved.commit);
      const [d] = await db
        .insert(deploys)
        .values({ companyId: actor.companyId, targetId: t.id, agentId: actor.agentId, ticketId: input.ticketId ?? null, ref: input.ref, notes: input.notes ?? null, createdAt: now(), ...resolved })
        .returning();
      const tagNote = resolved.tagName ? (resolved.tagResult ? ` The tag ${resolved.tagName} won't move: ${resolved.tagResult.replace(/^skipped: /, "")}.` : ` After it succeeds, Boss Man moves the tag ${resolved.tagName} to ${short(resolved.commit)}.`) : "";
      if (!needsApproval(t)) return { deploy: await startWhenApproved(d!, t, actor.runId), note: `Approved; you'll be woken in a run that holds the target's secrets.${tagNote}` };

      const [agent] = actor.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, actor.agentId)) : [];
      const ships = resolved.commit ? ` (ships ${short(resolved.commit)})` : "";
      // BOS-1516: a deploy that carries the owner's Priority 1 work, once its whole group has merged, is headed "Ready to put live"
      // and paged once (the same urgent path as a live fix; a later card for the same ticket is a plain ask).
      const ready = input.ticketId ? await readyUrgentFor(db, input.ticketId) : undefined;
      await db.insert(decisions).values({
        companyId: actor.companyId,
        kind: "approval",
        question: `${ready ? `${ready.heading}.\n\n` : ""}${agent?.name ?? "An agent"} wants to deploy ${input.ref}${ships} to ${t.name}${t.isProduction ? " (production)" : ""}.${input.notes ? ` Notes: ${input.notes}` : ""}${tagNote}`,
        options: ["Approve", "Reject"],
        recommendedOption: "Approve",
        raisedByAgentId: actor.agentId,
        tier: "owner",
        context: { type: "deploy", deployId: d!.id, ...(resolved.commit ? { commit: resolved.commit } : {}), ...(ready ? { urgent: ready } : {}) },
      });
      return { deploy: d!, note: `Waiting for the owner to approve. You'll be woken with the answer; don't wait in this turn.${tagNote}` };
    },

    /** The owner's answer to a deploy approval. */
    async approve(id: string, approved: boolean) {
      const d = await load(id);
      if (d.status !== "pending_approval") return d;
      const t = await target(d.targetId);
      if (approved) {
        const row = await startWhenApproved(d, t);
        if (d.ticketId) await ownerActed(db, { companyId: d.companyId, ticketIds: [d.ticketId], reason: `the owner approved deploying ${d.ref} to ${t.name}`, wake, now: now() });
        return row;
      }
      const [row] = await db
        .update(deploys)
        .set({ status: "rejected", finishedAt: now(), ...(d.tagName && !d.tagResult ? skipTagUpdate("the deploy was rejected") : {}) })
        .where(eq(deploys.id, id))
        .returning();
      if (d.agentId && wake) await wake({ agentId: d.agentId, ticketId: d.ticketId, reason: "deploy rejected", note: `The owner rejected deploying ${d.ref} to ${t.name}. Don't deploy it; raise a decision if you need another way forward.` });
      if (d.ticketId) await ownerActed(db, { companyId: d.companyId, ticketIds: [d.ticketId], reason: `the owner rejected deploying ${d.ref} to ${t.name}`, wake, now: now() });
      return row!;
    },

    /** Called by the scheduler before it starts the run, so the run's first secrets fetch includes the target. */
    async bindRun(deployId: string, runId: string) {
      await db.update(deploys).set({ status: "running", runId }).where(and(eq(deploys.id, deployId), eq(deploys.status, "approved")));
    },

    async unbindRun(deployId: string) {
      await db.update(deploys).set({ status: "approved", runId: null }).where(and(eq(deploys.id, deployId), eq(deploys.status, "running")));
    },

    /**
     * The run carrying out the deploy reports how it went; its secrets stop with it. A success on a target
     * with a deploy tag queues the tag move (DR-033), which never changes the deploy's own result.
     */
    async report(actor: { companyId: string; runId?: string | null }, input: { deployId: string; outcome: "succeeded" | "failed"; notes?: string }) {
      const d = await load(input.deployId);
      if (d.companyId !== actor.companyId) throw new DeployError(404, "No such deploy.");
      if (d.status !== "running") throw new DeployError(409, `That deploy is ${d.status.replace("_", " ")}, not running.`);
      if (actor.runId && d.runId !== actor.runId) throw new DeployError(403, "Only the run carrying out the deploy can report it.");
      const tagWaiting = !!d.tagName && !!d.commit && !d.tagResult;
      const tag = d.tagName && !d.tagResult ? (input.outcome === "succeeded" && tagWaiting ? { tagResult: "pending" } : skipTagUpdate("the deploy failed")) : {};
      const [row] = await db
        .update(deploys)
        .set({ status: input.outcome, outcome: input.notes ?? null, finishedAt: now(), ...tag })
        .where(eq(deploys.id, d.id))
        .returning();
      if (row!.tagResult === "pending") void queueTag(d.id, d.targetId);
      if (input.outcome === "succeeded" && d.ticketId) await deps.onShipped?.(d.ticketId);
      if (d.ticketId && input.outcome === "succeeded") await ownerActed(db, { companyId: d.companyId, ticketIds: [d.ticketId], reason: `the deploy of ${d.ref} went live`, wake, now: now() });
      return row!;
    },

    /** A run that ends without reporting leaves the deploy failed, which also ends its access to secrets. */
    async onRunEnded(runId: string) {
      const ended = await db
        .update(deploys)
        .set({ status: "failed", outcome: "The run ended without reporting a result.", finishedAt: now() })
        .where(and(eq(deploys.runId, runId), eq(deploys.status, "running")))
        .returning({ id: deploys.id, tagName: deploys.tagName, tagResult: deploys.tagResult });
      for (const d of ended) if (d.tagName && !d.tagResult) await db.update(deploys).set(skipTagUpdate("the deploy failed")).where(eq(deploys.id, d.id));
    },

    /**
     * Picks up tag moves a restart cut off (DR-033): every succeeded deploy still marked pending that this
     * server isn't already working on. Safe to run often: the runner's lease makes a repeat push a no-op.
     */
    async resumeTags() {
      const pending = await db
        .select({ id: deploys.id, targetId: deploys.targetId })
        .from(deploys)
        .where(and(eq(deploys.status, "succeeded"), eq(deploys.tagResult, "pending")))
        .orderBy(asc(deploys.finishedAt));
      for (const p of pending) if (!inFlight.has(p.id)) void queueTag(p.id, p.targetId);
      return pending.length;
    },

    /** The tag job for one deploy, awaited (tests and the resume sweep). */
    waitForTag(deployId: string, targetId: string) {
      return inFlight.has(deployId) ? (chains.get(targetId) ?? Promise.resolve()) : Promise.resolve();
    },

    async list(companyId?: string) {
      return db
        .select({ deploy: deploys, target: deployTargets.name, isProduction: deployTargets.isProduction })
        .from(deploys)
        .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
        .where(companyId ? eq(deploys.companyId, companyId) : undefined)
        .orderBy(asc(deploys.createdAt));
    },
  };
}
