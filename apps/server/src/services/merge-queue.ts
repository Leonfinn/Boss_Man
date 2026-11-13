// The merge queue screen (BOS-587): a read-only view of the line for the owner, in their words.
// What is running now, what is waiting (in the order it will go) and how it ended last time, so a
// gate that stops can be seen rather than asked about. Reads only what the server already records:
// the tickets in review, their latest check results, the one open merge card per ticket, and the
// merges this process is running. Nothing here changes the queue.
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { type RiskTier, riskOf, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, checkResults, companies, decisions, reviewRequests, ticketDependencies, tickets } from "../db/schema.js";
import { evaluate } from "./review-kinds.js";
import { heldTicketIds, holdView } from "./review-holds.js";
import { holdsMergeSql } from "./ticket-links.js";

/** How many recently finished items the screen shows. */
export const RECENT_LIMIT = 10;
/** A merge still running after this long is flagged: a check may take an hour, a merge some minutes. */
export const RUNNING_LIMIT_MS = 60 * 60_000;
/** A ticket in review, approved and waiting to merge for longer than this is flagged as stuck. */
export const WAITING_LIMIT_MS = 60 * 60_000;

/** Who is acting on a stuck item, in the owner's words. */
export type ActorKind = "agent" | "ceo" | "owner" | "system";

export type MergePhase = "queued" | "checking" | "merging" | "waiting_to_retry";

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
};

export type WaitingState = "waiting_for_slot" | "check_failed_retrying" | "needs_you" | "waiting_for_sign_off" | "waiting_for_check_capacity" | "checking" | "waiting_host" | "waiting_for_decision" | "waiting_for_other_ticket" | "held";

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
  /** When the owner's sign-off for this round was given, if it was: a merge held by another card says so. */
  signedOffAt?: string | null;
};

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
};

export type MergeQueueView = {
  companyId: string;
  mode: "legacy" | "server";
  slots: number;
  running: RunningNow[];
  waiting: WaitingRow[];
  recent: RecentRow[];
  /** How many approved tickets are waiting to merge (the side menu's badge). */
  waitingCount: number;
  /** How many items look stuck: running past the limit, or waiting rows flagged stuck (BOS-767). */
  stuckCount: number;
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
    runningMerges: () => Array<{ ticketId: string; startedAt: string; startedBy: string; phase?: MergePhase }>;
    /** The check slot limit: how many merge checks run at once. */
    limit: () => Promise<number>;
    /** The check queue's own slot setting and mode (BOS-316); null when it is not running. */
    queueStatus?: (companyId: string) => Promise<{ mode: "legacy" | "server"; slots: number; running: number; waiting: number } | null>;
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
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, RECENT_LIMIT);
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

  return {
    async get(companyId: string): Promise<MergeQueueView> {
      const t = now();
      const [company] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
      const prefix = company?.prefix ?? null;

      // Running now: this process's merges (the same markers the ticket page shows), with their phase.
      const live = deps.runningMerges().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const limit = await deps.limit();
      const liveIds = live.map((l) => l.ticketId);
      const liveTitles = liveIds.length
        ? new Map((await db.select({ id: tickets.id, title: tickets.title, number: tickets.number }).from(tickets).where(inArray(tickets.id, liveIds))).map((r) => [r.id, r]))
        : new Map<string, { id: string; title: string; number: number | null }>();
      const running: RunningNow[] = live.map((l, i) => {
        const row = liveTitles.get(l.ticketId);
        const started = new Date(l.startedAt);
        const elapsed = t.getTime() - started.getTime();
        return {
          ticketId: l.ticketId,
          ref: ticketRef(prefix, row?.number),
          title: row?.title ?? "a ticket",
          phase: l.phase ?? "checking",
          startedAt: started.toISOString(),
          startedBy: l.startedBy,
          minutes: mins(elapsed),
          what: "merge_check",
          slot: (i % Math.max(1, limit)) + 1,
          overLimit: elapsed > RUNNING_LIMIT_MS,
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

      const waiting: WaitingRow[] = [];
      const heldIds = await heldTicketIds(db, ids);
      for (const r of inReview) {
        if (runningIds.has(r.id)) continue;
        const card = cards.get(r.id);
        const check = checks.get(r.id);
        const failedCheck = check ? !check.passed : false;
        // How long it has waited, in milliseconds so the "over an hour" limit compares like with like
        // (the ticket shows whole minutes). The last activity is the best stamp we have for an approval.
        const waitedMs = t.getTime() - r.lastActivityAt.getTime();
        const overAnHour = waitedMs > WAITING_LIMIT_MS;
        const base = { ticketId: r.id, ref: ticketRef(prefix, r.number), title: r.title, minutes: mins(waitedMs), risk: riskOf(r.risk), urgent: r.urgent, failedCheck };
        // A reviewer's hold (BOS-808): held on purpose, so never "stuck" and never waiting for a slot.
        const hold = heldIds.has(r.id) ? await holdView(db, r.id, t) : null;
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
        if (queue?.mode === "server" && queue.waiting > 0) {
          waiting.push({ ...base, state: "waiting_for_check_capacity", label: `waiting for a check slot (${queue.waiting} ahead)`, stuck: overAnHour, next: "Boss Man starts it as soon as a slot frees.", actor: "system", decisionId: null });
          continue;
        }
        waiting.push({ ...base, state: "waiting_for_slot", label: "waiting for a check slot", stuck: overAnHour, next: "Boss Man checks and merges it by itself.", actor: "system", decisionId: null });
      }
      waiting.sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.minutes - a.minutes);

      return {
        companyId,
        mode: queue?.mode ?? "legacy",
        slots: queue?.slots ?? limit,
        running,
        waiting,
        recent: await recent(companyId, prefix, t),
        waitingCount: waiting.length,
        stuckCount: running.filter((r) => r.overLimit).length + waiting.filter((w) => w.stuck).length,
      };
    },
  };
}
