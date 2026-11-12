// The facts a sign-off card shows the owner (BOS-1236): who reviewed the ticket and what they said, and how the
// last quick check ended. Worked out when the card is listed, from the ticket's latest review round and check
// jobs, and never stored on the card, so they are always today's. Kept apart from signoff.ts, which imports
// decisions.ts (this is imported by it).
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, checkJobs, tickets } from "../db/schema.js";
import { latestRows } from "./review-kinds.js";

export type SignoffReview = { name: string; kind: string; verdict: "passed" | "changes" | "waiting" | "overruled" };
export type SignoffFacts = {
  reviews: SignoffReview[];
  quickCheck: { result: "passed" | "failed"; sha: string; at: string } | null;
  /** The number of files the branch changes. Not recorded anywhere on the server yet, so null; the card then leaves the row out. */
  files: number | null;
  /** The agent who holds the ticket (built it), so the card can say where "Send it back" goes. */
  builder: string | null;
};

const VERDICT: Record<string, SignoffReview["verdict"] | undefined> = {
  approved: "passed",
  overruled: "overruled",
  changes_requested: "changes",
  pending: "waiting",
};

export async function signoffFacts(db: Db, ticketId: string): Promise<SignoffFacts> {
  const rows = (await latestRows(db, ticketId)).filter((r) => VERDICT[r.status]);
  const ids = [...new Set(rows.map((r) => r.reviewerAgentId).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) for (const a of await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids))) names.set(a.id, a.name);
  const [job] = await db
    .select({ state: checkJobs.state, commit: checkJobs.commit, at: checkJobs.endedAt })
    .from(checkJobs)
    .where(and(eq(checkJobs.ticketId, ticketId), eq(checkJobs.kind, "pre_review"), inArray(checkJobs.state, ["passed", "failed"]), isNotNull(checkJobs.endedAt)))
    .orderBy(desc(checkJobs.endedAt))
    .limit(1);
  const [held] = await db.select({ name: agents.name }).from(tickets).innerJoin(agents, eq(agents.id, tickets.assigneeAgentId)).where(eq(tickets.id, ticketId));
  return {
    builder: held?.name ?? null,
    reviews: rows.map((r) => ({ name: (r.reviewerAgentId && names.get(r.reviewerAgentId)) || "A reviewer", kind: r.kind, verdict: VERDICT[r.status]! })),
    quickCheck: job?.at ? { result: job.state === "passed" ? "passed" : "failed", sha: job.commit, at: job.at.toISOString() } : null,
    files: null,
  };
}
