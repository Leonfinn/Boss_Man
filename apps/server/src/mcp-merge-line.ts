// A read-only export of the merge line's timeline rows (BOS-1210), so an analyst can measure jams (BOS-801)
// from a run. Reads only activity rows of kind "merge_line" in the caller's own company and returns six
// fields of each row's detail; nothing else of the row (summary, agent, other detail keys) leaves the server.
//
// what: "check_jobs" (BOS-1309) exports the whole check line instead: every check_jobs row (agents' request_check
// jobs and the gate's merge checks, which share the slots) plus one row per request_check answered by an existing
// job (activity kind check_reused, since such a request makes no job). Same since/until/limit/format; eight named
// fields per row, never the command, log, commit or requester.
//
// what: "cards" (BOS-2763) exports the merge and check cards (cardRow below), never their question or output.
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { activity, checkJobs, checkWorkers, decisions } from "./db/schema.js";
import { MERGE_LINE_KIND } from "./services/merge-line.js";
import { CHECK_REUSED_KIND } from "./services/check-request.js";
import { fail, text, type Scope } from "./mcp-common.js";

export const MERGE_LINE_EXPORT_DEFAULT = 5000;
export const MERGE_LINE_EXPORT_MAX = 20_000;
/** with and files (BOS-1515): a train_clash row's clashing tickets (ids, space-separated) and files (comma-separated, capped). */
export const MERGE_LINE_COLUMNS = ["ticket_id", "at", "event", "hold", "heldMs", "check", "passed", "by", "commit", "with", "files", "note", "action", "rebuilds", "reason"] as const;
// BOS-1823: note = a hold_started's note (for hold "turn", names the ticket that has the landing turn); action = a landing_turn's
// (taken, queued, ended, expired) or a train_clash's; rebuilds = a rebuilt's or landing_turn's count; reason = why a merge was
// rebuilt (rebuilt rows) or failed (attempt_failed rows), or how a GitHub CI wait ended (ci_wait_ended rows, BOS-1871). An
// attempt_failed row with reason "restart" also carries its note (BOS-2089). Other events' notes and reasons stay private.
/** ran_on (BOS-1435): "company runner" or the check worker's name, for a job that started; null otherwise. */
/**
 * BOS-1923: busy_at_start = slots busy on its machine when it started (itself not counted); ran = "quick" or "quick+full"
 * (whether the full check ran after the quick one, read from the output); steps = "name=seconds" pairs separated by spaces,
 * in order (kept 14 days, then empty). All empty for a job from before or a reused row.
 */
export const CHECK_JOB_COLUMNS = ["ticket_id", "kind", "scope", "queued", "started", "finished", "outcome", "reused", "ran_on", "busy_at_start", "ran", "steps"] as const;
/**
 * BOS-2763: what "cards" exports, one row per merge or check card (decisions with context.type "check_stuck", raised by
 * raiseMergeStuck and raiseCheckStuck), so a card-routing check (BOS-1875) can be repeated from the export. Read from the
 * cards themselves rather than recorded as new events: the card already keeps its ladder hops, answer and settler, and
 * reading them covers cards raised before this change too. Never the question or the check output.
 */
export const CARD_COLUMNS = ["card_id", "ticket_id", "card", "raised", "first_rung", "rung", "to_owner", "outcome", "answer", "answered_by", "closed", "minutes"] as const;

type Cell = string | number | boolean | null;
type Row = Record<(typeof MERGE_LINE_COLUMNS)[number], Cell>;
type JobRow = Record<(typeof CHECK_JOB_COLUMNS)[number], string | number | null>;
type CardRow = Record<(typeof CARD_COLUMNS)[number], string | number | null>;

const str = (v: unknown) => (typeof v === "string" ? v : null);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** One export row: only the named keys of the detail, each read as the right type or null. */
export function exportRow(r: { ticketId: string | null; at: Date; detail: Record<string, unknown> | null }): Row {
  const d = r.detail ?? {};
  return {
    ticket_id: r.ticketId,
    at: r.at.toISOString(),
    event: str(d.event),
    hold: str(d.hold),
    heldMs: typeof d.heldMs === "number" ? d.heldMs : null,
    check: str(d.check),
    passed: typeof d.passed === "boolean" ? d.passed : null,
    by: str(d.by),
    commit: str(d.commit),
    with: Array.isArray(d.with) ? d.with.map((w) => str((w as { ticketId?: unknown } | null)?.ticketId)).filter((x): x is string => !!x).join(" ") || null : null,
    files: Array.isArray(d.files) ? d.files.filter((f): f is string => typeof f === "string").join(",") || null : null,
    // BOS-2089: a "restart" failure's note is the runner's own reason (lock time-out, no answer), so a run of them can be told apart.
    note: d.event === "hold_started" || (d.event === "attempt_failed" && d.reason === "restart") ? str(d.note) : null,
    action: str(d.action),
    rebuilds: typeof d.rebuilds === "number" ? d.rebuilds : null,
    reason: d.event === "rebuilt" ? str(d.why) : d.event === "attempt_failed" ? str(d.reason) : d.event === "ci_wait_ended" ? str(d.outcome) : null,
  };
}

/** A check job: queued/started/finished are its own times; outcome is its state (queued, running, passed, failed, stuck, cancelled). */
export function jobRow(j: { ticketId: string; kind: string; scope: string; state: string; queuedAt: Date; startedAt: Date | null; endedAt: Date | null; worker?: string | null; workerId?: string | null; busyAtStart?: number | null; stages?: string | null; ranFull?: boolean | null }): JobRow {
  const ranOn = !j.startedAt ? null : j.workerId ? (j.worker ?? "a check worker") : "company runner";
  let steps: string | null = null;
  try {
    const list = j.stages ? (JSON.parse(j.stages) as Array<{ name?: unknown; seconds?: unknown }>) : [];
    steps = list.filter((s) => typeof s.name === "string" && typeof s.seconds === "number").map((s) => `${String(s.name).replace(/\s+/g, "_")}=${s.seconds}`).join(" ") || null;
  } catch {
    steps = null;
  }
  return { ticket_id: j.ticketId, kind: j.kind, scope: j.scope, queued: iso(j.queuedAt), started: iso(j.startedAt), finished: iso(j.endedAt), outcome: j.state, reused: null, ran_on: ranOn, busy_at_start: j.busyAtStart ?? null, ran: j.ranFull == null ? null : j.ranFull ? "quick+full" : "quick", steps };
}

/** A reused request: queued is when it was asked; it never waits or runs; reused is "passed" or "live"; outcome is the answering job's state then. */
export function reusedRow(r: { ticketId: string | null; at: Date; detail: Record<string, unknown> | null }): JobRow {
  const d = r.detail ?? {};
  return { ticket_id: r.ticketId, kind: "pre_review", scope: str(d.scope), queued: r.at.toISOString(), started: null, finished: null, outcome: str(d.outcome), reused: str(d.reused), ran_on: null, busy_at_start: null, ran: null, steps: null };
}

/**
 * A merge or check card (BOS-2763). card: "merge" for a merge that didn't finish (raiseMergeStuck, no command), "check" for a
 * check that couldn't finish. first_rung / rung: where the alert ladder put it first and where it is now; a card with no ladder
 * went straight to the owner's queue (owner-first by design, or raised before BOS-1873), so both are "owner" and to_owner is
 * its raise time. to_owner: when it reached the owner's queue, empty if it never did. answered_by: "owner", the name of the
 * agent that settled it (the CEO's, usually), or "withdrawn" (replaced or cleared by Boss Man). minutes: raised to closed.
 */
export function cardRow(r: { id: string; createdAt: Date; status: string; answer: string | null; answeredAt: Date | null; context: unknown }): CardRow {
  const c = (r.context && typeof r.context === "object" ? r.context : {}) as {
    ticketId?: unknown;
    command?: unknown;
    settled?: { name?: unknown } | null;
    ladder?: { rung?: unknown; hops?: Array<{ to?: unknown; at?: unknown } | null> } | null;
  };
  const raised = r.createdAt.toISOString();
  const rawHops = c.ladder?.hops;
  const hops = Array.isArray(rawHops) ? rawHops : [];
  const ladder = !!c.ladder && typeof c.ladder === "object";
  const firstRung = ladder ? (str(hops[0]?.to) ?? str(c.ladder?.rung)) : "owner";
  const toOwner = ladder ? str(hops.find((h) => h?.to === "owner")?.at) : raised;
  const settledBy = str(c.settled?.name);
  const answeredBy = r.status === "withdrawn" ? "withdrawn" : r.status === "answered" ? (settledBy ?? "owner") : null;
  const minutes = r.answeredAt ? Math.round((r.answeredAt.getTime() - r.createdAt.getTime()) / 6000) / 10 : null;
  return {
    card_id: r.id,
    ticket_id: str(c.ticketId),
    card: c.command === "" ? "merge" : "check",
    raised,
    first_rung: firstRung,
    rung: ladder ? str(c.ladder?.rung) : "owner",
    to_owner: toOwner,
    outcome: r.status,
    answer: r.status === "answered" ? r.answer : null,
    answered_by: answeredBy,
    closed: iso(r.answeredAt),
    minutes,
  };
}

/** A CSV cell, quoted when needed; a leading = + - @ is prefixed so a spreadsheet never reads it as a formula. */
const cell = (v: Cell) => {
  if (v === null) return "";
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csv = <C extends string>(cols: readonly C[], rows: Array<Record<C, Cell>>, note: string) =>
  [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + `\n# ${note}`;

export function registerMergeLineExport(server: Pick<McpServer, "registerTool">, db: Db, scope: Scope) {
  server.registerTool(
    "merge_line_records",
    {
      description:
        `Read-only export of your company's merge-line timeline (the rows BOS-769 records: approved, check queued/started/ended, hold started/ended, merged, and each server takeover: event "takeover" with the cause in by and the live commit in commit), oldest first. Returns ticket_id, at, event, hold, heldMs, check, passed, by, commit, with, files, note, action, rebuilds and reason for each row, and nothing else (with and files: a train_clash row's clashing ticket ids and files, for a ticket held to land alone or sent back for a clash with main; note: a hold_started row's note, which for hold "turn" names the ticket that HAS the landing turn: the row's own ticket is only waiting behind it; action: a landing_turn row's taken, queued, ended or expired; rebuilds and reason: why a merge was rebuilt after main moved, or why an attempt failed; ci_wait_started and ci_wait_ended: a landing's wait for GitHub CI on its merge copy, with commit, and reason on the end row saying how it ended; ci_covered: a merge-train ticket that landed on the GitHub pass of the ticket in by, behind it, on that ticket's commit). since is an ISO date or time (e.g. 2026-11-08T21:22:00Z); optional until (exclusive), format json (default) or csv, and limit (default ${MERGE_LINE_EXPORT_DEFAULT}, at most ${MERGE_LINE_EXPORT_MAX}). If the answer was cut at the limit it says so; ask again with since set to the last row's at to carry on (rows at that exact moment repeat, so drop them). ` +
        `what: "check_jobs" exports the whole check line instead, by queue time: every check job (kind pre_review for agents' request_check, merge for the gate) with ticket_id, kind, scope, queued, started, finished, outcome, reused and ran_on ("company runner" or a check worker's name). Queue wait = started - queued; a job never started has started empty. A request_check answered by an earlier pass or by the ticket's job already in line is its own row with reused "passed" or "live" and no start or finish. Since BOS-1923 a job that ran also has busy_at_start (slots busy on its machine when it started, itself not counted), ran ("quick" or "quick+full": whether the full check ran after the quick one) and steps ("name=seconds" pairs in order, kept 14 days), for passed and failed jobs alike. Carry on from the last row's queued. ` +
        `what: "cards" exports the merge and check cards instead, by raise time: card_id, ticket_id, card ("merge" or "check"), raised, first_rung and rung (the alert ladder's first and current rung: scrum_master, ceo or owner; a card that went straight to the owner, by design or from before the CEO-first routing, says owner for both), to_owner (when it reached the owner's queue, empty if never), outcome (open, answered, withdrawn), answer, answered_by ("owner", the settling agent's name, or "withdrawn"), closed and minutes (raised to closed). Carry on from the last row's raised.`,
      inputSchema: {
        since: z.string().min(8).max(40),
        until: z.string().min(8).max(40).optional(),
        format: z.enum(["json", "csv"]).optional(),
        limit: z.number().int().min(1).max(MERGE_LINE_EXPORT_MAX).optional(),
        what: z.enum(["merge_line", "check_jobs", "cards"]).optional(),
      },
    },
    async ({ since, until, format, limit, what }) => {
      const from = new Date(since);
      const to = until ? new Date(until) : null;
      if (Number.isNaN(from.getTime())) return fail("since is not a date. Use ISO form, e.g. 2026-11-08T21:22:00Z.");
      if (to && Number.isNaN(to.getTime())) return fail("until is not a date. Use ISO form, e.g. 2026-11-12T00:00:00Z.");
      const max = limit ?? MERGE_LINE_EXPORT_DEFAULT;
      const activityRows = (kind: string) =>
        db
          .select({ ticketId: activity.ticketId, at: activity.at, detail: activity.detail })
          .from(activity)
          .where(and(eq(activity.companyId, scope.companyId), eq(activity.kind, kind), gte(activity.at, from), to ? lt(activity.at, to) : undefined))
          .orderBy(asc(activity.at), asc(activity.id))
          .limit(max + 1);
      if (what === "cards") {
        const found = await db
          .select({ id: decisions.id, createdAt: decisions.createdAt, status: decisions.status, answer: decisions.answer, answeredAt: decisions.answeredAt, context: decisions.context })
          .from(decisions)
          .where(and(eq(decisions.companyId, scope.companyId), sql`${decisions.context}->>'type' = 'check_stuck'`, gte(decisions.createdAt, from), to ? lt(decisions.createdAt, to) : undefined))
          .orderBy(asc(decisions.createdAt), asc(decisions.id))
          .limit(max + 1);
        const cut = found.length > max;
        const rows = found.slice(0, max).map(cardRow);
        const note = cut ? `Cut at ${max} rows; carry on with since=${rows[rows.length - 1]?.raised}.` : `${rows.length} rows.`;
        if (format === "csv") return text(csv(CARD_COLUMNS, rows, note));
        return text(JSON.stringify({ note, rows }));
      }
      if (what === "check_jobs") {
        const jobs = await db
          .select({ ticketId: checkJobs.ticketId, kind: checkJobs.kind, scope: checkJobs.scope, state: checkJobs.state, queuedAt: checkJobs.queuedAt, startedAt: checkJobs.startedAt, endedAt: checkJobs.endedAt, workerId: checkJobs.workerId, worker: checkWorkers.name, busyAtStart: checkJobs.busyAtStart, stages: checkJobs.stages, ranFull: checkJobs.ranFull })
          .from(checkJobs)
          .leftJoin(checkWorkers, eq(checkWorkers.id, checkJobs.workerId))
          .where(and(eq(checkJobs.companyId, scope.companyId), gte(checkJobs.queuedAt, from), to ? lt(checkJobs.queuedAt, to) : undefined))
          .orderBy(asc(checkJobs.queuedAt), asc(checkJobs.id))
          .limit(max + 1);
        // Each source is fetched up to max + 1, so the first max of the merged, time-sorted list are exact. ISO strings sort as times.
        const found = [...jobs.map(jobRow), ...(await activityRows(CHECK_REUSED_KIND)).map(reusedRow)].sort((a, b) => (a.queued! < b.queued! ? -1 : a.queued! > b.queued! ? 1 : 0));
        const cut = found.length > max;
        const rows = found.slice(0, max);
        const note = cut ? `Cut at ${max} rows; carry on with since=${rows[rows.length - 1]?.queued}.` : `${rows.length} rows.`;
        if (format === "csv") return text(csv(CHECK_JOB_COLUMNS, rows, note));
        return text(JSON.stringify({ note, rows }));
      }
      const found = await activityRows(MERGE_LINE_KIND);
      const cut = found.length > max;
      const rows = found.slice(0, max).map(exportRow);
      const note = cut ? `Cut at ${max} rows; carry on with since=${rows[rows.length - 1]?.at}.` : `${rows.length} rows.`;
      if (format === "csv") return text(csv(MERGE_LINE_COLUMNS, rows, note));
      return text(JSON.stringify({ note, rows }));
    },
  );
}
