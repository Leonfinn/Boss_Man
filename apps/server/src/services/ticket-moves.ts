// The one function that moves a ticket between states (DR-047 points 1 and 2, BOS-298 step 13).
// set_ticket_state, the owner's move and updateTicket all come through here, so the rules (the column,
// the WIP limit, the field rules, the history line, the merge line's "left" event and the steps that follow
// a real change) can't drift apart again. Wakes stay with the callers: they differ by cause.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { SystemState } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, tickets, workflowColumns } from "../db/schema.js";
import { record } from "./activity.js";
import { agentWipHold, cantMoveSql, countWip } from "./agent-wip.js";
import { lineEvent } from "./merge-line.js";
import { WorkError } from "./ticket-links.js";

export type TicketRow = typeof tickets.$inferSelect;

/** Moving a merged no-code ticket back into one of these clears the stale mark (BOS-532). Review is left to review.ts: only a commit there is real code work. */
const REOPEN_STATES = new Set<SystemState>(["ready", "in_progress"]);

/**
 * The one refusal for a stale expected_version (R81, BOS-897), shared by set_ticket_state, assign_ticket,
 * update_ticket and updateTicket: it reads the ticket as it is now so the caller can decide again.
 * Scoped to the caller's company, so another company's ticket id reveals nothing.
 */
export async function staleVersionMessage(db: Db, companyId: string, ticketId: string, expected: number): Promise<string> {
  const [now] = await db
    .select({ state: tickets.systemState, version: tickets.version, changed: tickets.lastActivityAt, assignee: agents.name })
    .from(tickets)
    .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
    .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId)));
  if (!now) return "No ticket with that ID in your company.";
  return `Nothing changed: the ticket changed since you last saw it (you had version ${expected}). It is now ${now.state}, assigned to ${now.assignee ?? "nobody"}, version ${now.version}, last changed ${now.changed.toISOString()}. Read it again with tickets, then decide.`;
}

/** What follows a real state change. Each is optional; the caller says what it wakes. */
export type MoveHooks = {
  onDone?: (ticket: TicketRow) => unknown;
  /** Opens the review round (the reviews the tier requires are requested and the reviewers woken). */
  onReview?: (ticket: TicketRow) => unknown;
  onFeature?: (featureId: string) => unknown;
};

export type MoveOpts = {
  /** The agent making the move; left out for the owner or Boss Man. */
  by?: string | null;
  /** The states the move may start from; default any. A ticket in another state is refused with a 409. */
  from?: SystemState[];
  /** Refuse (409, with the ticket as it is now) when the version moved on. */
  expectedVersion?: number;
  /** Only a ticket of this company (an agent's scope); another company's id reads as "no such ticket". */
  companyId?: string;
  outcome?: "completed" | "cancelled";
  /** Only with `to` blocked: until when it waits, and why. `null` clears. Left out leaves them as they are. */
  blockedUntil?: Date | null;
  blockedUntilReason?: string | null;
  /** Why, for the history line. */
  note?: string;
  /** Skip the column's WIP limit (the owner's override, Boss Man's own moves). */
  overLimit?: boolean;
  /** Boss Man's own move (back from the merge): skips the no-code reopen rule. */
  internal?: boolean;
  /** "new" (default) opens a review round on a real move into review; "keep" leaves the round alone. */
  reviewRound?: "new" | "keep";
  /** A column of the ticket's board (or of `projectId`'s): the state follows the column and `to` is ignored. */
  columnId?: string;
  /** Move to this project's board, keeping the state (the caller has checked it). Skips the WIP limit. */
  projectId?: string;
  /** Other columns of the ticket to write in the same guarded statement (title, note, assignee, ...). */
  fields?: Partial<typeof tickets.$inferInsert>;
  hooks?: MoveHooks;
  now?: Date;
};

/** `held`: the agent's WIP limit kept a new start in Ready (the "Waiting:" note, also written on the ticket); `urgentOver`: an urgent ticket started over the limit. */
export type MoveResult = { ticket: TicketRow; before: TicketRow; changed: boolean; held: string | null; urgentOver: boolean };

/**
 * Moves a ticket to `to` (null keeps its state, for a note or field edit) and writes everything that goes
 * with it, in order: one guarded UPDATE (id, version, the allowed from-states); the column (kept when the
 * state is unchanged, DR-010; else the first column for the state, with the WIP limit); the field rules;
 * one history line; the merge line's "left" event when it leaves review; and, only when the state really
 * changed, the done steps, the review round and the feature sync.
 */
export async function moveTicket(db: Db, ticketId: string, to: SystemState | null, opts: MoveOpts = {}): Promise<MoveResult> {
  const at = opts.now ?? new Date();
  const [t] = await db.select().from(tickets).where(opts.companyId ? and(eq(tickets.id, ticketId), eq(tickets.companyId, opts.companyId)) : eq(tickets.id, ticketId));
  if (!t) throw new WorkError(404, opts.companyId ? "No ticket with that ID in your company." : "No such ticket.");
  if (opts.expectedVersion !== undefined && t.version !== opts.expectedVersion) throw new WorkError(409, await staleVersionMessage(db, t.companyId, ticketId, opts.expectedVersion));
  if (opts.from && !opts.from.includes(t.systemState)) throw new WorkError(409, `It is ${t.systemState}, so it can't be moved from there.`);

  // The column: an explicit one, else the first for the state, else (state unchanged) where it is (DR-010).
  const boardId = opts.projectId ?? t.projectId;
  const cols = opts.columnId || (to && to !== t.systemState) || opts.projectId ? await db.select().from(workflowColumns).where(eq(workflowColumns.projectId, boardId)).orderBy(asc(workflowColumns.position)) : [];
  let target: SystemState = to ?? t.systemState;
  let columnId: string | null = t.columnId;
  if (opts.columnId) {
    const col = cols.find((c) => c.id === opts.columnId);
    if (!col) throw new WorkError(422, "That column isn't on this project's board.");
    target = col.systemState;
    columnId = col.id;
  } else if (cols.length && (target !== t.systemState || opts.projectId)) {
    const col = cols.find((c) => c.systemState === target);
    if (!col) throw new WorkError(422, "That column isn't on this project's board.");
    columnId = col.id;
  }
  // The agent's own limit (BOS-1029): a new start (backlog or ready -> in progress) of an agent at its limit waits in Ready,
  // assigned, with a note saying why. Boss Man's own moves are held too; only the owner's override (overLimit, not internal) skips it.
  let held: string | null = null;
  let urgentOver = false;
  if (target === "in_progress" && (t.systemState === "backlog" || t.systemState === "ready") && !(opts.overLimit && !opts.internal) && !opts.projectId) {
    const r = await agentWipHold(db, t);
    urgentOver = r.urgentOver;
    if (r.hold) {
      const ready = t.systemState === "ready" ? { id: t.columnId } : (await db.select().from(workflowColumns).where(and(eq(workflowColumns.projectId, boardId), eq(workflowColumns.systemState, "ready"))).orderBy(asc(workflowColumns.position)))[0];
      if (!ready) throw new WorkError(422, "That column isn't on this project's board.");
      held = r.hold.reason;
      target = "ready";
      columnId = ready.id ?? null;
    }
  }
  if (columnId && columnId !== t.columnId && !opts.overLimit && !opts.projectId && !held) {
    const col = cols.find((c) => c.id === columnId);
    if (col?.wipLimit != null) {
      // The same counting rule as the agent's limit: tickets in this column and state, not counting this one.
      const inCol = await countWip(db, and(eq(tickets.columnId, col.id), eq(tickets.systemState, col.systemState), col.systemState === "in_progress" ? sql`not ${cantMoveSql}` : undefined), t.id);
      if (inCol >= col.wipLimit) throw new WorkError(409, `"${col.name}" is at its limit of ${col.wipLimit}.`);
    }
  }

  // The field rules.
  const changed = target !== t.systemState;
  const fields: Partial<typeof tickets.$inferInsert> = { ...opts.fields };
  if (held) Object.assign(fields, { stateNote: held, stateNoteAt: at, stateNoteStaleAt: null });
  else if (target === "in_progress" && fields.stateNote === undefined && t.wipHeldAt) fields.stateNote = null;
  // The hold is a field, so a later state note can't erase it (BOS-1180): set when held, kept while the ticket stays in Ready, cleared on leaving it.
  if (held) fields.wipHeldAt = t.systemState === "ready" && t.wipHeldAt ? t.wipHeldAt : at; // the first hold's time, so "held for 30 minutes" isn't reset by each refusal
  else if (target !== "ready") fields.wipHeldAt = null;
  // "Being checked" (BOS-1906) is a mark on a ticket in review; any move out of review ends it.
  if (target !== "review" && t.checkHoldAt && fields.checkHoldAt === undefined) fields.checkHoldAt = null;
  if (t.noCode && t.mergeCommit && !opts.internal && fields.noCode === undefined && changed && REOPEN_STATES.has(target)) fields.noCode = false;
  const set: Partial<typeof tickets.$inferInsert> = {
    ...fields,
    systemState: target,
    columnId,
    outcome: target === "done" ? (opts.outcome ?? (t.systemState === "done" ? t.outcome : null) ?? "completed") : null,
    ...(target === "done" ? { monitorAt: null } : {}),
    ...(target === "blocked" && opts.blockedUntil !== undefined ? { blockedUntil: opts.blockedUntil, blockedUntilReason: opts.blockedUntil ? (opts.blockedUntilReason ?? null) : null } : {}),
    lastActivityAt: at,
  };
  // The version and the allowed states go in the same statement as the write, so nothing changes if another write landed after the read above.
  const [updated] = await db
    .update(tickets)
    .set(set)
    .where(and(eq(tickets.id, ticketId), opts.companyId ? eq(tickets.companyId, opts.companyId) : undefined, opts.expectedVersion === undefined ? undefined : eq(tickets.version, opts.expectedVersion), opts.from ? inArray(tickets.systemState, opts.from) : undefined))
    .returning();
  if (!updated) {
    if (opts.expectedVersion !== undefined) throw new WorkError(409, await staleVersionMessage(db, t.companyId, ticketId, opts.expectedVersion));
    throw new WorkError(409, "The ticket changed while it was being moved. Read it again, then decide.");
  }

  if (changed) {
    const until = target === "blocked" && updated.blockedUntil && opts.blockedUntil ? ` (until ${updated.blockedUntil.toISOString().slice(0, 16).replace("T", " ")} UTC${updated.blockedUntilReason ? `: ${updated.blockedUntilReason}` : ""})` : "";
    await record(db, { companyId: t.companyId, agentId: opts.by ?? undefined, ticketId: t.id, kind: "state", summary: `${t.systemState} -> ${target}${opts.note?.trim() ? `: ${opts.note.trim()}` : ""}${until}${urgentOver ? " (urgent: started over the WIP limit)" : ""}`, at });
    // Out of review without a merge (sent back, cancelled, closed by hand) ends its pass through the merge line (BOS-769).
    // A merge records "merged" first, and an unapproved ticket was never in the line, so lineEvent writes nothing for either.
    if (t.systemState === "review") await lineEvent(db, t, { event: "left", to: target }, at);
    if (target === "done") await opts.hooks?.onDone?.(updated);
    if (target === "review" && (opts.reviewRound ?? "new") === "new") await opts.hooks?.onReview?.(updated);
  }
  // A task of the feature started, finished, reopened, moved or was added: the feature's status may need to follow.
  if (opts.hooks?.onFeature) for (const fid of new Set([t.featureId, updated.featureId])) if (fid) await opts.hooks.onFeature(fid);
  return { ticket: updated, before: t, changed, held, urgentOver };
}
