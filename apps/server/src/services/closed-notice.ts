// BOS-739: an owner card Boss Man closes by itself leaves a "closed because" notice in its place.
// On 8 Nov the owner was part-way through a hand-apply card's steps (they had run the database backup)
// when the server went live on that commit by itself and the card vanished from Decisions with no word
// of why. The notice is kept on the closed card's own context, so the steps it showed stay readable
// with it, and Decisions shows it for NOTICE_MS. An owner who was acting on the card in the last
// ENGAGED_MS also gets a feed note, since they may not be looking at Decisions.
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";
import type { NotifyInput } from "./notifications.js";

/** How long Decisions shows the notice: the ticket asks for at least an hour. */
export const NOTICE_MS = 2 * 3_600_000;
/** The owner opened the card's steps, approved it or reported a failed step this recently: they may be mid-way, so the feed is told too. */
export const ENGAGED_MS = 30 * 60_000;

export type ClosedNotice = {
  /** Why Boss Man closed it: the update is live already, a newer card covers it, it was switched back, or a server update started (BOS-1010). */
  why: "live" | "newer" | "switched-back" | "replaced";
  /** The owner's words, shown on the card and in the feed note. */
  text: string;
  at: string;
  /** Decisions shows it until then. */
  until: string;
  /** The commit that is live (why "live"). */
  commit?: string;
  /** The card to follow instead (why "newer"). */
  newer?: { decisionId: string; label: string };
};

/** The backup file a hand-apply card's database step writes (self-deploy.ts), with the folder the host reported. */
const BACKUP_FILE = /"([^"\s]*\/db-backup-before-restart\.sql\.gz)"/;

/** What a step the owner may already have run left behind, in plain words. Read from the card's own steps, so the path is the host's own. */
export function leftBehind(steps: string[] | undefined) {
  const file = (steps ?? []).map((s) => BACKUP_FILE.exec(s)?.[1]).find(Boolean);
  return file
    ? `If you ran the database backup step, it left a backup file at ${file}. It doesn't need undoing: keep it or delete it, either is fine.`
    : "Nothing you ran needs undoing.";
}

const short = (sha: string) => sha.slice(0, 8);
/** A time the owner reads, the same wherever the server runs: "8 Nov, 13:47 UTC". */
export function atWords(at: Date) {
  const month = at.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${at.getUTCDate()} ${month}, ${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
}

const READ_ONLY = "Its steps are kept below to read; there is nothing left to press.";

/** The notice for a card whose update went live by itself. */
export function liveNotice(a: { commit: string; liveAt: Date; steps?: string[]; now: Date }): ClosedNotice {
  return {
    why: "live",
    commit: a.commit,
    text: `This update is already live (commit ${short(a.commit)}, at ${atWords(a.liveAt)}). You don't need to finish these steps. Anything you already ran is safe. ${leftBehind(a.steps)} ${READ_ONLY}`,
    at: a.now.toISOString(),
    until: new Date(a.now.getTime() + NOTICE_MS).toISOString(),
  };
}

/** The notice for a card a newer one covers. */
export function newerNotice(a: { newerId: string; label: string; steps?: string[]; now: Date }): ClosedNotice {
  return {
    why: "newer",
    newer: { decisionId: a.newerId, label: a.label },
    text: `A newer update card covers this one: "${a.label}". It brings in everything this one did, so follow that card instead. You don't need to finish these steps. Anything you already ran is safe. ${leftBehind(a.steps)} ${READ_ONLY}`,
    at: a.now.toISOString(),
    until: new Date(a.now.getTime() + NOTICE_MS).toISOString(),
  };
}

/** The notice for a runner-update card a newer one replaced (BOS-1010, the owner's rule of 9 Nov). */
export function replacedNotice(a: { commit: string; text: string; now: Date }): ClosedNotice {
  return { why: "replaced", commit: a.commit, text: a.text, at: a.now.toISOString(), until: new Date(a.now.getTime() + NOTICE_MS).toISOString() };
}

/** The notice for a card whose change was switched back off (BOS-740): its setup steps no longer apply. */
export function switchedBackNotice(a: { steps?: string[]; now: Date }): ClosedNotice {
  return {
    why: "switched-back",
    text: `Boss Man switched back to an older version, so this change isn't running any more and its setup steps no longer apply. You can stop: there is nothing to finish. ${leftBehind(a.steps)} ${READ_ONLY}`,
    at: a.now.toISOString(),
    until: new Date(a.now.getTime() + NOTICE_MS).toISOString(),
  };
}

type Engagement = { ownerOpenedAt?: string; lastFailure?: { at: string }; type?: string };
const within = (iso: string | undefined, now: Date) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && now.getTime() - t <= ENGAGED_MS;
};

/**
 * Whether the owner was acting on the card in the last 30 minutes: they opened its steps (`ownerOpenedAt`),
 * reported a failed step, or (for a hand-apply to-do, which pressing Approve creates) approved it.
 */
export function engagedRecently(row: { createdAt: Date; context: unknown }, now: Date) {
  const c = row.context as Engagement;
  return within(c.ownerOpenedAt, now) || within(c.lastFailure?.at, now) || (c.type === "owner_todo" && now.getTime() - row.createdAt.getTime() <= ENGAGED_MS);
}

/**
 * Leaves the notice on a card Boss Man has just closed, and tells the feed when the owner was acting on it.
 * Only a closed owner card is touched, so a card answered by the owner in between keeps its own outcome.
 * Returns whether the feed was told.
 */
export async function leaveClosedNotice(db: Db, id: string, notice: ClosedNotice, deps: { notify: (n: NotifyInput) => Promise<unknown>; now?: () => Date }) {
  const now = deps.now?.() ?? new Date();
  const [row] = await db.select({ companyId: decisions.companyId, createdAt: decisions.createdAt, context: decisions.context, status: decisions.status, tier: decisions.tier }).from(decisions).where(eq(decisions.id, id));
  if (!row || row.status === "open" || row.tier !== "owner") return false;
  // One key merged in place, so nothing else written to the context meanwhile is lost.
  await db.update(decisions).set({ context: sql`${decisions.context} || jsonb_build_object('closedNotice', ${JSON.stringify(notice)}::jsonb)` }).where(eq(decisions.id, id));
  if (!engagedRecently(row, now)) return false;
  await deps.notify({ companyId: row.companyId, level: "flag", title: notice.why === "live" ? "You can stop: that update is already live" : notice.why === "switched-back" ? "You can stop: that change was switched back off" : notice.why === "replaced" ? "You can stop: that update was replaced by a newer one" : "You can stop: a newer update card covers that one", body: notice.text, link: "#/decisions" });
  return true;
}

/**
 * The owner cards Boss Man closed whose notice is still showing, newest first: what Decisions puts where the
 * card was. The whole context goes back, so the steps the card showed stay readable (and nothing to press).
 */
export async function recentClosedNotices(db: Db, now = new Date()) {
  const rows = await db
    .select({ id: decisions.id, companyId: decisions.companyId, question: decisions.question, context: decisions.context, answeredAt: decisions.answeredAt })
    .from(decisions)
    .where(and(ne(decisions.status, "open"), eq(decisions.tier, "owner"), sql`(${decisions.context}->'closedNotice'->>'until')::timestamptz > ${now.toISOString()}::timestamptz`))
    .limit(20);
  return rows
    .map((r) => ({ ...r, notice: (r.context as { closedNotice: ClosedNotice }).closedNotice }))
    .sort((x, y) => y.notice.at.localeCompare(x.notice.at));
}

/** Records that the owner opened an open card's steps (BOS-739), so a later system close knows they may be mid-way. */
export async function markOwnerOpened(db: Db, id: string, now = new Date()) {
  const rows = await db
    .update(decisions)
    .set({ context: sql`${decisions.context} || jsonb_build_object('ownerOpenedAt', ${now.toISOString()}::text)` })
    .where(and(eq(decisions.id, id), eq(decisions.status, "open"), eq(decisions.tier, "owner")))
    .returning({ id: decisions.id });
  return rows.length > 0;
}
