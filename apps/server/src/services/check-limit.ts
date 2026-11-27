// BOS-1152: keeps the runners on the owner's "Checks at once" after any rebuild, swap or restart, and says why the limit in force is lower.
//
// BOS-993 pushed the setting to the launcher only when the owner changed it or a runner was recreated. A launcher that lost its copy
// (a rebuilt or replaced launcher with no saved file) fell back to 1 slot, the server never sent the setting again, and the panel
// showed "1 at once" with no reason because the launcher's number was not the setting it had been sent. This service closes that gap.
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { projects, settings } from "../db/schema.js";
import type { LauncherChecks } from "./launcher.js";

type RunLimits = { instance: number; company: number; background: number };
/**
 * BOS-1498: the most agents one company's runner can carry at once, which sizes its memory: the company limit (never more
 * than the all-companies one) plus the background (Infinite-mode) slots, which sit outside both.
 */
export const agentsAtOnce = (l: RunLimits) => Math.min(l.company, l.instance) + l.background;
/** The same from the owner's saved run limits (settings.run_limits), else `defaults`. */
export async function readRunnerAgents(db: Db, defaults: RunLimits): Promise<number> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "run_limits"));
  const v = row?.value as Partial<RunLimits> | undefined;
  return agentsAtOnce({ instance: v?.instance ?? defaults.instance, company: v?.company ?? defaults.company, background: v?.background ?? defaults.background });
}

/**
 * BOS-1165: the most memory one check may use before scripts/check-all.sh stops it (scripts/check-mem-guard.mjs): 1.5 times the largest peak
 * measured (4.5 GB for a quick check; the server and web suites alone peaked at 3.9 GB). Same number as the 6912 default of
 * BOSSMAN_CHECK_MEMORY_MB in check-all.sh (a test keeps the two equal); the panel shows it.
 */
export const CHECK_MEMORY_CEILING_BYTES = 6912 * 1024 ** 2;

/**
 * Why the limit in force is lower than the owner's setting, in plain words; null when it is not lower.
 * A lower limit never comes back without a reason: when the launcher gave none, a generic one is made.
 */
export function limitReason(setting: number, lc: Pick<LauncherChecks, "requested" | "slots" | "reason">): string | null {
  if (lc.slots >= setting) return null;
  if (lc.requested !== setting) {
    return `The runner's helper has not been given your setting of ${setting} yet (it has ${lc.requested ?? "none"}). Boss Man sends it again within a minute and restarts the runner when it is idle.`;
  }
  return lc.reason ?? `The host cannot give ${setting} at once (its memory or a .env limit holds it to ${lc.slots}), but it did not say which.`;
}

const gb = (b: number) => `${Math.round((b / 1024 ** 3) * 10) / 10} GB`;
/**
 * BOS-1498: the one line the wizard and Settings show about a runner's memory: the launcher's own line on what a runner made now
 * is given and why. When the company's runner (or, with no slug, any runner) still has another size, it says so first, because
 * the new size only applies once the runner is recreated. Null when the launcher is off, unreachable or too old to say.
 */
export function memoryLine(lc: LauncherChecks | null, slug?: string, checksHere = true): string | null {
  if (!lc?.why) return null;
  const line = capacityLine(lc, checksHere) ?? lc.why;
  const mine = lc.runners.filter((r) => slug === undefined || r.slug === slug);
  const off = mine.filter((r) => r.memoryBytes !== lc.memoryBytes);
  if (!off.length) return line;
  const now = [...new Set(off.map((r) => gb(r.memoryBytes)))].join(" or ");
  return `Has ${now} now; from its next restart, ${line}`;
}

/** BOS-1498 sizing, the same as the launcher's: 2 GB for the runner, 1 GB per agent, 3 GB per check. */
const BASE_GB = 2;
const AGENT_GB = 1;
const CHECK_GB = 3;
const agentsWord = (k: number) => `${k} ${k === 1 ? "agent" : "agents"}`;

/**
 * BOS-2802: leads with what the machine can run ("This machine can run 4 agents at once"), explains a check once, and says what to
 * change when the saved settings don't fit. `checksHere` is false when this company has no check to run on its runner (no code
 * project, or a check worker takes them all): then checks are not counted at all. Null when the launcher didn't send the
 * machine's limit (an older one, or before it has the agents number): the caller falls back to the launcher's own line.
 */
function capacityLine(lc: LauncherChecks, checksHere: boolean): string | null {
  if (typeof lc.ceilingBytes !== "number" || typeof lc.agents !== "number") return null;
  const room = Math.floor(lc.ceilingBytes / 1024 ** 3) - BASE_GB;
  const alone = Math.max(0, Math.floor(room / AGENT_GB));
  if (!checksHere) {
    const fit = lc.agents <= alone;
    return `This machine can run ${agentsWord(alone)} at once.${fit ? "" : ` Agents at once is set to ${lc.agents}: lower it to ${alone}.`}`;
  }
  const withCheck = Math.floor((room - CHECK_GB) / AGENT_GB);
  const what = " (A check is an automated test run of code changes before they merge; only code projects need one.)";
  if (withCheck < 1) return `This machine can run ${agentsWord(alone)} at once, with no room for a check beside them.${what}`;
  const lower = lc.agents > withCheck ? ` Agents at once is set to ${lc.agents}: lower it to ${withCheck} to keep room for a check.` : "";
  return `This machine can run ${agentsWord(alone)} at once, or ${agentsWord(withCheck)} plus 1 check.${what}${lower}`;
}

/**
 * BOS-2802: whether checks run on this machine's runner: some project (of this company, or of any when `companyId` is left out)
 * has a git repo, and no check worker is set up to take all of that company's checks (enabled, takes merges and quick checks).
 * A knowledge-work company has no repo, so it never has a check to run.
 */
export async function checksRunHere(db: Db, workers: { companies: { id: string }[]; enabled: boolean; takes: string }[], companyId?: string): Promise<boolean> {
  const rows = await db.selectDistinct({ companyId: projects.companyId }).from(projects).where(and(isNotNull(projects.repoUrl), companyId ? eq(projects.companyId, companyId) : undefined));
  return rows.some((r) => !workers.some((w) => w.enabled && w.takes === "both" && w.companies.some((c) => c.id === r.companyId)));
}

type Deps = {
  slots: () => Promise<number>;
  /** BOS-1498: the agents number (agentsAtOnce) that sizes the runner's memory. */
  agents?: () => Promise<number>;
  launch: { enabled: boolean; setChecks: (n: number, agents?: number) => Promise<void>; checks: () => Promise<LauncherChecks | null> };
  /** Whether a drain or hold is already going (a second start would only join it). */
  holdActive: () => Promise<boolean>;
  startDrain: () => Promise<unknown>;
  now?: () => number;
  /** Least time between two drains this service starts, so a recreate that cannot reach the plan does not hold the runners over and over. */
  cooldownMs?: number;
};

export function checkLimitReconciler(deps: Deps) {
  const now = deps.now ?? Date.now;
  const cooldown = deps.cooldownMs ?? 10 * 60_000;
  let lastStart = -Infinity;
  return {
    /** One pass: push the setting if the launcher has another, then drain the runners that are off the plan. Returns what it did. */
    async step(): Promise<"off" | "ok" | "pushed" | "draining" | "waiting"> {
      if (!deps.launch.enabled) return "off";
      const setting = await deps.slots();
      let lc = await deps.launch.checks();
      if (!lc) return "off"; // launcher off, unreachable or too old: nothing to compare
      let did: "ok" | "pushed" = "ok";
      const agents = await deps.agents?.();
      // A launcher too old for the agents number reports no `agents` at all: only the slots are compared, so it isn't pushed every minute.
      const agentsOff = agents !== undefined && lc.agents !== undefined && lc.agents !== agents;
      if (lc.requested !== setting || agentsOff) {
        await deps.launch.setChecks(setting, agents);
        lc = (await deps.launch.checks()) ?? lc;
        did = "pushed";
      }
      const off = lc.runners.some((r) => r.slots !== lc!.slots || r.memoryBytes !== lc!.memoryBytes);
      if (!off) return did;
      if (await deps.holdActive()) return "waiting";
      if (now() - lastStart < cooldown) return "waiting";
      lastStart = now();
      await deps.startDrain();
      return "draining";
    },
  };
}
