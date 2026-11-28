// BOS-2058: every wait in a server or runner update is one row in this table, and nothing else may add one.
//
// Why it exists. Five updates stuck or were mis-explained in about 15 hours (19 to 20 Nov). Each had a different wait,
// and each wait's three parts were written in separate places that disagreed:
//   - what it WAITS FOR (the quiet-machine test) and what its hold BLOCKS (the gates that stop new starts) were two
//     lists. A server update counted a check worker's quick check as "not quiet" while its own hold let a worker start
//     one, so a new one began as each ended and the update never went in (the 10:05 update).
//   - its END, its CEO wake and its words on screen were hand-written per wait, and most had none.
//   - waits counted records, not live work: a merge record that had stopped beating held a swap (the 11:44 hold).
// A WaitRule says all of it once. `waitsFor` must be a subset of `blocks` (rule a: nothing the wait would then have to
// wait for may start while it waits), `endMin` is finite for every kind (rule b), `words` is what the screen says (rule
// c), `expectedMin` is when the CEO is woken (rule d) and `forUpdate` says which update a wrap-up belongs to (rule e).
// update-waits-guard.test.ts fails when a kind is missing, has no end or no words, or waits for what it does not block.
// Adding a hold or wait means adding a kind here: `WAIT_RULES` is a Record over `WaitKind`, so a kind with no rule does
// not compile, and scripts/check-guards.sh keeps the hold readers in the few files that know about this table.
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { DEPLOY_WAIT_KEY } from "./deploy-wait-hold.js";

/** What can be started while an update waits. The same list names what a wait counts and what its hold stops. */
export type WorkClass = "agent-run" | "chat" | "update-alert" | "quick-check-runner" | "quick-check-worker" | "merge-check" | "full-check" | "merge-landing";

export type WaitKind =
  | "server-quiet"
  | "server-behind-runner"
  | "server-host-memory"
  | "server-build"
  | "server-window"
  | "server-handover"
  | "runner-queued"
  | "runner-building"
  | "runner-drain"
  | "runner-landing"
  | "runner-settle"
  | "runner-launcher"
  | "runner-reconnect"
  | "owner-force"
  | "wrapup";

export type WaitRule = {
  forUpdate: "server" | "runner" | "none";
  /** What the wait counts as "still going" before it may continue. */
  waitsFor: WorkClass[];
  /** What the wait's hold stops from starting. Always a superset of `waitsFor` (rule a). */
  blocks: WorkClass[];
  /** Minutes after `since` when the CEO is woken (rule d). */
  expectedMin: number;
  /** Minutes after `since` when the wait ends by itself (rule b). */
  endMin: number;
  /** At the end: carry on with the update through its existing stop option, or lift the hold and tell the CEO. */
  atEnd: "go-ahead" | "give-up";
  /** What the screen says it waits on, in plain words (rule c). */
  words: string;
};

const ALL_CHECKS: WorkClass[] = ["quick-check-runner", "merge-check", "full-check"];

export const WAIT_RULES: Record<WaitKind, WaitRule> = {
  // A worker's quick checks are NOT blocked by the server wait's hold (BOS-1748), so they are not waited for either.
  "server-quiet": { forUpdate: "server", waitsFor: ["agent-run", ...ALL_CHECKS], blocks: ["agent-run", ...ALL_CHECKS], expectedMin: 30, endMin: 60, atEnd: "go-ahead", words: "the machine to be quiet (merge checks and runs finishing)" },
  "server-behind-runner": { forUpdate: "server", waitsFor: ["agent-run", ...ALL_CHECKS, "merge-landing"], blocks: ["agent-run", ...ALL_CHECKS, "quick-check-worker", "merge-landing"], expectedMin: 30, endMin: 70, atEnd: "go-ahead", words: "the runner update that goes first" },
  "server-host-memory": { forUpdate: "server", waitsFor: [], blocks: ["agent-run", ...ALL_CHECKS], expectedMin: 30, endMin: 60, atEnd: "give-up", words: "the host to have enough free memory" },
  "server-build": { forUpdate: "server", waitsFor: [], blocks: ["agent-run", ...ALL_CHECKS], expectedMin: 15, endMin: 45, atEnd: "give-up", words: "the host to build and switch to the new server" },
  "server-window": { forUpdate: "server", waitsFor: [], blocks: ["agent-run", ...ALL_CHECKS], expectedMin: 15, endMin: 30, atEnd: "go-ahead", words: "the standby window of the new server to end" },
  "server-handover": { forUpdate: "server", waitsFor: [], blocks: ["agent-run", ...ALL_CHECKS], expectedMin: 15, endMin: 30, atEnd: "go-ahead", words: "the runner update to start" },
  "runner-queued": { forUpdate: "runner", waitsFor: [], blocks: [], expectedMin: 60, endMin: 180, atEnd: "give-up", words: "the update in front of it" },
  "runner-building": { forUpdate: "runner", waitsFor: [], blocks: ["agent-run", ...ALL_CHECKS], expectedMin: 15, endMin: 45, atEnd: "give-up", words: "the new runner image to be built" },
  "runner-drain": { forUpdate: "runner", waitsFor: ["agent-run", "chat", "quick-check-runner", "merge-check", "full-check"], blocks: ["agent-run", "quick-check-runner", "merge-check", "full-check"], expectedMin: 30, endMin: 60, atEnd: "go-ahead", words: "running agents and checks to finish" },
  "runner-landing": { forUpdate: "runner", waitsFor: ["merge-landing"], blocks: ["merge-landing"], expectedMin: 10, endMin: 20, atEnd: "go-ahead", words: "a merge that is being pushed to main" },
  "runner-settle": { forUpdate: "runner", waitsFor: [], blocks: ["agent-run"], expectedMin: 3, endMin: 5, atEnd: "go-ahead", words: "a scheduling pass to end" },
  "runner-launcher": { forUpdate: "runner", waitsFor: [], blocks: ["agent-run"], expectedMin: 5, endMin: 15, atEnd: "give-up", words: "the runner launcher to answer" },
  "runner-reconnect": { forUpdate: "runner", waitsFor: [], blocks: ["agent-run"], expectedMin: 3, endMin: 5, atEnd: "go-ahead", words: "the new runner to connect" },
  "owner-force": { forUpdate: "runner", waitsFor: ["agent-run", "chat"], blocks: ["agent-run", ...ALL_CHECKS], expectedMin: 15, endMin: 30, atEnd: "go-ahead", words: "the runs you chose to stop to end" },
  // A wrap-up with no update waiting lifts after an hour; one for an update ends with that update (forUpdate "none" here:
  // the kind a wrap-up has is read from `forUpdate` on the hold, see wrapUpEnds).
  wrapup: { forUpdate: "none", waitsFor: ["agent-run"], blocks: ["agent-run", ...ALL_CHECKS], expectedMin: 30, endMin: 60, atEnd: "give-up", words: "agents to wrap up their work" },
};

/** BOS-2058: a merge landing counts as "being pushed" for at most this long. Past it the swap goes ahead (DR-014: a restart fails an in-flight merge at once, and the gate retries it). */
export const LANDING_END_MS = WAIT_RULES["runner-landing"].endMin * 60_000;
/**
 * Which running landings a runner swap still waits on, before the heartbeat test (merge-status.ts landingMergeIds).
 * BOS-2479: one positive rule. A landing counts only while its call that can push to main is going (`pushingSince`, set by
 * merge-rounds.ts whilePushing), and for at most LANDING_END_MS from that call's start. Everything before the push (a train
 * seat, a landing turn, a check slot, the check, GitHub CI) is not counted: the swap's own hold can stall each of those, so
 * waiting for them made the swap wait on a merge that waited on the swap. This replaces the list of exceptions that grew one
 * at a time: GitHub CI (BOS-1991, 20 Nov 11:44), a queued merge check (BOS-1954, 19 Nov 22:13), and the train-seat wait
 * none of them caught (24 Nov 10:11 BOS-2408; 17:22 BOS-2484 and BOS-2521).
 */
export function landingsThatCount(ids: string[], facts: { pushingSince: (id: string) => number | undefined; now: number }): string[] {
  return ids.filter((id) => {
    const since = facts.pushingSince(id);
    return since !== undefined && !(facts.now - since > LANDING_END_MS);
  });
}

/** BOS-1982: how long "Swap as soon as these finish" holds, counted from the answer. */
export const SWAP_WHEN_DONE_CAP_MINUTES = 60;
/**
 * When a runner drain goes ahead by itself (maintenance.ts step): its own end from the hold's start, or later if the owner
 * chose "Wait 10 more minutes" (deadline) or "Swap as soon as these finish" (its own bound). Shared by the drain and the
 * screen, so what the screen says is when it happens.
 */
export function drainEndsAt(hold: { since: string; deadline?: string; swapWhenDone?: boolean; swapWhenDoneAt?: string }): Date {
  const own = Date.parse(hold.since) + WAIT_RULES["runner-drain"].endMin * 60_000;
  const deadline = hold.deadline ? Date.parse(hold.deadline) : 0;
  const swd = hold.swapWhenDone && hold.swapWhenDoneAt ? Date.parse(hold.swapWhenDoneAt) + SWAP_WHEN_DONE_CAP_MINUTES * 60_000 : 0;
  return new Date(Math.max(own, Number.isFinite(deadline) ? deadline : 0, Number.isFinite(swd) ? swd : 0));
}

/** A wrap-up with no update behind it lifts by itself after this long. */
export const STANDALONE_WRAPUP_MS = WAIT_RULES.wrapup.endMin * 60_000;

/**
 * BOS-2786: a runner update queued behind a server update's trial gets Boss Man's own wrap-up (maintenance.ts autoWrap).
 * New work and checks are held from the press: a merge check on the company runner takes 18 min at the median and 26 at
 * the 90th percentile (270 merge checks, 24 to 27 Nov), longer than the whole 15-minute trial, so no shorter lead lets one
 * that starts in the trial end with it (on 27 Nov four started 09:59 to 10:03, inside 62e77f40's trial). Running agents
 * are asked to finish this many minutes before the trial ends: a told agent ends within about a minute of reading the
 * message (15 of 15 runs since 11 Nov), and reads it when the tool call it is in ends, which is minutes for an ordinary
 * step such as a test file in the quick lane. Until then they keep working.
 */
export const AUTO_WRAPUP_TELL_LEAD_MIN = 10;
/**
 * BOS-2786: Boss Man's own wrap-up gives up when its runner update is still only queued this long after the trial's end
 * (something else holds it back, such as a failed update being diagnosed): the host takes a request within a minute or
 * two, and all work must not stay held for the runner-queued wait's 180 minutes for a press that is not moving.
 */
export const AUTO_WRAPUP_QUEUED_GRACE_MIN = 10;

/** Does this wait's hold stop `cls` from starting? Gates call this instead of keeping their own list. */
export const blocksClass = (kind: WaitKind, cls: WorkClass): boolean => WAIT_RULES[kind].blocks.includes(cls);

/** The wait a runner hold (not a wrap-up) is: the owner's stop-and-update choice, or the plain drain. The screen and the check dispatcher (BOS-2108) both read it here. */
export const runnerHoldWait = (hold: { force?: boolean; ignoreChecks?: boolean }): "owner-force" | "runner-drain" => (hold.force || hold.ignoreChecks ? "owner-force" : "runner-drain");

/** Is `cls` one the server update's quiet wait counts? Same list as what its hold blocks, by the invariant above. */
export const serverQuietCounts = (cls: WorkClass): boolean => WAIT_RULES["server-quiet"].waitsFor.includes(cls);

/** The rule every kind must meet; the guard test runs it over `WAIT_RULES`. Returns what is wrong, empty when fine. */
export function ruleProblems(kind: WaitKind, rule: WaitRule = WAIT_RULES[kind]): string[] {
  const out: string[] = [];
  const missing = rule.waitsFor.filter((c) => !rule.blocks.includes(c) && c !== "chat");
  // Chat is the one class a wait may wait for without blocking: the owner's chat is let through while work still runs (BOS-349).
  if (missing.length) out.push(`${kind} waits for ${missing.join(", ")} but its hold does not stop them from starting`);
  if (!Number.isFinite(rule.endMin) || rule.endMin <= 0) out.push(`${kind} has no end of its own`);
  if (!(rule.expectedMin < rule.endMin)) out.push(`${kind} wakes the CEO at ${rule.expectedMin} min, which is not before its end at ${rule.endMin} min`);
  if (!rule.words.trim()) out.push(`${kind} has no words for the screen`);
  return out;
}

/** One line of "what is waiting now", for Settings, the banner and server_status: every screen reads this one list. */
export type ActiveWait = {
  kind: WaitKind;
  forUpdate: "server" | "runner" | "none";
  since: string;
  /** In plain words: what it waits on, with the counts. */
  waitingOn: string;
  expectedAt: string;
  endsAt: string;
  atEnd: "go-ahead" | "give-up";
  /** When it ends: goes ahead, or gives up and lifts the hold. */
  endsWords: string;
};

const plus = (since: string, min: number) => new Date(Date.parse(since) + min * 60_000).toISOString();
const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;

export function describeWait(kind: WaitKind, since: string, detail?: string, endsAtOverride?: string): ActiveWait {
  const r = WAIT_RULES[kind];
  const endsAt = endsAtOverride ?? plus(since, r.endMin);
  return {
    kind,
    forUpdate: r.forUpdate,
    since,
    waitingOn: `${r.words}${detail ? ` (${detail})` : ""}`,
    expectedAt: plus(since, r.expectedMin),
    endsAt,
    atEnd: r.atEnd,
    endsWords: r.atEnd === "go-ahead" ? `goes ahead at ${hhmm(endsAt)} at the latest` : `ends at ${hhmm(endsAt)} and the hold is lifted`,
  };
}

/** The shape of the two settings rows this reads; only the fields it needs. */
type DeployWaitRow = { phase?: string; approvedAt?: string; sentAt?: string; windowUntil?: string; handoverSince?: string; quiet?: { why?: string[] } };
type HoldRow = { kind?: string; since?: string; deadline?: string; swapWhenDoneAt?: string; force?: boolean; ignoreChecks?: boolean; swapWhenDone?: boolean; wrapSince?: string; forUpdate?: string; settleSince?: string; launcherDownSince?: string };

/** A running check as the drain's words name it: its ticket reference and what kind of check it is. */
export type NamedCheck = { ticket: string | null; kind: string; scope: string };
/**
 * BOS-2479: what the runner drain waits on now, from the same reads the drain itself uses (runner-busy.ts runnerBusy with
 * onRunnerOnly, runnerChecks), plus the check-worker checks it lets run and does not wait for (BOS-2108).
 */
export type DrainFacts = { runs: number; runnerChecks: NamedCheck[]; workerChecks: NamedCheck[] };

const checkWord = (c: NamedCheck) => (c.kind === "merge" ? "merge check" : c.scope === "full" ? "full check" : c.scope === "quick" ? "quick check" : "check");

/** "2 quick checks: BOS-2456, BOS-2468; 1 merge check: BOS-2408", grouped by kind in first-seen order. */
export function namedChecksText(checks: NamedCheck[]): string {
  const groups = new Map<string, string[]>(); // not state: local to this call
  for (const c of checks) groups.set(checkWord(c), [...(groups.get(checkWord(c)) ?? []), c.ticket ?? "no ticket"]);
  return [...groups].map(([word, tickets]) => `${tickets.length} ${word}${tickets.length === 1 ? "" : "s"}: ${tickets.join(", ")}`).join("; ");
}

/**
 * BOS-2479: the drain line's detail. On 24 Nov the line always read "running agents and checks to finish", with no counts,
 * while the drain was waiting on nothing of its own, and the CEO read the two quick checks running on a check worker as what
 * it waited for. It now says what is left (with counts and tickets), says plainly when nothing is, and names the worker's
 * checks as not waited for.
 */
export function drainDetail(d: DrainFacts, otherWaits: boolean): string {
  const left = [...(d.runs > 0 ? [`${d.runs} agent run${d.runs === 1 ? "" : "s"}`] : []), ...(d.runnerChecks.length ? [namedChecksText(d.runnerChecks)] : [])];
  const own = left.length ? left.join("; ") : otherWaits ? "nothing left of its own; it now waits only for the waits below" : "nothing left; the swap happens on the next pass";
  return d.workerChecks.length ? `${own}. Not waited for: ${namedChecksText(d.workerChecks)} on a check worker` : own;
}

/**
 * BOS-2861: which waits that count running checks are on now, read from the same rows as activeWaits: the runner drain
 * (not the owner's "stop and update now", which waits for no check, and not a wrap-up or a build, which swap nothing) and
 * the server update's quiet wait. The Merge queue marks each running check from these (runner-busy.ts updateCheckMarks).
 */
export async function checkCountingWaits(db: Db): Promise<{ runner: boolean; server: boolean }> {
  const rows = await db.select().from(settings);
  const deploy = rows.find((r) => r.key === DEPLOY_WAIT_KEY)?.value as DeployWaitRow | undefined;
  const hold = rows.find((r) => r.key === "maintenance")?.value as HoldRow | undefined;
  const runner = !!hold?.since && hold.kind !== "wrapup" && hold.kind !== "building" && runnerHoldWait(hold) === "runner-drain";
  const server = !!deploy?.approvedAt && deploy.phase !== "sent" && deploy.phase !== "window" && deploy.phase !== "handover";
  return { runner, server };
}

/**
 * Every wait that is on now, from the rows that exist today (`deploy_wait`, `maintenance`) plus the live landing ids
 * the runner swap waits on. No table of its own: a restart keeps every `since`.
 */
export async function activeWaits(db: Db, opts: { landingSince?: string | null; landingNames?: string[]; drain?: DrainFacts } = {}): Promise<ActiveWait[]> {
  const rows = await db.select().from(settings);
  const deploy = rows.find((r) => r.key === DEPLOY_WAIT_KEY)?.value as DeployWaitRow | undefined;
  const hold = rows.find((r) => r.key === "maintenance")?.value as HoldRow | undefined;
  const out: ActiveWait[] = [];
  if (deploy?.approvedAt) {
    const why = deploy.quiet?.why?.join("; ");
    const kind: WaitKind = deploy.phase === "sent" ? "server-build" : deploy.phase === "window" ? "server-window" : deploy.phase === "handover" ? "server-handover" : "server-quiet";
    const since = kind === "server-build" ? (deploy.sentAt ?? deploy.approvedAt) : kind === "server-window" ? (deploy.windowUntil ? plus(deploy.windowUntil, -WAIT_RULES["server-window"].endMin) : deploy.approvedAt) : kind === "server-handover" ? (deploy.handoverSince ?? deploy.approvedAt) : deploy.approvedAt;
    out.push(describeWait(kind, since, kind === "server-quiet" ? why : undefined));
  }
  if (hold?.since) {
    if (hold.kind === "wrapup" || hold.wrapSince) out.push(describeWait("wrapup", hold.wrapSince ?? hold.since, hold.forUpdate === "none" || !hold.forUpdate ? "no update is waiting, so it lifts by itself" : `for the ${hold.forUpdate} update`));
    if (hold.kind !== "wrapup") {
      // The drain goes ahead at drainEndsAt (maintenance.ts step), with checks ignored or not; once forced, only a merge
      // being pushed is left, on its own end.
      const goAt = drainEndsAt({ ...hold, since: hold.since }).toISOString();
      const kind = runnerHoldWait(hold);
      // BOS-2479: the plain drain says what it still waits on; "other waits" are the rows pushed after it.
      const others = !!opts.landingSince || !!hold.settleSince || !!hold.launcherDownSince;
      const detail = kind === "runner-drain" && opts.drain ? drainDetail(opts.drain, others) : undefined;
      out.push(kind === "owner-force" && hold.force ? describeWait(kind, hold.since) : describeWait(kind, hold.since, detail, goAt));
      if (hold.settleSince) out.push(describeWait("runner-settle", hold.settleSince));
      if (hold.launcherDownSince) out.push(describeWait("runner-launcher", hold.launcherDownSince));
    }
  }
  if (opts.landingSince) out.push(describeWait("runner-landing", opts.landingSince, opts.landingNames?.length ? opts.landingNames.join(", ") : undefined));
  return out;
}
