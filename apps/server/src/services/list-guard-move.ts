// BOS-2522: the reads behind the list-guard check at the move to review; the rule itself is the pure list-guard-gate.ts.
// Like the screen-change check (render-check-move.ts, BOS-2511), a project without a repo or a diff the runner can't
// give skips it, and so does any error here: this check only saves the author a failed quick check, which still runs
// the real guards, so it must never be the reason a move is stuck.
import { and, eq } from "drizzle-orm";
import type { WorkspaceDiff } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { projects, tickets } from "../db/schema.js";
import { guardReads, listGuardRefusal } from "./list-guard-gate.js";

export type MoveReads = {
  diff(ticketId: string, companyId?: string): Promise<WorkspaceDiff>;
  readFile(ticketId: string, path: string, companyId?: string): Promise<{ text: string; truncated: boolean }>;
};

/** The same reads with the diff asked of the runner once per move: the screen-change check and this one both use it. */
export function diffOnce(review: MoveReads): MoveReads {
  let d: Promise<WorkspaceDiff> | undefined;
  return { diff: (ticketId, companyId) => (d ??= review.diff(ticketId, companyId)), readFile: (ticketId, path, companyId) => review.readFile(ticketId, path, companyId) };
}

export const LIST_GUARD_WRONG_MIN = 10;
export const LIST_GUARD_WRONG_MAX = 300;
export function listGuardWrongProblem(why: string): string | null {
  const t = why.trim();
  if (t.length < LIST_GUARD_WRONG_MIN) return `listGuardWrong needs a reason of at least ${LIST_GUARD_WRONG_MIN} characters: say which edit is wrong and why (e.g. "the label is built from a variable").`;
  if (/[\r\n]/.test(t)) return "listGuardWrong must be one line.";
  return null;
}

export async function listGuardForMove(db: Db, review: MoveReads, input: { ticketId: string; companyId: string }): Promise<{ refusal?: string; skipped?: boolean }> {
  try {
    const [t] = await db.select({ url: projects.repoUrl }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, input.companyId)));
    if (!t?.url) return {};
    const d = await review.diff(input.ticketId, input.companyId).catch(() => null);
    if (!d) return { skipped: true };
    const plan = guardReads(d);
    const paths = [...plan.lists, ...plan.webFiles];
    if (!paths.length) return {};
    // A truncated read counts as unread: a list cut short could drop the very entry being looked for.
    const read = await Promise.all(paths.map((p) => review.readFile(input.ticketId, p, input.companyId).then((f) => (f.truncated ? null : f.text), () => null)));
    const refusal = listGuardRefusal(plan, Object.fromEntries(paths.map((p, i) => [p, read[i] ?? null])));
    return refusal ? { refusal } : {};
  } catch {
    return { skipped: true };
  }
}
