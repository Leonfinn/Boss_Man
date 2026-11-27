// BOS-2672 (RCA-011): the one place the owner's wrap-up is worded. The top banner, the Updates status box and the
// notice when it ends all read these functions, from the one record of what the wrap-up is tied to, so they can't
// disagree (on 26 Nov the box said "no update was waiting" and, under it, "Runners will update at 11:47").
// Pure: the caller passes the clock format (the web uses the reader's clock, the server 24-hour UTC).

/** Where the server update a wrap-up is tied to has got. */
export type WrapServerStage = "approved" | "going-in" | "live-trial" | "handover";
/** Where the runner update a wrap-up is tied to has got. "swapping": its drain took the wrap-up over. */
export type WrapRunnerStage = "queued" | "building" | "swapping";

/** What the screen needs to word a wrap-up: when it was asked, and the steps of the update it is tied to (if any). */
export type WrapTieView = {
  since: string;
  server?: { approvedAt: string | null; stage: WrapServerStage; liveAt?: string | null; trialEndsAt?: string | null } | null;
  runner?: { queuedAt: string | null; stage: WrapRunnerStage; startsAt?: string | null; why?: string | null } | null;
  /** Only for a wrap-up tied to nothing: when it lifts by itself. */
  liftsAt?: string | null;
  /** BOS-2786: "boss-man" when Boss Man started it for a runner update queued behind a trial (absent: the owner asked). */
  by?: "owner" | "boss-man";
  /** BOS-2786: with by "boss-man": when running agents are (or were) asked to finish. */
  tellAt?: string | null;
};

export type WrapWords = {
  /** The top banner on every page. */
  banner: string;
  /** The status box's bold sentence. */
  say: string;
  /** The status box's grey line. */
  more: string;
};

/** The one phrase for a wrap-up's lift time when nothing is tied. */
export const STANDALONE_WRAPUP_MINUTES = 60;

const runsWord = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;
const checksWord = (n: number) => `${n} ${n === 1 ? "check" : "checks"}`;

/**
 * The words for a wrap-up that is on, in every state (RCA-011 table rows A–I, and BOS-2786's row J). `runs` is how many
 * agents are still finishing; `checks` how many checks on the runner the runner update still waits for; `at` formats an
 * instant as a clock time; `now` (ms) says whether Boss Man's ask to agents is still to come. "No update was waiting"
 * appears only when nothing is tied.
 */
export function wrapUpWords(v: WrapTieView, runs: number, at: (iso: string) => string, checks = 0, now: number = Date.now()): WrapWords {
  const s = v.server ?? null;
  const r = v.runner ?? null;
  const server = s ? `the server update${s.approvedAt ? ` you approved at ${at(s.approvedAt)}` : ""}` : "";
  const left = [...(runs > 0 ? [runsWord(runs)] : []), ...(checks > 0 ? [checksWord(checks)] : [])].join(" and ");
  const finishing = runs > 0 ? `${runs} ${runs === 1 ? "agent is" : "agents are"} still finishing the step ${runs === 1 ? "it is" : "they are"} on.${checks > 0 ? ` ${checksWord(checks)} still running.` : ""}` : checks > 0 ? `Every agent has finished; ${checksWord(checks)} still running.` : "Every agent has finished.";
  const waitingRuns = left ? ` Waiting for ${left} to finish.` : "";
  const out = (lead: string, lift: string): WrapWords => ({ banner: `${lead} ${lift}${waitingRuns}`, say: `${lead} ${finishing}`, more: lift });

  // J (BOS-2786): Boss Man started it for a runner update queued behind a trial, and nobody has to press anything.
  if (v.by === "boss-man" && r && r.stage === "queued") {
    const startsAt = r.startsAt ?? s?.trialEndsAt ?? null;
    const when = startsAt ? ` for ${at(startsAt)}` : "";
    const trial = s ? ", when the server update's trial ends" : "";
    const tell = v.tellAt ? (Date.parse(v.tellAt) > now ? ` and asks agents to finish at ${at(v.tellAt)}` : ` and asked agents to finish at ${at(v.tellAt)}`) : "";
    return out(`Runner update queued${when}${trial}. Boss Man is holding new work and checks since ${at(v.since)}${tell}.`, "It lifts by itself when the runners are updated, or if the update is switched back or cancelled. Nothing for you to press.");
  }

  // A: tied to nothing. The only state that says no update was waiting, and it has no update line beside it.
  if (!s && !r) {
    const asked = at(v.since);
    const lifts = v.liftsAt ? at(v.liftsAt) : null;
    return {
      banner: `You asked agents to wrap up at ${asked}. No update was approved, going in or queued, so this lifts by itself${lifts ? ` at ${lifts}` : " after an hour"}, or press Cancel wrap-up on Settings → Server and runner.${waitingRuns}`,
      say: `No update was waiting when you asked at ${asked}. ${finishing}`,
      more: `Lifts by itself${lifts ? ` at ${lifts}` : " after an hour"}, or press Cancel wrap-up to restart work now.`,
    };
  }
  const runnersLift = "This lifts by itself when the runners are updated.";
  const after = s ? ` (after ${server})` : "";
  // G and H: the runner update is under way.
  if (r && r.stage === "swapping") return out(`Wrapping up for the runner update${after}: each runner is swapped as its company goes idle.`, runnersLift);
  if (r && r.stage === "building") return out(`Wrapping up for the runner update${after}: the new runner image is being built.`, runnersLift);
  if (s && (s.stage === "approved" || s.stage === "going-in")) {
    const where = s.stage === "approved" ? "waiting for a quiet machine" : "going in now";
    // D: the server update, then the runner update queued after it.
    if (r) return out(`Wrapping up for ${server} (${where}), then the runner update after its trial${r.startsAt ? ` (about ${at(r.startsAt)})` : ""}.`, "This lifts by itself when both are in.");
    // B and C.
    return out(s.stage === "approved" ? `Wrapping up for ${server}. It goes in once agents finish and the machine is quiet.` : `Wrapping up for ${server}: it is going in now.`, "This lifts by itself when it is live.");
  }
  if (s) {
    // E: the server update is live; the runner update follows its trial.
    if (r) return out(`Wrapping up for the runner update${r.startsAt ? ` at ${at(r.startsAt)}` : ""}, after ${server}${s.liveAt ? ` (live since ${at(s.liveAt)})` : ""}.`, runnersLift);
    // F: live, on trial, nothing queued after it.
    const ends = s.trialEndsAt ? ` (ends ${at(s.trialEndsAt)})` : "";
    return out(`Wrapping up while ${server} finishes its trial${ends}.`, "This lifts by itself then.");
  }
  // I: a runner update queued with no server update in front of it.
  const why = r!.why ? `: it is waiting for ${r!.why.replace(/\.$/, "")}` : "";
  return out(`Wrapping up for the runner update you queued${r!.queuedAt ? ` at ${at(r!.queuedAt)}` : ""}${why}.`, runnersLift);
}

/** How a tied wrap-up ended (RCA-011 End 1–5). */
export type WrapEnd =
  | { how: "in"; server: boolean; runner: boolean }
  | { how: "failed"; step: "server" | "runner"; switchedBack?: boolean }
  | { how: "cancelled"; step: "server" | "runner"; why?: string | null }
  | { how: "gave-up"; step: "server" | "runner"; didNot: string; minutes?: number }
  | { how: "standalone" };

/** The notice the owner gets when a wrap-up ends by itself. `at` is the time it ended, already formatted. */
export function wrapUpEndWords(e: WrapEnd, at: string): { title: string; body: string } {
  const restarted = "Work has restarted.";
  if (e.how === "in") {
    const what = e.server && e.runner ? "the server update and the runner update are" : e.server ? "the server update is" : "the runner update is";
    return { title: "Wrap-up over", body: `Wrap-up over: ${what} in (${at}). ${restarted}` };
  }
  if (e.how === "failed") {
    const did = e.switchedBack ? "was switched back" : "failed";
    const earlier = e.step === "runner" ? "the earlier runner image" : "the earlier version";
    return { title: `Wrap-up lifted: the ${e.step} update ${did}`, body: `The ${e.step} update ${did} at ${at}; Boss Man is still on ${earlier}. ${restarted}` };
  }
  if (e.how === "cancelled") return { title: `Wrap-up lifted: the ${e.step} update was cancelled`, body: `${e.why ? e.why.trim() : `The ${e.step} update was cancelled at ${at}.`} ${restarted}` };
  if (e.how === "gave-up") return { title: `Wrap-up lifted: the ${e.step} update did not ${e.didNot}`, body: `The ${e.step} update it was tied to did not ${e.didNot}${e.minutes ? ` within ${e.minutes} minutes` : ""}, so work has restarted.` };
  return { title: `Wrap-up lifted after ${STANDALONE_WRAPUP_MINUTES} minutes`, body: `No update was waiting for it, so new runs start again after ${STANDALONE_WRAPUP_MINUTES} minutes. Agents that were still going finish on their own; any that ended cleanly are woken on their tickets.` };
}
