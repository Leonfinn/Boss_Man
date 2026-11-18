// After-merge checks wait for go-live (BOS-1021). A merged ticket's live check can't pass before the merge is
// running: not before the server runs a commit that contains it, and, for runner code, not before the runners are
// on an image built from it. The server has no git, so "contains" is read from merge order, as in
// runner-image.ts; a merge Boss Man can't place is never assumed to be live.
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { GoLiveWait } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, settings, tickets } from "../db/schema.js";
import { imageContains, runnerImageCommit } from "./runner-image.js";

const SEEN_PREFIX = "live_release:";
const isSha = (sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha);

/**
 * The commit this company's server runs, as release-log recorded it (null before the first observation), and the
 * earlier live commits it is known to contain (BOS-1640): the host deployer only deploys a fast-forward of what runs,
 * so a deploy's from_commit is inside its to_commit. Those place a live commit that is no ticket's recorded merge.
 */
export async function liveServerRecord(db: Db, companyId: string): Promise<{ live: string | null; contains: string[] }> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, `${SEEN_PREFIX}${companyId}`));
  const seen = (row?.value as { new?: string; contains?: unknown } | undefined) ?? {};
  const contains = Array.isArray(seen.contains) ? seen.contains.filter(isSha).map((c) => c.toLowerCase()) : [];
  return { live: isSha(seen.new) ? seen.new.toLowerCase() : null, contains };
}

/** The commit this company's server runs, as release-log recorded it; null before the first observation. */
export async function liveServerCommit(db: Db, companyId: string): Promise<string | null> {
  return (await liveServerRecord(db, companyId)).live;
}

/**
 * Every merge commit of the company, oldest merge first, whatever the ticket's state: a ticket waiting for
 * go-live is still open, so the done-only order in runner-image.ts can't place it. mergedAt is the merge time;
 * tickets merged before it existed fall back to when they were closed.
 */
export async function allMergeOrder(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ mergeCommit: tickets.mergeCommit })
    .from(tickets)
    .where(and(eq(tickets.companyId, companyId), isNotNull(tickets.mergeCommit)))
    .orderBy(asc(sql`coalesce(${tickets.mergedAt}, ${tickets.stateChangedAt})`));
  return [...new Set(rows.map((r) => r.mergeCommit!.toLowerCase()))];
}

/**
 * Where a running commit sits in merge order: its own place, or else the newest place of a commit it is known to
 * contain (BOS-1640: a merge that landed on main without the gate recording it, e.g. a reply lost to a runner
 * restart, is no ticket's mergeCommit). -1 when neither can be placed: never assumed live.
 */
export function placeInOrder(commit: string, order: string[], contains: readonly string[] = []): number {
  const own = order.indexOf(commit);
  if (own >= 0) return own;
  return contains.reduce((best, c) => Math.max(best, order.indexOf(c.toLowerCase())), -1);
}

/** True when the commit the server runs is `merge`, a merge that came after it, or contains such a commit (`contains`). */
export function serverContains(live: string | null, merge: string, order: string[], contains: readonly string[] = []): boolean {
  if (!live) return false;
  const want = merge.toLowerCase();
  if (live === want || contains.some((c) => c.toLowerCase() === want)) return true;
  const at = order.indexOf(want);
  const run = placeInOrder(live, order, contains);
  return at >= 0 && run >= 0 && at <= run;
}

/** BOS-1644: the three answers to "does what the server runs include this merge?". "unknown" always carries why. */
export type LiveAnswer = { state: "yes" } | { state: "no" } | { state: "unknown"; reason: string };

/**
 * The same question as serverContains, but "can't tell" is its own answer instead of a "no" (R26). "no" only when
 * both commits are placed in merge order and the merge is the later one. Nothing recorded, a merge or a running
 * commit Boss Man can't place: "unknown", with the reason. serverContains is this answer being "yes".
 */
export function serverHas(live: string | null, merge: string, order: string[], contains: readonly string[] = []): LiveAnswer {
  if (!live) return { state: "unknown", reason: "nothing is recorded yet about which version the server runs" };
  const want = merge.toLowerCase();
  if (live === want || contains.some((c) => c.toLowerCase() === want)) return { state: "yes" };
  const at = order.indexOf(want);
  if (at < 0) return { state: "unknown", reason: "Boss Man can't place this merge among the recorded merges" };
  const run = placeInOrder(live, order, contains);
  if (run < 0) return { state: "unknown", reason: `Boss Man can't place the running version (${live.slice(0, 8)}) among the recorded merges` };
  return at <= run ? { state: "yes" } : { state: "no" };
}

/** What the runner image contains beyond its own place: the server's known contents when it was built from the live commit. */
const imageKnown = (image: string | null, rec: { live: string | null; contains: string[] }) => (image && image === rec.live ? rec.contains : []);

/**
 * DR-061 Q5: the one answer to "is this merge commit running?", over the one merge order (allMergeOrder).
 * "server": the commit release-log recorded as live contains it. "runner": the runners' image was built from it
 * or a later merge. False when nothing is recorded or either commit can't be placed: never assumed live.
 * `serverFallback` is only used when the server has no recorded live commit yet (a fresh install): the commit
 * this process was built from.
 */
export async function commitIsLive(
  db: Db,
  companyId: string,
  commit: string | null | undefined,
  side: "server" | "runner",
  opts: { serverFallback?: string | null } = {},
): Promise<boolean> {
  if (!commit) return false;
  const order = await allMergeOrder(db, companyId);
  const rec = await liveServerRecord(db, companyId);
  if (side === "runner") {
    const image = await runnerImageCommit(db, companyId);
    return imageContains(image, commit, order, imageKnown(image, rec));
  }
  const fallback = opts.serverFallback?.toLowerCase();
  return serverContains(rec.live ?? (fallback && isSha(fallback) ? fallback : null), commit, order, rec.contains);
}

/** The go-live facts of a merged ticket that every reader needs (liveMarkedAt is required so no caller can forget it). */
export type GoLiveTicket = { companyId: string; mergeCommit: string | null; touchesRunner: boolean | null; liveMarkedAt: Date | null; liveEvidence?: string | null; deploysNothing?: boolean | null };

/**
 * BOS-1345: whether Boss Man's own server (its deploy and its runner image) is how this company's merges go live.
 * Only for the home company: Boss Man belongs to no company and its own work is filed under the oldest one
 * (self-deploy.ts homeCompany). Not a deploy_targets row: the home company has none, its target is the
 * self-deploy. Every other company works in its own repository and puts its work live itself, so our server's
 * commit (which self-deploy records for every company) says nothing about its merges.
 */
export async function serverIsGoLive(db: Db, companyId: string): Promise<boolean> {
  const [home] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
  return home?.id === companyId;
}

/**
 * What a merged ticket's after-merge checks still wait for, or null when the change is live. A merge with no
 * commit (nothing in the repository) has nothing to deploy. Runner code is only waited for when the merge is
 * known to have touched it (touchesRunner true). At merge an unknown file list is stored as true (wait for both);
 * a null is only a ticket merged before this wait existed, which waits for the server alone. A company that puts
 * its own work live waits for its CEO to mark the ticket live ("own"), never for our server (BOS-1345).
 */
export async function goLiveWaitOf(db: Db, t: GoLiveTicket): Promise<GoLiveWait | null> {
  if (!t.mergeCommit) return null;
  // BOS-1711: a merge that changed only tests, docs or CI (deploysNothing, the fixesMergeCheck rule) has nothing to
  // deploy: it is live once merged. An unknown file list (null) still waits.
  if (t.deploysNothing === true) return null;
  const merge = t.mergeCommit.toLowerCase();
  const [rec, order] = [await liveServerRecord(db, t.companyId), await allMergeOrder(db, t.companyId)];
  const live = rec.live;
  // Nothing recorded about what runs (a fresh install, a runner that never said its image commit) means there
  // is nothing to wait for: that is the behaviour from before this wait existed, and it can't hang forever.
  // The same holds for a company that puts its own work live: no record means Boss Man keeps no go-live facts here.
  if (!(await serverIsGoLive(db, t.companyId))) return live === null || t.liveMarkedAt ? null : "own";
  const server = live !== null && !serverContains(live, merge, order, rec.contains);
  const image = await runnerImageCommit(db, t.companyId);
  const runner = t.touchesRunner === true && image !== null && !imageContains(image, merge, order, imageKnown(image, rec));
  return server && runner ? "both" : server ? "server" : runner ? "runner" : null;
}

/** The two go-live facts of a merged ticket: undefined where nothing is recorded or needed (no runner code, no report yet). */
export async function goLiveFacts(
  db: Db,
  t: { companyId: string; mergeCommit: string | null; touchesRunner: boolean | null },
): Promise<{ live: string | null; server: boolean | undefined; serverUnknownReason?: string; runners: boolean | undefined } | null> {
  if (!t.mergeCommit) return null;
  const merge = t.mergeCommit.toLowerCase();
  const rec = await liveServerRecord(db, t.companyId);
  const live = rec.live;
  const order = await allMergeOrder(db, t.companyId);
  const image = await runnerImageCommit(db, t.companyId);
  const has = live === null ? null : serverHas(live, merge, order, rec.contains);
  return {
    live,
    // undefined = nothing reported or can't tell (serverUnknownReason says why); never a false "no" (BOS-1644).
    server: has === null || has.state === "unknown" ? undefined : has.state === "yes",
    serverUnknownReason: has?.state === "unknown" ? has.reason : undefined,
    runners: t.touchesRunner === true && image !== null ? imageContains(image, merge, order, imageKnown(image, rec)) : undefined,
  };
}

const yesNo = (b: boolean | undefined): string => (b === undefined ? "unknown (nothing reported yet)" : b ? "yes" : "no");

/** One line for `tickets read` on a merged ticket (BOS-1024); null for a ticket with no merge commit. */
export async function goLiveLine(db: Db, t: GoLiveTicket): Promise<string | null> {
  if (t.mergeCommit && !(await serverIsGoLive(db, t.companyId)) && (t.liveMarkedAt || (await liveServerCommit(db, t.companyId)) !== null)) {
    return t.liveMarkedAt
      ? `Go-live: this company puts its own work live; the CEO marked this merge live at ${t.liveMarkedAt.toISOString().slice(0, 16).replace("T", " ")} UTC (evidence: ${t.liveEvidence ?? "none recorded"}).`
      : `Go-live: this company puts its own work live; not marked live yet. Once it is live, the CEO marks it with update_ticket markLive (a commit sha or a short note). Say "is live" or "is deployed" only after that.`;
  }
  const f = await goLiveFacts(db, t);
  if (!f) return null;
  const server = `live on the server: ${f.serverUnknownReason ? `can't tell (${f.serverUnknownReason})` : yesNo(f.server)}${f.live ? ` (the server runs commit ${f.live.slice(0, 8)})` : ""}`;
  return `Go-live: ${server}${t.touchesRunner === true ? `; runners rebuilt: ${yesNo(f.runners)}` : ""}. Say "is live" or "is deployed" only when this says yes.`;
}

const LIVE_CLAIM = /\b(is|are|now|been|went|gone)\s+(live|deployed|released|rolled out)\b|\b(it|this|that|change|fix)'s\s+(live|deployed)\b|\bgone live\b|\bhas shipped\b/i;

/** A note for the agent when a reply says the work is live but the merge isn't (BOS-1024); the reply still posts. */
export async function liveClaimWarning(db: Db, t: GoLiveTicket, body: string): Promise<string | null> {
  if (!LIVE_CLAIM.test(body)) return null;
  const wait = await goLiveWaitOf(db, t);
  if (!wait) return null;
  const awaited = wait === "own" ? "the CEO to mark it live" : wait === "both" ? "the server update and the runner rebuild" : wait === "runner" ? "the runner rebuild" : "the server update";
  return `Heads up (BOS-1024): your reply says the work is live, but this ticket's merge is not live yet: still waiting for ${awaited}. The reply was posted. Check "tickets read" (Go-live line), then correct yourself on the ticket.`;
}
