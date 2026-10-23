// "Did it move the goal?" (follow-up after release): a released feature that is tied to a key
// result is looked at again after a delay. The owner is asked once to Keep, Change or Drop it,
// and the answer stays on the feature. Features with no linked key result are left alone.
import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, decisions, features, keyResults, milestones, tickets } from "../db/schema.js";

export const GOAL_KEEP = "Keep";
export const GOAL_CHANGE = "Change";
export const GOAL_DROP = "Drop";
export const GOAL_OPTIONS = [GOAL_KEEP, GOAL_CHANGE, GOAL_DROP];
export const DEFAULT_GOAL_CHECK_DAYS = 14;
const DAY = 86_400_000;

/** The key results a feature is meant to move: those its tickets link to, and those of the objective it (or its milestone) links to. */
export async function goalKeyResults(db: Db, featureId: string) {
  const [f] = await db.select({ objectiveId: features.objectiveId, milestoneId: features.milestoneId }).from(features).where(eq(features.id, featureId));
  if (!f) return [];
  const [m] = f.milestoneId ? await db.select({ objectiveId: milestones.objectiveId }).from(milestones).where(eq(milestones.id, f.milestoneId)) : [];
  const fromTickets = await db.select({ id: tickets.keyResultId }).from(tickets).where(and(eq(tickets.featureId, featureId), isNotNull(tickets.keyResultId)));
  const objectiveIds = [f.objectiveId, m?.objectiveId].filter((x): x is string => !!x);
  const ids = fromTickets.map((t) => t.id!);
  const where = or(ids.length ? inArray(keyResults.id, ids) : undefined, objectiveIds.length ? inArray(keyResults.objectiveId, objectiveIds) : undefined);
  return where ? db.select().from(keyResults).where(where) : [];
}

/** Called when a feature has just become released. Sets the follow-up time once; a later release changes nothing. */
export async function scheduleGoalCheck(db: Db, f: { id: string; companyId: string }, at: Date) {
  if (!(await goalKeyResults(db, f.id)).length) return false;
  const [c] = await db.select({ days: companies.goalCheckDays }).from(companies).where(eq(companies.id, f.companyId));
  const due = new Date(at.getTime() + (c?.days ?? DEFAULT_GOAL_CHECK_DAYS) * DAY);
  const rows = await db
    .update(features)
    .set({ goalCheckDueAt: due })
    .where(and(eq(features.id, f.id), isNull(features.goalCheckDueAt)))
    .returning({ id: features.id });
  return rows.length > 0;
}

const num = (n: number | null, unit: string | null) => (n === null ? "not set" : `${n}${unit ? ` ${unit}` : ""}`);

/** Puts the follow-up to the owner for every released feature that is due and not yet asked. */
export async function raiseDueGoalChecks(db: Db, at: Date) {
  const due = await db
    .select()
    .from(features)
    .where(and(isNotNull(features.goalCheckDueAt), lte(features.goalCheckDueAt, at), isNull(features.goalCheckRaisedAt), eq(features.status, "released")));
  let raised = 0;
  for (const f of due) {
    const krs = await goalKeyResults(db, f.id);
    if (!krs.length) continue;
    const lines = krs.map((k) => `- ${k.title}: now ${num(k.current, k.unit)}, target ${num(k.target, k.unit)}`);
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(decisions)
        .values({
          companyId: f.companyId,
          kind: "approval",
          question: `Did "${f.title}" move the goal? It was released ${Math.max(0, Math.round((at.getTime() - (f.releasedAt ?? f.goalCheckDueAt!).getTime()) / DAY))} days ago.\n${lines.join("\n")}\nKeep it as it is, change it, or drop it?`,
          options: GOAL_OPTIONS,
          recommendedOption: GOAL_KEEP,
          tier: "owner",
          dedupeKey: `goal-check:${f.id}`,
          context: { type: "goal_check", featureId: f.id },
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id });
      await tx.update(features).set({ goalCheckRaisedAt: at }).where(eq(features.id, f.id));
      if (row) raised++;
    });
  }
  return { raised };
}

export async function recordGoalAnswer(db: Db, featureId: string, answer: string, at: Date) {
  await db.update(features).set({ goalCheckAnswer: answer, goalCheckAnsweredAt: at }).where(eq(features.id, featureId));
}
