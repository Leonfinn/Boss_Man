// Settings and limits (R30, R61, BOS-798, BOS-313, BOS-1029), owner only. Moved out of app.ts unchanged
// (BOS-298 step 15): the risk-tier help, the run and WIP limits, and the check-queue and merged-result settings.
// The caller passes its owner scope, so requireOwner and the app's error handler still apply: this registers
// routes on that instance rather than through app.register, which would add a new scope.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { RISK_TIERS, SENIOR_DEV, riskSummary } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { stagingReachable } from "../mcp-common.js";
import { agents, companies, runners as runnersTable, settings } from "../db/schema.js";
import { DEFAULT_AGENT_WIP_LIMIT, readWipLimits } from "../services/agent-wip.js";
import { checkQueue, DEFAULT_CHECK_SLOTS, MACHINE_TAKES, MAX_CHECK_SLOTS } from "../services/check-queue.js";
import { DEFAULT_BACKGROUND_LANE_AGE_MINUTES, MAX_BACKGROUND_LANE_AGE_MINUTES } from "../services/check-gate.js";
import { agentsAtOnce, CHECK_MEMORY_CEILING_BYTES, limitReason, memoryLine, readRunnerAgents } from "../services/check-limit.js";
import type { checkDispatcher } from "../services/check-dispatcher.js";
import type { mainCiService } from "../services/main-ci.js";
import { MEMORY_MB_MAX, MEMORY_MB_MIN, THREADS_MAX, type CheckWorkersService } from "../services/check-workers.js";
import { runnerImageCommit } from "../services/runner-image.js";
import { WORKER_OFF_CLOSE } from "./check-worker-socket.js";
import type { launcherService } from "../services/launcher.js";
import { getHold, type maintenanceService } from "../services/maintenance.js";
import { MERGE_TURN_MAX_MIN, type reviewService } from "../services/review.js";
import type { runnersService } from "../services/runners.js";
import { DEFAULT_LIMITS, type schedulerService } from "../services/scheduler.js";

const Uuid = z.string().uuid();
/** BOS-1602: what a machine takes and how many of its slots are kept for merges (only with "both"). */
const Policy = z.object({ takes: z.enum(MACHINE_TAKES), mergeKept: z.number().int().min(0).max(MAX_CHECK_SLOTS) });

export function settingsLimitsRoutes(
  owner: FastifyInstance,
  deps: {
    db: Db;
    scheduler: ReturnType<typeof schedulerService>;
    checkQueueSvc: ReturnType<typeof checkQueue>;
    launch: ReturnType<typeof launcherService>;
    maintenance: ReturnType<typeof maintenanceService>;
    checks: ReturnType<typeof checkDispatcher>;
    review: ReturnType<typeof reviewService>;
    runners: ReturnType<typeof runnersService>;
    mainCi: ReturnType<typeof mainCiService>;
    /** BOS-1435: check workers; absent in older test set-ups, then the panel lists none and the worker routes say so. */
    checkWorkers?: CheckWorkersService;
  },
) {
  const { db, scheduler, checkQueueSvc, launch, maintenance, checks, review, runners, mainCi, checkWorkers } = deps;

  /** What each risk tier means, in the server's own words, for the help next to every risk picker (R61). */
  // With ?companyId the reviewer and sign-off come from that company's review policy.
  owner.get("/api/risk-tiers", async (req) => {
    const { companyId } = z.object({ companyId: Uuid.optional() }).parse(req.query);
    // The staging promise is made only for a company with a staging target (BOS-1473).
    if (!companyId) return RISK_TIERS.map((tier) => ({ tier, summary: riskSummary(tier, undefined, undefined, false) }));
    const [c] = await db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, companyId));
    if (!c) return RISK_TIERS.map((tier) => ({ tier, summary: riskSummary(tier, undefined, undefined, false) }));
    const staging = await stagingReachable(db, companyId);
    const names = new Map((await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId))).map((a) => [a.id, a.name]));
    const who = (ref: string | string[]): string => (Array.isArray(ref) ? ref.map((r) => names.get(r) ?? "the CEO").filter((n, i, all) => all.indexOf(n) === i).join(" or ") : ref === "ceo" ? "the CEO" : ref === SENIOR_DEV ? "the Senior Developer (the CEO until one is hired)" : (names.get(ref) ?? "the CEO"));
    return RISK_TIERS.map((tier) => ({ tier, summary: riskSummary(tier, c.policy[tier].ownerSignoff, who(c.policy[tier].reviewer), staging) }));
  });

  // Run limits: how many agents may work at once (instance-wide and per company); per-agent stays fixed at 1.
  // Infinite-mode agents have their own "background" slots instead (BOS-279), so slow free runs never take a normal one.
  const runLimits = async () => {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "run_limits"));
    const v = row?.value as { instance?: number; company?: number; background?: number } | undefined;
    return {
      instance: v?.instance ?? scheduler.limits.instance,
      company: v?.company ?? scheduler.limits.company,
      background: v?.background ?? scheduler.limits.background,
      defaults: { instance: DEFAULT_LIMITS.instance, company: DEFAULT_LIMITS.company, background: DEFAULT_LIMITS.background },
      // BOS-1634: the numbers the scheduler really uses (all companies, background) and whether new merge checks are paused,
      // each differing from the saved one only with a reason (a server update's hold).
      inForce: await scheduler.limitsInForce(),
    };
  };
  owner.get("/api/run-limits", async () => runLimits());
  owner.put("/api/run-limits", async (req) => {
    const value = z
      .object({ instance: z.number().int().min(1).max(32), company: z.number().int().min(1).max(16), background: z.number().int().min(0).max(16).optional() })
      .refine((b) => b.company <= b.instance, { message: "The company limit can't be higher than the all-companies limit." })
      .parse(req.body);
    // A saved value without background (an older save) keeps whatever is stored, so this write never resets it to the default.
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "run_limits"));
    const before = row?.value as { instance?: number; company?: number; background?: number } | undefined;
    const merged = { instance: value.instance, company: value.company, background: value.background ?? before?.background ?? DEFAULT_LIMITS.background };
    await db.insert(settings).values({ key: "run_limits", value: merged }).onConflictDoUpdate({ target: settings.key, set: { value: merged } });
    // BOS-1498: the agents number sizes the runners' memory, so a change reaches them the way Checks at once does (BOS-993):
    // the launcher is told, and the runners that would change are recreated through the settings drain as each company goes idle.
    if (launch.enabled && agentsAtOnce(merged) !== agentsAtOnce({ instance: before?.instance ?? scheduler.limits.instance, company: before?.company ?? scheduler.limits.company, background: before?.background ?? scheduler.limits.background })) await pushToRunners();
    return runLimits();
  });
  /** Tells the launcher both settings and starts the settings drain when a runner would change. Never fails the save. */
  const pushToRunners = async (): Promise<boolean> => {
    try {
      await launch.setChecks(await checkQueueSvc.slots(), await readRunnerAgents(db, scheduler.limits));
      const lc = await launch.checks();
      if (lc?.runners.some((r) => r.slots !== lc.slots || r.memoryBytes !== lc.memoryBytes)) {
        await maintenance.start({ kind: "settings" }); // leader-only
        return true;
      }
    } catch (e) {
      owner.log.error(`runner settings: could not apply to the runners: ${(e as Error).message}`);
    }
    return false;
  };
  // Tickets in progress per agent, and (optionally) in the whole company (BOS-1029). null is "No limit".
  owner.get("/api/wip-limits", async () => ({ ...(await readWipLimits(db)), defaultAgent: DEFAULT_AGENT_WIP_LIMIT }));
  owner.put("/api/wip-limits", async (req) => {
    const value = z.object({ agent: z.number().int().min(1).max(50).nullable(), company: z.number().int().min(1).max(1000).nullable() }).parse(req.body);
    await db.insert(settings).values({ key: "wip_limits", value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    return { ...value, defaultAgent: DEFAULT_AGENT_WIP_LIMIT };
  });
  // BOS-798: Settings → Server and runner → Checks. The owner's switch for the server-owned check queue (DR-003) and its slots.
  // Owner only: no agent tool or route writes these settings.
  const checkQueueView = async () => {
    const rows = await db.select({ id: runnersTable.id, company: companies.name }).from(runnersTable).innerJoin(companies, eq(companies.id, runnersTable.companyId));
    const live = rows.filter((r) => runners.isConnected(r.id));
    const slots = await checkQueueSvc.slots();
    // BOS-993: the limit a runner really gets (the launcher works it out from the setting, .env bounds and host memory) and whether runners already have it.
    const lc = await launch.checks();
    const hold = await getHold(db);
    const runner = lc
      ? {
          slots: lc.slots,
          memoryBytes: lc.memoryBytes,
          perCheckBytes: CHECK_MEMORY_CEILING_BYTES,
          // A lower limit always carries a reason (BOS-1152), also while the launcher has not yet been sent the setting.
          reason: limitReason(slots, lc),
          // BOS-1498: what a runner is given and why, in one line.
          memoryLine: memoryLine(lc),
          // Every runner is sized on its own from the whole host's memory, so with more than one the panel warns (BOS-993).
          runnerCount: lc.runners.length,
          pending: lc.runners.filter((r) => r.slots !== lc.slots || r.memoryBytes !== lc.memoryBytes).length,
          applying: hold?.kind === "settings",
        }
      : null;
    // BOS-1471: what the runners said they run at once (hello). The server hands out at most the smaller of that and the setting,
    // so the number that really applies is the least over the connected runners that reported one.
    const reported = live.map((r) => checks.runnerSlots(r.id)).filter((n): n is number => typeof n === "number");
    const effectiveSlots = reported.length ? Math.min(slots, ...reported) : slots;
    return {
      mode: await checkQueueSvc.mode(),
      slots,
      effectiveSlots,
      runnerSlotsReported: reported.length ? Math.min(...reported) : null,
      runner,
      maxSlots: MAX_CHECK_SLOTS,
      defaultSlots: DEFAULT_CHECK_SLOTS,
      // Connected runners on an image too old to run queued checks: their companies' jobs would wait until the runners are updated.
      runnersTooOld: live.filter((r) => !runners.can(r.id, "check-jobs")).map((r) => r.company),
      // BOS-1366: the merge train switch (off by default) and the connected runners too old for it (they land one at a time).
      train: await checkQueueSvc.train(),
      runnersTooOldForTrain: live.filter((r) => !runners.can(r.id, "merge-base")).map((r) => r.company),
      // BOS-1803: minutes a background-lane merge lets newer ordinary work go first (0 = always), and the default.
      laneAgeMinutes: await checkQueueSvc.laneAge(),
      defaultLaneAgeMinutes: DEFAULT_BACKGROUND_LANE_AGE_MINUTES,
      // BOS-1602: what the company runner takes and how many of its slots are kept for merges.
      runnerPolicy: await checkQueueSvc.runnerPolicy(),
      // BOS-1435: check workers, each with per company whether it takes checks and, if not, why.
      workers: (await checkWorkers?.list()) ?? [],
    };
  };
  owner.get("/api/settings/check-queue", async () => checkQueueView());
  owner.put("/api/settings/check-queue", async (req) => {
    // `train` is optional, so an older page that doesn't send it leaves the switch as it was.
    // BOS-1602: `runnerPolicy` is optional too (an older page leaves it as it was); kept for merges can't exceed the slots.
    const b = z
      .object({ mode: z.enum(["legacy", "server"]), slots: z.number().int().min(1).max(MAX_CHECK_SLOTS), train: z.boolean().optional(), runnerPolicy: Policy.optional(), laneAgeMinutes: z.number().int().min(0).max(MAX_BACKGROUND_LANE_AGE_MINUTES).optional() })
      .refine((v) => !v.runnerPolicy || v.runnerPolicy.mergeKept <= v.slots, { message: "Kept for merges can't be more than the runner's check slots." })
      .parse(req.body);
    const was = await checkQueueSvc.mode();
    const slotsWere = await checkQueueSvc.slots();
    await checkQueueSvc.setSlots(b.slots);
    if (b.runnerPolicy) await checkQueueSvc.setRunnerPolicy(b.runnerPolicy);
    await checkQueueSvc.setMode(b.mode);
    if (b.train !== undefined) await checkQueueSvc.setTrain(b.train);
    // Optional too: an older page leaves the background-lane wait as it was.
    if (b.laneAgeMinutes !== undefined) await checkQueueSvc.setLaneAge(b.laneAgeMinutes);
    // BOS-993: no .env edit. The launcher is told the new number and the runners are recreated through the same drain a
    // setting change uses (each as its company goes idle, agents woken afterwards), but only when a runner would really change.
    const applying = launch.enabled && b.slots !== slotsWere ? await pushToRunners() : false;
    // Back to legacy: nothing starts queued jobs any more, so each is cancelled with its reason and whoever asked is told
    // (an agent is woken to run check-quick.sh itself; a merge waiting on one gets the usual "check stopped" card). Running jobs finish.
    let cancelled = 0;
    if (was === "server" && b.mode === "legacy")
      for (const id of await checkQueueSvc.queuedIds())
        if (await checks.cancel(id, "The owner switched the check queue off (back to legacy), so this queued check will not run. Run scripts/check-quick.sh yourself, as before.")) cancelled++;
    if (b.mode === "server") await checks.pump();
    return { ...(await checkQueueView()), cancelled, applying };
  });
  // BOS-1072: the main-CI watcher's switch and the plain line it keeps for each project.
  const mainCiView = async () => ({ on: await mainCi.isOn(), projects: await mainCi.statuses() });
  owner.get("/api/settings/main-ci", async () => mainCiView());
  owner.put("/api/settings/main-ci", async (req) => {
    await mainCi.setOn(z.object({ on: z.boolean() }).parse(req.body).on);
    return mainCiView();
  });
  // BOS-1435 (DR-060): Settings → Server and runner → Checks → Check workers. Owner only. The token is in the answer to the
  // add, once; only its hash is kept. Turning a worker off or removing it puts its running checks back in line at once
  // and closes its socket.
  const WorkerBody = z.object({
    name: z.string().trim().min(1).max(80),
    companyIds: z.array(Uuid).max(200),
    slots: z.number().int().min(1).max(MAX_CHECK_SLOTS),
    checkThreads: z.number().int().min(1).max(THREADS_MAX).nullable(),
    checkMemoryMb: z.number().int().min(MEMORY_MB_MIN).max(MEMORY_MB_MAX).nullable(),
    enabled: z.boolean(),
    // BOS-1602: optional, so an older page leaves them as they were (a new worker then takes both kinds, none kept).
    takes: z.enum(MACHINE_TAKES).optional(),
    mergeKept: z.number().int().min(0).max(MAX_CHECK_SLOTS).optional(),
  });
  const keptFits = (b: { slots?: number; mergeKept?: number }, slotsNow?: number) => {
    const slots = b.slots ?? slotsNow;
    if (b.mergeKept !== undefined && slots !== undefined && b.mergeKept > slots) throw Object.assign(new Error("Kept for merges can't be more than the worker's slots."), { statusCode: 400 });
  };
  const needWorkers = () => {
    if (!checkWorkers) throw Object.assign(new Error("Check workers are not available on this server."), { statusCode: 404 });
    return checkWorkers;
  };
  const knownCompanies = async (ids: string[]) => {
    if (!ids.length) return;
    const found = new Set((await db.select({ id: companies.id }).from(companies)).map((c) => c.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw Object.assign(new Error("One of the chosen companies no longer exists."), { statusCode: 400 });
  };
  owner.get("/api/settings/check-workers", async () => (await checkWorkers?.list()) ?? []);
  owner.post("/api/settings/check-workers", async (req) => {
    const w = needWorkers();
    const b = WorkerBody.parse(req.body);
    keptFits(b);
    await knownCompanies(b.companyIds);
    const { worker, token } = await w.register(b);
    // BOS-1550: the commit the worker must be built from = the one its chosen companies' runners are built from, so the
    // Add a check worker card can show a compose file already filled in. Null when no chosen runner has said one yet.
    let commit: string | null = null;
    for (const companyId of b.companyIds) {
      commit = await runnerImageCommit(db, companyId);
      if (commit) break;
    }
    return { id: worker.id, token, commit };
  });
  owner.patch("/api/settings/check-workers/:id", async (req, reply) => {
    const w = needWorkers();
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = WorkerBody.partial().parse(req.body);
    if (b.mergeKept !== undefined) keptFits(b, (await w.get(id))?.slots);
    if (b.companyIds) await knownCompanies(b.companyIds);
    const row = await w.update(id, b);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (!row.enabled) {
      await checks.onWorkerOff(id, `The owner turned off the check worker "${row.name}", so this check was put back in line.`);
      w.disconnect(id, WORKER_OFF_CLOSE, "worker off");
    } else await checks.pump();
    return (await w.list()).find((x) => x.id === id) ?? null;
  });
  owner.delete("/api/settings/check-workers/:id", async (req, reply) => {
    const w = needWorkers();
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const row = await w.get(id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    // Off first, so the pump inside onWorkerOff can't hand the re-queued jobs straight back to this worker (they would be
    // left running with no machine once the row goes). Then back in line, then the row goes (its token with it), then the
    // socket closes; a redial gets 401.
    await w.update(id, { enabled: false });
    await checks.onWorkerOff(id,`The owner removed the check worker "${row.name}", so this check was put back in line.`);
    await w.remove(id);
    w.disconnect(id, WORKER_OFF_CLOSE, "worker removed");
    return { ok: true };
  });
  // BOS-313: check the merged result before pushing it (off by default while it rolls out).
  owner.get("/api/settings/check-merged-result", async () => ({ on: await review.checkMergedResult() }));
  owner.put("/api/settings/check-merged-result", async (req) => ({ on: await review.setCheckMergedResult(z.object({ on: z.boolean() }).parse(req.body).on) }));
  // BOS-1070: the merge gate waits for GitHub CI on the merge commit before it merges.
  owner.get("/api/settings/wait-for-ci", async () => ({ on: await review.waitForCi() }));
  owner.put("/api/settings/wait-for-ci", async (req) => ({ on: await review.setWaitForCi(z.object({ on: z.boolean() }).parse(req.body).on) }));
  // BOS-1762: land a passed merge across a main move that touches none of its files, and the landing turn's cap (0 = off).
  // BOS-1900: `refresh` is the merge_retarget switch (BOS-1344/1820/1821): rebuild a waiting merge on a moved main while it waits.
  const mergeCarryView = async () => ({ on: await review.mergeCarry(), turnMinutes: await review.mergeTurnMinutes(), refresh: await review.mergeRetarget() });
  owner.get("/api/settings/merge-carry", mergeCarryView);
  owner.put("/api/settings/merge-carry", async (req) => {
    const body = z.object({ on: z.boolean().optional(), turnMinutes: z.number().int().min(0).max(MERGE_TURN_MAX_MIN).optional(), refresh: z.boolean().optional() }).parse(req.body);
    if (body.on !== undefined) await review.setMergeCarry(body.on);
    if (body.turnMinutes !== undefined) await review.setMergeTurnMinutes(body.turnMinutes);
    if (body.refresh !== undefined) await review.setMergeRetarget(body.refresh);
    return mergeCarryView();
  });
}
