// BOS-1152: keeps the runners on the owner's "Checks at once" after any rebuild, swap or restart, and says why the limit in force is lower.
//
// BOS-993 pushed the setting to the launcher only when the owner changed it or a runner was recreated. A launcher that lost its copy
// (a rebuilt or replaced launcher with no saved file) fell back to 1 slot, the server never sent the setting again, and the panel
// showed "1 at once" with no reason because the launcher's number was not the setting it had been sent. This service closes that gap.
import type { LauncherChecks } from "./launcher.js";

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

type Deps = {
  slots: () => Promise<number>;
  launch: { enabled: boolean; setChecks: (n: number) => Promise<void>; checks: () => Promise<LauncherChecks | null> };
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
      if (lc.requested !== setting) {
        await deps.launch.setChecks(setting);
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
