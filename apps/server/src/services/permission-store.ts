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

export type RuleUseCounts = { allow: number; ceo: number; owner: number; deny: number };
export type RuleUsage = { week: RuleUseCounts; month: RuleUseCounts; lastAt: string };

/**
 * How often each rule decided in the last 7 and 30 days (BOS-2372), by the rule text stored on the decision,
 * split by where the request went (allowed, the CEO, the owner, refused), with the last time it matched.
 * One company, or every company when companyId is null. Read-only. A rule renamed since keeps its old counts under the old name.
 */
export async function ruleUsage(db: Db, companyId: string | null, now: Date = new Date()): Promise<Record<string, RuleUsage>> {
  const monthStart = new Date(now.getTime() - 30 * 86_400_000);
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const count = (tier: string, from: Date) => sql<number>`count(*) filter (where ${permissionDecisions.tier} = ${tier} and ${permissionDecisions.at} >= ${from.toISOString()}::timestamptz)::int`;
  const rows = await db
    .select({
      rule: permissionDecisions.rule,
      wAllow: count("allow", weekStart),
      wCeo: count("ceo", weekStart),
      wOwner: count("owner", weekStart),
      wDeny: count("deny", weekStart),
      mAllow: count("allow", monthStart),
      mCeo: count("ceo", monthStart),
      mOwner: count("owner", monthStart),
      mDeny: count("deny", monthStart),
      lastAt: sql<string>`max(${permissionDecisions.at})`,
    })
    .from(permissionDecisions)
    .where(and(sql`${permissionDecisions.at} >= ${monthStart.toISOString()}::timestamptz`, companyId ? eq(permissionDecisions.companyId, companyId) : undefined))
    .groupBy(permissionDecisions.rule);
  const out: Record<string, RuleUsage> = {};
  for (const r of rows) {
    out[r.rule] = {
      week: { allow: r.wAllow, ceo: r.wCeo, owner: r.wOwner, deny: r.wDeny },
      month: { allow: r.mAllow, ceo: r.mCeo, owner: r.mOwner, deny: r.mDeny },
      lastAt: new Date(r.lastAt).toISOString(),
    };
  }
  return out;
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
