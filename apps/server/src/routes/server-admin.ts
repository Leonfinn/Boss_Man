// Server and host admin routes: scheduling and kill switches, the runner update hold, self-deploy and
// restart, and deploy targets. Owner routes: app.ts registers these inside its owner scope, so the
// owner check and error handling are the same as for its other routes.
import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { RUNNER_ADDONS } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies } from "../db/schema.js";
import { record } from "../services/activity.js";
import { DeployError, type deploysService } from "../services/deploys.js";
import type { launcherService } from "../services/launcher.js";
import type { maintenanceService } from "../services/maintenance.js";
import type { runnerReportService } from "../services/runner-report.js";
import type { schedulerService } from "../services/scheduler.js";
import type { deployWaitService } from "../services/deploy-wait.js";
import type { selfDeployService } from "../services/self-deploy.js";
import type { ActiveWait } from "../services/update-waits.js";

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

export function serverAdminRoutes(
  owner: FastifyInstance,
  deps: {
    db: Db;
    scheduler: ReturnType<typeof schedulerService>;
    maintenance: ReturnType<typeof maintenanceService>;
    runnerReport: ReturnType<typeof runnerReportService>;
    launch: ReturnType<typeof launcherService>;
    selfDeploy: ReturnType<typeof selfDeployService>;
    deployWait: ReturnType<typeof deployWaitService>;
    deploysSvc: ReturnType<typeof deploysService>;
    /** The per-run stop (runsService.cancel). */
    cancelRun: (runId: string) => Promise<unknown>;
    /** BOS-2058: every update wait that is on, from update-waits.ts (the same list server_status shows the CEO). */
    activeWaits: () => Promise<ActiveWait[]>;
  },
) {
  const { db, scheduler, maintenance, runnerReport, launch, selfDeploy, deployWait, deploysSvc, cancelRun, activeWaits } = deps;
  // One list for every screen (rule c): what each update wait waits on, since when, and when it goes ahead or ends.
  owner.get("/api/update-waits", async () => ({ waits: await activeWaits() }));

  // Scheduling and kill switches (R30).
  owner.post("/api/agents/:id/wake", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ ticketId: Uuid.optional(), note: z.string().max(5000).optional(), priority: z.number().int().min(1).max(5).optional() }).parse(req.body ?? {});
    return reply.code(201).send(await scheduler.wake({ agentId: id, reason: "woken by owner", ...b }));
  });
  owner.get("/api/scheduler/queue", async () => scheduler.queue());
  owner.post("/api/scheduler/tick", async () => scheduler.tick());
  // Read by Settings → "Stop all work" and the every-page banner, so a reload shows the real hold (BOS-836).
  owner.get("/api/kill-switch", async () => ({ paused: await scheduler.globallyPaused() }));
  owner.post("/api/kill-switch", async (req) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await scheduler.setGlobalPause(paused);
    return { paused };
  });
  owner.post("/api/companies/:id/pause", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
    if (!company) return reply.code(404).send({ error: "not_found" });
    await scheduler.setCompanyPause(id, paused);
    await record(db, { companyId: id, kind: "settings", summary: paused ? "Owner paused this company" : "Owner resumed this company" });
    return { paused };
  });

  // The runner update hold (docs/09-self-deploy.md, phase 2): the banner's numbers, a manual start, and cancel.
  owner.get("/api/maintenance", async () => maintenance.status());
  // The Settings → Runner update panel: the live state first, then the last update as history (BOS-465).
  owner.get("/api/runner-report", async () => runnerReport.updatePanel());
  owner.post("/api/maintenance/start", async (req, reply) => {
    const { minutes } = z.object({ minutes: z.number().int().min(1).max(1440).optional() }).parse(req.body ?? {});
    if (!launch.enabled) return reply.code(409).send({ error: "no_launcher", message: "Draining needs the launcher (BOSSMAN_LAUNCHER=1); without it runners are restarted by scripts/update-runner.sh --now." });
    await maintenance.start({ minutes }); // leader-only
    return maintenance.status();
  });
  owner.post("/api/maintenance/cancel", async () => ({ cancelled: await maintenance.cancel() })); // leader-only
  // "Ask agents to wrap up" (BOS-929): the owner's clean stop before an update. A mode of the same hold, so it
  // needs no launcher: it swaps nothing, it only messages every live work run and holds new ones until cancelled.
  // While an update waits it joins that hold instead of being refused (BOS-988): the update stays and goes ahead
  // when the runs end; the wrap-up adds the message, the still-running list, and Cancel wrap-up.
  owner.post("/api/maintenance/wrapup", async () => {
    await maintenance.start({ kind: "wrapup" }); // leader-only
    return maintenance.status();
  });
  // "Stop the checks and update now" (BOS-1600): only when checks on a runner are all that is left; they restart afterwards.
  owner.post("/api/maintenance/update-now", async (_req, reply) => {
    const r = await maintenance.updateNow(); // leader-only
    if (r.ok) return maintenance.status();
    const message = r.reason === "agents_running" ? "Agents are still running; ask them to wrap up first." : r.reason === "no_checks" ? "No check is holding the update, so there is nothing to stop." : "No runner update is waiting.";
    return reply.code(409).send({ error: r.reason, message });
  });
  // "Cancel wrap-up" while an update waits (BOS-988): take back only the owner's ask; the update is untouched.
  owner.post("/api/maintenance/cancel-wrap", async () => ({ cancelled: await maintenance.cancelWrap() })); // leader-only

  // "Stop N and carry on with the update" (BOS-1238): the runs shown as still going after the wrap-up deadline. The
  // server fixes the scope (maintenance.stragglers): runs that were told to wrap up and are still going, never others.
  // Each is ended through the same per-run stop as BOS-929's Stop this run; no lane is paused, no ticket moved.
  owner.post("/api/maintenance/stop-stragglers", async (req, reply) => {
    const { runIds } = z.object({ runIds: z.array(Uuid).min(1).max(200) }).parse(req.body ?? {});
    const r = await maintenance.stragglers(runIds);
    if (!r.ok) return reply.code(409).send({ error: r.reason, message: r.reason === "too_early" ? "The wrap-up deadline has not passed yet, so nothing is stopped." : "No wrap-up is waiting, so there is nothing to stop." });
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const id of r.ids) {
      try {
        await cancelRun(id);
        stopped.push(id);
      } catch {
        // Ended on its own between the list and the stop, or could not be stopped: either way it is not counted.
        failed.push(id);
      }
    }
    return { stopped: stopped.length, skipped: r.skipped + failed.length };
  });

  // Self-deploy: what the host deployer last reported, and the "Deploy latest" button.
  owner.get("/api/self-deploy", async () => selfDeploy.overview());
  // The panel's Recent updates (BOS-1238): the newest answered update cards. Owner login only (this is the owner scope).
  owner.get("/api/self-deploy/history", async (req) => {
    const { limit, before } = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5), before: z.string().uuid().optional() }).parse(req.query ?? {});
    return selfDeploy.history(limit, before);
  });
  owner.post("/api/self-deploy/deploy-latest", async (_req, reply) => {
    const r = await selfDeploy.deployLatest();
    return "error" in r ? reply.code(409).send({ error: "nothing_to_deploy", message: r.error }) : r;
  });

  // A server update waiting for a quiet machine (BOS-420): what it waits for, and the owner's cancel.
  // BOS-1472: "Deploy to staging": main's newest commit goes to the host's staging lane. Owner session only; agents use the deploy tool.
  owner.post("/api/self-deploy/deploy-staging", async (_req, reply) => {
    const r = await selfDeploy.deployStaging();
    return "error" in r ? reply.code(409).send({ error: "staging_unavailable", message: r.error }) : r;
  });
  owner.get("/api/self-deploy/wait", async () => deployWait.status());
  owner.post("/api/self-deploy/wait/cancel", async (_req, reply) => {
    const r = await deployWait.cancel(); // leader-only
    return r.tooLate ? reply.code(409).send({ error: "too_late", message: "The machine has already started this update, so it can't be cancelled. The hold lifts when it ends." }) : r;
  });

  owner.post("/api/self-deploy/update-runners",async (_req, reply) => {
    const r = await selfDeploy.updateRunners();
    // BOS-953: during the trial the refusal says when it can work, and carries the time so the panel shows it too.
    return "error" in r
      ? reply.code(409).send({ error: "cannot_update_runners", message: r.error, ...("retryAt" in r && r.retryAt ? { retryAt: r.retryAt } : {}) })
      : r;
  });

  // BOS-1086: take back a queued runner update.
  owner.post("/api/self-deploy/cancel-runner-queue", async () => selfDeploy.cancelRunnerQueue());

  // BOS-1583: the runner add-on tick boxes. GET says what the owner saved and what the last build held; PUT saves the
  // ticked ids for the next "Build and update runners" (the host script reads the file; nothing is rebuilt now).
  owner.get("/api/self-deploy/runner-addons", async () => selfDeploy.runnerAddons());
  owner.put("/api/self-deploy/runner-addons", async (req, reply) => {
    const body = z.object({ ids: z.array(z.string().max(40)).max(50) }).parse(req.body);
    const r = await selfDeploy.setRunnerAddons(body.ids, RUNNER_ADDONS.map((a) => a.id));
    return "error" in r ? reply.code(409).send({ error: "cannot_save_addons", message: r.error }) : r;
  });

  // "Restart the server" (BOS-647): owner session only; it writes a request file the host deployer acts on. No MCP tool reaches it.
  owner.post("/api/self-deploy/restart", async (_req, reply) => {
    const r = await selfDeploy.restartServer();
    return "error" in r ? reply.code(409).send({ error: "cannot_restart", message: r.error }) : r;
  });

  // Deploy targets and deploys (R14, R15).
  const TargetInput = z.object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["ssh", "docker", "git"]),
    endpoint: z.string().trim().min(1).max(500),
    isProduction: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
    /** DR-033: the tag to move after a successful deploy; null turns it off. Owner-only, like every target setting. */
    liveTag: z.object({ projectId: Uuid, name: z.string().trim().min(1).max(100) }).nullable().optional(),
  });
  const deployErrors = (reply: FastifyReply) => (err: unknown) => {
    if (err instanceof DeployError) return reply.code(err.status).send({ error: "deploy", message: err.message });
    throw err;
  };
  owner.get("/api/companies/:id/deploy-targets", async (req) => {
    const { id } = IdParam.parse(req.params);
    const [targets, last] = await Promise.all([deploysSvc.listTargets(id), deploysSvc.lastSucceeded(id)]);
    return targets.map((t) => {
      const d = last.get(t.id);
      return { ...t, lastDeploy: d ? { id: d.id, ref: d.ref, commit: d.commit, at: d.finishedAt, tagName: d.tagName, tagResult: d.tagResult, tagFrom: d.tagFrom, tagTo: d.tagTo } : null };
    });
  });
  owner.post("/api/companies/:id/deploy-targets", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    return deploysSvc
      .createTarget(id, TargetInput.parse(req.body))
      .then((t) => reply.code(201).send(t))
      .catch(deployErrors(reply));
  });
  owner.patch("/api/deploy-targets/:id", async (req, reply) =>
    deploysSvc.updateTarget(IdParam.parse(req.params).id, TargetInput.partial().parse(req.body)).catch(deployErrors(reply)),
  );
  owner.delete("/api/deploy-targets/:id", async (req, reply) => {
    const force = z.object({ force: z.enum(["1", "true"]).optional() }).parse(req.query).force !== undefined;
    const r = await deploysSvc.deleteTarget(IdParam.parse(req.params).id, force);
    if (r.result === "deleted") return reply.code(204).send();
    if (r.result === "live") return reply.code(409).send({ error: "live", message: `${r.detail} Let it finish or reject it in Decisions, then remove the target.` });
    if (r.result === "has_history") return reply.code(409).send({ error: "has_history", field: "has_history", message: `This target has ${r.count} past deploy${r.count === 1 ? "" : "s"}, and removing it would erase ${r.count === 1 ? "it" : "them"} and the target's secret grants.` });
    return reply.code(404).send({ error: "not_found" });
  });
  owner.get("/api/deploys", async (req) => {
    const q = z.object({ companyId: Uuid.optional(), targetId: Uuid.optional(), limit: z.coerce.number().int().min(1).optional(), before: Uuid.optional() }).parse(req.query);
    // No paging parameters: the whole list, as before. Any of them: one newest-first page.
    const paged = q.targetId !== undefined || q.limit !== undefined || q.before !== undefined;
    return deploysSvc.list(q.companyId, paged ? { targetId: q.targetId, limit: q.limit, before: q.before } : undefined);
  });
}
