// R19b: which outside sites' docs have misled this company's owner lately. Derived from the cards themselves, so there
// is nothing extra to store and the record lapses by itself: a card with outside-site steps that the owner answered
// "My screen looks different", that was withdrawn citing a mismatch, or that was replaced by a card citing one.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";
import { outsideSiteKeys, SEEN_MAX_DAYS } from "./steps.js";

const SCREEN_DIFFERENT = /\bmy screen looks different\b/i;
/** Words a withdrawal note or a replacing card uses when the owner's screen did not match the steps. */
const MISMATCH_WORDS = /\b(?:mis-?match(?:es|ed)?|(?:does|do|did)(?:n'?t| not) match|screen (?:looks|looked) different|looks? different|(?:docs?|documentation|instructions|steps|click path|menu)\b[^.\n]{0,40}\b(?:wrong|out of date|outdated|moved|changed))\b/i;
const SUPERSEDED = /^superseded by ([0-9a-f-]{36})/i;

type Row = { id: string; answer: string | null; status: string; answeredAt: Date | string | null; createdAt: Date | string; context: unknown };
const asDate = (d: Date | string | null): Date | null => (d === null ? null : new Date(d));
const stepsOf = (ctx: unknown): string[] => {
  const s = (ctx as { steps?: unknown } | null)?.steps;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : [];
};

/**
 * Site key → ISO date of the newest mismatch in the last SEEN_MAX_DAYS days, for the sites the given steps send the
 * owner to. Undefined when the steps name no outside site (so a card without one costs no query).
 */
export async function screenMismatchSites(db: Db, companyId: string, steps: readonly string[] | undefined, serverHost: string | null | undefined, now: Date = new Date()): Promise<Record<string, string> | undefined> {
  const wanted = new Set((steps ?? []).flatMap((s) => outsideSiteKeys(s, serverHost)));
  if (!wanted.size) return undefined;
  const since = new Date(now.getTime() - SEEN_MAX_DAYS * 86_400_000);
  const rows = (await db
    .select({ id: decisions.id, answer: decisions.answer, status: decisions.status, answeredAt: decisions.answeredAt, createdAt: decisions.createdAt, context: decisions.context })
    .from(decisions)
    .where(and(eq(decisions.companyId, companyId), inArray(decisions.status, ["answered", "withdrawn"]), gte(decisions.answeredAt, since), sql`${decisions.context}->'steps' is not null`))) as Row[];
  const found: Record<string, string> = {};
  const note = (site: string, at: Date | null) => {
    if (!at || !wanted.has(site)) return;
    const iso = at.toISOString();
    if (!found[site] || found[site]! < iso) found[site] = iso;
  };
  for (const r of rows) {
    const keys = stepsOf(r.context).flatMap((s) => outsideSiteKeys(s, serverHost));
    if (!keys.length) continue;
    const at = asDate(r.answeredAt);
    let mismatch = false;
    if (r.status === "answered") mismatch = SCREEN_DIFFERENT.test(r.answer ?? "");
    else {
      const withdrawn = (r.context as { withdrawn?: { note?: string } } | null)?.withdrawn?.note ?? "";
      if (MISMATCH_WORDS.test(withdrawn)) mismatch = true;
      const next = SUPERSEDED.exec(withdrawn)?.[1];
      if (next) {
        // A replaced card counts when the card that replaced it says why: its tried-first line or its question.
        const [n] = await db.select({ question: decisions.question, context: decisions.context }).from(decisions).where(and(eq(decisions.id, next), eq(decisions.companyId, companyId)));
        const said = `${(n?.context as { triedFirst?: string } | null)?.triedFirst ?? ""}\n${n?.question ?? ""}`;
        if (MISMATCH_WORDS.test(said)) mismatch = true;
      }
    }
    if (mismatch) for (const k of new Set(keys)) note(k, at);
  }
  return Object.keys(found).length ? found : undefined;
}
