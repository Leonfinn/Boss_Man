// BOS-1648 (R26 of BOS-1457): the one answer to "is a runner update needed?". The runners only need rebuilding when
// a merge between the commit their image was built from and the commit the server runs changed something the
// runner images are built from (touchesRunner, stored at merge from RUNNER_CODE_PATHS, which is read from the
// Dockerfiles). Settings' line, the Build and update runners button's card and the automatic runner card all read
// this, and its words are the words they show, so they can't disagree.
//
// It answers needed or not needed. When it truly can't work it out (a commit it can't place, an image that never said
// what it was built from, a merge whose changed files weren't recorded) it says "can't tell", why, and what fixes
// it: never "not needed" by default, and never "may be". That is a fault: the CEO is woken once per cause.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, runners, settings, tickets } from "../db/schema.js";
import { liveServerCommit } from "./go-live-wait.js";
import { runnerImageCommit } from "./runner-image.js";
import { companyMerges } from "./ticket-merges.js";

export type RunnerNeed =
  | { state: "needed"; image: string; live: string; tickets: string[]; words: string }
  | { state: "not_needed"; image: string; live: string; tickets: string[]; words: string }
  | { state: "unknown"; image: string | null; live: string | null; reason: string; fix: string; key: string; words: string };

const isSha = (sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha);
const short = (sha: string) => sha.slice(0, 8);
const MAX_NAMED = 10;
const list = (refs: string[]) => (refs.length > MAX_NAMED ? `${refs.slice(0, MAX_NAMED).join(", ")} and ${refs.length - MAX_NAMED} more` : refs.join(", "));

function unknown(image: string | null, live: string | null, key: string, reason: string, fix: string): RunnerNeed {
  return { state: "unknown", image, live, key, reason, fix, words: `Boss Man can't tell whether a runner update is needed, because ${reason}. ${fix}` };
}

/**
 * Whether this company's runners need rebuilding for the version its server runs; null when it has no runner (nothing
 * to update). The live commit is the one release-log recorded; `liveFallback` (the host's deployed commit) is used only
 * when none is recorded yet.
 */
export async function runnerUpdateNeed(db: Db, companyId: string, opts: { liveFallback?: string | null } = {}): Promise<RunnerNeed | null> {
  const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
  if (!runner) return null;
  const image = await runnerImageCommit(db, companyId);
  const fallback = isSha(opts.liveFallback) ? opts.liveFallback.toLowerCase() : null;
  const live = (await liveServerCommit(db, companyId)) ?? fallback;
  if (!image) {
    return unknown(null, live, "image-unrecorded", "the runners haven't said which version their image was built from", "Press Build and update runners once: a rebuilt image reports its version, and this line then answers by itself.");
  }
  if (!live) {
    return unknown(image, null, "live-unrecorded", "Boss Man hasn't recorded which version the server runs yet", "It records it within a few minutes of the server starting; if this stays, the host deployer isn't reporting (Settings → Server and runner → This server).");
  }
  if (image === live) {
    return { state: "not_needed", image, live, tickets: [], words: `Runners are up to date: they were built from the version the server runs (${short(live)}).` };
  }
  const merges = await companyMerges(db, companyId);
  const order = [...new Set(merges.map((m) => m.commit))];
  const at = order.indexOf(live);
  const built = order.indexOf(image);
  if (at < 0) {
    return unknown(image, live, `live-unplaced:${live}`, `the server runs ${short(live)}, which isn't a merge Boss Man recorded, so it can't list the changes since the runners were built from ${short(image)}`, "The CEO has been asked to record that merge; once it is recorded this line answers by itself.");
  }
  if (built < 0) {
    return unknown(image, live, `image-unplaced:${image}`, `the runners were built from ${short(image)}, which isn't a merge Boss Man recorded`, "Pressing Build and update runners rebuilds them from the version the server runs, which clears this.");
  }
  // Built from the live merge or a later one: the image has everything the server runs.
  if (built >= at) {
    return { state: "not_needed", image, live, tickets: [], words: `Runners are up to date: they were built from ${short(image)}, which has everything the server runs (${short(live)}).` };
  }
  const since = new Set(order.slice(built + 1, at + 1));
  // Every merge in the range, a ticket's earlier merges too (BOS-2653): a runner change in a ticket's first merge counts
  // even after the ticket merged again. A ticket is named once, as touching if any of its merges in the range did.
  const inRange = merges.filter((m) => since.has(m.commit));
  const ids = [...new Set(inRange.map((m) => m.ticketId))];
  const rows = ids.length
    ? await db
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, prefix: companies.ticketPrefix })
        .from(tickets)
        .innerJoin(companies, eq(companies.id, tickets.companyId))
        .where(and(eq(tickets.companyId, companyId), inArray(tickets.id, ids)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const merged = ids.flatMap((id) => {
    const t = byId.get(id);
    if (!t) return [];
    const mine = inRange.filter((m) => m.ticketId === id);
    const touchesRunner = mine.some((m) => m.touchesRunner === true) ? true : mine.some((m) => m.touchesRunner === null) ? null : false;
    return [{ ...t, touchesRunner }];
  });
  const name = (r: (typeof merged)[number]) => ticketRef(r.prefix, r.number) ?? `"${r.title.slice(0, 60)}"`;
  const touching = merged.filter((r) => r.touchesRunner === true).map(name);
  if (touching.length) {
    return { state: "needed", image, live, tickets: touching, words: `Runner update needed: ${list(touching)} ${touching.length === 1 ? "changes" : "change"} what the runners are built from (they were built from ${short(image)}; the server runs ${short(live)}).` };
  }
  // touchesRunner is null only for a merge from before it was recorded: its files are unknown, so it can't count as server-only.
  const unrecorded = merged.filter((r) => r.touchesRunner !== false).map(name);
  if (unrecorded.length) {
    return unknown(image, live, `files-unrecorded:${image}:${live}`, `Boss Man didn't record which files ${list(unrecorded)} changed`, "Press Build and update runners to be sure; afterwards the runners are on the version the server runs and this clears.");
  }
  const refs = merged.map(name);
  return { state: "not_needed", image, live, tickets: refs, words: `Runners are up to date: the changes since they were built (${list(refs)}) are server-only.` };
}

export type CeoWake = (agentId: string, input: { reason: string; note: string }) => Promise<unknown>;
const UNKNOWN_KEY = (companyId: string) => `runner_need_unknown:${companyId}`;
export const RUNNER_NEED_UNKNOWN_REASON = "runner update: can't tell";

/**
 * A "can't tell" is a fault, not a normal answer: wake the company's CEO once per cause (a new cause wakes again), and
 * forget the cause once the answer is known again. A wake that was dropped is not remembered, so the next pass retries.
 * Returns true when the CEO was woken.
 */
export async function wakeCeoIfRunnerNeedUnknown(db: Db, companyId: string, need: RunnerNeed | null, wake: CeoWake | null | undefined): Promise<boolean> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, UNKNOWN_KEY(companyId)));
  const seen = (row?.value as { key?: string } | undefined)?.key ?? null;
  if (need?.state !== "unknown") {
    if (row) await db.delete(settings).where(eq(settings.key, UNKNOWN_KEY(companyId)));
    return false;
  }
  if (!wake || seen === need.key) return false;
  const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
  if (!ceo) return false;
  const w = await wake(ceo.id, {
    reason: RUNNER_NEED_UNKNOWN_REASON,
    note: `Settings → Server and runner → Updates can't say whether the runners need an update. ${need.words}\nFind and fix the cause (for an unrecorded live merge: which ticket it belongs to, and why its merge wasn't recorded); log it in the cock-ups log if it is a new kind. Boss Man wakes you once per cause.`,
  });
  if (w && typeof w === "object" && (w as { status?: string }).status === "dropped") return false;
  const value = { key: need.key, at: new Date().toISOString() };
  await db.insert(settings).values({ key: UNKNOWN_KEY(companyId), value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return true;
}
