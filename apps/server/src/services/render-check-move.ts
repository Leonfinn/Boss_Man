// BOS-2511 (DR-075): the reads behind the screen-change check at the move to review; the rule itself is the pure
// render-check-gate.ts. It asks for the diff itself (through the review service), so it doesn't depend on the check
// queue switch the way checkRequests.reviewRefusal does. A project without a repo, or a diff the runner can't give,
// skips the check (as the other diff-based review checks do), so a runner outage can't freeze every move.
import { and, eq, min, sql } from "drizzle-orm";
import type { WorkspaceDiff } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { projects, ticketImages, tickets, ticketTransitions } from "../db/schema.js";
import { hasSeededMarker, layoutFiles, MARKER_PREFIX_BYTES, renderCheckRefusal, renderTestCandidates } from "./render-check-gate.js";

type Reads = {
  diff(ticketId: string, companyId?: string): Promise<WorkspaceDiff>;
  readFile(ticketId: string, path: string, companyId?: string): Promise<{ text: string; truncated: boolean }>;
};

export async function renderCheckForMove(db: Db, review: Reads, input: { ticketId: string; companyId: string; noVisualChange?: string }): Promise<{ refusal?: string; skipped?: boolean; layout?: boolean }> {
  const [t] = await db.select({ url: projects.repoUrl, createdAt: tickets.createdAt }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, input.companyId)));
  if (!t?.url) return {};
  const d = await review.diff(input.ticketId, input.companyId).catch(() => null);
  if (!d) return { skipped: true };
  const layout = layoutFiles(d);
  if (!layout.length) return {};
  if (input.noVisualChange?.trim()) return { layout: true };
  // A truncated read still holds the imports and helpers at the top, which is what the test check reads.
  const tests = await Promise.all(renderTestCandidates(d).map(async (path) => ({ path, text: await review.readFile(input.ticketId, path, input.companyId).then((f) => f.text, () => null) })));
  // "Since the ticket started": the before shot comes before any commit, so the branch's first commit is too late a bound.
  // Tickets from before transitions were recorded fall back to their creation time.
  const [started] = await db.select({ at: min(ticketTransitions.at) }).from(ticketTransitions).where(and(eq(ticketTransitions.ticketId, input.ticketId), eq(ticketTransitions.toState, "in_progress")));
  const since = started?.at ? new Date(started.at) : t.createdAt;
  const rows = await db
    .select({ name: ticketImages.name, caption: ticketImages.caption, agentId: ticketImages.agentId, type: ticketImages.type, createdAt: ticketImages.createdAt, head: sql<Uint8Array>`substring(${ticketImages.bytes} from 1 for ${MARKER_PREFIX_BYTES})` })
    .from(ticketImages)
    .where(and(eq(ticketImages.ticketId, input.ticketId), eq(ticketImages.companyId, input.companyId), sql`${ticketImages.type} like 'image/%'`));
  const images = rows.map((i) => ({ name: i.name, caption: i.caption, byAgent: !!i.agentId, seeded: i.type === "image/png" && hasSeededMarker(i.head), sinceStart: i.createdAt.getTime() >= since.getTime() }));
  const refusal = renderCheckRefusal({ layout, tests, images });
  return refusal ? { refusal, layout: true } : { layout: true };
}
