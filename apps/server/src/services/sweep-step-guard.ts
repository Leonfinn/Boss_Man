// Reporting for the minute sweep's background steps (BOS-2160). Each step is caught on purpose so one failure
// cannot stop the whole pass (BOS-611), but a step that fails every minute used to do so silently. This guard
// keeps that behaviour (the step returns its fallback and the other steps still run) and adds: a log line with
// the step name and the redacted error, the step's name in the pass result's `failedSteps`, and, after
// FAIL_PASSES passes in a row, one owner alert per step that closes itself after the step's next success.
// The count of failing passes lives in one `settings` row, so a restart does not reset it.
import { eq } from "drizzle-orm";
import { redact } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { AlertInput } from "./alert-ladder.js";

export const FAIL_PASSES = 3;
const KEY = "sweep-step-failures";

export const sweepStepKey = (step: string) => `sweep-step:${step}`;

async function readCounts(db: Db): Promise<Record<string, number>> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY));
  const v = row?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, number>) } : {};
}

/** For the card's closer: null while the step is still failing, otherwise why the card can close. */
export async function sweepStepOkReason(db: Db, step: string): Promise<string | null> {
  const counts = await readCounts(db);
  return (counts[step] ?? 0) === 0 ? `the "${step}" step ran without an error in the last pass` : null;
}

export type StepGuardOpts = {
  log?: (message: string) => void;
  alert?: (input: AlertInput) => Promise<{ id: string } | null>;
  /** The company Boss Man's own cards go to; without it nothing is raised (the log and failedSteps still work). */
  homeCompany?: () => Promise<string | null>;
};

/** One guard per sweep pass: wrap each step with `step`, then call `finish` once. */
export async function sweepStepGuard(db: Db, opts: StepGuardOpts) {
  const before = await readCounts(db).catch(() => ({}) as Record<string, number>);
  const failed = new Set<string>(); // lost on restart, harmless because it lives for one pass and the counts are in settings
  const seen = new Set<string>(); // lost on restart, harmless because it lives for one pass and the counts are in settings
  return {
    failed: () => [...failed],
    /** Runs the step. A throw is logged, recorded and answered with `fallback`; a step that is skipped is neither a success nor a failure. */
    async step<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
      seen.add(name);
      try {
        return await fn();
      } catch (err) {
        failed.add(name);
        try {
          opts.log?.(`sweep step "${name}" failed: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
        } catch {
          // a broken logger must not take the pass down
        }
        return fallback;
      }
    },
    /** Saves the counts, raises the alert for a step at its third failing pass, and lets the closer see the ones that recovered. */
    async finish() {
      const after = { ...before };
      const raise: string[] = [];
      for (const name of seen) {
        if (failed.has(name)) {
          after[name] = (before[name] ?? 0) + 1;
          if (after[name] === FAIL_PASSES) raise.push(name);
        } else delete after[name];
      }
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        await db.insert(settings).values({ key: KEY, value: after }).onConflictDoUpdate({ target: settings.key, set: { value: after } }).catch((err) => opts.log?.(`sweep step failure counts not saved: ${redact(String(err?.message ?? err)).slice(0, 200)}`));
      }
      if (!raise.length || !opts.alert || !opts.homeCompany) return;
      const companyId = await opts.homeCompany().catch(() => null);
      if (!companyId) return;
      for (const name of raise) {
        await opts
          .alert({
            companyId,
            kind: "sweep_step_failing",
            question: `A background safety step of Boss Man, "${name}", has failed in ${FAIL_PASSES} sweeps in a row (about ${FAIL_PASSES} minutes). Nothing it guards is being checked while it fails. The server's error log has the reason (search for: sweep step "${name}" failed). This closes by itself after the step's next success.`,
            from: "owner",
            why: "a broken safety step needs a fix or a server restart, which only the owner can do",
            dedupeKey: sweepStepKey(name),
            clearWhen: [{ kind: "sweepStepOk", step: name }],
            about: [],
          })
          .catch((err) => opts.log?.(`sweep step alert not raised: ${redact(String(err?.message ?? err)).slice(0, 200)}`));
      }
    },
  };
}
