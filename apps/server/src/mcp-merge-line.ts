// A read-only export of the merge line's timeline rows (BOS-1210), so an analyst can measure jams (BOS-801)
// from a run. Reads only activity rows of kind "merge_line" in the caller's own company and returns six
// fields of each row's detail; nothing else of the row (summary, agent, other detail keys) leaves the server.
import { and, asc, eq, gte, lt } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { activity } from "./db/schema.js";
import { MERGE_LINE_KIND } from "./services/merge-line.js";
import { fail, text, type Scope } from "./mcp-common.js";

export const MERGE_LINE_EXPORT_DEFAULT = 5000;
export const MERGE_LINE_EXPORT_MAX = 20_000;
export const MERGE_LINE_COLUMNS = ["ticket_id", "at", "event", "hold", "heldMs", "check", "passed", "by", "commit"] as const;

type Row = Record<(typeof MERGE_LINE_COLUMNS)[number], string | number | boolean | null>;

const str = (v: unknown) => (typeof v === "string" ? v : null);

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
  };
}

/** A CSV cell, quoted when needed; a leading = + - @ is prefixed so a spreadsheet never reads it as a formula. */
const cell = (v: string | number | boolean | null) => {
  if (v === null) return "";
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function registerMergeLineExport(server: Pick<McpServer, "registerTool">, db: Db, scope: Scope) {
  server.registerTool(
    "merge_line_records",
    {
      description:
        `Read-only export of your company's merge-line timeline (the rows BOS-769 records: approved, check queued/started/ended, hold started/ended, merged, and each server takeover: event "takeover" with the cause in by and the live commit in commit), oldest first. Returns ticket_id, at, event, hold, heldMs, check, passed, by and commit for each row, and nothing else. since is an ISO date or time (e.g. 2026-11-08T21:22:00Z); optional until (exclusive), format json (default) or csv, and limit (default ${MERGE_LINE_EXPORT_DEFAULT}, at most ${MERGE_LINE_EXPORT_MAX}). If the answer was cut at the limit it says so; ask again with since set to the last row's at to carry on (rows at that exact moment repeat, so drop them).`,
      inputSchema: {
        since: z.string().min(8).max(40),
        until: z.string().min(8).max(40).optional(),
        format: z.enum(["json", "csv"]).optional(),
        limit: z.number().int().min(1).max(MERGE_LINE_EXPORT_MAX).optional(),
      },
    },
    async ({ since, until, format, limit }) => {
      const from = new Date(since);
      const to = until ? new Date(until) : null;
      if (Number.isNaN(from.getTime())) return fail("since is not a date. Use ISO form, e.g. 2026-11-08T21:22:00Z.");
      if (to && Number.isNaN(to.getTime())) return fail("until is not a date. Use ISO form, e.g. 2026-11-12T00:00:00Z.");
      const max = limit ?? MERGE_LINE_EXPORT_DEFAULT;
      const found = await db
        .select({ ticketId: activity.ticketId, at: activity.at, detail: activity.detail })
        .from(activity)
        .where(and(eq(activity.companyId, scope.companyId), eq(activity.kind, MERGE_LINE_KIND), gte(activity.at, from), to ? lt(activity.at, to) : undefined))
        .orderBy(asc(activity.at), asc(activity.id))
        .limit(max + 1);
      const cut = found.length > max;
      const rows = found.slice(0, max).map(exportRow);
      const note = cut ? `Cut at ${max} rows; carry on with since=${rows[rows.length - 1]?.at}.` : `${rows.length} rows.`;
      if (format === "csv") return text([MERGE_LINE_COLUMNS.join(","), ...rows.map((r) => MERGE_LINE_COLUMNS.map((c) => cell(r[c])).join(","))].join("\n") + `\n# ${note}`);
      return text(JSON.stringify({ note, rows }));
    },
  );
}
