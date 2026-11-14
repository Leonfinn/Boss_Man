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
import { checkQueue, DEFAULT_CHECK_SLOTS, MAX_CHECK_SLOTS } from "../services/check-queue.js";
import { CHECK_MEMORY_CEILING_BYTES, limitReason } from "../services/check-limit.js";
import type { checkDispatcher } from "../services/check-dispatcher.js";
import type { launcherService } from "../services/launcher.js";
import { getHold, type maintenanceService } from "../services/maintenance.js";
import type { reviewService } from "../services/review.js";
import type { runnersService } from "../services/runners.js";
import { DEFAULT_LIMITS, type schedulerService } from "../services/scheduler.js";

const Uuid = z.string().uuid();

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
  },
) {
  const { db, scheduler, checkQueueSvc, launch, maintenance, checks, review, runners } = deps;

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
    const before = row?.value as { background?: number } | undefined;
    const merged = { instance: value.instance, company: value.company, background: value.background ?? before?.background ?? DEFAULT_LIMITS.background };
    await db.insert(settings).values({ key: "run_limits", value: merged }).onConflictDoUpdate({ target: settings.key, set: { value: merged } });
    return runLimits();
  });
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
          // Every runner is sized on its own from the whole host's memory, so with more than one the panel warns (BOS-993).
          runnerCount: lc.runners.length,
          pending: lc.runners.filter((r) => r.slots !== lc.slots || r.memoryBytes !== lc.memoryBytes).length,
          applying: hold?.kind === "settings",
        }
      : null;
    return {
      mode: await checkQueueSvc.mode(),
      slots,
      runner,
      maxSlots: MAX_CHECK_SLOTS,
      defaultSlots: DEFAULT_CHECK_SLOTS,
      // Connected runners on an image too old to run queued checks: their companies' jobs would wait until the runners are updated.
      runnersTooOld: live.filter((r) => !runners.can(r.id, "check-jobs")).map((r) => r.company),
      // BOS-1366: the merge train switch (off by default) and the connected runners too old for it (they land one at a time).
      train: await checkQueueSvc.train(),
      runnersTooOldForTrain: live.filter((r) => !runners.can(r.id, "merge-base")).map((r) => r.company),
    };
  };
  owner.get("/api/settings/check-queue", async () => checkQueueView());
  owner.put("/api/settings/check-queue", async (req) => {
    // `train` is optional, so an older page that doesn't send it leaves the switch as it was.
    const b = z.object({ mode: z.enum(["legacy", "server"]), slots: z.number().int().min(1).max(MAX_CHECK_SLOTS), train: z.boolean().optional() }).parse(req.body);
    const was = await checkQueueSvc.mode();
    const slotsWere = await checkQueueSvc.slots();
    await checkQueueSvc.setSlots(b.slots);
    await checkQueueSvc.setMode(b.mode);
    if (b.train !== undefined) await checkQueueSvc.setTrain(b.train);
    // BOS-993: no .env edit. The launcher is told the new number and the runners are recreated through the same drain a
    // setting change uses (each as its company goes idle, agents woken afterwards), but only when a runner would really change.
    let applying = false;
    if (launch.enabled && b.slots !== slotsWere) {
      try {
        await launch.setChecks(b.slots);
        const lc = await launch.checks();
        if (lc?.runners.some((r) => r.slots !== lc.slots || r.memoryBytes !== lc.memoryBytes)) {
          await maintenance.start({ kind: "settings" }); // leader-only
          applying = true;
        }
      } catch (e) {
        owner.log.error(`check slots: could not apply to the runners: ${(e as Error).message}`);
      }
    }
    // Back to legacy: nothing starts queued jobs any more, so each is cancelled with its reason and whoever asked is told
    // (an agent is woken to run check-quick.sh itself; a merge waiting on one gets the usual "check stopped" card). Running jobs finish.
    let cancelled = 0;
    if (was === "server" && b.mode === "legacy")
      for (const id of await checkQueueSvc.queuedIds())
        if (await checks.cancel(id, "The owner switched the check queue off (back to legacy), so this queued check will not run. Run scripts/check-quick.sh yourself, as before.")) cancelled++;
    if (b.mode === "server") await checks.pump();
    return { ...(await checkQueueView()), cancelled, applying };
  });
  // BOS-313: check the merged result before pushing it (off by default while it rolls out).
  owner.get("/api/settings/check-merged-result", async () => ({ on: await review.checkMergedResult() }));
  owner.put("/api/settings/check-merged-result", async (req) => ({ on: await review.setCheckMergedResult(z.object({ on: z.boolean() }).parse(req.body).on) }));
}
