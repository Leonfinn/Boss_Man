// BOS-2877: the time limit of a server-queued check job. The limit used to be one wall clock from "slot taken": on a busy host
// (3 checks and 2 merge checks sharing the CPU) a quick check whose steps all passed, one after the other, was stopped
// at 30 minutes while a later step (shell tests, the squeeze report) was still running.
// Now the limit is per step: every finished step line (PASS, FAIL, SKIP at the start of a line) restarts the clock, so a check
// that keeps finishing steps is slow, not stuck. A hard cap (CHECK_CAP_FACTOR times the limit, from the slot) still stops a check
// that never ends. A single step that runs past the limit alone is stopped as before.

/** The hard cap on a whole check, as a multiple of its per-step limit. */
export const CHECK_CAP_FACTOR = 2;

/** True when the output chunk holds a finished-step line as check-quick and check-all print them. */
export function finishesStep(chunk: string): boolean {
  return /(^|\n)(PASS|FAIL|SKIP) {1,2}\S/.test(chunk);
}

/** The time to give the check from `now`: the per-step limit, cut to what is left of the hard cap. 0 means the cap is reached. */
export function stepLimitMs(opts: { now: number; slotTakenAt: number; limitMs: number }): number {
  const capAt = opts.slotTakenAt + opts.limitMs * CHECK_CAP_FACTOR;
  return Math.max(0, Math.min(opts.limitMs, capAt - opts.now));
}
