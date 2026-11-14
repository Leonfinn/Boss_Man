// Server and host admin routes: scheduling and kill switches, the runner update hold, self-deploy and
// restart, and deploy targets. Owner routes: app.ts registers these inside its owner scope, so the
// owner check and error handling are the same as for its other routes.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { DeployError, type deploysService } from "../services/deploys.js";
import type { launcherService } from "../services/launcher.js";
import type { maintenanceService } from "../services/maintenance.js";
import type { runnerReportService } from "../services/runner-report.js";
import type { schedulerService } from "../services/scheduler.js";
import type { deployWaitService } from "../services/deploy-wait.js";
import type { selfDeployService } from "../services/self-deploy.js";

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

export function serverAdminRoutes(
  owner: FastifyInstance,
  deps: {
    scheduler: ReturnType<typeof schedulerService>;
    maintenance: ReturnType<typeof maintenanceService>;
    runnerReport: ReturnType<typeof runnerReportService>;
    launch: ReturnType<typeof launcherService>;
    selfDeploy: ReturnType<typeof selfDeployService>;
    deployWait: ReturnType<typeof deployWaitService>;
    deploysSvc: ReturnType<typeof deploysService>;
  },
) {
  const { scheduler, maintenance, runnerReport, launch, selfDeploy, deployWait, deploysSvc } = deps;

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
  owner.post("/api/companies/:id/pause", async (req) => {
    const { id } = IdParam.parse(req.params);
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await scheduler.setCompanyPause(id, paused);
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
  // "Cancel wrap-up" while an update waits (BOS-988): take back only the owner's ask; the update is untouched.
  owner.post("/api/maintenance/cancel-wrap", async () => ({ cancelled: await maintenance.cancelWrap() })); // leader-only

  // Self-deploy: what the host deployer last reported, and the "Deploy latest" button.
  owner.get("/api/self-deploy", async () => selfDeploy.overview());
  owner.post("/api/self-deploy/deploy-latest", async (_req, reply) => {
    const r = await selfDeploy.deployLatest();
    return "error" in r ? reply.code(409).send({ error: "nothing_to_deploy", message: r.error }) : r;
  });

  // A server update waiting for a quiet machine (BOS-420): what it waits for, and the owner's cancel.
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
  owner.delete("/api/deploy-targets/:id", async (req, reply) => ((await deploysSvc.deleteTarget(IdParam.parse(req.params).id)) ? reply.code(204).send() : reply.code(404).send({ error: "not_found" })));
  owner.get("/api/deploys", async (req) => deploysSvc.list(z.object({ companyId: Uuid.optional() }).parse(req.query).companyId));
}
