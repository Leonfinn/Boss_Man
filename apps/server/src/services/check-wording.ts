// Plain words for the two queues an agent can meet (BOS-1412): where its own check sits in line, and the fallback
// check it booked, so a repeat request or a second booking can say "you already have one" without a second job.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkJobs, tickets } from "../db/schema.js";
import { checkQueue, type CheckJob } from "./check-queue.js";

/** Boss Man's own carry-on wake (scheduler.ts). Kept here so the fallback rule can read it without importing the scheduler. */
export const CARRY_ON_NOTE = "Carry on where your last run stopped: the ticket is still in progress and you set no check";

/** HH:MM of a time on this system's clock (UTC), as the rest of Boss Man's notes write it. */
export const hhmm = (d: Date) => d.toISOString().slice(11, 16);

/** Where a live job sits: running now, number N in line, or held back (a red main). */
export async function checkPlace(queue: ReturnType<typeof checkQueue>, companyId: string, job: CheckJob): Promise<string> {
  if (job.state === "running") return "running now";
  const st = await queue.status(companyId);
  const place = st.queued.find((q) => q.id === job.id)?.place;
  return place ? `queued at no. ${place}` : "waiting (a red main holds back some checks)";
}

/** The agent's own live (queued or running) job on the ticket, if any: request_check and schedule_check set it. */
export async function ownLiveCheck(db: Db, ticketId: string, agentId: string): Promise<CheckJob | null> {
  const [j] = await db
    .select()
    .from(checkJobs)
    .where(and(eq(checkJobs.ticketId, ticketId), eq(checkJobs.requestedBy, agentId), inArray(checkJobs.state, ["queued", "running"])))
    .limit(1);
  return j ?? null;
}

/**
 * The ticket's booked fallback check, if one is set and nobody but the agent put it there. Boss Man's own carry-on
 * wake is not the agent's to count (BOS-1273), so it never blocks a booking. The wake time is returned too.
 */
export async function pendingFallback(db: Db, ticketId: string, carryOnNote: string): Promise<{ at: Date } | null> {
  const [t] = await db.select({ monitorAt: tickets.monitorAt, monitorNote: tickets.monitorNote }).from(tickets).where(eq(tickets.id, ticketId));
  if (!t?.monitorAt || t.monitorNote === carryOnNote) return null;
  return { at: t.monitorAt };
}
