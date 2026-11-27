// Projects, boards, tickets, dependencies and objectives (Phase 3, R16–R18, R25).
import { and, asc, desc, eq, exists, inArray, isNull, or, ne, sql, type SQL } from "drizzle-orm";

/** BOS-2166: how many of the newest done tickets the board sends unless it asks for all of them. */
export const BOARD_DONE_LIMIT = 50;

/**
 * BOS-2497: the ticket fields a board card sends, the ones the page reads (web `BoardTicket`). The whole row was about
 * 2.8 KB a card (about 100 columns, half of it the description), so 1 MB a refresh, every 10 s. A field the board starts
 * to show is added here and to the web type; the page's typecheck catches a read of one that isn't sent.
 * columnId stays: the server places each card in its column with it.
 */
export function boardCardFields(t: typeof tickets.$inferSelect) {
  const { id, number, title, systemState, outcome, columnId, assigneeAgentId, assignedToOwner, branch, risk, size, planFirst, planApprovedAt, featureId, lastActivityAt, stateChangedAt, urgent, urgentByOwner, recurring, watchingFor, watchUntil, mergeCommit } = t;
  return { id, number, title, systemState, outcome, columnId, assigneeAgentId, assignedToOwner, branch, risk, size, planFirst, planApprovedAt, featureId, lastActivityAt, stateChangedAt, urgent, urgentByOwner, recurring, watchingFor, watchUntil, mergeCommit };
}
import { addsUsabilityCriterion, watchEndsAt, withUsabilityCriterion,columnProblems, DEFAULT_COLUMNS, type GoLiveWait, effectiveDueDate, planFirstByDefault, readCriteria, type ColumnSpec, type RiskTier, type Criterion, type SystemState, type TaskSize } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { boardBuildsFor, type BoardBuild } from "./board-build.js";
import { record } from "./activity.js";
import { liveRuns } from "./runs.js";
import { passedReviewTickets, REVIEW_REASON, reviewWaits } from "./review-kinds.js";
import { PHASE_LABEL, type MergePhase } from "./merge-queue.js";
import { goLiveNote, openUpdateCards } from "./go-live-note.js";
import { reviewTicketWriteRefusal } from "./skill-proposals.js";
import { addTicketDependency, openBlockers, WorkError, type OpenBlocker } from "./ticket-links.js";
import { moveTicket, staleVersionMessage } from "./ticket-moves.js";
import { derivedSignoff } from "./signoff.js";
import { heldTicketIds, holdView, type HoldView } from "./review-holds.js";
import { fixesLiveProblem } from "./decisions.js";
import { hiddenWhileRechecked } from "./card-validity.js";
import { cantMoveSql, isWorkingRun, wipExemptKind } from "./agent-wip.js";
import { agents, decisions, engagements, features, keyResults, milestones, objectives, projects, reviewRequests, runs, ticketDependencies, tickets, wakes, watchdogFlags, workflowColumns } from "../db/schema.js";
import { baselineRefusal } from "./hand-offs.js";
import { looksStuck, type StuckFlag } from "./board-stuck.js";
import { SCRUM_MASTER_DUTY } from "./watchdog.js";
import { checkQueue } from "./check-queue.js";
import { workingHoursNotes } from "./working-hours-note.js";
import { checkPlace, CARRY_ON_NOTE, hhmm, ownLiveCheck, pendingFallback } from "./check-wording.js";

export { WorkError };

/**
 * A merged ticket's owner setup steps (BOS-443, widened by BOS-2075). Until the go-live card is raised from them
 * (`ownerSetupDecisionId` still null), the ticket's assignee or the CEO may correct them: the MCP write path runs
 * them through the card check again, logs the reason and tells the reviewers who approved, so "nothing checks it
 * again" no longer holds. Once the card is raised they are frozen against agents: the owner is already reading
 * them. This also covers the CEO's DR-052 fix card, which is only raised when the owner's card wasn't.
 * The owner's own web edit is unaffected (it passes no actor), and a write that changes nothing passes.
 */
function setupFrozenRefusal(t: { mergeCommit: string | null; ownerSetup: string | null; ownerSetupDecisionId: string | null; assigneeAgentId: string | null }, patch: { byAgentId?: string | null; ownerSetup?: string | null }, byCeo: boolean): string | null {
  if (!t.mergeCommit || !patch.byAgentId || patch.ownerSetup === undefined) return null;
  const next = patch.ownerSetup?.trim() || null;
  if (next === (t.ownerSetup?.trim() || null)) return null;
  if (t.ownerSetupDecisionId) return SETUP_CARD_RAISED;
  if (byCeo || t.assigneeAgentId === patch.byAgentId) return null;
  return "This ticket is merged and its owner's card isn't raised yet, so only its assignee or the CEO can correct its setup steps (update_ticket ownerSetup with a reason). Ask them, or tell the CEO.";
}

export const SETUP_CARD_RAISED = 'This ticket\'s setup steps are frozen: Boss Man has already raised the owner\'s "Ready to use" card from them, so the owner is reading these steps. An agent can\'t change them now. If they are wrong, ask the owner to fix them on the ticket page, or open a follow-up ticket with the right steps.';

/** Ticket ids a wake's note or a nudge's reason names, the way those notes write them. */
const NOTE_TICKET_IDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

type TicketPatch = {
  /** Who made the change, for the activity log (the assigner on an assignment). */
  byAgentId?: string | null;
  title?: string;
  body?: string | null;
  columnId?: string;
  state?: SystemState;
  outcome?: "completed" | "cancelled";
  assigneeAgentId?: string | null;
  /** A note for whoever reads the ticket next. */
  stateNote?: string;
  /** While blocked: when the wait ends and why (BOS-59); cleared by the database when the ticket leaves blocked. */
  blockedUntil?: Date | null;
  blockedUntilReason?: string | null;
  assignedToOwner?: boolean;
  milestoneId?: string | null;
  keyResultId?: string | null;
  dueDate?: string | null;
  customFields?: Record<string, unknown>;
  /** Risk tier (R48); null means medium. */
  risk?: RiskTier | null;
  /** Relative size (docs/19 part 6); null clears it. */
  size?: TaskSize | null;
  /** The feature request this ticket delivers. */
  featureId?: string | null;
  /** BOS-2682: why a ticket may join a released (baselined) feature, e.g. a bug fix that restores what it promised. */
  featureExceptionReason?: string | null;
  /** Makes this a sub-task of that task: it inherits the parent's feature when that is allowed (BOS-2682) and the parent waits on it. Null on an update takes it out. */
  parentTicketId?: string | null;
  /** Moves the ticket, with its sub-tasks, to another project in the company (update only). */
  projectId?: string;
  /** The agent that created it, so a repeated call after a resume returns the same task. */
  createdByAgentId?: string | null;
  /** Start in plan mode until a plan is approved (R40). */
  planFirst?: boolean;
  /** Acceptance criteria: 1 to 10 non-empty ones; empty means none. A plain string is checked before merge, `{ text, after: "merge" }` after it. */
  acceptanceCriteria?: Criterion[];
  /** Research, wiki, docs or deploy-only work: an empty diff is fine. */
  noCode?: boolean;
  /** What the owner has to do once this is live, in plain words by button path (DR-011); null clears it. */
  ownerSetup?: string | null;
  /** The CEO's lintOverride reason for these steps (DR-052); stored with them, cleared by any write without one. */
  ownerSetupOverride?: string | null;
  /** BOS-1650: the one-line "why" and "if skipped" the go-live card opens with; blank clears. Written with the steps. */
  ownerSetupWhy?: string | null;
  ownerSetupIfSkipped?: string | null;
  /** "Fixes live" (BOS-639): one sentence naming the live symptom this fixes; null or blank clears it. */
  fixesLive?: string | null;
  /** Owner-marked urgent: always passes the subscription quota hold (BOS-227). */
  urgent?: boolean;
  /** BOS-2485: a standing, repeated job; shown as a "Recurring" label. */
  recurring?: boolean;
  /** BOS-1516: the urgent mark was set by the owner ("Priority 1"). Only the owner's routes pass it; clearing urgent clears it too. */
  urgentByOwner?: boolean;
  /** Move past a full column anyway. */
  overLimit?: boolean;
  /** A move into review: "new" opens a review round (the owner's move), "keep" (the default here) leaves it to the caller (review.ts moves tickets into review itself). */
  reviewRound?: "new" | "keep";
  /** Why it moved, for the one history line (the owner's move says "Owner moved it to Done"). Defaults to the state note. */
  moveReason?: string;
  /** Boss Man's own move (a review sent back, a landing): not an agent starting work, so the start check (BOS-254) does not apply. */
  internal?: boolean;
  /** Write only if the ticket is still at this version (R81, BOS-897): checked in the UPDATE itself, so a change landing after the caller's read is not overwritten. */
  expectedVersion?: number;
  /** The title the page loaded: refuse the edit if the stored one changed since (BOS-905). */
  titleLoaded?: string | null;
  /** The description the page loaded: refuse the edit if the stored one changed since (BOS-905). Absent means not checked. */
  bodyLoaded?: string | null;
  /** The acceptance criteria the page loaded: refuse the edit if the stored ones changed since (BOS-905). */
  acceptanceCriteriaLoaded?: Criterion[];
};

export { staleVersionMessage };

/** Roles that may move a ticket into work whatever it waits on (BOS-254): the CEO, a manager, or the owner (no agent). */
const START_OVERRIDE_ROLES = new Set(["ceo", "manager"]);

/**
 * Why a ticket may not start (BOS-254): it still waits on an unfinished ticket or engagement, or it is
 * in the Backlog and nobody handed it over. Null when it may start. `actor.agentId` is the agent
 * moving it, or null for the owner; the owner, the CEO and managers may always override.
 */
export function startRefusal(
  t: { systemState: SystemState; createdAt: Date | null; lastActivityAt: Date | null },
  /** What still holds the ticket, from `openBlockers` (BOS-1458); an open decision doesn't stop a start. */
  open: OpenBlocker[],
  actor: { agentId?: string | null; role?: string | null },
): string | null {
  if (t.systemState === "in_progress" || t.systemState === "review" || t.systemState === "done") return null;
  // The owner (no agent), the CEO and a manager may start anything.
  if (!actor.agentId) return null;
  if (actor.role && START_OVERRIDE_ROLES.has(actor.role)) return null;
  const waiting = open.filter((d) => d.kind !== "decision");
  if (waiting.length) {
    const names = waiting.map((d) => (d.title ? `"${d.title}"` : "another ticket"));
    return `This ticket still waits on ${names.join(" and ")}, which ${waiting.length === 1 ? "isn't" : "aren't"} finished, so you can't start work on it yet. Finish or drop that first, or ask your CEO to move it on.`;
  }
  // Backlog is for work nobody has picked up: only a hand-over (the owner, a manager or a wake that
  // named it) starts it. Starting it straight from the backlog is refused.
  if (t.systemState === "backlog") {
    const handedOver = !!t.lastActivityAt && !!t.createdAt && t.lastActivityAt.getTime() > t.createdAt.getTime();
    if (!handedOver) return "This ticket is still in the Backlog and nobody handed it to you, so you can't start it. Ask your CEO or the owner to put it on the board, or move it to Ready first.";
  }
  return null;
}

/** The text fields a page can edit, each one checked on its own so an unrelated change doesn't hold it up (BOS-905). */
const EDIT_FIELDS = ["title", "body", "acceptanceCriteria"] as const;
type EditField = (typeof EDIT_FIELDS)[number];
export type EditConflict = { field: EditField; message: string };
const FIELD_NOUN: Record<EditField, string> = { title: "title", body: "description", acceptanceCriteria: "acceptance criteria" };

/** What was stored for a text field, as the page compares it. */
function storedEditField(t: typeof tickets.$inferSelect, field: EditField): string | null {
  if (field === "title") return t.title;
  if (field === "body") return t.body ?? null;
  return JSON.stringify(readCriteria(t.acceptanceCriteria));
}

/**
 * A save that would overwrite someone else's change to the same field (BOS-905, BOS-298 step 13): the page
 * sends what it loaded for each text field it edits, and a mismatch refuses the save with a 409. Only the
 * edited field is compared, because the version moves on every state change and would refuse unrelated edits.
 * A field sent without its loaded value (an older client, another caller) is not checked.
 */
export function editConflicts(t: typeof tickets.$inferSelect, patch: TicketPatch): EditConflict[] {
  const loaded: Partial<Record<EditField, string | null>> = {
    title: patch.title !== undefined && "titleLoaded" in patch ? (patch.titleLoaded ?? null) : undefined,
    body: patch.body !== undefined && "bodyLoaded" in patch ? (patch.bodyLoaded ?? null) : undefined,
    acceptanceCriteria: patch.acceptanceCriteria !== undefined && patch.acceptanceCriteriaLoaded !== undefined ? JSON.stringify(patch.acceptanceCriteriaLoaded) : undefined,
  };
  return EDIT_FIELDS.filter((f) => loaded[f] !== undefined && loaded[f] !== storedEditField(t, f)).map((field) => ({
    field,
    message: `The ${FIELD_NOUN[field]} was changed by someone else after you opened it, so your save was refused and nothing was overwritten. Your edit is still here. Reload the ticket to see the latest, then save again if you still want your change.`,
  }));
}

export type WorkHooks = {
  onAssigned?: (ticket: typeof tickets.$inferSelect) => Promise<unknown>;
  onDone?: (ticket: typeof tickets.$inferSelect) => Promise<unknown>;
  /** A move into review that asks for a round (the owner's): request the reviews and wake the reviewers. */
  onReview?: (ticket: typeof tickets.$inferSelect) => Promise<unknown>;
  /** A task of this feature started, finished, reopened, moved or was added: its status may need to follow. */
  onFeature?: (featureId: string) => Promise<unknown>;
  /** The merges this process is running, with their phase (the review service's markers), so an approved card can say where it is. */
  runningMerges?: () => Array<{ ticketId: string; phase?: MergePhase }>;
  now?: () => Date;
};

export function workService(db: Db, hooks: WorkHooks = {}) {
  const now = hooks.now ?? (() => new Date());
  async function project(id: string) {
    const [p] = await db.select().from(projects).where(eq(projects.id, id));
    if (!p) throw new WorkError(404, "No such project.");
    return p;
  }

  async function columnsOf(projectId: string) {
    return db.select().from(workflowColumns).where(eq(workflowColumns.projectId, projectId)).orderBy(asc(workflowColumns.position));
  }

  async function assertAgentInCompany(agentId: string, companyId: string) {
    const [a] = await db.select({ id: agents.id, name: agents.name, retiredAt: agents.retiredAt }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!a) throw new WorkError(422, "That agent isn't in this company.");
    if (a.retiredAt) throw new WorkError(422, `${a.name} is retired.`);
  }

  async function assertLinkInCompany(kind: "milestone" | "keyResult", id: string, companyId: string) {
    const table = kind === "milestone" ? milestones : keyResults;
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .innerJoin(objectives, eq(objectives.id, table.objectiveId))
      .where(and(eq(table.id, id), eq(objectives.companyId, companyId)));
    if (!row) throw new WorkError(422, `That ${kind === "milestone" ? "milestone" : "key result"} isn't in this company.`);
  }

  async function assertFeatureInCompany(id: string, companyId: string) {
    const [f] = await db.select({ id: features.id }).from(features).where(and(eq(features.id, id), eq(features.companyId, companyId)));
    if (!f) throw new WorkError(422, "That feature isn't in this company.");
  }

  /** BOS-2682: why joining a released (baselined) feature may be an exception, kept on the ticket; null when fine. */
  async function featureJoinCheck(featureId: string | null | undefined, exceptionReason: string | undefined | null, companyId: string): Promise<string | null> {
    if (!featureId) return null;
    const [f] = await db.select({ title: features.title, status: features.status }).from(features).where(and(eq(features.id, featureId), eq(features.companyId, companyId)));
    if (!f) throw new WorkError(422, "That feature isn't in this company.");
    const refusal = baselineRefusal({ id: featureId, ...f }, exceptionReason);
    if (refusal) throw new WorkError(409, refusal);
    return f.status === "released" ? (exceptionReason?.trim() ?? null) : null;
  }

  /**
   * One guard for every write that links tickets (parent, sub-task, waitsOn, dependency), BOS-86
   * round 11. Either end of the link may be an open security-review task: only the reviewer assigned
   * to it (or the owner, whose routes pass no agent) may attach anything to it or make it wait.
   * Living in the service means a new tool can't open the hole again by forgetting its own check.
   */
  async function assertLinkWriteAllowed(companyId: string, ids: Array<string | null | undefined>, byAgentId: string | null) {
    for (const id of ids) {
      if (!id) continue;
      const refusal = await reviewTicketWriteRefusal(db, companyId, id, byAgentId);
      if (refusal) throw new WorkError(403, refusal);
    }
  }

  /** The task a sub-task hangs off: in the same company and not itself a sub-task (one level only). */
  async function parentOf(parentId: string, companyId: string) {
    const [p] = await db.select().from(tickets).where(and(eq(tickets.id, parentId), eq(tickets.companyId, companyId)));
    if (!p) throw new WorkError(422, "That parent task isn't in this company.");
    if (p.parentTicketId) throw new WorkError(422, "A sub-task can't have sub-tasks.");
    return p;
  }

  /** Resolves where a ticket lands and enforces the column's card limit. */
  async function placement(projectId: string, target: { columnId?: string; state?: SystemState }, opts: { ticketId?: string; overLimit?: boolean }) {
    const cols = await columnsOf(projectId);
    const col = target.columnId ? cols.find((c) => c.id === target.columnId) : cols.find((c) => c.systemState === (target.state ?? "backlog"));
    if (!col) throw new WorkError(422, "That column isn't on this project's board.");
    if (col.wipLimit != null && !opts.overLimit) {
      // The same counting rule as ticket-moves.ts and the agent's limit: in progress, tickets that can't move don't count.
      const inCol = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.columnId, col.id), eq(tickets.systemState, col.systemState), col.systemState === "in_progress" ? sql`not ${cantMoveSql}` : undefined));
      if (inCol.filter((t) => t.id !== opts.ticketId).length >= col.wipLimit) {
        throw new WorkError(409, `"${col.name}" is at its limit of ${col.wipLimit}.`);
      }
    }
    return col;
  }

  return {
    async createProject(companyId: string, name: string, columns: ColumnSpec[] = DEFAULT_COLUMNS) {
      const problems = columnProblems(columns);
      if (problems.length) throw new WorkError(422, problems.join(" "));
      return db.transaction(async (tx) => {
        const [p] = await tx.insert(projects).values({ companyId, name }).returning();
        await tx.insert(workflowColumns).values(columns.map((c, i) => ({ projectId: p!.id, name: c.name.trim(), systemState: c.systemState, wipLimit: c.wipLimit ?? null, position: i })));
        return p!;
      });
    },

    /** Replaces the board's columns. Tickets keep their state and move to the first column showing it. */
    async setColumns(projectId: string, columns: ColumnSpec[]) {
      await project(projectId);
      const problems = columnProblems(columns);
      if (problems.length) throw new WorkError(422, problems.join(" "));
      await db.transaction(async (tx) => {
        await tx.update(tickets).set({ columnId: null }).where(eq(tickets.projectId, projectId));
        await tx.delete(workflowColumns).where(eq(workflowColumns.projectId, projectId));
        const created = await tx
          .insert(workflowColumns)
          .values(columns.map((c, i) => ({ projectId, name: c.name.trim(), systemState: c.systemState, wipLimit: c.wipLimit ?? null, position: i })))
          .returning();
        for (const state of new Set(created.map((c) => c.systemState))) {
          const first = created.find((c) => c.systemState === state)!;
          await tx.update(tickets).set({ columnId: first.id }).where(and(eq(tickets.projectId, projectId), eq(tickets.systemState, state)));
        }
      });
      return columnsOf(projectId);
    },

    async board(projectId: string, opts: { doneAll?: boolean; withText?: boolean } = {}) {
      const p = await project(projectId);
      const cols = await columnsOf(projectId);
      const boardRows = (where: SQL | undefined) =>
        db.select({ t: tickets, milestoneTarget: milestones.targetDate }).from(tickets).leftJoin(milestones, eq(milestones.id, tickets.milestoneId)).where(where).orderBy(asc(tickets.createdAt));
      // BOS-2166: every open ticket, plus the newest BOARD_DONE_LIMIT done ones (all of them with doneAll), and the count of all done.
      const doneTotal = Number((await db.select({ n: sql<number>`count(*)` }).from(tickets).where(and(eq(tickets.projectId, projectId), eq(tickets.systemState, "done"))))[0]?.n ?? 0);
      const openRows = await boardRows(and(eq(tickets.projectId, projectId), ne(tickets.systemState, "done")));
      const doneRows = opts.doneAll
        ? await boardRows(and(eq(tickets.projectId, projectId), eq(tickets.systemState, "done")))
        : (await boardRows(and(eq(tickets.projectId, projectId), eq(tickets.systemState, "done"), inArray(tickets.id, db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.projectId, projectId), eq(tickets.systemState, "done"))).orderBy(desc(tickets.lastActivityAt), desc(tickets.id)).limit(BOARD_DONE_LIMIT)))));
      const rows = [...openRows, ...doneRows].sort((a, b) => a.t.createdAt.getTime() - b.t.createdAt.getTime());
      // Parents, blockers and the checked ticket may be old done tickets outside the rows sent; look them up by id.
      const sent = new Set(rows.map((r) => r.t.id));
      const wantedIds = new Set<string>();
      for (const r of rows) {
        if (r.t.parentTicketId) wantedIds.add(r.t.parentTicketId);
        if (r.t.checksTicketId) wantedIds.add(r.t.checksTicketId);
      }
      const deps = rows.length
        ? await db.select().from(ticketDependencies).where(inArray(ticketDependencies.blockedTicketId, rows.map((r) => r.t.id)))
        : [];
      for (const d of deps) if (d.blockerTicketId) wantedIds.add(d.blockerTicketId);
      const missing = [...wantedIds].filter((x) => !sent.has(x));
      const byId = new Map<string, typeof tickets.$inferSelect>(rows.map((r) => [r.t.id, r.t]));
      if (missing.length) for (const t of await db.select().from(tickets).where(inArray(tickets.id, missing))) byId.set(t.id, t);
      const fids = [...new Set(rows.map((r) => r.t.featureId).filter((x): x is string => !!x))];
      const featureTitle = new Map((fids.length ? await db.select({ id: features.id, title: features.title }).from(features).where(inArray(features.id, fids)) : []).map((f) => [f.id, f.title]));
      // A ticket in review waits on the owner while the sign-off decision raised after an agent's approval is open (review.approve).
      const decisionIds = deps.flatMap((d) => (d.blockerDecisionId ? [d.blockerDecisionId] : []));
      const signoffs = new Map(
        (decisionIds.length ? await db.select({ id: decisions.id, context: decisions.context }).from(decisions).where(and(inArray(decisions.id, decisionIds), eq(decisions.status, "open"))) : [])
          .filter((d) => (d.context as { type?: string }).type === "risk_review")
          .map((d) => [d.id, (d.context as { reviewer?: string }).reviewer ?? null] as const),
      );
      // Any other open question for the owner that a ticket waits on (raise_decision with blocksTicketId, loop alerts).
      const openOwnerCards = decisionIds.length ? await db.select({ id: decisions.id, question: decisions.question, staleAt: decisions.staleAt, recheckStage: decisions.recheckStage, context: decisions.context, raisedByAgentId: decisions.raisedByAgentId }).from(decisions).where(and(inArray(decisions.id, decisionIds), eq(decisions.status, "open"), eq(decisions.tier, "owner"))) : [];
      // BOS-1193 (DR-054): a card being re-checked is not the owner's to answer yet, so the ticket it holds is not "waiting on
      // you" either; the Decisions list folds it away by the same rule. Urgent, live-run and merge/review cards stay.
      const hiddenCards = await hiddenWhileRechecked(db, openOwnerCards);
      const rechecking = new Map<string, string>();
      if (hiddenCards.size) {
        const names = new Map((await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, openOwnerCards.filter((d) => hiddenCards.has(d.id) && d.raisedByAgentId).map((d) => d.raisedByAgentId!)))).map((a) => [a.id, a.name] as const));
        for (const d of openOwnerCards) if (hiddenCards.has(d.id)) rechecking.set(d.id, (d.raisedByAgentId && names.get(d.raisedByAgentId)) || "the agent");
      }
      const questions = new Map(
        openOwnerCards
          .filter((d) => !signoffs.has(d.id) && !hiddenCards.has(d.id))
          .map((d) => [d.id, d.question] as const),
      );
      // A review no agent could take (the CEO did the work and nobody else can review it) waits on the owner too.
      const inReview = rows.filter((r) => r.t.systemState === "review").map((r) => r.t.id);
      const unreviewed = new Set(
        (inReview.length ? await db.select({ ticketId: reviewRequests.ticketId }).from(reviewRequests).where(and(inArray(reviewRequests.ticketId, inReview), eq(reviewRequests.status, "pending"), isNull(reviewRequests.reviewerAgentId))) : []).map((r) => r.ticketId),
      );
      // A ticket in review with no open review at all (none pending or approved, no sign-off decision, no pull request) has nobody to approve it, so it is the owner's too.
      // An approved request means the ticket is landing (a background merge, or a pull request waiting on CI), which is not the owner's to act on.
      const pendingAny = new Set(
        (inReview.length ? await db.select({ ticketId: reviewRequests.ticketId }).from(reviewRequests).where(and(inArray(reviewRequests.ticketId, inReview), inArray(reviewRequests.status, ["pending", "approved"]))) : []).map((r) => r.ticketId),
      );
      // DR-021: the owner's lane follows the derived sign-off state, card or not. "Approved with no open card"
      // used to read as landing, so a ticket whose card was lost vanished from Your review (BOS-494).
      const signoffWaiting = new Map<string, string>();
      for (const r of rows) {
        if (r.t.systemState !== "review") continue;
        const d = await derivedSignoff(db, r.t);
        if (d.state === "waiting") signoffWaiting.set(r.t.id, d.reviewer);
      }
      const withPr = new Set(rows.filter((r) => r.t.pullRequestUrl).map((r) => r.t.id));
      // BOS-1906: a ticket "Being checked" has no review open on purpose; it is not the owner's until its check has passed.
      const beingChecked = new Set(rows.filter((r) => r.t.systemState === "review" && r.t.checkHoldAt).map((r) => r.t.id));
      // BOS-1910: the watchdog's open flag per ticket is the "Looks stuck" verdict (the same flag that goes to the Scrum Master).
      const flagIds = rows.filter((r) => r.t.systemState !== "done" && r.t.systemState !== "backlog").map((r) => r.t.id);
      const stuckFlags = new Map<string, StuckFlag>();
      for (const f of flagIds.length ? await db.select().from(watchdogFlags).where(and(inArray(watchdogFlags.ticketId, flagIds), eq(watchdogFlags.status, "open"))) : []) {
        const prev = stuckFlags.get(f.ticketId);
        if (f.rule !== "owner_decision_waiting" && (!prev || f.openedAt < prev.openedAt)) stuckFlags.set(f.ticketId, f);
      }
      // BOS-2737: the Scrum Master's runs since the earliest hand-off, so each card's line says whether a run has started
      // on its flag (the first one at or after that flag's hand-off) or that nobody has picked it up.
      const handedAt = [...stuckFlags.values()].flatMap((f) => (f.lastFlaggedAt ? [f.lastFlaggedAt.getTime()] : []));
      const smRuns = handedAt.length
        ? await db
            .select({ agent: agents.name, startedAt: runs.startedAt })
            .from(runs)
            .innerJoin(agents, eq(agents.id, runs.agentId))
            .where(and(eq(agents.companyId, p.companyId), eq(agents.duty, SCRUM_MASTER_DUTY), sql`${runs.startedAt} >= ${new Date(Math.min(...handedAt)).toISOString()}`, sql`${runs.purpose} is distinct from 'chat'`))
            .orderBy(asc(runs.startedAt))
        : [];
      const smRunAfter = (f: StuckFlag | undefined) => (f?.lastFlaggedAt ? (smRuns.find((r) => r.startedAt.getTime() >= f.lastFlaggedAt!.getTime()) ?? null) : null);
      // Where each one stands in the check line, in the words a check's owner hears ("queued at no. 3", "running now").
      const checkLines = new Map<string, string>();
      if (beingChecked.size) {
        const q = await checkQueue(db).status(p.companyId);
        for (const j of q.running) if (beingChecked.has(j.ticketId) && j.kind === "pre_review") checkLines.set(j.ticketId, "running now");
        for (const j of q.queued) if (beingChecked.has(j.ticketId) && j.kind === "pre_review" && !checkLines.has(j.ticketId)) checkLines.set(j.ticketId, `no. ${j.place} in line`);
        for (const j of q.held) if (beingChecked.has(j.ticketId) && !checkLines.has(j.ticketId)) checkLines.set(j.ticketId, "waiting (the line is held)");
      }
      for (const id of inReview) if (!beingChecked.has(id) && !pendingAny.has(id) && !withPr.has(id) && !signoffWaiting.has(id) && !deps.some((d) => d.blockedTicketId === id && d.blockerDecisionId && signoffs.has(d.blockerDecisionId))) unreviewed.add(id);
      // Who is running on each ticket right now, so a card can show live work. A run counts for a
      // ticket when it is on it, was about it without being on it (a nudge that named it), or a
      // wake's note names it (a review wake can list several tickets in one run). Chat runs don't.
      const everyLive = await liveRuns(db, p.companyId);
      const named = (r: (typeof everyLive)[number]) => [...new Set(`${r.wakeNote ?? ""} ${r.originNote ?? ""}`.match(NOTE_TICKET_IDS) ?? [])];
      // Only this board's tickets can be lit; a run about a ticket in another project has no card here.
      const boardTicketIds = new Set(rows.map((r) => r.t.id));
      // Every ticket on this board a run is about, so one run can light two cards and still count once.
      const about = (r: (typeof everyLive)[number]) => {
        const found = new Set<string>();
        if (r.purpose === "chat") return found;
        for (const id of [r.ticketId, r.runTicketId, ...named(r)]) if (id && boardTicketIds.has(id)) found.add(id);
        return found;
      };
      // What a run is doing, after the agent's name on the card. A review run that lists several
      // tickets is on none of them, so "reviewing" shows on a card only when it is really on it.
      const doing = (r: (typeof everyLive)[number], ticketId?: string) =>
        r.origin === REVIEW_REASON ? (!r.ticketId || r.ticketId === ticketId ? "reviewing" : "working") : r.origin === "check due" ? "re-checking" : r.origin === "ci passed" ? "checking the merge" : r.origin === "nudge" ? "picking this up" : "working";
      // Runs with no ticket at all: the strip lists them, so the board never under-reports.
      const notHere = everyLive.filter((r) => about(r).size === 0);
      // BOS-1908: the ticket each busy agent is running now (a live run that isn't a chat), so an In progress ticket of theirs says "Agent busy on BOS-N".
      const runningNow = new Map<string, { id: string; number: number | null }>();
      {
        const live = everyLive.filter((r) => isWorkingRun(r) && r.agentId && r.ticketId);
        // The ticket's number and whether it has started; a run on a ticket still in Backlog or Ready (a held start) is not "busy on" it.
        const known = new Map<string, { number: number | null; started: boolean }>(rows.map((r) => [r.t.id, { number: r.t.number, started: r.t.systemState !== "backlog" && r.t.systemState !== "ready" }]));
        const unknown = [...new Set(live.map((r) => r.ticketId!).filter((id) => !known.has(id)))];
        if (unknown.length) for (const o of await db.select({ id: tickets.id, number: tickets.number, state: tickets.systemState }).from(tickets).where(inArray(tickets.id, unknown))) known.set(o.id, { number: o.number, started: o.state !== "backlog" && o.state !== "ready" });
        for (const r of live) if (!runningNow.has(r.agentId!) && known.get(r.ticketId!)?.started) runningNow.set(r.agentId!, { id: r.ticketId!, number: known.get(r.ticketId!)!.number });
      }
      const busyOn = (t: typeof tickets.$inferSelect) => {
        const r = t.assigneeAgentId ? runningNow.get(t.assigneeAgentId) : undefined;
        return r && r.id !== t.id ? r : null;
      };
      // A run on a ticket in another project is real, tracked work: name the ticket and its project instead of calling it ticketless.
      const candidates = (r: (typeof everyLive)[number]) => [r.ticketId, r.runTicketId, ...named(r)].filter((x): x is string => !!x);
      const elsewhereIds = [...new Set(notHere.flatMap((r) => (r.purpose === "chat" ? [] : candidates(r))))];
      const elsewhereRows = elsewhereIds.length
        ? await db
            .select({ id: tickets.id, number: tickets.number, title: tickets.title, projectId: tickets.projectId, projectName: projects.name })
            .from(tickets)
            .innerJoin(projects, eq(projects.id, tickets.projectId))
            .where(and(inArray(tickets.id, elsewhereIds), eq(projects.companyId, p.companyId), ne(tickets.projectId, p.id)))
        : [];
      const elsewhereOf = (r: (typeof everyLive)[number]) => {
        if (r.purpose === "chat") return null;
        for (const id of candidates(r)) {
          const hit = elsewhereRows.find((e) => e.id === id);
          if (hit) return hit;
        }
        return null;
      };
      const withoutCard = notHere.filter((r) => !elsewhereOf(r));
      const otherProjects = notHere.flatMap((r) => {
        const e = elsewhereOf(r);
        return e ? [{ id: r.id, agent: r.agent, purpose: r.purpose, startedAt: r.startedAt.toISOString(), ticketId: e.id, ticketNumber: e.number, ticketTitle: e.title, projectId: e.projectId, projectName: e.projectName }] : [];
      });
      const waits = await reviewWaits(db, inReview);
      // Approved by every reviewer, so only the merge is left (BOS-667): the board shows these apart from
      // tickets still waiting on a reviewer, so a long merge line doesn't read as a reviewer shortage.
      const passed = await passedReviewTickets(db, inReview);
      const holds = new Map<string, HoldView>();
      for (const id of await heldTicketIds(db, inReview)) {
        const v = await holdView(db, id);
        if (v) holds.set(id, v);
      }
      const builds = await boardBuildsFor(db)(rows.filter((r) => r.t.systemState === "review" && r.t.branch && !r.t.mergeCommit).map((r) => ({ id: r.t.id, activityKey: r.t.lastActivityAt.toISOString() }))).catch(() => new Map<string, BoardBuild>());
      const merging = new Map((hooks.runningMerges?.() ?? []).map((m) => [m.ticketId, m.phase ?? "checking"] as const));
      const mergeNote = (t: typeof tickets.$inferSelect) => {
        const phase = merging.get(t.id);
        if (phase) return phase === "queued" ? "Waiting for a check slot." : `Now ${PHASE_LABEL[phase]}.`;
        if (t.pullRequestUrl) return t.pullRequestNote ? `Pull request waiting on the git host: ${t.pullRequestNote.slice(0, 120)}` : "Pull request open; merges when the git host's checks pass.";
        return "Waiting to be checked and merged.";
      };
      // A held wake whose reason is the subscription quota (BOS-227), so the card can show it and offer Run now.
      // A ticket's wake can be merged into another of its assignee's wakes, so the assignee's held
      // wakes count too (BOS-253), not just ones naming the ticket.
      const assigneeIds = [...new Set(rows.map((r) => r.t.assigneeAgentId).filter((x): x is string => !!x))];
      const heldWakes = rows.length
        ? await db
            .select({ ticketId: wakes.ticketId, agentId: wakes.agentId, until: wakes.notBefore, reason: wakes.statusReason })
            .from(wakes)
            .where(and(or(inArray(wakes.ticketId, rows.map((r) => r.t.id)), assigneeIds.length ? inArray(wakes.agentId, assigneeIds) : sql`false`), eq(wakes.status, "deferred"), sql`${wakes.statusReason} like 'subscription %'`))
        : [];
      const heldFor = (t: typeof tickets.$inferSelect) => heldWakes.find((h) => h.ticketId === t.id) ?? (t.assigneeAgentId ? heldWakes.find((h) => h.agentId === t.assigneeAgentId) : undefined);
      const heldByAgent = (t: typeof tickets.$inferSelect) => !heldWakes.some((h) => h.ticketId === t.id) && !!(t.assigneeAgentId && heldWakes.some((h) => h.agentId === t.assigneeAgentId));
      const hoursNotes = await workingHoursNotes(db, rows.filter((r) => r.t.systemState === "backlog" || r.t.systemState === "ready" || r.t.systemState === "in_progress").map((r) => ({ id: r.t.id, assigneeAgentId: r.t.assigneeAgentId })), now());
      const blocker = (id: string | null) => (id ? byId.get(id) : undefined);
      const doneIds = new Set([...byId.values()].filter((t) => t.systemState === "done").map((t) => t.id));
      const updateCards = rows.some((r) => r.t.goLiveWait && r.t.systemState !== "done") ? await openUpdateCards(db, p.companyId) : { server: null, runner: null };
      const cards = rows.map(({ t, milestoneTarget }) => {
        const waitingDecisionId = t.systemState === "review" ? (deps.find((d) => d.blockedTicketId === t.id && d.blockerDecisionId && signoffs.has(d.blockerDecisionId))?.blockerDecisionId ?? null) : null;
        // A sign-off still open on a ticket no longer in review (moved, blocked) must not vanish from the owner's lane.
        const askedId = t.systemState === "done" ? null : (deps.find((d) => d.blockedTicketId === t.id && d.blockerDecisionId && (questions.has(d.blockerDecisionId) || (t.systemState !== "review" && signoffs.has(d.blockerDecisionId))))?.blockerDecisionId ?? null);
        const waitingOnOwner = !!waitingDecisionId || signoffWaiting.has(t.id) || unreviewed.has(t.id) || !!askedId;
        // Only for a ticket in review that isn't the owner's to act on: those are in Your review.
        // A reviewer's hold (BOS-808): passed, but kept from merging on purpose. Its own stage, apart from waiting for a reviewer or merging.
        const hold = t.systemState === "review" ? (holds.get(t.id) ?? null) : null;
        const reviewStage = t.systemState !== "review" || waitingOnOwner ? null : beingChecked.has(t.id) ? ("checking" as const) : hold ? ("held" as const) : passed.has(t.id) || withPr.has(t.id) || merging.has(t.id) ? ("merging" as const) : ("awaiting_review" as const);
        return {
        ...boardCardFields(t),
        // The description only for the search box, which asks for it while it has words (BOS-2497).
        ...(opts.withText ? { body: t.body } : {}),
        hasPlan: !!t.plan,
        waitingOnOwner,
        reviewStage,
        checkLine: reviewStage === "checking" ? (checkLines.get(t.id) ?? "waiting for its check") : null,
        hold,
        mergeNote: reviewStage === "merging" ? mergeNote(t) : null,
        ownerQuestion: askedId ? (questions.get(askedId) ?? "Waiting for your sign-off.") : null,
        // The card itself, so "Answer in Decisions" opens that exact card (BOS-1159).
        ownerQuestionId: askedId,
        // The agent re-checking a card this ticket waits on (BOS-1193): the board says so instead of asking the owner to answer it.
        recheckingBy: [...rechecking].find(([cardId]) => deps.some((d) => d.blockedTicketId === t.id && d.blockerDecisionId === cardId))?.[1] ?? null,
        noReviewer: unreviewed.has(t.id),
        build: t.systemState === "review" ? (builds.get(t.id) ?? null) : null,
        reviewWait: waits.get(t.id) ?? null,
        waitingDecisionId,
        approvedBy: waitingDecisionId ? signoffs.get(waitingDecisionId) ?? null : (signoffWaiting.get(t.id) ?? null),
        featureTitle: t.featureId ? (featureTitle.get(t.featureId) ?? null) : null,
        parentTitle: (t.parentTicketId ? byId.get(t.parentTicketId)?.title : undefined) ?? null,
        dueDate: effectiveDueDate(t.dueDate, milestoneTarget),
        // Work not linked to any objective may be drifting (R16).
        unlinked: !t.keyResultId && !t.milestoneId,
        working: [...new Set(everyLive.filter((l) => about(l).has(t.id)).map((l) => `${l.agent ?? "An agent"} ${doing(l, t.id)}`))],
        // When the earliest of those runs began, so the card can say how long the work has been going.
        workingSince: everyLive.filter((l) => about(l).has(t.id)).map((l) => l.startedAt).sort((a, b) => a.getTime() - b.getTime())[0]?.toISOString() ?? null,
        // A blocker task already done no longer holds the card up.
        blockedBy: deps.filter((d) => d.blockedTicketId === t.id && !(d.blockerTicketId && (doneIds.has(d.blockerTicketId) || (d.until === "merged" && !!blocker(d.blockerTicketId)?.mergeCommit)))).map((d) => ({ ticketId: d.blockerTicketId, until: d.blockerTicketId ? d.until : null, ticketTitle: blocker(d.blockerTicketId)?.title ?? null, ticketNumber: blocker(d.blockerTicketId)?.number ?? null, engagementId: d.blockerEngagementId, decisionId: d.blockerDecisionId })),
        // Why an in-progress ticket doesn't count towards a WIP limit (BOS-1172); null when it counts.
        wipExempt: t.systemState === "in_progress" ? wipExemptKind(t, deps.some((d) => d.blockedTicketId === t.id && !!d.blockerTicketId && !doneIds.has(d.blockerTicketId) && !(d.until === "merged" && !!blocker(d.blockerTicketId)?.mergeCommit)), busyOn(t)?.id ?? null) : null,
        // BOS-1908: the ticket this one's agent is running instead ("Agent busy on BOS-N"), and the one marked Next up in Ready.
        busyOnTicketId: t.systemState === "in_progress" ? (busyOn(t)?.id ?? null) : null,
        busyOnNumber: t.systemState === "in_progress" ? (busyOn(t)?.number ?? null) : null,
        nextUp: t.systemState === "ready" && !!t.nextUpAt,
        quotaHeldUntil: heldFor(t)?.until?.toISOString() ?? null,
        quotaHeldReason: heldFor(t)?.reason ?? null,
        quotaHeldAgent: heldByAgent(t),
        // BOS-2200: "Waiting for Dylan's working hours, from 00:00" while the assignee's hours hold its wake.
        workingHoursNote: t.systemState === "backlog" || t.systemState === "ready" || t.systemState === "in_progress" ? (hoursNotes.get(t.id) ?? null) : null,
        // BOS-1546: a merged ticket that only waits to go live says so, so it doesn't look stuck in Blocked.
        goLiveNote: t.systemState !== "done" ? goLiveNote(t.goLiveWait as GoLiveWait | null, updateCards) : null,
        // BOS-1907: a split-out check ticket joins the "Merged, watching" lane through its parent's merge; the card shows the watch.
        checksParentMerged: (() => {
          const parent = t.checksTicketId ? byId.get(t.checksTicketId) : undefined;
          // BOS-2417: a parent closed at go-live leaves its check here; a cancelled parent takes it out.
          return !!parent?.mergeCommit && !(parent.systemState === "done" && parent.outcome === "cancelled");
        })(),
        watchEndsAt: t.mergeCommit ? (watchEndsAt(t)?.toISOString() ?? null) : null,
        // BOS-1910: null for Being checked, Merged watching (before its date) and Next up, whatever the watchdog holds.
        looksStuck: looksStuck(
          stuckFlags.get(t.id),
          { beingChecked: beingChecked.has(t.id), nextUp: t.systemState === "ready" && !!t.nextUpAt, watching: !!t.mergeCommit && (watchEndsAt(t)?.getTime() ?? 0) > now().getTime(), smRun: smRunAfter(stuckFlags.get(t.id)) },
          now(),
        ),
        };
      });
      return {
        project: p,
        // Same rule as the Dashboard's "agents working" and the Agents page (DR-061 Q3): every agent with a run going that isn't a chat.
        workingAgents: new Set(everyLive.filter(isWorkingRun).map((r) => r.agentId)).size,
        withoutTicket: withoutCard.map((r) => ({ id: r.id, agent: r.agent, ticketId: r.ticketId, ticket: r.ticket, purpose: r.purpose, origin: r.origin, originFrom: r.originFrom, originNote: r.originNote, wakeNote: r.wakeNote, runTicketId: r.runTicketId, startedAt: r.startedAt.toISOString() })),
        otherProjects,
        doneTotal,
        columns: cols.map((c) => ({
          ...c,
          // A ticket shows in its column while that column matches its state; otherwise (no
          // column, or one left over from an older move) in the first column for its state.
          tickets: cards.filter((t) => {
            const own = cols.find((x) => x.id === t.columnId);
            return own && own.systemState === t.systemState ? own.id === c.id : cols.find((x) => x.systemState === t.systemState)?.id === c.id;
          }),
        })),
      };
    },

    async createTicket(projectId: string, input: TicketPatch & { title: string }) {
      const p = await project(projectId);
      if (p.archivedAt) throw new WorkError(409, `${p.name} is archived. Unarchive it on the Projects page to add tasks to it.`);
      if (input.assigneeAgentId) await assertAgentInCompany(input.assigneeAgentId, p.companyId);
      if (input.milestoneId) await assertLinkInCompany("milestone", input.milestoneId, p.companyId);
      if (input.keyResultId) await assertLinkInCompany("keyResult", input.keyResultId, p.companyId);
      if (input.featureId) await assertFeatureInCompany(input.featureId, p.companyId);
      const badFix = input.fixesLive ? fixesLiveProblem(input.fixesLive) : null;
      if (badFix) throw new WorkError(400, badFix);
      const parent = input.parentTicketId ? await parentOf(input.parentTicketId, p.companyId) : null;
      if (parent) await assertLinkWriteAllowed(p.companyId, [parent.id], input.createdByAgentId ?? null);
      // BOS-2682: a sub-task stays with its parent (the parent's feature is not new work on a released one); any other
      // ticket joining a released feature needs a reason.
      const featureId = parent ? parent.featureId : (input.featureId ?? null);
      const featureExceptionReason = parent ? null : await featureJoinCheck(featureId, input.featureExceptionReason, p.companyId);
      const featureP1 = featureId ? !!(await db.select({ p: features.priorityOne }).from(features).where(eq(features.id, featureId)))[0]?.p : false;
      const col = await placement(projectId, { columnId: input.columnId, state: input.state }, { overLimit: input.overLimit });
      // BOS-1571: a feature's ticket, or one with owner setup steps, carries the usability gate from the start.
      const criteria = withUsabilityCriterion(input.acceptanceCriteria ?? [], { featureId, ownerSetup: input.ownerSetup, noCode: input.noCode });
      const [t] = await db
        .insert(tickets)
        .values({
          companyId: p.companyId,
          projectId,
          title: input.title,
          body: input.body ?? null,
          systemState: col.systemState,
          columnId: col.id,
          outcome: col.systemState === "done" ? (input.outcome ?? "completed") : null,
          assigneeAgentId: input.assigneeAgentId ?? null,
          assignedToOwner: input.assignedToOwner ?? false,
          milestoneId: input.milestoneId ?? null,
          keyResultId: input.keyResultId ?? null,
          dueDate: input.dueDate ?? null,
          customFields: input.customFields ?? {},
          acceptanceCriteria: criteria,
          noCode: input.noCode ?? false,
          ownerSetup: input.ownerSetup?.trim() || null,
          fixesLive: input.fixesLive?.trim() || null,
          // BOS-1516: a ticket made in a Priority 1 feature carries the owner's mark from the start.
          urgent: input.urgent ?? featureP1,
          urgentByOwner: (input.urgent ?? featureP1) && (input.urgentByOwner ?? featureP1),
          lastActivityAt: now(),
          risk: input.risk ?? null,
          size: input.size ?? null,
          // Graded planning: high and critical work is planned first unless the creator says otherwise.
          planFirst: input.planFirst ?? (input.risk ? planFirstByDefault(input.risk) : false),
          featureId,
          parentTicketId: parent?.id ?? null,
          createdByAgentId: input.createdByAgentId ?? null,
        })
        .returning();
      await record(db, { companyId: p.companyId, ticketId: t!.id, kind: "ticket_created", summary: `Created "${t!.title}" in ${t!.systemState}${t!.assigneeAgentId ? ", assigned" : ""}`, at: now() });
      // BOS-2682: joining a released (baselined) feature is only for an exception, and the reason is kept on the ticket.
      if (featureExceptionReason && featureId) await record(db, { companyId: p.companyId, ticketId: t!.id, agentId: input.createdByAgentId ?? null, kind: "reorganised", summary: `Joined the released feature "${(await db.select({ title: features.title }).from(features).where(eq(features.id, featureId)))[0]?.title ?? featureId}" as an exception: ${featureExceptionReason}`, at: now() });
      if (parent) await this.waitOnSubtask(parent, t!.id, input.createdByAgentId ?? null);
      if (featureId) await hooks.onFeature?.(featureId);
      if (t!.assigneeAgentId && t!.systemState !== "done") await hooks.onAssigned?.(t!);
      return t!;
    },

    /** The parent waits on its new sub-task; the existing unblocked note hands it back when the sub-task is done. */
    async waitOnSubtask(parent: typeof tickets.$inferSelect, childId: string, byAgentId: string | null = null) {
      await addTicketDependency(db, {
        companyId: parent.companyId,
        blockedTicketId: parent.id,
        blockerTicketId: childId,
        actor: { type: "agent", agentId: byAgentId },
      });
      if (parent.systemState === "ready" || parent.systemState === "in_progress") await this.updateTicket(parent.id, { state: "blocked", overLimit: true, byAgentId });
    },

    /** Checks a parent for a new sub-task before it is created. */
    parentOf,

    /**
     * Turns the ticket's watcher on or off (R80). Turning it on asks for a first report straight
     * away; after that it reports every `everyMinutes`, and once more when the ticket is done.
     */
    async setWatcher(ticketId: string, watcher: { agentId: string | null; everyMinutes?: number }) {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, "No such ticket.");
      if (watcher.agentId) await assertAgentInCompany(watcher.agentId, t.companyId);
      const [row] = await db
        .update(tickets)
        .set(
          watcher.agentId
            ? { watcherAgentId: watcher.agentId, watchEveryMinutes: watcher.everyMinutes ?? t.watchEveryMinutes ?? 30, ...(watcher.agentId !== t.watcherAgentId ? { watchedAt: null } : {}) }
            : { watcherAgentId: null, watchedAt: null },
        )
        .where(eq(tickets.id, ticketId))
        .returning({ watcherAgentId: tickets.watcherAgentId, watchEveryMinutes: tickets.watchEveryMinutes, watchedAt: tickets.watchedAt });
      return row!;
    },

    /**
     * Arms the ticket's monitor: wake the assignee at `at` to re-check `note`. An agent sets it only on
     * its own ticket, in the future; the owner may set "now". The owner re-arming a fired or exhausted
     * monitor starts the count again.
     */
    async setMonitor(ticketId: string, input: { at: Date; note: string; maxChecks?: number; by?: { agentId: string; companyId: string } }) {
      const [t] = await db.select().from(tickets).where(input.by ? and(eq(tickets.id, ticketId), eq(tickets.companyId, input.by.companyId)) : eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, input.by ? "No ticket with that ID in your company." : "No such ticket.");
      const note = input.note.trim();
      if (!note || note.length > 500) throw new WorkError(422, "Say what to re-check, in 1 to 500 characters.");
      if (Number.isNaN(input.at.getTime())) throw new WorkError(422, "That isn't a valid time.");
      if (input.maxChecks !== undefined && (!Number.isInteger(input.maxChecks) || input.maxChecks < 1 || input.maxChecks > 20)) throw new WorkError(422, "maxChecks is 1 to 20.");
      // Blocked too (BOS-1171): a ticket that only waits should sit in Blocked and still be re-checked later.
      if (t.systemState !== "in_progress" && t.systemState !== "review" && t.systemState !== "blocked") throw new WorkError(422, `A check can only be scheduled on a ticket that is in progress, in review or blocked; this one is ${t.systemState}.`);
      if (!t.assigneeAgentId) throw new WorkError(422, "The ticket has no agent to wake.");
      if (input.by) {
        if (t.assigneeAgentId !== input.by.agentId) throw new WorkError(403, "Only the agent the ticket is assigned to can schedule a check.");
        if (input.at.getTime() <= now().getTime()) throw new WorkError(422, "The time must be in the future.");
        // BOS-1412: while the agent's own check waits or runs, its result wakes them, so one booked fallback is all it
        // needs. A second would be an empty run that only re-reads the queue. Re-booking the same time is just a rewrite.
        const own = await ownLiveCheck(db, t.id, input.by.agentId);
        if (own) {
          const booked = await pendingFallback(db, t.id, CARRY_ON_NOTE);
          if (booked && booked.at.getTime() !== input.at.getTime()) {
            const place = await checkPlace(checkQueue(db), t.companyId, own);
            throw new WorkError(422, `Your check for ${own.commit.slice(0, 8)} is ${place}; its result will wake you. You already have a fallback booked for ${hhmm(booked.at)}.`);
          }
        }
      }
      const [row] = await db
        .update(tickets)
        .set({ monitorAt: input.at, monitorNote: note, ...(input.maxChecks ? { monitorMax: input.maxChecks } : {}), ...(!input.by && !t.monitorAt ? { monitorAttempts: 0 } : {}) })
        .where(eq(tickets.id, ticketId))
        .returning();
      const [who] = input.by ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, input.by.agentId)) : [];
      await record(db, { companyId: t.companyId, agentId: input.by?.agentId, ticketId, kind: "monitor", summary: `${who?.name ?? "The owner"} scheduled a check for ${input.at.toISOString()}: ${note}`, at: now() });
      return row!;
    },

    async clearMonitor(ticketId: string, by?: { agentId: string; companyId: string }) {
      const [t] = await db.select().from(tickets).where(by ? and(eq(tickets.id, ticketId), eq(tickets.companyId, by.companyId)) : eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, by ? "No ticket with that ID in your company." : "No such ticket.");
      if (by && t.assigneeAgentId !== by.agentId) throw new WorkError(403, "Only the agent the ticket is assigned to can clear its check.");
      if (!t.monitorAt) return t;
      const [row] = await db.update(tickets).set({ monitorAt: null, monitorAttempts: 0 }).where(eq(tickets.id, ticketId)).returning();
      await record(db, { companyId: t.companyId, agentId: by?.agentId, ticketId, kind: "monitor", summary: "Cleared the scheduled check", at: now() });
      return row!;
    },

    /**
     * A run that had no ticket starts working on one, so the runs list, the agent's page and the
     * ticket page can show it as "Working on BOS-x" (BOS-254). Only the ticket it is really on is
     * set: a ticket that only waits on it, or one it merely mentioned, never is. A reviewer is
     * the exception (BOS-268): the ticket in review is not assigned to it, and reading the diff
     * and giving a verdict is all the work there is.
     */
    async attachRun(ticketId: string, runId: string) {
      const [r] = await db.select({ id: runs.id, companyId: runs.companyId, agentId: runs.agentId, ticketId: runs.ticketId, purpose: runs.purpose, endedAt: runs.endedAt }).from(runs).where(eq(runs.id, runId));
      if (!r || r.purpose === "chat" || r.endedAt || r.ticketId) return false;
      const [t] = await db.select({ id: tickets.id, companyId: tickets.companyId, assigneeAgentId: tickets.assigneeAgentId }).from(tickets).where(eq(tickets.id, ticketId));
      if (!t || t.companyId !== r.companyId) return false;
      // The ticket must be the run's own: assigned to the agent, one it created, or (for a
      // reviewer) one in review with a review of it open to the agent. A stray reply or nudge
      // about a colleague's ticket is not "working on it".
      if (!r.agentId) return false;
      const agentId = r.agentId;
      const [own] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(
          and(
            eq(tickets.id, ticketId),
            or(
              eq(tickets.assigneeAgentId, agentId),
              eq(tickets.createdByAgentId, agentId),
              and(
                eq(tickets.systemState, "review"),
                exists(db.select({ id: reviewRequests.id }).from(reviewRequests).where(and(eq(reviewRequests.ticketId, ticketId), eq(reviewRequests.reviewerAgentId, agentId), inArray(reviewRequests.status, ["pending", "approved"])))),
              ),
            ),
          ),
        );
      if (!own) return false;
      await db.update(runs).set({ ticketId }).where(and(eq(runs.id, runId), isNull(runs.ticketId)));
      await record(db, { companyId: r.companyId, agentId: r.agentId, ticketId, kind: "run_started", summary: "This run started working on it.", at: now() });
      return true;
    },

    async updateTicket(ticketId: string, patch: TicketPatch) {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, "No such ticket.");
      const expected = patch.expectedVersion;
      if (expected !== undefined && t.version !== expected) throw new WorkError(409, await staleVersionMessage(db, t.companyId, ticketId, expected));
      // Someone else changed the text the page is saving: refuse it before anything is written (BOS-905).
      const conflict = editConflicts(t, patch)[0];
      if (conflict) throw new WorkError(409, conflict.message, conflict.field);
      if (patch.assigneeAgentId) await assertAgentInCompany(patch.assigneeAgentId, t.companyId);
      if (patch.milestoneId) await assertLinkInCompany("milestone", patch.milestoneId, t.companyId);
      if (patch.keyResultId) await assertLinkInCompany("keyResult", patch.keyResultId, t.companyId);
      if (patch.featureId) await assertFeatureInCompany(patch.featureId, t.companyId);
      const { overLimit: _ignored, internal: _internal, reviewRound: _round, moveReason: _why, expectedVersion: _v, titleLoaded: _tl, bodyLoaded: _bl, acceptanceCriteriaLoaded: _acl, state: _s, columnId: _c, projectId: _p, parentTicketId: newParent, featureExceptionReason: exceptionGiven, ...fields } = patch;
      const dest = patch.projectId && patch.projectId !== t.projectId ? await project(patch.projectId) : null;
      const kids = dest || newParent ? await db.select().from(tickets).where(eq(tickets.parentTicketId, t.id)) : [];
      if (dest) {
        if (dest.companyId !== t.companyId) throw new WorkError(422, "That project isn't in this company.");
        if (dest.archivedAt) throw new WorkError(409, `${dest.name} is archived.`);
        // Its branch and working copy belong to the current project's repo.
        const busy = [t, ...kids].find((x) => x.systemState === "in_progress" || x.systemState === "review");
        if (busy) throw new WorkError(409, `"${busy.title}" is ${busy.systemState === "review" ? "in review" : "in progress"}. Move tickets before work starts or after it ends.`);
      }
      const parent = newParent ? await parentOf(newParent, t.companyId) : null;
      const actor = patch.byAgentId ?? null;
      // Either end of a parent link: the ticket itself, the parent it leaves and the parent it joins.
      if (newParent !== undefined) await assertLinkWriteAllowed(t.companyId, [t.id, t.parentTicketId, newParent], actor);
      if (parent) {
        if (parent.id === t.id) throw new WorkError(422, "A ticket can't be its own parent.");
        if (kids.length) throw new WorkError(422, "It has sub-tasks of its own, so it can't become a sub-task.");
        if (parent.projectId !== (dest?.id ?? t.projectId)) throw new WorkError(422, "The parent task is in another project. Move the parent, or move this ticket to the parent's project in the same call.");
        // BOS-2682: a sub-task stays with its parent, and the parent's feature is not new work on it.
        fields.featureId = parent.featureId;
      }
      // BOS-2682: joining a released (baselined) feature needs an exception reason. A ticket already on that feature
      // is not joining it again, so its other writes are not held up.
      const featureExceptionReason = patch.featureId && patch.featureId !== t.featureId ? await featureJoinCheck(patch.featureId, exceptionGiven, t.companyId) : null;
      // BOS-1516: switching urgent off (by anyone) drops the owner's mark too; turning it on keeps whatever the caller said (agents never set it).
      if (patch.urgent === false) fields.urgentByOwner = false;
      if (dest && t.parentTicketId && newParent === undefined) {
        const [old] = await db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, t.parentTicketId));
        if (old?.projectId !== dest.id) throw new WorkError(422, "It is a sub-task: move its parent task (sub-tasks go with it), or take it out of the parent first.");
      }
      const reparent = newParent !== undefined && newParent !== t.parentTicketId;
      if (reparent) Object.assign(fields, { parentTicketId: newParent });
      // The state the ticket ends in: a column's own state wins over `state`; a move between projects keeps the state.
      const wanted = patch.columnId ? (await columnsOf(dest?.id ?? t.projectId)).find((c) => c.id === patch.columnId) : null;
      if (patch.columnId && !wanted) throw new WorkError(422, "That column isn't on this project's board.");
      const target: SystemState = wanted?.systemState ?? patch.state ?? t.systemState;
      // Starting work (BOS-254): a run can't begin a ticket that still waits on something unfinished,
      // or one in the Backlog nobody handed it. The owner, the CEO and managers override.
      if (target === "in_progress" && t.systemState !== "in_progress" && !patch.internal) {
        const deps = await openBlockers(db, ticketId);
        const [who] = patch.byAgentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, patch.byAgentId)) : [];
        const refusal = startRefusal({ systemState: t.systemState, createdAt: t.createdAt, lastActivityAt: t.lastActivityAt }, deps, { agentId: patch.byAgentId, role: who?.role ?? null });
        if (refusal) throw new WorkError(409, refusal);
      }
      // Blank setup steps mean none: store null, so the go-live pass never raises an empty card.
      // A merged ticket's steps are frozen against agents once the owner's card is raised (BOS-443, BOS-2075).
      if (patch.ownerSetup !== undefined) {
        const [who] = t.mergeCommit && patch.byAgentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, patch.byAgentId)) : [];
        const frozen = setupFrozenRefusal(t, patch, who?.role === "ceo");
        if (frozen) throw new WorkError(409, frozen);
        fields.ownerSetup = patch.ownerSetup?.trim() || null;
        // An override covers only the text it came with, so any other write of the steps clears it.
        fields.ownerSetupOverride = fields.ownerSetup ? (patch.ownerSetupOverride ?? null) : null;
      }
      if (patch.ownerSetupWhy !== undefined) fields.ownerSetupWhy = patch.ownerSetupWhy?.trim() || null;
      if (patch.ownerSetupIfSkipped !== undefined) fields.ownerSetupIfSkipped = patch.ownerSetupIfSkipped?.trim() || null;
      if (patch.fixesLive !== undefined) {
        const bad = patch.fixesLive ? fixesLiveProblem(patch.fixesLive) : null;
        if (bad) throw new WorkError(400, bad);
        fields.fixesLive = patch.fixesLive?.trim() || null;
      }
      // BOS-1571: a ticket that joins a feature, gains owner setup steps or has its criteria replaced keeps the
      // usability gate; the write that makes it due adds it, so nobody has to remember it.
      if (!t.mergeCommit && (fields.featureId !== undefined || fields.ownerSetup !== undefined || fields.acceptanceCriteria !== undefined || fields.noCode !== undefined)) {
        const criteria = fields.acceptanceCriteria ?? readCriteria(t.acceptanceCriteria);
        const gate = { featureId: fields.featureId !== undefined ? fields.featureId : t.featureId, ownerSetup: fields.ownerSetup !== undefined ? fields.ownerSetup : t.ownerSetup, noCode: fields.noCode ?? t.noCode };
        if (addsUsabilityCriterion(criteria, gate)) fields.acceptanceCriteria = withUsabilityCriterion(criteria, gate);
      }
      if (dest) Object.assign(fields, { projectId: dest.id });
      // Plan first follows the risk level (there's no checkbox): changing the risk before work
      // starts and before a plan is approved turns it on for high and critical, off otherwise.
      if (patch.risk !== undefined && patch.planFirst === undefined && !t.planApprovedAt && (t.systemState === "backlog" || t.systemState === "ready"))
        fields.planFirst = patch.risk ? planFirstByDefault(patch.risk) : false;
      // Every state change, and the write of the other fields with it, goes through moveTicket (DR-047): the
      // column, the WIP limit, the no-code reopen rule (BOS-532), the history line, the merge line's "left"
      // event (BOS-769), and the done, review and feature steps after a real change.
      // One instant for the whole write (BOS-1343): the note's time and the activity time come from one read,
      // so a fresh note never reads as stale because the clock ticked between the two.
      const at = now();
      const { ticket: updated } = await moveTicket(db, ticketId, target, {
        by: patch.byAgentId,
        expectedVersion: expected,
        outcome: patch.outcome,
        note: patch.moveReason ?? patch.stateNote,
        // A move to another project keeps the state in that board's column and never stops at a limit.
        overLimit: patch.overLimit,
        internal: patch.internal,
        reviewRound: patch.reviewRound ?? "keep",
        columnId: patch.columnId,
        projectId: dest?.id,
        fields: { ...fields, ...(patch.stateNote ? { stateNoteAt: at, stateNoteStaleAt: null } : {}) },
        hooks,
        now: at,
      });
      if (dest) {
        const [from] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, t.projectId));
        for (const k of kids) {
          const kc = await placement(dest.id, { state: k.systemState }, { ticketId: k.id, overLimit: true });
          await db.update(tickets).set({ projectId: dest.id, columnId: kc.id, lastActivityAt: now() }).where(eq(tickets.id, k.id));
        }
        await record(db, { companyId: t.companyId, ticketId: t.id, kind: "moved", summary: `Moved from ${from?.name ?? "another project"} to ${dest.name}${kids.length ? `, with ${kids.length} sub-task${kids.length === 1 ? "" : "s"}` : ""}`, at: now() });
      }
      if (reparent) {
        // The old parent no longer waits on it; the new one does while it is open.
        if (t.parentTicketId) await db.delete(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, t.parentTicketId), eq(ticketDependencies.blockerTicketId, t.id)));
        if (parent && updated!.systemState !== "done") await this.waitOnSubtask(parent, t.id, actor);
        await record(db, { companyId: t.companyId, ticketId: t.id, kind: "parent", summary: parent ? `Now a sub-task of "${parent.title}"` : "No longer a sub-task", at: now() });
      }
      // BOS-2682: the reason for joining a released (baselined) feature is kept on the ticket.
      if (featureExceptionReason && patch.featureId) await record(db, { companyId: t.companyId, ticketId: t.id, agentId: actor ?? undefined, kind: "reorganised", summary: `Joined the released feature "${(await db.select({ title: features.title }).from(features).where(eq(features.id, patch.featureId)))[0]?.title ?? patch.featureId}" as an exception: ${featureExceptionReason}`, at: now() });
      if (updated!.assigneeAgentId !== t.assigneeAgentId) {
        const [to] = updated!.assigneeAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, updated!.assigneeAgentId)) : [];
        await record(db, { companyId: t.companyId, ticketId: t.id, kind: "assigned", agentId: patch.byAgentId ?? undefined, summary: `Assigned to ${to?.name ?? "nobody"}`, at: now() });
        // BOS-2309: a check the old assignee booked was their plan, not the new assignee's: drop it, and the new assignee books their own.
        if (updated!.monitorAt) {
          await db.update(tickets).set({ monitorAt: null, monitorNote: null, monitorAttempts: 0 }).where(eq(tickets.id, t.id));
          await record(db, { companyId: t.companyId, ticketId: t.id, kind: "monitor", summary: "Cleared the scheduled check: the ticket was reassigned", at: now() });
        }
      }
      if (updated!.assigneeAgentId && updated!.assigneeAgentId !== t.assigneeAgentId && updated!.systemState !== "done") await hooks.onAssigned?.(updated!);
      if ((updated!.ownerSetup ?? null) !== (t.ownerSetup ?? null))
        await record(db, { companyId: t.companyId, ticketId: t.id, kind: "reorganised", agentId: patch.byAgentId ?? undefined, summary: `${patch.byAgentId ? ((await db.select({ name: agents.name }).from(agents).where(eq(agents.id, patch.byAgentId)))[0]?.name ?? "An agent") : "The owner"} changed the owner's setup steps`, at: now() });
      return updated;
    },

    /** A ticket can wait on another ticket in its company, or on an engagement its company requested (R25). */
    async addDependency(ticketId: string, blocker: { ticketId?: string; engagementId?: string; until?: "merged" | "done" }, byAgentId: string | null = null) {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, "No such ticket.");
      if (!!blocker.ticketId === !!blocker.engagementId) throw new WorkError(422, "Give exactly one blocker: a ticket or an engagement.");
      if (blocker.ticketId) {
        if (blocker.ticketId === ticketId) throw new WorkError(422, "A ticket can't block itself.");
        const [b] = await db.select().from(tickets).where(and(eq(tickets.id, blocker.ticketId), eq(tickets.companyId, t.companyId)));
        if (!b) throw new WorkError(422, "The blocking ticket must be in the same company. Use an engagement to wait on another company.");
        if (await this.wouldCycle(ticketId, blocker.ticketId)) throw new WorkError(422, "That would make the tickets wait on each other.");
      } else {
        const [e] = await db.select().from(engagements).where(and(eq(engagements.id, blocker.engagementId!), eq(engagements.requesterCompanyId, t.companyId)));
        if (!e) throw new WorkError(422, "Only an engagement this company requested can block its tickets.");
      }
      // The same link again only changes when it is released (BOS-989), so a repeat call can't stack two rows.
      if (blocker.ticketId) {
        const [same] = await db.select().from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(ticketDependencies.blockerTicketId, blocker.ticketId)));
        if (same) {
          const until = blocker.until ?? same.until;
          if (until === same.until) return same;
          const [changed] = await db.update(ticketDependencies).set({ until }).where(eq(ticketDependencies.id, same.id)).returning();
          await record(db, { companyId: t.companyId, ticketId, kind: "dependency", summary: `Waits on ticket ${blocker.ticketId} until it is ${until}`, at: now() });
          return changed!;
        }
      } else {
        const [same] = await db.select().from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(ticketDependencies.blockerEngagementId, blocker.engagementId!)));
        if (same) return same;
      }
      const dep = await addTicketDependency(db, {
        companyId: t.companyId,
        blockedTicketId: ticketId,
        blockerTicketId: blocker.ticketId ?? null,
        blockerEngagementId: blocker.engagementId ?? null,
        until: blocker.until,
        actor: { type: "agent", agentId: byAgentId },
      });
      await record(db, { companyId: t.companyId, ticketId, kind: "dependency", summary: blocker.ticketId ? `Now waits on ticket ${blocker.ticketId} until it is ${blocker.until ?? "done"}` : `Now waits on engagement ${blocker.engagementId}`, at: now() });
      return dep;
    },

    /** Takes a "waits on" link off a ticket (BOS-989). True if there was one. */
    async removeDependency(ticketId: string, blockerTicketId: string, byAgentId: string | null = null) {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, "No such ticket.");
      const gone = await db.delete(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(ticketDependencies.blockerTicketId, blockerTicketId))).returning({ id: ticketDependencies.id });
      if (!gone.length) return false;
      await record(db, { companyId: t.companyId, ticketId, agentId: byAgentId ?? undefined, kind: "dependency", summary: `No longer waits on ticket ${blockerTicketId}`, at: now() });
      return true;
    },

    /** True if `blocker` already (transitively) waits on `ticket`. */
    async wouldCycle(ticketId: string, blockerId: string): Promise<boolean> {
      const seen = new Set<string>();
      const stack = [blockerId];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === ticketId) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const next = await db.select({ id: ticketDependencies.blockerTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, cur));
        for (const n of next) if (n.id) stack.push(n.id);
      }
      return false;
    },

    async createObjective(companyId: string, input: { title: string; priority?: number; projectId?: string }) {
      const [o] = await db.insert(objectives).values({ companyId, title: input.title, priority: input.priority ?? 2, projectId: input.projectId ?? null }).returning();
      return o!;
    },

    async addKeyResult(objectiveId: string, input: { title: string; target?: number; current?: number; unit?: string; method?: "manual" | "agent" | "check" }) {
      const [k] = await db.insert(keyResults).values({ objectiveId, ...input }).returning();
      return k!;
    },

    async addMilestone(objectiveId: string, input: { title: string; targetDate?: string; horizon?: "now" | "next" | "later" }) {
      const [m] = await db.insert(milestones).values({ objectiveId, title: input.title, targetDate: input.targetDate ?? null, horizon: input.horizon ?? null }).returning();
      return m!;
    },

    async objectivesTree(companyId: string) {
      const objs = await db.select().from(objectives).where(eq(objectives.companyId, companyId)).orderBy(asc(objectives.priority), asc(objectives.createdAt));
      if (!objs.length) return [];
      const ids = objs.map((o) => o.id);
      const krs = await db.select().from(keyResults).where(inArray(keyResults.objectiveId, ids));
      const ms = await db.select().from(milestones).where(inArray(milestones.objectiveId, ids)).orderBy(asc(milestones.targetDate));
      return objs.map((o) => ({
        ...o,
        keyResults: krs
          .filter((k) => k.objectiveId === o.id)
          .map((k) => ({ ...k, progress: k.target ? Math.max(0, Math.min(1, (k.current ?? 0) / k.target)) : null })),
        milestones: ms.filter((m) => m.objectiveId === o.id),
      }));
    },
  };
}
