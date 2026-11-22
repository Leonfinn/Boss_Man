// The stored side of the permission log (BOS-2185): one row per decision, kept 60 days so the Run
// page can list what each rule decided after a restart. The title can hold command text, so it is
// redacted the way logs are before it is stored; raw tool input is never passed in.
import { and, asc, eq, sql } from "drizzle-orm";
import { redact } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { permissionDecisions } from "../db/schema.js";
import type { PermissionLogEntry } from "./permission-log.js";

export const PERMISSION_TITLE_MAX = 200;
export const PERMISSIONS_PER_RUN_MAX = 500;

export type PermissionStore = {
  insert(entry: PermissionLogEntry): Promise<void>;
  /** The card for a request was answered. */
  markAnswered(decisionId: string, answeredBy: string, at: Date): Promise<void>;
};

export const storedTitle = (title: string | null | undefined): string | null =>
  title == null ? null : redact(title).replace(/\s+/g, " ").trim().slice(0, PERMISSION_TITLE_MAX);

export function permissionStore(db: Db): PermissionStore {
  return {
    async insert(e) {
      await db.insert(permissionDecisions).values({
        at: e.at,
        companyId: e.companyId,
        runId: e.runId,
        agentId: e.agentId,
        ticketId: e.ticketId,
        title: storedTitle(e.title),
        kind: e.kind,
        rule: e.rule,
        position: e.position,
        outcome: e.outcome,
        tier: e.tier,
        decisionId: e.decisionId ?? null,
      });
    },
    async markAnswered(decisionId, answeredBy, at) {
      await db
        .update(permissionDecisions)
        .set({ answeredBy, answeredAt: at })
        .where(and(eq(permissionDecisions.decisionId, decisionId), sql`${permissionDecisions.answeredBy} is null`));
    },
  };
}

/** One run's decisions, oldest first, capped; `truncated` says the run had more. */
export async function permissionsForRun(db: Db, runId: string) {
  const rows = await db
    .select({
      id: permissionDecisions.id,
      at: permissionDecisions.at,
      title: permissionDecisions.title,
      kind: permissionDecisions.kind,
      rule: permissionDecisions.rule,
      position: permissionDecisions.position,
      outcome: permissionDecisions.outcome,
      tier: permissionDecisions.tier,
      answeredBy: permissionDecisions.answeredBy,
      answeredAt: permissionDecisions.answeredAt,
    })
    .from(permissionDecisions)
    .where(eq(permissionDecisions.runId, runId))
    .orderBy(asc(permissionDecisions.at))
    .limit(PERMISSIONS_PER_RUN_MAX + 1);
  return { entries: rows.slice(0, PERMISSIONS_PER_RUN_MAX), truncated: rows.length > PERMISSIONS_PER_RUN_MAX };
}
