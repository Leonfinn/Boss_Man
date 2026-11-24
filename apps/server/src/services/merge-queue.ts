// The merge queue screen (BOS-587): a read-only view of the line for the owner, in their words.
// What is running now, what is waiting (in the order it will go) and how it ended last time, so a
// gate that stops can be seen rather than asked about. Reads only what the server already records:
// the tickets in review, their latest check results, the one open merge card per ticket, and the
// merges this process is running. Nothing here changes the queue.
import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { type RiskTier, riskOf, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { stageLine } from "./check-stage-line.js";
import { agents, checkJobs, checkResults, checkWorkers, companies, decisions, reviewRequests, ticketDependencies, tickets } from "../db/schema.js";
import { evaluate } from "./review-kinds.js";
import { softHold, softHoldReason } from "./deploy-wait-hold.js";
import { holdView, mergeHolds } from "./review-holds.js";
import { holdsMergeSql } from "./ticket-links.js";
import { clashWords } from "./merge-line.js";
import { mergeLineHealth, startBrakeOff, type StartBrakeOff, type HeldBehindFix, type HeldFix, type MergeLineHealth } from "./merge-line-health.js";
import { goLiveWaitOf } from "./go-live-wait.js";
import { goLiveWaitWords } from "@boss-man/shared";
import { landingEtas, lineClearAt, turnOverdue } from "./landing-turn-eta.js";

/** BOS-1942: the place a check job's record names: a check worker by its name, or the company runner (the server's own machine). */
const placeOf = (workerId: string | null, worker: string | null) => (workerId ? (worker ?? "a check worker") : "company runner");

/** BOS-1942: the running check jobs of a company, oldest first, each with where it runs (read from the job's record). */
export async function runningCheckJobs(db: Db, companyId: string) {
  const rows = await db
    .select({ ticketId: checkJobs.ticketId, kind: checkJobs.kind, startedAt: checkJobs.startedAt, workerId: checkJobs.workerId, worker: checkWorkers.name })
    .from(checkJobs)
    .leftJoin(checkWorkers, eq(checkWorkers.id, checkJobs.workerId))
    .where(and(eq(checkJobs.companyId, companyId), eq(checkJobs.state, "running")))
    .orderBy(asc(checkJobs.startedAt));
  return rows.map(({ workerId, worker, ...j }) => ({ ...j, ranOn: placeOf(workerId, worker) }));
}

/** BOS-1942: where the latest ended merge check of each ticket ran, for a landing that now waits only for GitHub CI. */
export async function endedMergePlaces(db: Db, companyId: string, ticketIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>(); // lost on restart, harmless because it is a per-call local result, not module state.
  if (!ticketIds.length) return out;
  const rows = await db
    .select({ ticketId: checkJobs.ticketId, workerId: checkJobs.workerId, worker: checkWorkers.name })
    .from(checkJobs)
    .leftJoin(checkWorkers, eq(checkWorkers.id, checkJobs.workerId))
    .where(and(eq(checkJobs.companyId, companyId), eq(checkJobs.kind, "merge"), inArray(checkJobs.ticketId, ticketIds), isNotNull(checkJobs.startedAt), isNotNull(checkJobs.endedAt)))
    .orderBy(desc(checkJobs.endedAt));
  for (const r of rows) if (!out.has(r.ticketId)) out.set(r.ticketId, placeOf(r.workerId, r.worker));
  return out;
}

/** A fix that has been landing this long with no result is stalled (R28). */
export const FIX_LANDING_LIMIT_MIN = 60;

/**
 * R28: the approved rows held only by waits, narrowed to those waiting on a ticket marked as fixing the merge check.
 * The ids come from mergeHolds (the call that holds them), so the line can't disagree with the hold.
 */
async function heldBehindFixOf(
  db: Db,
  prefix: string | null | undefined,
  heldWaits: Map<string, { ids: string[]; since: string }>,
  view: { running: RunningNow[]; waiting: WaitingRow[] },
): Promise<HeldBehindFix | null> {
  const all = [...new Set([...heldWaits.values()].flatMap((h) => h.ids))];
  if (!all.length) return null;
  const fixes = await db
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, state: tickets.systemState, companyId: tickets.companyId, mergeCommit: tickets.mergeCommit, touchesRunner: tickets.touchesRunner, liveMarkedAt: tickets.liveMarkedAt })
    .from(tickets)
    .where(and(inArray(tickets.id, all), eq(tickets.fixesMergeCheck, true)));
  if (!fixes.length) return null;
  const fixIds = new Set(fixes.map((f) => f.id));
  const rows = [...heldWaits.values()].filter((h) => h.ids.some((id) => fixIds.has(id)));
  const out: HeldFix[] = [];
  let updateCardId: string | null | undefined;
  for (const f of fixes) {
    const run = view.running.find((r) => r.ticketId === f.id);
    const wait = view.waiting.find((w) => w.ticketId === f.id);
    const goLive = f.mergeCommit ? await goLiveWaitOf(db, f).catch(() => null) : null;
    let stateText: string;
    let stalled: HeldFix["stalled"] = null;
    if (f.mergeCommit) stateText = goLive === "own" ? "merged, waiting for the CEO to mark it live" : goLive ? `merged, ${goLiveWaitWords(goLive).replace(/^waiting for go-live: /, "waiting for ")}` : "merged";
    else if (run) {
      stateText = `merge check running, ${run.minutes} min`;
      // The time with no result: the wait for GitHub CI when there is one, else the check's own run.
      const noResult = Math.max(run.minutes, run.ci?.minutes ?? 0);
      if (noResult >= FIX_LANDING_LIMIT_MIN) stalled = { reason: `it has been ${run.ci ? "waiting for GitHub CI" : "landing"} for ${noResult} minutes with no result` };
    } else if (wait?.state === "waiting_for_ci") {
      // BOS-1871: its check is over and the landing waits only for GitHub CI; `minutes` is that wait's own clock, not the approval's.
      stateText = `waiting for GitHub CI, ${wait.minutes} min`;
      if (wait.minutes >= FIX_LANDING_LIMIT_MIN) stalled = { reason: `it has been waiting for GitHub CI for ${wait.minutes} minutes with no result` };
    } else if (wait) {
      stateText = `approved, waiting to land, ${wait.minutes} min`;
      // Whoever owns the wait (Boss Man, the CEO, an agent), an approved fix that has not landed in an hour is stalled.
      if (wait.minutes >= FIX_LANDING_LIMIT_MIN) stalled = { reason: `it has been approved for ${wait.minutes} minutes and has not landed` };
    } else if (f.state === "review") stateText = "in review";
    else if (f.state === "in_progress") {
      // Sent back: its latest review round asked for changes. Nobody's review is moving it now, so the line is stuck on it.
      const [last] = await db.select({ round: reviewRequests.round }).from(reviewRequests).where(eq(reviewRequests.ticketId, f.id)).orderBy(desc(reviewRequests.round)).limit(1);
      const sentBack = last ? (await db.select({ id: reviewRequests.id }).from(reviewRequests).where(and(eq(reviewRequests.ticketId, f.id), eq(reviewRequests.round, last.round), eq(reviewRequests.status, "changes_requested"))).limit(1)).length > 0 : false;
      stateText = sentBack ? "sent back for changes" : "being fixed";
      if (sentBack) stalled = { reason: "it was sent back from review, so it is not landing yet" };
    } else {
      stateText = f.state === "blocked" ? "blocked" : f.state === "ready" || f.state === "backlog" ? "not started" : f.state;
      stalled = { reason: `it is ${stateText}, so nobody is working on it` };
    }
    const ownerUpdate = !!f.mergeCommit && !!goLive && goLive !== "own";
    // Only the owner's server update is left: link the update card that is already open, and never raise a new one.
    if (ownerUpdate && updateCardId === undefined) {
      const [card] = await db
        .select({ id: decisions.id })
        .from(decisions)
        .where(and(eq(decisions.companyId, f.companyId), eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'deploy'`))
        .orderBy(desc(decisions.createdAt))
        .limit(1);
      updateCardId = card?.id ?? null;
    }
    out.push({ ticketId: f.id, ref: ticketRef(prefix, f.number), title: f.title, stateText, ownerUpdate, updateCardId: ownerUpdate ? (updateCardId ?? null) : null, stalled });
  }
  const since = rows.map((h) => h.since).sort()[0] ?? null;
  return { held: rows.length, fixes: out, since };
}

/** How many recently finished items the screen shows. */
export const RECENT_LIMIT = 10;
/** A merge still running after this long is flagged: a check may take an hour, a merge some minutes. */
export const RUNNING_LIMIT_MS = 60 * 60_000;
/** A ticket in review, approved and waiting to merge for longer than this is flagged as stuck. */
export const WAITING_LIMIT_MS = 60 * 60_000;

/** Who is acting on a stuck item, in the owner's words. */
export type ActorKind = "agent" | "ceo" | "owner" | "system";

export type MergePhase = "queued" | "checking" | "merging" | "waiting_to_retry" | "retrying_git";

export type RunningNow = {
  ticketId: string;
  ref: string | null;
  title: string;
  phase: MergePhase;
  startedAt: string;
  startedBy: string;
  /** Minutes since the merge started, against the 60-minute limit. */
  minutes: number;
  /** What is running: the merge check, or the agent's own check before review. */
  what: "merge_check" | "agent_check";
  slot: number;
  /** True past the limit, so the screen says what happens next. */
  overLimit: boolean;
  /** BOS-1070: waiting for GitHub CI on the merge commit (beside the check): minutes so far, and the jobs still running. */
  ci?: { minutes: number; waiting: string[] };
  /** BOS-1942: where the merge check runs, from its check job: the check worker's name, or "company runner" for this server; absent when no job is known. */
  ranOn?: string | null;
  /** BOS-1517: the same facts as one line. */
  statusLine: StatusLine;
};

/**
 * BOS-1517: the one status line of a ticket in the merge pipeline, from live state. `step` is what it is doing now, `since`
 * when it began that step (a running check's own start, never the landing's), `next` what happens after, `blocker` what is
 * in the way (null when nothing is).
 */
export type StatusLine = {
  step: string;
  since: string;
  next: string;
  blocker: string | null;
  /** BOS-2359: when the ticket is estimated to land (ISO): one usual GitHub wait after its run began, or after the landing turn ahead of it. Absent when not known. */
  landsAt?: string;
};

/**
 * BOS-2359: a project's landing turn as the Merges tab shows it: who holds it, what it waits for, when it should land, and the
 * usual GitHub wait that estimate rests on (the median of recent passed waits; null with too few). `overdue`: held for over
 * twice the usual wait (the CEO's alert fires at the same point).
 */
export type LandingTurnView = {
  projectId: string;
  holder: { ticketId: string; ref: string | null; title: string | null; since: string; waitingFor: string; waitingSince: string | null; landsAt: string | null; overdue: boolean };
  usualWaitMin: number | null;
  samples: number;
  line: Array<{ ticketId: string; ref: string | null; title: string | null; landsAt: string | null }>;
};

/**
 * waiting_for_ci (BOS-1871): its landing is under way, its check holds no slot any more, and it waits only for GitHub CI on its merge copy.
 * waiting_for_turn (BOS-2119): its landing is under way and waits for another ticket's landing turn (to re-check, or to push).
 */
export type WaitingState = "waiting_for_seat" | "waiting_for_slot" | "check_failed_retrying" | "needs_you" | "waiting_for_sign_off" | "waiting_for_check_capacity" | "checking" | "waiting_host" | "waiting_for_decision" | "waiting_for_other_ticket" | "held" | "waiting_for_ci" | "waiting_for_turn";

/** Approved work held by the carried-work guard (BOS-130): the ticket(s) it waits for, by ref and title. */
export type CarriedHold = { ticketId: string | null; ref: string | null; title: string };

export type WaitingRow = {
  ticketId: string;
  ref: string | null;
  title: string;
  /** Minutes the ticket has waited since its last approval (or since it entered review). */
  minutes: number;
  state: WaitingState;
  /** One line for the owner, plain words. */
  label: string;
  /** True when it has waited over an hour or its last check failed. */
  stuck: boolean;
  /** What happens next, when it is stuck or someone else is acting. */
  next: string | null;
  actor: ActorKind | null;
  /** The open card in the owner's Decisions this ticket waits on, when there is one. */
  decisionId: string | null;
  risk: RiskTier;
  urgent: boolean;
  /** True when its own last check failed (shown with the failing step). */
  failedCheck: boolean;
  /** The tickets this one waits for, when its branch carries their unapproved work (waiting_for_other_ticket). */
  carried?: CarriedHold[];
  /** The card that holds the merge (BOS-1078), so the screen names it and links straight to it. */
  card?: HoldingCardView | null;
  /** BOS-1384: place among the queued checks (1 is next) and why it is ahead ("urgent", "moved to front by …"); null when not queued. */
  place?: number | null;
  why?: string | null;
  /** BOS-1803: "background lane: …" for a waiting background-lane merge (how long newer ordinary work still goes first); null otherwise. */
  lane?: string | null;
  /** When the owner's sign-off for this round was given, if it was: a merge held by another card says so. */
  signedOffAt?: string | null;
  /** BOS-1517: the one status line (step, since, next, what is in the way). */
  statusLine?: StatusLine;
  /** BOS-1942: for waiting_for_ci, where the finished merge check ran (same values as RunningNow.ranOn). */
  ranOn?: string | null;
  /** BOS-1515: held by the merge train to land on main alone: who it clashed with (refs), the files, since when. */
  heldAlone?: { clashWith: string[]; files: string[]; since: string | null; holdsLine: boolean } | null;
};

/** BOS-1515: a ticket the merge train holds to land on main alone (merge-stall.ts mergeTrainStatus). */
export type HeldAloneView = { ticketId: string; clashWith: string[]; files: string[]; since: string | null; holdsLine: boolean };

/** The card a waiting merge is held by, in the owner's words (BOS-1078). */
export type HoldingCardView = {
  id: string;
  /** sign_off: the owner's sign-off; hold: a card that holds the merge on purpose; merge: the merge's own card (a stuck check). */
  kind: "sign_off" | "hold" | "merge";
  /** The card's question, first line, shortened. */
  question: string;
  /** Who raised it: an agent's name, or null for Boss Man itself. */
  raisedBy: string | null;
  raisedAt: string;
  /** Set when the card looks stale (it names a ticket that is done): the CEO is told. */
  staleHint: string | null;
};

/** A card's question as one short line for the screen. */
export function shortQuestion(q: string, max = 140): string {
  const line = q.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export type RecentRow = {
  ticketId: string;
  ref: string | null;
  title: string;
  result: "merged" | "check_failed";
  /** One line: a failure names the failing step. */
  detail: string;
  at: string;
  /** BOS-1938: the ticket's last finished merge check, quick or full, per stage; absent when no step times were kept. */
  stageLine?: string;
};

export type MergeQueueView = {
  companyId: string;
  mode: "legacy" | "server";
  slots: number;
  /** BOS-1942: the name Boss Man records for this server's host, for "Running on this server (name)"; null when none is recorded. */
  serverHost?: string | null;
  /** BOS-1942: what `slots` is made of, one entry per machine; only sent when more than one machine holds slots. */
  slotSplit?: Array<{ ranOn: string; slots: number }>;
  running: RunningNow[];
  waiting: WaitingRow[];
  recent: RecentRow[];
  /** BOS-2505: when the last ticket of the line is expected to land (ISO), the same figure as the banner's; null when it can't be told. */
  clearAt?: string | null;
  /** How many approved tickets are waiting to merge, not counting running ones (the start hold's figure). */
  waitingCount: number;
  /**
   * R43 (BOS-1716), mergeQueue.inLine: everything in the merge line, waiting or running: the side menu's badge, the
   * Merges tab and the Dashboard all show this one figure as "N in the merge line" (@boss-man/shared owner-figures).
   */
  lineCount: number;
  /** 1 while the merge line is stuck (the same verdict as `line`), else 0; slow-but-landing is not stuck (BOS-767, BOS-1594). */
  stuckCount: number;
  /** BOS-1594: the one verdict on the line's health (healthy, stuck, or merging but slowly); the banner and the jam alert both read it. */
  line: MergeLineHealth;
  /** R47: set while the start brake has no limit and the line has grown for an hour; the banner and the CEO's wake read it. */
  startBrakeOff?: StartBrakeOff | null;
  /** BOS-2359: each project's landing turn in this company, with the estimates; empty when no turn is held. */
  landingTurns?: LandingTurnView[];
};

/** One plain line from a check's last output: the first error-looking line, or the last line. */
export function failingLine(output: string | null | undefined): string | null {
  if (!output?.trim()) return null;
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.find((l) => /\b(error|failed|fail\b|not ok|ELIFECYCLE|command not found)\b/i.test(l));
  const line = bad ?? lines[lines.length - 1];
  return line ? line.replace(/\s+/g, " ").slice(0, 200) : null;
}

/**
 * The failing step of a check from its output: the script or command that printed the error,
 * else the error line itself. The owner reads this instead of the whole log.
 */
export function failingStep(output: string | null | undefined): string | null {
  const line = failingLine(output);
  if (!line) return null;
  const step = /(?:^|\s)(?:scripts\/[\w.-]+|pnpm [\w:.-]+|npm [\w:.-]+|npx [\w:.-]+)/.exec(line)?.[0]?.trim();
  return step && !line.startsWith(step) ? `${step}: ${line}` : line;
}

/** Where the merge is in the owner's words, from the running marker's phase. */
export const PHASE_LABEL: Record<MergePhase, string> = {
  queued: "waiting for a check slot",
  checking: "running the check",
  merging: "merging",
  waiting_to_retry: "trying again after the runner restarted",
  retrying_git: "retrying after a push/fetch failure to the git host",
};

/** BOS-1517: a running merge's step in the status line. Unlike PHASE_LABEL, "queued" here already holds a slot. */
const PHASE_TEXT: Record<MergePhase, string> = {
  queued: "about to start the check",
  checking: "running the check",
  merging: "merging",
  waiting_to_retry: "trying again after the runner restarted",
  retrying_git: "retrying after a push/fetch failure to the git host",
};

/** The prefix of the carried-work note `refuseCarried` writes on the held ticket (BOS-130). */
export const CARRIED_NOTE_PREFIX = "Waiting: its branch also carries";

/**
 * The carried-work hold's note and the titles it names, kept apart so a title is never parsed back out of
 * the prose (BOS-819): a title with a quote or an apostrophe used to be cut short there. `titles` is stored
 * as JSON in the note's own line, after the sentence the owner reads; a note without it is read the old way.
 */
export function carriedHold(note: string | null | undefined): { titles: string[]; note: string | null } {
  if (!note?.startsWith(CARRIED_NOTE_PREFIX)) return { titles: [], note: null };
  // The hidden line is the last one: the owner's sentence first, then the titles exactly as they are.
  const cut = note.lastIndexOf("\n");
  if (cut >= 0) {
    const rest = note.slice(cut + 1).trim();
    if (rest.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(rest);
        if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) return { titles: parsed, note: note.slice(0, cut) };
      } catch {
        // Not our marker (a title that happens to look like one): the sentence carries no titles.
      }
    }
  }
  // An older note, written before the titles were kept apart: quoted titles, best effort.
  return { titles: [...note.matchAll(/"([^"]+)"/g)].map((m) => m[1]!), note };
}

/** The ticket titles a carried-work hold names, as carriedHold reads them. */
export function carriedTitles(note: string | null | undefined): string[] {
  return carriedHold(note).titles;
}

/** What the owner reads for a hold on `titles`: the sentence only, never the hidden title list. */
export function carriedNoteText(note: string | null | undefined): string {
  return carriedHold(note).note ?? (note ?? "");
}

/**
 * BOS-1871: the words for a landing that waits only for GitHub CI on its merge copy, e.g. "waiting for GitHub CI (check), 12 min
 * so far". Written where that wait is decided (the landing's own CI marker), so the screen can't fall through to "next in line".
 */
export function ciWaitLabel(ci: { minutes: number; waiting: string[] }): string {
  return `waiting for GitHub CI on its merge copy${ci.waiting.length ? ` (${ci.waiting.join(", ")})` : ""}, ${waitedText(Math.max(0, ci.minutes))} so far`;
}

/**
 * BOS-2119 (R43): a merge waiting for another ticket's landing turn. "rebuild": it is in line for the turn and builds and
 * checks its merge again once the turn is its own; "push": its check passed and only the push waits.
 */
export type TurnWait = { holderId: string; since: number; then: "rebuild" | "push" };

/** The one line for a landing-turn wait, e.g. "waiting for BOS-12 to land, then re-checks". */
export function turnWaitLabel(holder: string, then: TurnWait["then"]): string {
  return then === "rebuild" ? `waiting for ${holder} to land, then re-checks` : `check passed; waiting for ${holder} to land, then pushes`;
}

/**
 * turnWaitLabel with the holder named the way every screen names a ticket (its reference, else its title). The Merges tab,
 * mergeState and server_status all call this, so the three can't disagree.
 */
export async function turnWaitWords(db: Db, w: TurnWait): Promise<string> {
  const [h] = await db.select({ number: tickets.number, title: tickets.title, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, w.holderId));
  return turnWaitLabel(ticketRef(h?.prefix ?? null, h?.number) ?? (h ? `"${h.title}"` : "another ticket"), w.then);
}

/** One plain duration for the owner, e.g. "1 h 10 min". */
export function waitedText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * The queries the screen runs, at module level so a test can EXPLAIN exactly what ships and prove
 * none of them scans a whole table (BOS-587's performance criterion).
 */
export const mergeQueueQueries = {
  /** Approved work still in review, oldest state change first: a company+state index range. */
  inReview: (db: Db, companyId: string) =>
    db
      .select({ id: tickets.id, number: tickets.number, title: tickets.title, urgent: tickets.urgent, risk: tickets.risk, pullRequestUrl: tickets.pullRequestUrl, pullRequestNote: tickets.pullRequestNote, lastActivityAt: tickets.lastActivityAt, stateChangedAt: tickets.stateChangedAt })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "review")))
      .orderBy(tickets.stateChangedAt)
      .limit(200),
  /**
   * The latest review round of the given tickets, one row per ticket and kind: whether it is approved.
   * The waiting list keeps only tickets whose reviews are all approved (a ticket still with its
   * reviewers is not waiting to merge), which is the same test the rest of the server uses.
   */
  latestReviews: (db: Db, ticketIds: string[]) =>
    db
      .select()
      .from(reviewRequests)
      .where(inArray(reviewRequests.ticketId, ticketIds)),
  /** Recently finished merges: a company+state index range since a cut-off. */
  recentlyDone: (db: Db, companyId: string, since: Date) =>
    db
      .select({ id: tickets.id, number: tickets.number, title: tickets.title, mergeCommit: tickets.mergeCommit, at: tickets.stateChangedAt })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done"), gte(tickets.stateChangedAt, since)))
      .orderBy(desc(tickets.stateChangedAt))
      .limit(RECENT_LIMIT * 2),
  /** BOS-1938: each ticket's finished merge checks that kept step times, newest first. */
  finishedMergeChecks: (db: Db, ticketIds: string[]) =>
    db
      .select({ ticketId: checkJobs.ticketId, stages: checkJobs.stages, ranFull: checkJobs.ranFull, busyAtStart: checkJobs.busyAtStart, startedAt: checkJobs.startedAt, endedAt: checkJobs.endedAt })
      .from(checkJobs)
      .where(and(inArray(checkJobs.ticketId, ticketIds), eq(checkJobs.kind, "merge"), inArray(checkJobs.state, ["passed", "failed"]), isNotNull(checkJobs.stages)))
      .orderBy(desc(checkJobs.endedAt)),
  /** When tickets landed (merged) since a cut-off, for the landing rate (R47). */
  landedSince: (db: Db, companyId: string, since: Date) =>
    db
      .select({ at: tickets.stateChangedAt })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done"), isNotNull(tickets.mergeCommit), gte(tickets.stateChangedAt, since))),
  /** Failed checks on finished tickets, through the company+time index (0105). */
  recentFailedChecks: (db: Db, companyId: string, since: Date) =>
    db
      .select({ ticketId: checkResults.ticketId, at: checkResults.at, detail: checkResults.detail, title: tickets.title, number: tickets.number })
      .from(checkResults)
      .innerJoin(tickets, eq(tickets.id, checkResults.ticketId))
      .where(and(eq(checkResults.companyId, companyId), eq(checkResults.passed, false), gte(checkResults.at, since), eq(tickets.systemState, "done")))
      .orderBy(desc(checkResults.at))
      .limit(RECENT_LIMIT),
};

export function mergeQueueService(
  db: Db,
  deps: {
    /** This process's running merges, from the review service's own markers. */
    runningMerges: () => Array<{ ticketId: string; startedAt: string; startedBy: string; phase?: MergePhase; ci?: { since: string; waiting: string[] }; turn?: TurnWait; pushingSince?: string }>;
    /** The check slot limit: how many merge checks run at once. */
    limit: () => Promise<number>;
    /** The check queue's own slot setting and mode (BOS-316); null when it is not running. */
    /** This company's running check jobs, oldest start first: what really holds a slot (server mode). */
    runningChecks?: (companyId: string) => Promise<Array<{ ticketId: string; kind: string; startedAt?: Date | null; ranOn?: string | null }>>;
    /** BOS-1942: where each ticket's latest finished merge check ran (worker name or "company runner"), for a landing that waits only for GitHub CI. */
    endedMergePlaces?: (companyId: string, ticketIds: string[]) => Promise<Map<string, string>>;
    /** BOS-1942: the name Boss Man records for this server's host. */
    serverHost?: () => Promise<string | null>;
    /** BOS-1942: how many of the check slots each machine holds (ranOn as in RunningNow). */
    slotSplit?: (companyId: string) => Promise<Array<{ ranOn: string; slots: number }>>;
    queueStatus?: (companyId: string) => Promise<{ mode: "legacy" | "server"; slots: number; running: number; waiting: number } | null>;
    /** BOS-1384: each queued merge's place in the check queue's serving order, and why it is ahead (urgent, moved to front). */
    places?: (companyId: string) => Promise<Map<string, { place: number | null; why: string | null; seatPlace?: number | null; lane?: string | null }>>;
    /** BOS-1486: whether this company's runner is connected right now (a waiting merge can't start without one). */
    runnerConnected?: (companyId: string) => Promise<boolean>;
    /** BOS-1486: a runner update is holding the line (a wrap-up hold is not one). */
    runnerUpdateOn?: () => Promise<boolean>;
    /** BOS-1486: whether the launcher is on, so the screen may point at Start runner in Settings. */
    launcherOn?: () => boolean;
    /** BOS-1486: what holds the check slots and whether a red main holds checks back (server mode only). */
    queueDetail?: (companyId: string) => Promise<{ slots: number; busy: Array<{ ref: string | null; title: string; kind: string }>; mainRed: boolean; fixRef: string | null; /** BOS-1517: merges whose check is held until the ticket has a merge-train seat. */ seatWait?: string[]; /** BOS-1515: tickets held to land on main alone, with the clash (refs and files). */ heldAlone?: HeldAloneView[] }>;
    /** BOS-1594: when a merge-train seat went empty (epoch ms), or null; the merge stall alarm's own clock. */
    emptySeatSince?: (companyId: string) => Promise<number | null>;
    /** BOS-1594: whether a check worker is connected and ready for this company; the capacity advice names a worker only when it is not. */
    workerReady?: (companyId: string) => Promise<boolean>;
    /** BOS-2359: the company's landing turns (review.landingTurnStatus); absent: none are shown. */
    landingTurns?: (companyId: string) => Promise<Array<{ projectId: string; holder: { ticketId: string; ref: string | null; title: string | null; since: string } | null; line: Array<{ ticketId: string; ref: string | null; title: string | null }> }>>;
    /** BOS-2359: the usual GitHub wait of a landing (landing-turn-eta.ts usualCiWait); null with too few recent landings. */
    usualCiWait?: (companyId: string) => Promise<{ ms: number; samples: number } | null>;
    /** BOS-2505: the usual length of a passed merge check (landing-turn-eta.ts usualMergeCheck); null with too few. */
    usualMergeCheck?: (companyId: string) => Promise<{ ms: number; samples: number } | null>;
    now?: () => Date;
  },
) {
  const now = deps.now ?? (() => new Date());
  const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));

  type OwnerCard = { id: string; tier: string; type: string; question: string; raisedBy: string | null; raisedAt: Date };
  const cardCols = { id: decisions.id, tier: decisions.tier, context: decisions.context, question: decisions.question, raisedAt: decisions.createdAt, raisedBy: agents.name };
  const toCard = (r: { id: string; tier: string; context: unknown; question: string; raisedAt: Date; raisedBy: string | null }): OwnerCard => ({ id: r.id, tier: r.tier, type: (r.context as { type?: string } | null)?.type ?? "", question: r.question, raisedBy: r.raisedBy, raisedAt: r.raisedAt });

  /**
   * The open card that holds each ticket's merge: the owner's sign-off first, then a card the gate holds the merge
   * for (holdsMergeSql, the same rule as openHoldingCard, BOS-1078), then the merge's own cards. A card that is only
   * linked to the ticket (a plain question, an owner to-do) holds nothing, so it isn't shown as what the merge waits on.
   */
  async function ownerCards(ticketIds: string[]) {
    const out = new Map<string, OwnerCard>();
    if (!ticketIds.length) return out;
    const linked = await db
      .select({ ...cardCols, ticketId: ticketDependencies.blockedTicketId })
      .from(ticketDependencies)
      .innerJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
      .leftJoin(agents, eq(agents.id, decisions.raisedByAgentId))
      .where(and(inArray(ticketDependencies.blockedTicketId, ticketIds), eq(decisions.status, "open"), or(sql`${decisions.context}->>'type' = 'risk_review'`, holdsMergeSql)))
      .orderBy(decisions.createdAt);
    // The sign-off before any other card: it is the owner's own gate, and the screen says so.
    const cards = linked.map((r) => ({ ticketId: r.ticketId, card: toCard(r) }));
    for (const { ticketId, card } of [...cards.filter((c) => c.card.type === "risk_review"), ...cards.filter((c) => c.card.type !== "risk_review")]) if (ticketId && !out.has(ticketId)) out.set(ticketId, card);
    // The merge cards (a stuck check, a retry) hang off no dependency row; they carry the ticket in their context.
    const mergeCards = await db
      .select(cardCols)
      .from(decisions)
      .leftJoin(agents, eq(agents.id, decisions.raisedByAgentId))
      .where(and(eq(decisions.status, "open"), inArray(decisions.dedupeKey, ticketIds.map((id) => `merge-stuck:${id}`))));
    for (const r of mergeCards) {
      const ticketId = (r.context as { ticketId?: string } | null)?.ticketId;
      if (ticketId && ticketIds.includes(ticketId) && !out.has(ticketId)) out.set(ticketId, toCard(r));
    }
    return out;
  }

  /**
   * A hint for the CEO that a card holding a merge may be stale (BOS-1078): it names another ticket of the company,
   * by reference (BOS-12) or id, that is done now. Only a hint, never acted on: the CEO checks and withdraws it.
   */
  async function staleHint(companyId: string, prefix: string | null, heldId: string, text: string): Promise<string | null> {
    const refs = prefix ? [...new Set([...text.matchAll(new RegExp(`\\b${prefix.replace(/[^A-Za-z0-9]/g, "")}-(\\d{1,7})\\b`, "g"))].map((m) => Number(m[1])))].slice(0, 10) : [];
    const ids = [...new Set([...text.matchAll(/\b([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi)].map((m) => m[1]!.toLowerCase()))].slice(0, 10);
    if (!refs.length && !ids.length) return null;
    const named = or(...(refs.length ? [inArray(tickets.number, refs)] : []), ...ids.map((id) => sql`${tickets.id}::text like ${`${id}%`}`));
    const [done] = await db
      .select({ number: tickets.number, title: tickets.title, id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done"), sql`${tickets.id} <> ${heldId}`, named))
      .limit(1);
    if (!done) return null;
    return `It names ${ticketRef(prefix, done.number) ?? `"${done.title}"`}, which is done now, so it may no longer be needed.`;
  }

  /** The latest check result for each ticket, from the indexed ticket+time lookup. */
  async function latestChecks(ticketIds: string[]) {
    if (!ticketIds.length) return new Map<string, { passed: boolean; kind: string; at: Date; detail: string | null }>();
    const latest = db
      .selectDistinctOn([checkResults.ticketId])
      .from(checkResults)
      .where(inArray(checkResults.ticketId, ticketIds))
      .orderBy(checkResults.ticketId, desc(checkResults.at))
      .as("latest");
    const rows = await db.select({ ticketId: latest.ticketId, passed: latest.passed, kind: latest.kind, at: latest.at, detail: latest.detail }).from(latest);
    return new Map(rows.map((r) => [r.ticketId, r]));
  }

  /**
   * The tickets named by a carried-work hold, found by their titles (the note names only titles), inside
   * the same company: a branch may carry work from a ticket in another project. A title that matches
   * nothing keeps its name, with no ref.
   */
  async function carriedOf(companyId: string, prefix: string | null, titles: string[]): Promise<CarriedHold[]> {
    if (!titles.length) return [];
    const found = await db
      .select({ id: tickets.id, title: tickets.title, number: tickets.number })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), inArray(tickets.title, titles)));
    return titles.map((title) => {
      const hit = found.find((f) => f.title === title);
      return { title, ticketId: hit?.id ?? null, ref: ticketRef(prefix, hit?.number) };
    });
  }

  /** Recently finished merges and failed checks, newest first. */
  async function recent(companyId: string, prefix: string | null, t: Date): Promise<RecentRow[]> {
    const since = new Date(t.getTime() - 7 * 24 * 3_600_000);
    const done = await mergeQueueQueries.recentlyDone(db, companyId, since);
    const merged: RecentRow[] = done
      .filter((r) => r.mergeCommit)
      .slice(0, RECENT_LIMIT)
      .map((r) => ({ ticketId: r.id, ref: ticketRef(prefix, r.number), title: r.title, result: "merged", detail: `merged as ${r.mergeCommit!.slice(0, 7)}`, at: r.at.toISOString() }));

    // Failed checks on finished tickets, so a failure that stopped a merge shows its step.
    const failed = await mergeQueueQueries.recentFailedChecks(db, companyId, since);
    const out = [...merged];
    for (const f of failed) {
      if (out.some((r) => r.ticketId === f.ticketId)) continue;
      out.push({ ticketId: f.ticketId, ref: ticketRef(prefix, f.number), title: f.title, result: "check_failed", detail: `check failed: ${failingStep(f.detail) ?? "no output recorded"}`, at: f.at.toISOString() });
    }
    const shown = out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, RECENT_LIMIT);
    if (!shown.length) return shown;
    const jobs = await mergeQueueQueries.finishedMergeChecks(db, shown.map((r) => r.ticketId));
    const slots = await deps.limit();
    return shown.map((r) => {
      const line = jobs.filter((j) => j.ticketId === r.ticketId).map((j) => stageLine(j, slots)).find(Boolean);
      return line ? { ...r, stageLine: line } : r;
    });
  }

  /**
   * Keep only the tickets that are waiting to merge: those whose latest review round has no review
   * still to come and none that asked for changes. A ticket with no reviews at all has no verdict
   * yet, so it is not waiting; a sign-off (a risk card) is still waiting, as it must be approved.
   */
  async function approvedOnly<T extends { id: string }>(rows: T[]): Promise<T[]> {
    if (!rows.length) return rows;
    const reviews = await mergeQueueQueries.latestReviews(db, rows.map((r) => r.id));
    const byTicket = new Map<string, Map<number, typeof reviews>>();
    for (const r of reviews) {
      const rounds = byTicket.get(r.ticketId) ?? new Map<number, typeof reviews>();
      rounds.set(r.round, [...(rounds.get(r.round) ?? []), r]);
      byTicket.set(r.ticketId, rounds);
    }
    return rows.filter((row) => {
      const rounds = byTicket.get(row.id);
      if (!rounds?.size) return false;
      const latest = [...rounds.keys()].sort((a, b) => b - a)[0]!;
      return evaluate(rounds.get(latest)!) === "passed";
    });
  }

  /**
   * Running now: this process's merges (the same markers the ticket page shows), with their phase.
   * In server mode only a check that holds a slot is "running" (BOS-1287): a merge the server started again
   * after a restart is only queued until the check queue starts it. Slots are numbered by start order among
   * the running checks, so each is unique and never past the limit.
   */
  async function liveMerges(companyId: string) {
    let live = deps.runningMerges().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const slotOf = new Map<string, number>();
    const restarted = new Set<string>();
    // BOS-1517: when each running check itself began. The landing's start (runningMerges) can be hours older: it covers the
    // wait for a seat and earlier attempts.
    const checkStart = new Map<string, Date>();
    // BOS-1871: landings whose check holds no slot (it has ended) but whose wait for GitHub CI is still open. They are
    // not running a check, so they stay out of Running now, but they are not waiting for one either.
    const ciWait = new Map<string, { since: string; waiting: string[] }>();
    // BOS-2119 (R43): landings waiting for another ticket's landing turn, holding no slot. Like ciWait: under way, not waiting for a check.
    const turnWait = new Map<string, TurnWait>(); // not state: local to this call
    // BOS-1942: where each running merge check runs, from its check job.
    const ranOnOf = new Map<string, string>();
    const queueMode = deps.runningChecks ? await deps.queueStatus?.(companyId).catch(() => null) : null;
    if (deps.runningChecks && queueMode?.mode === "server") {
      const held = await deps.runningChecks(companyId);
      held.forEach((j, i) => { if (j.kind === "merge" && !slotOf.has(j.ticketId)) { slotOf.set(j.ticketId, i + 1); if (j.startedAt) checkStart.set(j.ticketId, j.startedAt); if (j.ranOn) ranOnOf.set(j.ticketId, j.ranOn); } });
      for (const l of live) if (!slotOf.has(l.ticketId) && /restarted/i.test(l.startedBy)) restarted.add(l.ticketId);
      for (const l of live) if (!slotOf.has(l.ticketId) && l.ci) ciWait.set(l.ticketId, l.ci);
      for (const l of live) if (!slotOf.has(l.ticketId) && l.turn) turnWait.set(l.ticketId, l.turn);
      // BOS-2479: a push to main under way holds no slot (its check is over) but is what a runner update waits for, so it
      // stays in Running now: whenever the update banner says a merge is being pushed, this tab shows it.
      live = live.filter((l) => slotOf.has(l.ticketId) || !!l.pushingSince);
      // BOS-1757: a running merge job is what holds a slot, so it is listed even when no landing marker owns it (the ticket
      // was sent back, or the server restarted). The Checks panel counts the same rows, so the two screens can't disagree.
      const marked = new Set(live.map((l) => l.ticketId));
      for (const j of held) {
        if (j.kind !== "merge" || marked.has(j.ticketId)) continue;
        marked.add(j.ticketId);
        live.push({ ticketId: j.ticketId, startedAt: (j.startedAt ?? new Date(0)).toISOString(), startedBy: "the merge gate (no landing is waiting on it)" });
      }
    }
    return { live, slotOf, restarted, checkStart, ciWait, turnWait, ranOnOf };
  }

  return {
    /**
     * How many approved tickets wait in the merge line, not counting running merges: the same figure as `get(...).waitingCount`
     * (the screen's rows are exactly these), without building the rest of the view. BOS-1489's start hold reads it.
     */
    async waitingCount(companyId: string): Promise<number> {
      const { live } = await liveMerges(companyId);
      const running = new Set(live.map((l) => l.ticketId));
      const approved = await approvedOnly(await mergeQueueQueries.inReview(db, companyId));
      return approved.filter((r) => !running.has(r.id)).length;
    },
    /** Everything in the merge line, waiting or landing (including a landing that only waits for GitHub CI): the cheap form of `get(...).lineCount`. */
    async lineSize(companyId: string): Promise<number> {
      const { live, ciWait } = await liveMerges(companyId);
      return (await this.waitingCount(companyId)) + live.length + ciWait.size;
    },
    async get(companyId: string): Promise<MergeQueueView> {
      const t = now();
      const [company] = await db.select({ prefix: companies.ticketPrefix, brakeLimit: companies.holdStartsMergesWaiting }).from(companies).where(eq(companies.id, companyId));
      const prefix = company?.prefix ?? null;

      const { live, slotOf, restarted, checkStart, ciWait, turnWait, ranOnOf } = await liveMerges(companyId);
      const limit = await deps.limit();
      const liveIds = live.map((l) => l.ticketId);
      const liveTitles = liveIds.length
        ? new Map((await db.select({ id: tickets.id, title: tickets.title, number: tickets.number }).from(tickets).where(inArray(tickets.id, liveIds))).map((r) => [r.id, r]))
        : new Map<string, { id: string; title: string; number: number | null }>();
      const running: RunningNow[] = live.map((l, i) => {
        const row = liveTitles.get(l.ticketId);
        const started = checkStart.get(l.ticketId) ?? new Date(l.startedAt);
        const elapsed = t.getTime() - started.getTime();
        const phase = l.phase ?? "checking";
        const slot = slotOf.get(l.ticketId) ?? (i % Math.max(1, limit)) + 1;
        const over = elapsed > RUNNING_LIMIT_MS;
        // BOS-2479: a push with no slot of its own says so, with when the push began (the banner's "being pushed").
        const pushOnly = !!l.pushingSince && !slotOf.has(l.ticketId);
        return {
          statusLine: {
            step: pushOnly ? "pushing to main" : `slot ${slot}: ${PHASE_TEXT[phase]}`,
            since: pushOnly ? l.pushingSince! : started.toISOString(),
            next: phase === "merging" ? "It is done once the merge is in." : "It merges by itself if the check passes.",
            blocker: over ? "The check has run for over an hour." : null,
          },
          ticketId: l.ticketId,
          ref: ticketRef(prefix, row?.number),
          title: row?.title ?? "a ticket",
          phase,
          startedAt: started.toISOString(),
          startedBy: l.startedBy,
          minutes: mins(elapsed),
          what: "merge_check",
          slot,
          overLimit: over,
          ...(ranOnOf.has(l.ticketId) ? { ranOn: ranOnOf.get(l.ticketId) } : {}),
          ...(l.ci ? { ci: { minutes: mins(t.getTime() - new Date(l.ci.since).getTime()), waiting: l.ci.waiting } } : {}),
        };
      });

      // Waiting: approved work still in review. A ticket still with its reviewers is not waiting to
      // merge, so only those whose latest review round is all approved (or overruled) are kept.
      const inReviewAll = await mergeQueueQueries.inReview(db, companyId);
      const inReview = await approvedOnly(inReviewAll);
      const ids = inReview.map((r) => r.id);
      const checks = await latestChecks(ids);
      const cards = await ownerCards(ids);
      const runningIds = new Set(running.map((r) => r.ticketId));
      const queue = deps.queueStatus ? await deps.queueStatus(companyId).catch(() => null) : null;
      // A server update waiting for a quiet machine parks new checks (BOS-420): say so rather than "waiting for a slot".
      const soft = await softHold(db, t).catch(() => ({ on: false as const }));
      const held = soft.on;
      // BOS-1486: live state for the reason a merge waits. Absent deps (older callers, tests) mean "unknown", never a reason.
      const runnerUp = deps.runnerConnected ? await deps.runnerConnected(companyId).catch(() => null) : null;
      const runnerUpdateOn = deps.runnerUpdateOn ? await deps.runnerUpdateOn().catch(() => false) : false;
      const detail = deps.queueDetail && queue?.mode === "server" ? await deps.queueDetail(companyId).catch(() => null) : null;

      const waiting: WaitingRow[] = [];
      // BOS-1517: the status line's own parts, set as each row's reason is worked out (a hold's label is its step).
      const sinceOf = new Map<string, string>();
      const blockerOf = new Map<string, string>();
      const stepOf = new Map<string, string>();
      const heldWaits = new Map<string, { ids: string[]; since: string }>();
      // BOS-1942: where the finished check of each ticket that waits only for GitHub CI ran.
      const endedPlaces = deps.endedMergePlaces && ciWait.size ? await deps.endedMergePlaces(companyId, [...ciWait.keys()]).catch(() => new Map<string, string>()) : new Map<string, string>();
      for (const r of inReview) {
        if (runningIds.has(r.id)) continue;
        // BOS-1871: its landing is under way and waits only for GitHub CI on the merge copy (the check is over, so it holds no
        // slot). Said here, from the landing's own CI marker, before any reason a merge that hasn't started would have.
        const ci = ciWait.get(r.id);
        if (ci) {
          const since = new Date(ci.since);
          const words = ciWaitLabel({ minutes: mins(t.getTime() - since.getTime()), waiting: ci.waiting });
          sinceOf.set(r.id, since.toISOString());
          waiting.push({
            ticketId: r.id,
            ref: ticketRef(prefix, r.number),
            title: r.title,
            minutes: mins(t.getTime() - since.getTime()),
            risk: riskOf(r.risk),
            urgent: r.urgent,
            failedCheck: false,
            state: "waiting_for_ci",
            ...(endedPlaces.has(r.id) ? { ranOn: endedPlaces.get(r.id) } : {}),
            label: words,
            stuck: false,
            next: "It merges by itself once GitHub CI passes.",
            actor: "system",
            decisionId: null,
          });
          continue;
        }
        // BOS-2119 (R43): its landing is under way and waits for another ticket's landing turn, holding no slot. Said from the
        // landing's own marker, so it can't fall through to "next in line for a check… a slot is free".
        const turn = turnWait.get(r.id);
        if (turn) {
          const since = new Date(turn.since);
          sinceOf.set(r.id, since.toISOString());
          waiting.push({
            ticketId: r.id,
            ref: ticketRef(prefix, r.number),
            title: r.title,
            minutes: mins(t.getTime() - since.getTime()),
            risk: riskOf(r.risk),
            urgent: r.urgent,
            failedCheck: false,
            state: "waiting_for_turn",
            label: await turnWaitWords(db, turn),
            stuck: false,
            next: "It goes on by itself when that ticket lands or its turn ends.",
            actor: "system",
            decisionId: null,
          });
          continue;
        }
        const card = cards.get(r.id);
        const check = checks.get(r.id);
        const failedCheck = check ? !check.passed : false;
        // How long it has waited, in milliseconds so the "over an hour" limit compares like with like
        // (the ticket shows whole minutes). The last activity is the best stamp we have for an approval.
        const waitedMs = t.getTime() - r.lastActivityAt.getTime();
        sinceOf.set(r.id, r.lastActivityAt.toISOString());
        const overAnHour = waitedMs > WAITING_LIMIT_MS;
        const base = { ticketId: r.id, ref: ticketRef(prefix, r.number), title: r.title, minutes: mins(waitedMs), risk: riskOf(r.risk), urgent: r.urgent, failedCheck };
        // A reviewer's hold (BOS-808): held on purpose, so never "stuck" and never waiting for a slot.
        // DR-061 Q2b: the one merge-hold answer (mergeHolds), the same one the merge paths refuse on.
        const holds = await mergeHolds(db, r.id);
        const hold = holds.some((h) => h.kind === "hold") ? await holdView(db, r.id, t) : null;
        // R28: what holds this row is only waits on other tickets (Boss Man's own hold, or none yet): note them for the line's one verdict.
        const waitIds = holds.find((h): h is Extract<typeof h, { kind: "waits" }> => h.kind === "waits")?.ids ?? [];
        if (waitIds.length && holds.every((h) => h.kind === "waits" || (h.kind === "hold" && hold?.system))) heldWaits.set(r.id, { ids: waitIds, since: hold?.createdAt ?? r.lastActivityAt.toISOString() });
        const checking = holds.some((h) => h.kind === "check");
        // BOS-2303: approved while its own quick check runs; with or without Boss Man's hold yet, it is not next in line.
        if (checking && (!hold || hold.system)) {
          waiting.push({ ...base, state: "held", label: `approved, held by Boss Man: ${hold?.label ?? "waits for its quick check"}`, stuck: false, next: "It merges by itself once its quick check passes; a failure sends it back to its agent.", actor: "system", decisionId: null });
          continue;
        }
        if (hold) {
          // Boss Man's own hold (BOS-1173): approved work waiting on a fix; it releases itself once the fix is merged and live.
          if (hold.system) waiting.push({ ...base, state: "held", label: `approved, held by Boss Man: ${hold.label}`, stuck: false, next: "It merges by itself once what it waits on is merged and live. Nobody needs to review it again.", actor: "agent", decisionId: null });
          else waiting.push({ ...base, state: "held", label: `held by ${hold.reviewer ?? "a reviewer"}: ${hold.label}`, stuck: false, next: hold.ready ? "What it waited for is done; the reviewer re-checks and releases it." : "Boss Man wakes the reviewer once what it waits on has closed.", actor: "agent", decisionId: null });
          continue;
        }
        const view = (kind: HoldingCardView["kind"], staleHintText: string | null = null): HoldingCardView => ({ id: card!.id, kind, question: shortQuestion(card!.question), raisedBy: card!.raisedBy, raisedAt: card!.raisedAt.toISOString(), staleHint: staleHintText });
        if (card?.type === "risk_review") {
          waiting.push({ ...base, state: "waiting_for_sign_off", label: "waiting for your sign-off", stuck: overAnHour || failedCheck, next: "Boss Man merges it as soon as you answer the sign-off.", actor: "owner", decisionId: card.id, card: view("sign_off"), signedOffAt: null });
          continue;
        }
        if (card?.type === "check_stuck") {
          waiting.push({ ...base, state: "needs_you", label: "stopped: needs you", stuck: true, next: "Open the card to run the check again, send it back, or skip it.", actor: card.tier === "ceo" ? "ceo" : "owner", decisionId: card.id, card: view("merge") });
          continue;
        }
        if (card) {
          // A card that holds the merge on purpose (BOS-1078): name it, and say when the owner's own sign-off is already done.
          const merge = card.type !== "question" && card.type !== "review_loop";
          const [full] = await db.select().from(tickets).where(eq(tickets.id, r.id));
          // Loaded here, not at the top: signoff.ts reaches decisions.ts and review.ts, which import this module.
          const { derivedSignoff } = await import("./signoff.js");
          const so = full ? await derivedSignoff(db, full).catch(() => null) : null;
          const signedOffAt = so?.state === "signed_off" ? so.at.toISOString() : null;
          const hint = merge ? null : await staleHint(companyId, prefix, r.id, card.question).catch(() => null);
          const who = card.raisedBy ?? "Boss Man";
          waiting.push({
            ...base,
            state: "waiting_for_decision",
            label: `held by ${who}'s card: "${shortQuestion(card.question, 80)}"`,
            stuck: overAnHour || failedCheck,
            next: `${signedOffAt ? "Your sign-off is done; " : ""}it merges once that card is answered.`,
            actor: card.tier === "ceo" ? "ceo" : "owner",
            decisionId: card.id,
            card: view(merge ? "merge" : "hold", hint),
            signedOffAt,
          });
          continue;
        }
        // A wait on another ticket (mergeWaits): the merge gate refuses it, so the screen must not say "next in line".
        if (holds.some((h) => h.kind === "waits")) {
          waiting.push({ ...base, state: "waiting_for_other_ticket", label: "waiting for another ticket to be merged and live", stuck: false, next: "It merges by itself once what it waits on is merged and live.", actor: "system", decisionId: null });
          continue;
        }
        if (r.pullRequestUrl && r.pullRequestNote) {
          waiting.push({ ...base, state: "waiting_host", label: `pull request waiting on the host: ${carriedNoteText(r.pullRequestNote).slice(0, 120)}`, stuck: overAnHour || failedCheck, next: "Boss Man checks the host again every couple of minutes.", actor: "system", decisionId: null });
          continue;
        }
        // The carried-work guard held it (BOS-130, BOS-766): its branch also has another ticket's unapproved
        // work, so it waits for that ticket, not for a check slot. A card here was handled above.
        const heldTitles = carriedTitles(r.pullRequestNote);
        if (!r.pullRequestUrl && heldTitles.length) {
          const carried = await carriedOf(companyId, prefix, heldTitles);
          const names = carried.map((c) => c.ref ?? `"${c.title}"`).join(", ");
          const one = carried.length === 1;
          waiting.push({
            ...base,
            state: "waiting_for_other_ticket",
            label: `waiting for ${names} to merge first`,
            stuck: overAnHour || failedCheck,
            next: one ? `${names} has to be reviewed and merged first.` : `${names} have to be reviewed and merged first.`,
            actor: "system",
            decisionId: null,
            carried,
          });
          continue;
        }
        if (failedCheck) {
          waiting.push({ ...base, state: "check_failed_retrying", label: `check failed: retrying (${failingStep(check!.detail) ?? "no output recorded"})`, stuck: true, next: "Boss Man sends it back to the agent with the failure.", actor: "agent", decisionId: null });
          continue;
        }
        const why = restarted.has(r.id) ? "; the server restarted during this merge, so it is starting again" : "";
        // BOS-1486: the reason is worked out from live state, in this order: no runner; an update holding the line;
        // a red main; every slot busy (naming what is in each); otherwise next in line.
        if (runnerUp === false) {
          blockerOf.set(r.id, "No runner is connected.");
          waiting.push({ ...base, state: "waiting_for_slot", label: `waiting: no runner is connected${why}`, stuck: overAnHour, next: deps.launcherOn?.() ? "Start the runner in Settings → Server and runner → Runner. Boss Man checks it as soon as the runner connects." : "Start the runner container on your host; it connects by itself, and Boss Man checks this as soon as it does.", actor: "system", decisionId: null });
          continue;
        }
        if (runnerUpdateOn) {
          blockerOf.set(r.id, "A runner update is holding new checks.");
          waiting.push({ ...base, state: "waiting_for_slot", label: `waiting for the runner update${why}`, stuck: false, next: "New checks start once the runner update is done (runs in progress finish first, then each runner is swapped).", actor: "system", decisionId: null });
          continue;
        }
        if (held) {
          blockerOf.set(r.id, "A server update is holding new checks.");
          waiting.push({ ...base, state: "waiting_for_slot", label: `waiting for the server update${why}`, stuck: false, next: "New checks start once the server update is done (it waits for a quiet machine, then its standby window).", actor: "system", decisionId: null });
          continue;
        }
        // BOS-1517: a merge waiting for a seat in the merge train has no check to wait for yet: its check starts once it is
        // seated. Saying "waiting for a check slot (21 ahead)" here counted the whole queue and named the wrong thing.
        const alone = detail?.heldAlone?.find((h) => h.ticketId === r.id);
        if (alone) {
          // BOS-1515: held to land on main alone. Say who it clashed with and in which files, and what happens next.
          const clash = clashWords(alone.clashWith, alone.files);
          blockerOf.set(r.id, "The tickets ahead in the merge train haven't landed yet.");
          waiting.push({
            ...base,
            state: "waiting_for_seat",
            label: `waiting to land on main alone: it clashed with ${clash}${why}`,
            stuck: overAnHour,
            next: alone.holdsLine
              ? "It goes next, once the tickets ahead have landed; others wait behind it until then. It is sent back at once if the clash reaches main."
              : "It goes once the tickets ahead have landed. It is sent back at once if the clash reaches main.",
            actor: "system",
            decisionId: null,
            heldAlone: { clashWith: alone.clashWith, files: alone.files, since: alone.since, holdsLine: alone.holdsLine },
          });
          continue;
        }
        if (detail?.seatWait?.includes(r.id)) {
          blockerOf.set(r.id, "Every merge-train seat is taken.");
          waiting.push({ ...base, state: "waiting_for_seat", label: `waiting for a train seat${why}`, stuck: overAnHour, next: "It takes a seat as soon as one frees; its check then starts by itself.", actor: "system", decisionId: null });
          continue;
        }
        if (detail?.mainRed) {
          blockerOf.set(r.id, "Main is failing its check.");
          waiting.push({ ...base, state: "waiting_for_slot", label: `waiting: main is failing its check${why}`, stuck: false, next: detail.fixRef ? `New checks wait until the fix (${detail.fixRef}) merges.` : "New checks wait until main is fixed.", actor: "system", decisionId: null });
          continue;
        }
        if (detail && detail.busy.length >= detail.slots) {
          const names = detail.busy.map((b, i) => `slot ${i + 1}: ${b.ref ?? b.title} (${b.kind})`).join("; ");
          blockerOf.set(r.id, `Every slot is busy: ${names}.`);
          stepOf.set(r.id, `waiting for a check slot (${queue?.waiting ?? 0} ahead)${why}`);
          waiting.push({ ...base, state: "waiting_for_check_capacity", label: `waiting for a check slot (${queue?.waiting ?? 0} ahead). Every slot is busy: ${names}${why}`, stuck: overAnHour, next: "Boss Man starts it as soon as a slot frees.", actor: "system", decisionId: null });
          continue;
        }
        if (!detail) {
          // Legacy check-queue mode, or the detail lookup failed: slot use is not known, so don't claim a slot is free.
          waiting.push({ ...base, state: "waiting_for_check_capacity", label: `waiting for a check slot${why}`, stuck: overAnHour, next: "Boss Man checks and merges it by itself.", actor: "system", decisionId: null });
          continue;
        }
        waiting.push({ ...base, state: "waiting_for_check_capacity", label: `next in line for a check${why}`, stuck: overAnHour, next: "A slot is free; Boss Man checks and merges it by itself.", actor: "system", decisionId: null });
      }
      // BOS-1384: the order the check queue will serve them in (a fix for main, a move to front, urgent, then oldest), with why.
      const places = deps.places ? await deps.places(companyId).catch(() => null) : null;
      for (const w of waiting) {
        const p = places?.get(w.ticketId);
        if (p?.place) {
          w.place = p.place;
          w.why = p.why;
          // BOS-1405: the label counts this merge's own place, not the whole queue's length (place 1 is next up).
          if (w.state === "waiting_for_check_capacity") {
            const ahead = Math.max(0, p.place - 1);
            w.label = w.label.replace(/\(\d+ ahead\)/, ahead === 0 ? "(next up)" : `(${ahead} ahead)`);
            const s = stepOf.get(w.ticketId);
            if (s) stepOf.set(w.ticketId, s.replace(/\(\d+ ahead\)/, ahead === 0 ? "(next up)" : `(${ahead} ahead)`));
          }
        }
        // BOS-1803: a train-seat wait says how many wait ahead of it, and a background-lane merge says so and for how long,
        // in the label the ticket's status line shows too, so "merging since …" with nothing running isn't read as lost.
        if (p?.seatPlace && w.state === "waiting_for_seat" && !w.heldAlone) w.label = w.label.replace(/^waiting for a train seat/, `waiting for a train seat (${p.seatPlace === 1 ? "next up" : `${p.seatPlace - 1} ahead`})`);
        if (p?.lane) {
          w.lane = p.lane;
          w.label = `${w.label}; ${p.lane}`;
          const s = stepOf.get(w.ticketId);
          if (s) stepOf.set(w.ticketId, `${s}; ${p.lane}`);
        }
        w.statusLine = { step: stepOf.get(w.ticketId) ?? w.label, since: sinceOf.get(w.ticketId) ?? t.toISOString(), next: w.next ?? "", blocker: blockerOf.get(w.ticketId) ?? null };
      }
      // BOS-2359: who holds each landing turn, what it waits for, and when it and the tickets behind it should land: one usual
      // GitHub wait (the median of recent passed waits) per landing. The estimate goes onto the same status line (BOS-1517).
      const landingTurns: LandingTurnView[] = [];
      const turns = deps.landingTurns ? await deps.landingTurns(companyId).catch(() => []) : [];
      const usual = turns.some((s) => s.holder) && deps.usualCiWait ? await deps.usualCiWait(companyId).catch(() => null) : null;
      const lineOf = (id: string) => running.find((r) => r.ticketId === id)?.statusLine ?? waiting.find((w) => w.ticketId === id)?.statusLine;
      for (const s of turns) {
        if (!s.holder) continue;
        const h = s.holder;
        const ci = ciWait.get(h.ticketId);
        const run = running.find((r) => r.ticketId === h.ticketId);
        const waitingFor = ci ? "GitHub run" : run ? "its check" : "its merge to go on";
        const etas = landingEtas({ holderSinceMs: Date.parse(h.since), ciSinceMs: ci ? Date.parse(ci.since) : null, lineIds: s.line.map((x) => x.ticketId), usualMs: usual?.ms ?? null, nowMs: t.getTime() });
        const at = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
        const hl = lineOf(h.ticketId);
        if (hl && etas.holder !== null) hl.landsAt = at(etas.holder)!;
        for (const x of s.line) {
          const l = lineOf(x.ticketId);
          const when = etas.line.get(x.ticketId);
          if (l && when !== undefined) l.landsAt = at(when)!;
        }
        landingTurns.push({
          projectId: s.projectId,
          holder: { ...h, waitingFor, waitingSince: ci ? new Date(ci.since).toISOString() : null, landsAt: at(etas.holder), overdue: turnOverdue(Date.parse(h.since), usual?.ms ?? null, t.getTime()) },
          usualWaitMin: usual ? mins(usual.ms) : null,
          samples: usual?.samples ?? 0,
          line: s.line.map((x) => ({ ...x, landsAt: at(etas.line.get(x.ticketId)) })),
        });
      }
      waiting.sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity) || Number(b.urgent) - Number(a.urgent) || b.minutes - a.minutes);

      const recentRows = await recent(companyId, prefix, t);
      const slots = queue?.slots ?? limit;
      const emptySeatSince = deps.emptySeatSince ? await deps.emptySeatSince(companyId).catch(() => null) : null;
      const workerReady = deps.workerReady ? await deps.workerReady(companyId).catch(() => undefined) : undefined;
      const heldBehindFix = await heldBehindFixOf(db, prefix, heldWaits, { running, waiting });
      // R44: a server update holding new checks is a deliberate pause: its own verdict, with the reason and the latest end.
      const pause = soft.on ? { reason: "a server update", since: softHoldReason(soft).since, until: softHoldReason(soft).until } : null;
      // BOS-2505: when the last one lands, from the same usual times as the landing estimates above (check time, GitHub wait).
      const mergeRunning = running.filter((r) => r.what === "merge_check");
      const queuedForCheck = waiting.filter((w) => w.actor === "system" && !w.decisionId && (w.state === "waiting_for_check_capacity" || w.state === "waiting_for_seat" || w.state === "waiting_for_slot")).length;
      // A running check carries its GitHub run beside it (r.ci, minutes so far); a landing past its check is in ciWait.
      const ciOnlySinceMs = [...ciWait.values()].map((c) => Date.parse(c.since));
      const [usualCheckT, usualCiT] = mergeRunning.length + queuedForCheck + ciOnlySinceMs.length > 0 && deps.usualMergeCheck && deps.usualCiWait ? await Promise.all([deps.usualMergeCheck(companyId).catch(() => null), deps.usualCiWait(companyId).catch(() => null)]) : [null, null];
      const clearAt = lineClearAt({
        nowMs: t.getTime(),
        usualCheckMs: usualCheckT?.ms ?? null,
        usualCiMs: usualCiT?.ms ?? null,
        slots: Math.max(1, slots),
        running: mergeRunning.map((r) => ({ startedMs: Date.parse(r.startedAt), ciSinceMs: r.ci ? t.getTime() - r.ci.minutes * 60_000 : null })),
        ciOnlySinceMs,
        queued: queuedForCheck,
      });
      const line = mergeLineHealth({ running, waiting, recent: recentRows, slots }, { now: t, emptySeatSince, workerReady, heldBehindFix, pause, clearAt });
      // R47: only read the landings when there is no limit, so a company with the brake on pays nothing.
      const landed = company?.brakeLimit == null ? (await mergeQueueQueries.landedSince(db, companyId, new Date(t.getTime() - 24 * 3_600_000))).map((r) => r.at.getTime()) : [];
      const brakeOff = startBrakeOff({ brakeLimit: company?.brakeLimit ?? null, waiting, landed, now: t });
      return {
        companyId,
        mode: queue?.mode ?? "legacy",
        startBrakeOff: brakeOff,
        slots,
        serverHost: deps.serverHost ? await deps.serverHost().catch(() => null) : null,
        ...(await (async () => {
          const split = deps.slotSplit && queue?.mode === "server" ? await deps.slotSplit(companyId).catch(() => []) : [];
          return split.length > 1 ? { slotSplit: split } : {};
        })()),
        running,
        waiting,
        recent: recentRows,
        waitingCount: waiting.length,
        lineCount: waiting.length + running.length,
        // BOS-1594: the side-menu "stuck" badge follows the same verdict as the banner: 1 while the line is stuck, 0 when merging (even slowly) or healthy.
        stuckCount: line.state === "stuck" ? 1 : 0,
        line,
        /** BOS-2505: when the last ticket of the line is expected to land (ISO); the figure the banner gives too. Null when it can't be told or the line is empty. */
        clearAt: clearAt === null ? null : new Date(clearAt).toISOString(),
        ...(landingTurns.length ? { landingTurns } : {}),
      };
    },
    /** BOS-1517: a ticket's status line for its page: from the same live view as the queue, or null when it isn't in the merge pipeline. */
    async statusLineFor(companyId: string, ticketId: string): Promise<StatusLine | null> {
      const v = await (this as { get(c: string): Promise<MergeQueueView> }).get(companyId);
      return v.running.find((r) => r.ticketId === ticketId)?.statusLine ?? v.waiting.find((w) => w.ticketId === ticketId)?.statusLine ?? null;
    },
  };
}
