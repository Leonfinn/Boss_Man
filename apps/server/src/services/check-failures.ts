// BOS-1723: the list `tickets check_log` gives without a jobId. Before, it returned the newest kept log, which was often a
// different failure from the one the agent was asked about; now it names every failed check of the ticket so the right
// one can be opened: the gate's own jobs (merge and quick checks, with their job id) and GitHub CI failures on a merge.
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkResults } from "../db/schema.js";
import { checkQueue } from "./check-queue.js";

const LIMIT = 20;
const KIND_TEXT: Record<string, string> = { merge: "merge check", pre_review: "quick check" };
const when = (d: Date | null) => (d ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : "time unknown");

/** The text of the list, or null when the ticket has no failed check at all. */
export async function failedChecksText(db: Db, companyId: string, ticketId: string): Promise<string | null> {
  const jobs = await checkQueue(db).failedJobs(companyId, ticketId, LIMIT);
  const ci = await db
    .select({ at: checkResults.at, sha: checkResults.sha, detail: checkResults.detail })
    .from(checkResults)
    .where(and(eq(checkResults.companyId, companyId), eq(checkResults.ticketId, ticketId), eq(checkResults.kind, "ci"), eq(checkResults.passed, false)))
    .orderBy(desc(checkResults.at))
    .limit(LIMIT);
  if (!jobs.length && !ci.length) return null;
  const rows = [
    ...jobs.map((j) => ({
      at: j.endedAt,
      line: `- job ${j.jobId}: ${KIND_TEXT[j.kind] ?? j.kind} (${j.scope}) on ${j.commit.slice(0, 12)}, ${j.state === "stuck" ? "stuck" : "failed"} ${when(j.endedAt)}. ${j.firstLine ? `First failing line: ${j.firstLine.slice(0, 300)}` : "No failing line named."}${j.logChars ? ` Log kept (${Math.max(1, Math.round(j.logChars / 1024))} KB).` : " No log kept."}`,
    })),
    ...ci.map((c) => ({
      at: c.at,
      line: `- GitHub CI on the merge commit ${(c.sha ?? "").slice(0, 12) || "(unknown)"}, failed ${when(c.at)}: ${c.detail ?? "workflow failed"}. Its log stays on GitHub; the failing lines are in the bounce message in the ticket's conversation.`,
    })),
  ].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  return [
    `Failed checks of this ticket, newest first (up to ${LIMIT} of each kind). Open one with tickets check_log and its jobId:`,
    ...rows.map((r) => r.line),
  ].join("\n");
}
