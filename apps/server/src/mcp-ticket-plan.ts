// BOS-2720: a ticket's size and milestone as agents' lookups (tickets find/read, board) show them, so the CEO and the PM
// see what the owner sees on the Roadmap without a ticket to ask someone.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { features, milestones, objectives, tickets } from "./db/schema.js";
import { effectiveSize } from "./services/planning.js";

/**
 * A ticket's milestone: its own, else its feature's. The Roadmap counts a ticket the same way (ticketsOfMilestones), so
 * a list filtered by this matches the milestone's figures. Queries using it must left join features on the ticket's feature.
 */
export const milestoneOfTicket = sql<string | null>`coalesce(${tickets.milestoneId}, ${features.milestoneId})`;

/** Points, or "no size" (a size that isn't a real one counts as none, as on the Roadmap). */
export const sizeOut = (size: number | null | undefined): number | "no size" => effectiveSize(size) || "no size";

export const milestoneOut = (id: string | null | undefined, title: string | null | undefined) => (id ? { id, title: title ?? "" } : null);

/** The milestone an agent names, by id or exact title (any case), in its own company; or why none was found. */
export async function findMilestone(db: Db, companyId: string, given: string): Promise<{ id: string; title: string } | { error: string }> {
  const g = given.trim();
  const byId = z.string().uuid().safeParse(g).success;
  const rows = await db
    .select({ id: milestones.id, title: milestones.title, objective: objectives.title })
    .from(milestones)
    .innerJoin(objectives, eq(objectives.id, milestones.objectiveId))
    .where(and(eq(objectives.companyId, companyId), byId ? eq(milestones.id, g) : sql`lower(${milestones.title}) = ${g.toLowerCase()}`))
    .limit(10);
  if (rows.length === 1) return { id: rows[0]!.id, title: rows[0]!.title };
  if (rows.length > 1) return { error: `${rows.length} milestones are called "${g}"; give the id:\n${rows.map((r) => `- ${r.title} under "${r.objective}" (id ${r.id})`).join("\n")}` };
  return { error: `No milestone ${byId ? "with that id" : `called "${g}"`} in your company. roadmap list or board shows the milestones with their ids.` };
}
