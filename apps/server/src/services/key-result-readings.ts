// A key result's history (BOS-2458). Every write to key_results.current goes through
// setKeyResultValue, so each new value is stored with when and who.
import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, keyResultReadings, keyResults } from "../db/schema.js";

export type ReadingBy = { kind: "owner" } | { kind: "check" } | { kind: "agent"; agentId: string | null };

/** How many readings the roadmap carries per key result (the fold; the sparkline uses the last 12). */
export const READINGS_SHOWN = 30;
export const SPARK_POINTS = 12;

/** Sets a key result's current value and stores the reading. Returns the updated row, or undefined if it is gone. */
export async function setKeyResultValue(db: Db, keyResultId: string, value: number, by: ReadingBy, at: Date = new Date()) {
  return db.transaction(async (tx) => {
    const [k] = await tx.update(keyResults).set({ current: value }).where(eq(keyResults.id, keyResultId)).returning();
    if (!k) return undefined;
    await tx.insert(keyResultReadings).values({ keyResultId, value, at, byKind: by.kind, agentId: by.kind === "agent" ? by.agentId : null });
    return k;
  });
}

export type ReadingView = { at: string; value: number; by: string };

/** The newest readings per key result, oldest first, with who gave each (agent names looked up). */
export async function readingsFor(db: Db, keyResultIds: string[]): Promise<Map<string, ReadingView[]>> {
  const out = new Map<string, ReadingView[]>();
  if (!keyResultIds.length) return out;
  const rows = await db
    .select({ keyResultId: keyResultReadings.keyResultId, at: keyResultReadings.at, value: keyResultReadings.value, byKind: keyResultReadings.byKind, agentName: agents.name })
    .from(keyResultReadings)
    .leftJoin(agents, eq(agents.id, keyResultReadings.agentId))
    .where(inArray(keyResultReadings.keyResultId, keyResultIds))
    .orderBy(desc(keyResultReadings.at));
  for (const r of rows) {
    const list = out.get(r.keyResultId) ?? [];
    if (list.length >= READINGS_SHOWN) continue;
    list.push({ at: r.at.toISOString(), value: r.value, by: r.byKind === "owner" ? "the owner" : r.byKind === "check" ? "automatic check" : (r.agentName ?? "an agent") });
    out.set(r.keyResultId, list);
  }
  for (const list of out.values()) list.reverse();
  return out;
}
