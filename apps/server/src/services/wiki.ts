// The company wiki and what tickets produce (R69). Pages are Markdown, written by the owner
// or by agents through the wiki tool, and every save keeps a revision. A page written for a
// ticket shows on that ticket as something it produced, next to repo files and links an
// agent attaches, so "see the evidence" opens the work itself.
import { and, asc, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, ticketArtifacts, tickets, wikiPages, wikiRevisions } from "../db/schema.js";
import { record } from "./activity.js";
import { reviewTicketWriteRefusal } from "./skill-proposals.js";
import type { WikiSemantic } from "./wiki-semantic.js";

export const MAX_BODY = 200_000;
/** One appended entry: a log line, not a page. Keeps a single append cheap (BOS-430). */
export const MAX_ENTRY = 20_000;

// BOS-496: the history the owner's screen shows holds this many of the newest versions per
// request, and the rest are one page back (never dropped). Every save is kept; these only bound
// how much one response or one tool reply carries.
export const HISTORY_PAGE = 100;
export const HISTORY_PAGE_MAX = 500;

// BOS-496: a page change and its saved version must go together. The ways a page changes write
// the row with a plain UPDATE and then insert the version, which isn't atomic, so two overlapping
// writers (two agents saving at once, or an older server build beside this one) can leave a change
// with no version of the text before it — the 4 Nov release-log state, where the wipe was not
// undoable. Every write in this process queues here, so one save's read, version and page change
// finish before the next starts. Module-level: a process-wide lock, not per-call state.
// shortcut: a lock in this process only, lost on restart harmlessly: a restart has no write in flight, and the DB write + version insert are ordered per save; it does not span two servers (an older build beside this one can still interleave, hence BOS-496's DB-side fix).
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` once every write queued before it has finished (BOS-496). Use it around any change to
 * a page body that also saves a version, so the saved versions always match what the page held.
 */
export function serialiseWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export class WikiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * "2026 agent landscape!" → "2026-agent-landscape". The ends are trimmed after the cut to 80, so a
 * long title cut just after a word never leaves a slug ending in "-" (BOS-1324: DR-058 got two pages).
 */
export function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "") || "page"
  );
}

/** A given address in its stored form: each part through slugify (" Research/Agent-landscape- " → "research/agent-landscape"). */
export const normalSlug = (slug: string) => slug.trim().split("/").map(slugify).join("/");

/** " research / Competitors/ " → "Research/Competitors" style: trimmed, no empty folders, at most 6 deep. */
export function cleanFolder(folder: string) {
  const parts = folder
    .split("/")
    .map((p) => p.trim().replace(/\s+/g, " ").slice(0, 60))
    .filter(Boolean);
  if (parts.length > 6) throw new WikiError(400, "Folders can be at most 6 deep.");
  return parts.join("/");
}

/** A page's address from its folder and name: "Research/Competitors" + "Paperclip" → "research/competitors/paperclip". */
export function pageSlug(folder: string, name: string) {
  return [...(folder ? folder.split("/") : []), name].map(slugify).join("/");
}

/** The folder a bare address implies, for agents that pass only a slug: "research/agent-landscape" → "research". */
const folderOf = (slug: string) => slug.split("/").slice(0, -1).join("/");

/**
 * The page a given slug names: the page at exactly that address if there is one (a page saved before
 * slugs lost a trailing "-"), else the page at the slug's stored form (normalSlug). Read, write, append,
 * history, restore and delete all find their page here, so they can't disagree about which page "x-"
 * is: before BOS-1324 a write to "x-" tidied it to "x" and overwrote that page while a read of "x-"
 * showed another one. `lock` takes the row FOR UPDATE (append).
 */
async function findPage(conn: Db, companyId: string, slug: string, lock = false) {
  const at = async (s: string) => {
    const q = conn.select().from(wikiPages).where(and(eq(wikiPages.companyId, companyId), eq(wikiPages.slug, s)));
    return (await (lock ? q.for("update") : q))[0];
  };
  const given = slug.trim();
  const norm = normalSlug(given);
  return (await at(given)) ?? (norm !== given ? await at(norm) : undefined);
}

/** A heading's span in a page body. start..end is the section with its subsections; start..ownEnd is its own text. */
export type Section = { path: string; heading: string; level: number; start: number; ownEnd: number; end: number };

/**
 * The ``` or ~~~ fence a line opens or closes, or null for any other line: the fence's marker character
 * and how many of it. A fence opens with at least three of ``` or ~~~ and closes only with the same
 * character, in a run at least as long as the opener (adversarial round 7: a ```-opened block "closed"
 * with ~~~ stays open). Fences are tracked by this one function wherever page structure is read, so an
 * append's entry and `splitSections` can't disagree about whether a block is closed.
 */
export function fenceLine(line: string): { char: string; len: number } | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return m ? { char: m[1]![0]!, len: m[1]!.length } : null;
}

/** Whether `lines` end with a fence still open, by the same open/close rule `splitSections` uses. */
export function endsInOpenFence(lines: string[]): boolean {
  let open: { char: string; len: number } | null = null;
  for (const line of lines) {
    const f = fenceLine(line);
    if (!f) continue;
    if (!open) open = f;
    else if (f.char === open.char && f.len >= open.len) open = null;
  }
  return open !== null;
}

/** Markdown ATX headings, ignoring # lines inside ``` or ~~~ fences. Text before the first heading is "intro" (level 0). */
export function splitSections(body: string): Section[] {
  const out: Section[] = [];
  const stack: Section[] = [];
  let fence: { char: string; len: number } | null = null;
  let pos = 0;
  // A page pasted with Windows (CRLF) line endings still has headings; the trailing "\r" would stop the
  // heading regex from matching (adversarial round 6). Offsets still count in the original body.
  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const f = fenceLine(line);
    // Same rule as endsInOpenFence: close only on the opener's mark with a run at least as long (round 8).
    if (f) fence = fence === null ? f : fence.char === f.char && f.len >= fence.len ? null : fence;
    const m = fence === null && !f ? /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line) : null;
    if (m) {
      const level = m[1]!.length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      const s: Section = { heading: m[2]!, level, path: [...stack.map((x) => x.heading), m[2]!].join(" > "), start: pos, ownEnd: body.length, end: body.length };
      out.push(s);
      stack.push(s);
    }
    pos += raw.length + 1;
  }
  out.forEach((s, i) => {
    s.ownEnd = out[i + 1]?.start ?? body.length;
    s.end = out.slice(i + 1).find((x) => x.level <= s.level)?.start ?? body.length;
  });
  const first = out[0]?.start ?? body.length;
  if (body.slice(0, first).trim()) out.unshift({ heading: "intro", level: 0, path: "intro", start: 0, ownEnd: first, end: first });
  return out;
}

/** The section a reader asked for, by heading or heading path, case-insensitive; the first match wins. */
export function findSection(sections: Section[], wanted: string) {
  const w = wanted.trim().toLowerCase().replace(/\s*>\s*/g, " > ");
  return sections.find((s) => s.path.toLowerCase() === w) ?? sections.find((s) => s.path.toLowerCase().endsWith(` > ${w}`)) ?? sections.find((s) => s.heading.toLowerCase() === w);
}

/** The headings a body has, in order, ignoring "intro" (text before the first heading). */
export const headingsOf = (body: string) => splitSections(body).filter((s) => s.level > 0);

/** How much of a page a rewrite may remove before it needs `replace: true` (BOS-430). */
export const SHRINK_FRACTION = 0.25;

/**
 * The smallest cut the guard tolerates before flagging a write: a typo fix on a short page (a status
 * line, a one-row table) must still work, but a headingless page under 200 characters could otherwise
 * be emptied outright (BOS-430, adversarial round 2). The quarter rule covers anything longer.
 */
export const MIN_SHRINK = 40;

/** A page this long can only be shortened by an agent with replace: true plus confirmReplace (BOS-1280). */
export const LONG_PAGE_CHARS = 40_000;

/**
 * Why a write that replaces a page's body is refused without `replace: true` (BOS-430): it would
 * remove more than a quarter of the text, or drop a heading the page has now. Null when it's safe
 * (a grown or barely-changed page, or a brand-new one). The message says the sizes and the headings,
 * so an agent can fix the call instead of re-sending the whole page.
 *
 * The guard is measured against `largest`, the biggest the page has held since it was last deliberately
 * replaced, while `before` is what it holds now: ten writes that each cut 24% pass the per-write rule
 * but end with the page emptied, so the guard measures against what the page has held, not only what it
 * holds now (BOS-430, adversarial round 2). Callers pass `largest` only for a write that shrinks the
 * page from its current text, so a growing write is never refused and an append after a deliberate trim
 * still works (adversarial round 3).
 */
export function shrinkRefusalAgainst(before: string, largest: number, after: string): string | null {
  // Compare against whichever is bigger: a page that just grew and is now being cut back also matters.
  const baseline = Math.max(largest, before.length);
  if (after.length >= baseline) return null;
  const removed = baseline - after.length;
  const afterHeadings = new Set(headingsOf(after).map((h) => h.heading.trim().toLowerCase()));
  const gone = headingsOf(before).filter((h) => !afterHeadings.has(h.heading.trim().toLowerCase()));
  const tooSmall = removed > Math.max(MIN_SHRINK, baseline * SHRINK_FRACTION);
  if (!tooSmall && !gone.length) return null;
  const pct = baseline ? Math.round((removed / baseline) * 100) : 0;
  const parts = [
    `This write would replace a page of ${baseline.toLocaleString("en-GB")} characters with ${after.length.toLocaleString("en-GB")}`,
    tooSmall ? ` (${removed.toLocaleString("en-GB")} characters, ${pct}%, removed${baseline > before.length ? `; the page has been ${baseline.toLocaleString("en-GB")} characters before and can't be cut this far by small steps` : ""})` : "",
    gone.length ? `, and drop ${gone.length === 1 ? "the heading" : "these headings"}: ${gone.map((h) => `"${h.heading}"`).join(", ")}` : "",
    ".",
  ].join("");
  return `${parts} To add to a long page, use append. If you really mean to replace it, an agent may send the whole new body with replace: true (only the CEO or the owner may do that on a page someone else created).`;
}

/** The lines that make up an entry, trimmed: a line starting "- " or "* " is a list item, so it sits on its own. */
const entryLines = (entry: string) =>
  entry
    .trimEnd()
    .split("\n")
    .map((l) => l.trimEnd());
/** Space between an entry and the text around it: a blank line, or just the list's own break when both are list items. */
const GLUE = "\n\n";

/** Where an appended entry goes: under a named heading (newest first by default, or oldest/bottom within it), or at the top/bottom of the page. */
export type AppendPosition = "top" | "bottom" | "oldest";

/**
 * A page body with `entry` added (BOS-430), leaving every other character as it was. Under a heading,
 * the entry sits after the heading's own intro text and before its first sub-heading (newest first),
 * at the end of that heading's own text (oldest), or at the end of the whole section (bottom). A
 * section whose own text is only a list still takes a newest-first entry at the top of the list. With
 * no heading, it goes at the very top or the very bottom of the page. Throws when the heading isn't on
 * the page, so an append never silently lands somewhere unexpected.
 */
export function appendToBody(body: string, entry: string, heading: string | undefined, position: AppendPosition): string {
  // Use the page's own line ending for the entry and the glue, so a Windows (CRLF) page gains no mixed
  // endings around the entry (adversarial round 6).
  const nl = body.includes("\r\n") ? "\r\n" : "\n";
  const glue = nl + nl;
  const lines = entryLines(entry);
  const text = lines.join(nl);
  // An entry whose last code block never closes would swallow the page's later headings (adversarial
  // round 6), so refuse it rather than corrupt the page silently. The check is the same open/close rule
  // `splitSections` uses, so a ```-block "closed" with ~~~ is caught and a valid 4-tick block holding a
  // 3-tick line is not (adversarial round 7).
  if (endsInOpenFence(lines)) throw new WikiError(400, "This entry has a code fence (```) that it never closes. Close it with the same marks, so the page after the entry isn't read as code.");
  const isList = (l: string | undefined) => /^[-*] /.test(l ?? "");
  const bare = (l: string | undefined) => (l ?? "").replace(/\r$/, "");
  const lastLine = (t: string) => bare(t.split("\n").at(-1));
  const stripLead = (t: string) => t.replace(/^[ \t\r\n]+/, "");
  // A list entry that opens a list sits straight after its heading; one that joins a list needs no blank line.
  const glueAfterHeading = (firstLineAfter: string | undefined) => (isList(lines[0]) && !isList(firstLineAfter) ? nl : glue);
  if (!heading) {
    if (position === "top") {
      // Keep a page's leading "# Title" heading first: an entry never lands above it.
      const title = /^# [^\n]*\r?\n/.exec(body)?.[0];
      if (!title) return `${text}${glue}${body}`;
      const rest = stripLead(body.slice(title.length));
      const first = rest.split("\n")[0];
      if (isList(lines[0]) && !isList(bare(first))) return `${title}${text}${nl}${rest}`;
      return `${title.trimEnd()}${glue}${text}${glue}${rest}`;
    }
    // The very end of the page: after the last section's own text, so an entry never lands under another heading.
    const secs = splitSections(body);
    const last = secs.at(-1);
    const end = last && last.level > 0 ? last.ownEnd : body.length;
    const before = body.slice(0, end).trimEnd();
    const after = stripLead(body.slice(end));
    if (after) return `${before}${nl}${text}${glue}${after}`;
    const joins = isList(lines[0]) && isList(lastLine(before));
    return body ? `${before}${joins ? nl : glue}${text}${nl}` : `${text}${nl}`;
  }
  const sections = splitSections(body);
  const found = findSection(sections, heading);
  // "intro" is the text before the first heading, not a heading line: it has no heading to sit under,
  // and inserting "newest first" against it glues the entry onto the next heading (BOS-430, adversarial
  // round 6). It is never offered in the heading list; refuse it plainly, as with a missing heading.
  if (!found || found.level === 0) {
    const choices = headingsOf(body).map((h) => `"${h.path}"`);
    throw new WikiError(404, `There's no heading "${heading}" on that page. Its headings are: ${choices.length ? choices.join(", ") : "(none)"}.`);
  }
  const s = found;
  // Oldest: at the end of the section's own text, before its sub-headings, so an entry never lands inside one.
  if (position === "oldest") {
    // At the end of the section's own text (its sub-headings, if any, come after the entry), so it joins the list.
    const before = body.slice(0, s.ownEnd).trimEnd();
    const after = stripLead(body.slice(s.ownEnd));
    const joins = isList(lines[0]) && isList(lastLine(before));
    return `${before}${joins ? nl : glue}${text}${nl}${after ? `${nl}${after}` : ""}`;
  }
  // Bottom: the end of the whole section, after its sub-headings, so an entry never lands inside one.
  if (position === "bottom") {
    const before = body.slice(0, s.end).trimEnd();
    const after = stripLead(body.slice(s.end));
    const joins = isList(lines[0]) && isList(lastLine(before));
    return `${before}${joins ? nl : glue}${text}${nl}${after ? `${nl}${after}` : ""}`;
  }
  const headingLineEnd = body.indexOf("\n", s.start);
  if (headingLineEnd === -1) return `${body}${glue}${text}${nl}`;
  // The heading's own text runs from after its line to its first sub-heading (s.ownEnd). Newest first
  // keeps that intro in place: the entry goes after it and before the first sub-heading. A section whose
  // own text is only a list is the exception: its entry still goes at the top of the list (BOS-1288).
  const ownText = stripLead(body.slice(headingLineEnd + 1, s.ownEnd));
  const firstOwn = ownText.split("\n")[0];
  if (!isList(firstOwn)) {
    const before = body.slice(0, s.ownEnd).trimEnd();
    const after = stripLead(body.slice(s.ownEnd));
    const joins = isList(lines[0]) && isList(lastLine(before));
    return `${before}${joins ? nl : glue}${text}${nl}${after ? `${nl}${after}` : ""}`;
  }
  // Newest first in a list section: the entry goes first at the top of the section, keeping the heading's own blank line above it.
  const lineEnd = (s.end > s.start ? body.lastIndexOf("\n", s.end - 1) : -1) + 1 || body.length;
  // headingLine keeps the heading text only; the gap supplies the line ending, so a CRLF heading doesn't double its "\r".
  const headingLine = body.slice(s.start, headingLineEnd).replace(/\r$/, "");
  const afterHeading = stripLead(body.slice(headingLineEnd + 1, lineEnd));
  const first = afterHeading.split("\n")[0];
  const gap = glueAfterHeading(first);
  const rest = afterHeading ? `${gap}${afterHeading}` : "";
  return `${body.slice(0, s.start)}${headingLine}${gap}${text}${rest}${body.slice(lineEnd)}`;
}

/** [[slug]] and [[slug#Section heading]] in a page body: the slugs it links to. */
export const linkedSlugs = (body: string) => [...new Set([...body.matchAll(/\[\[([^\]#|]+?)(?:#[^\]]*)?\]\]/g)].map((m) => m[1]!.trim()))];

// BOS-359: a wiki link in agent-written text (a ticket reply, an owner note, a decision, a chat
// reply) is only a click away from a dead page. LinkHint caps how much text it reads and how many
// slugs it looks up, so a very long message or one with thousands of links costs little.
export const LINK_SCAN_CHARS = 40_000;
export const LINK_LOOKUPS = 20;

/**
 * The slugs a text links to with [[slug]] or [[slug#Heading]], in order and without repeats,
 * reading at most LINK_SCAN_CHARS characters of it.
 */
export function wikilinkSlugs(text: string, max = LINK_LOOKUPS): string[] {
  const seen = new Set<string>();  // not state: filled and dropped inside this call.
  const out: string[] = [];
  for (const m of text.slice(0, LINK_SCAN_CHARS).matchAll(/\[\[([^\]#|]*)(?:#[^\]]*)?\]\]/g)) {
    const slug = m[1]!.trim();
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
      if (out.length >= max) break;
    }
  }
  return out;
}

/**
 * A short note naming the wiki pages a text links to that don't exist, or null when they all do.
 * The note is advisory: a lookup that fails returns null, so a saved reply or note is never
 * turned into an error by it.
 */
export async function missingPageNote(db: Db, companyId: string, text: string): Promise<string | null> {
  const wanted = wikilinkSlugs(text);
  if (!wanted.length) return null;
  let rows: { slug: string }[];
  try {
    rows = await db.select({ slug: wikiPages.slug }).from(wikiPages).where(and(eq(wikiPages.companyId, companyId), inArray(wikiPages.slug, wanted)));
  } catch {
    return null;
  }
  const have = new Set(rows.map((r) => r.slug));
  const missing = wanted.filter((s) => !have.has(s));
  if (!missing.length) return null;
  return `Wiki link check: ${missing.length === 1 ? "this link is" : "these links are"} to no such page: ${missing.map((s) => `"${s}"`).join(", ")}. Fix the link, or create the page with wiki write. The text was saved as written.`;
}

// Lessons learned from sent-back reviews (R-review-lessons): a "Lessons" section on a project
// brief that only a lesson decision may change, so a rewrite passes over it untouched.
export const LESSONS_HEADING = "Lessons";
export const LESSONS_CAP = 20;
/** The lesson decision's answers: add it as it is, edit it (the owner's note is the new text), or drop it. */
export const LESSON_ADD = "Add";
export const LESSON_EDIT = "Edit";
export const LESSON_DROP = "Drop";
export const LESSON_DONT_ADD = "Don't add it";
export const LESSON_REPLACE_PREFIX = "Replace: ";
/** A lesson is one line the owner approves; lines are bullets in the brief's Lessons section. */
export const lessonLine = (lesson: string) => `- ${lesson}`;

export const LESSON_MAX = 240;

/** One-line, bounded text for the decision and the brief. */
export function normalizeLesson(text: string) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LESSON_MAX)
    .trim();
}

const findLessons = (body: string) => splitSections(body).find((x) => x.level === 2 && x.heading.toLowerCase() === LESSONS_HEADING.toLowerCase());

/** The Lessons section's own text of a page body, or null when it has none. */
export function lessonsSection(body: string) {
  const sec = findLessons(body);
  return sec ? body.slice(sec.start, sec.ownEnd) : null;
}

/** The approved lessons in a brief's Lessons section, in order. */
export function lessonsFrom(body: string): string[] {
  const s = lessonsSection(body);
  if (!s) return [];
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^- /.test(l))
    .map((l) => l.slice(2));
}

/** A body with the lesson appended: the Lessons section is created at the end when missing. */
export function addLesson(body: string, lesson: string): string {
  const line = lessonLine(lesson);
  const sec = findLessons(body);
  const sectionText = sec ? body.slice(sec.start, sec.ownEnd) : null;
  if (!sectionText) return `${body.trimEnd()}\n\n## ${LESSONS_HEADING}\n\n${line}\n`;
  const inner = sectionText.slice(sectionText.indexOf("\n") + 1).replace(/\n?\n*$/, "");
  return `${body.slice(0, sec!.start)}## ${LESSONS_HEADING}\n${inner}\n${line}\n${body.slice(sec!.ownEnd)}`;
}

/** A lesson's remove, when the owner swaps a full section's line for a new one: first match only. */
export function removeLessonLine(body: string, lesson: string) {
  const line = lessonLine(lesson);
  let removed = false;
  return body
    .split("\n")
    .filter((l) => {
      if (removed || l.trim() !== line) return true;
      removed = true;
      return false;
    })
    .join("\n");
}

export type SectionHit = { slug: string; title: string; path: string; snippet: string; score: number };

type Author = { agentId: string | null; runId: string | null };

/** What `write` saves. Shared by `write`, `writeWithin` and `append`, which all reach the same save (BOS-430). */
export type WriteInput = { slug?: string; folder?: string; title: string; body: string; ticketId?: string | null; replace?: boolean; confirmReplace?: string; isCeo?: boolean; fromRestore?: boolean } & Author;

export function wikiService(db: Db, semantic?: Pick<WikiSemantic, "enqueue" | "similar">) {
  async function ownTicket(conn: Db, companyId: string, ticketId: string) {
    const [t] = await conn.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId)));
    if (!t) throw new WikiError(404, "No ticket with that ID in this company.");
  }

  async function page(companyId: string, slug: string) {
    const p = await findPage(db, companyId, slug);
    if (!p) throw new WikiError(404, "There's no wiki page with that name.");
    return p;
  }

  /**
   * The biggest this page has ever been (the longest of all its version bodies, or its body now): the
   * baseline the shrink guard measures a rewrite against, so repeated small cuts can't add up to a wipe
   * (BOS-430, adversarial round 2). A length aggregate, so no old body is sent to the server.
   */
  async function largestEver(conn: Db, pageId: string, now: number): Promise<number> {
    const [row] = await conn
      .select({ longest: sql<number>`coalesce(max(length(${wikiRevisions.body})), 0)` })
      .from(wikiRevisions)
      .where(eq(wikiRevisions.pageId, pageId));
    return Math.max(now, Number(row?.longest ?? 0));
  }

  const ftsExpr = sql`to_tsvector('english', ${wikiPages.title} || ' ' || ${wikiPages.body})`;
  const ftsMatch = (q: string) => sql`${ftsExpr} @@ websearch_to_tsquery('english', ${q})`;
  /** The company's best full-text matches, best first. */
  const ftsPages = (companyId: string, q: string, limit: number) =>
    db
      .select({ id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, body: wikiPages.body })
      .from(wikiPages)
      .where(and(eq(wikiPages.companyId, companyId), ftsMatch(q)))
      .orderBy(sql`ts_rank(${ftsExpr}, websearch_to_tsquery('english', ${q})) desc`)
      .limit(limit);

  return {
    slugify,

    /**
     * Pages, most recently changed first. With q, full-text matches come first, best first, then
     * plain substring matches (so a partial word still finds its page, as it always did).
     */
    async list(companyId: string, q?: string) {
      const term = q?.trim();
      const pattern = term ? `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
      const rows = await db
        .select({ id: wikiPages.id, slug: wikiPages.slug, folder: wikiPages.folder, title: wikiPages.title, ticketId: wikiPages.ticketId, updatedAt: wikiPages.updatedAt, updatedBy: agents.name })
        .from(wikiPages)
        .leftJoin(agents, eq(agents.id, wikiPages.updatedByAgentId))
        .where(and(eq(wikiPages.companyId, companyId), pattern ? or(ilike(wikiPages.title, pattern), ilike(wikiPages.body, pattern), ftsMatch(term!)) : undefined))
        .orderBy(desc(wikiPages.updatedAt))
        .limit(2000);
      if (!term) return rows;
      const ranked = new Map((await ftsPages(companyId, term, 2000)).map((p, i) => [p.id, i]));
      return rows.sort((a, b) => (ranked.get(a.id) ?? Infinity) - (ranked.get(b.id) ?? Infinity));
    },

    /**
     * The sections that best match q, at most two per page, best first. Empty when full-text
     * search finds nothing (callers fall back to list). When semantic search is on, the 50
     * nearest sections by meaning are fused with the 50 best full-text sections (reciprocal
     * rank fusion), so a section can match without sharing a word with the query.
     */
    async search(companyId: string, q: string, pages = 10): Promise<SectionHit[]> {
      const similar = await semantic?.similar(companyId, q);
      if (!similar) return this.ftsSearch(companyId, q, pages);
      const fts = await this.ftsSearch(companyId, q, 25);
      const fused = new Map<string, SectionHit>();
      for (const [list, isFts] of [[fts, true], [similar, false]] as const)
        list.forEach((h, rank) => {
          const key = `${h.slug}\n${h.path}`;
          const add = 1 / (60 + rank + 1);
          const have = fused.get(key);
          if (have) have.score += add;
          else fused.set(key, { slug: h.slug, title: h.title, path: h.path, snippet: h.snippet, score: add });
          if (isFts) fused.get(key)!.snippet = h.snippet;
        });
      return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, pages * 2);
    },

    /** Full-text only: the sections of the best-matching pages, at most two per page. */
    async ftsSearch(companyId: string, q: string, pages = 10): Promise<SectionHit[]> {
      const top = await ftsPages(companyId, q, pages);
      if (!top.length) return [];
      const parts = top.flatMap((p, pi) =>
        splitSections(p.body).map((s) => ({ pi, path: s.path, text: p.body.slice(s.start, s.ownEnd) })),
      );
      const scored = (await db.execute(sql`
        with q as (select websearch_to_tsquery('english', ${q}) as q),
        t as (select (e.ord - 1)::int as i, e.value as s from jsonb_array_elements_text(${JSON.stringify(parts.map((x) => `${x.path}\n${x.text}`))}::jsonb) with ordinality as e(value, ord))
        select t.i, ts_rank(to_tsvector('english', t.s), q.q) as score, ts_headline('english', t.s, q.q, 'MaxWords=30, MinWords=12, MaxFragments=1, StartSel=*, StopSel=*') as snippet
        from t, q where to_tsvector('english', t.s) @@ q.q`)) as unknown as { rows: Array<{ i: number; score: number; snippet: string }> } | Array<{ i: number; score: number; snippet: string }>;
      const rows = Array.isArray(scored) ? scored : scored.rows;
      const hits: SectionHit[] = [];
      for (const [pi, p] of top.entries()) {
        rows
          .filter((r) => parts[r.i]!.pi === pi)
          .sort((a, b) => b.score - a.score)
          .slice(0, 2)
          .forEach((r) => hits.push({ slug: p.slug, title: p.title, path: parts[r.i]!.path, snippet: r.snippet.replace(/\s+/g, " ").trim(), score: Number(r.score) }));
      }
      return hits;
    },

    /**
     * Pages this text links to (that exist) and pages whose body links to slug.
     * shortcut: linked-from is a LIKE scan of this company's pages; add a wiki_links table
     * (written on save) when a company has thousands of pages or backlinks feel slow.
     */
    async links(companyId: string, slug: string, text: string) {
      const wanted = linkedSlugs(text).filter((l) => l !== slug);
      const out = wanted.length ? await db.select({ slug: wikiPages.slug }).from(wikiPages).where(and(eq(wikiPages.companyId, companyId), inArray(wikiPages.slug, wanted))) : [];
      const esc = slug.replace(/[%_\\]/g, (c) => `\\${c}`);
      const from = await db
        .select({ slug: wikiPages.slug })
        .from(wikiPages)
        .where(and(eq(wikiPages.companyId, companyId), or(like(wikiPages.body, `%[[${esc}]]%`), like(wikiPages.body, `%[[${esc}#%`))))
        .orderBy(asc(wikiPages.slug));
      return { links: wanted.filter((l) => out.some((o) => o.slug === l)), linkedFrom: from.map((r) => r.slug).filter((l) => l !== slug) };
    },

    /** One page with its history and the tickets it was produced for. */
    async get(companyId: string, slug: string) {
      const p = await page(companyId, slug);
      const [by] = p.updatedByAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, p.updatedByAgentId)) : [];
      // Every version, newest first, each with its size so a wiped page can be told from a full one (BOS-430).
      // revisionCount is the whole history, so the screen can page past `revisions` to the oldest (BOS-496).
      const revisions = await db
        .select({ id: wikiRevisions.id, title: wikiRevisions.title, createdAt: wikiRevisions.createdAt, agent: agents.name, agentId: wikiRevisions.agentId, runId: wikiRevisions.runId, size: sql<number>`length(${wikiRevisions.body})` })
        .from(wikiRevisions)
        .leftJoin(agents, eq(agents.id, wikiRevisions.agentId))
        .where(eq(wikiRevisions.pageId, p.id))
        .orderBy(desc(wikiRevisions.createdAt));
      const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(wikiRevisions).where(eq(wikiRevisions.pageId, p.id));
      const forTickets = await db
        .select({ id: tickets.id, title: tickets.title })
        .from(ticketArtifacts)
        .innerJoin(tickets, eq(tickets.id, ticketArtifacts.ticketId))
        .where(eq(ticketArtifacts.wikiPageId, p.id));
      // revisionCount is the whole history: the screen pages past `revisions` with it (BOS-496).
      return { ...p, updatedBy: by?.name ?? null, revisions, revisionCount: Number(total?.count ?? 0), tickets: forTickets };
    },

    /**
     * A page's saved versions, newest first, in pages of `limit`. The history screen and the wiki
     * tool read every version this way, so the oldest (the last good one before a wipe) is never
     * hidden behind a cap (BOS-496).
     */
    async versions(companyId: string, slug: string, opts: { offset?: number; limit?: number } = {}) {
      const p = await page(companyId, slug);
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? HISTORY_PAGE), 1), HISTORY_PAGE_MAX);
      const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
      return db
        .select({ id: wikiRevisions.id, createdAt: wikiRevisions.createdAt, agent: agents.name, runId: wikiRevisions.runId, size: sql<number>`length(${wikiRevisions.body})` })
        .from(wikiRevisions)
        .leftJoin(agents, eq(agents.id, wikiRevisions.agentId))
        .where(eq(wikiRevisions.pageId, p.id))
        .orderBy(desc(wikiRevisions.createdAt))
        .offset(offset)
        .limit(limit);
    },

    async revision(companyId: string, revisionId: string) {
      const [r] = await db
        .select({ id: wikiRevisions.id, title: wikiRevisions.title, body: wikiRevisions.body, createdAt: wikiRevisions.createdAt, agent: agents.name, slug: wikiPages.slug })
        .from(wikiRevisions)
        .innerJoin(wikiPages, eq(wikiPages.id, wikiRevisions.pageId))
        .leftJoin(agents, eq(agents.id, wikiRevisions.agentId))
        .where(and(eq(wikiRevisions.id, revisionId), eq(wikiPages.companyId, companyId)));
      if (!r) throw new WikiError(404, "No such revision.");
      return r;
    },

    /**
     * Creates or updates a page and keeps the old text as a revision. A slug that exists is
     * updated; a folder that differs from the page's moves it, which changes its address. With
     * a ticket, the page is linked to it as something the ticket produced.
     *
     * The body of this lives in `writeWithin`, which takes the database handle to use: a caller that
     * has read the page and must save it unchanged (append) passes its transaction, so the read and
     * the save can't interleave with another writer (BOS-430, adversarial round 2).
     */
    async write(companyId: string, input: WriteInput) {
      const r = await this.writeWithin(db, companyId, input);
      if (input.ticketId) await record(db, { companyId, agentId: input.agentId, ticketId: input.ticketId, kind: "artifact", summary: `Wrote wiki page "${input.title.trim()}"` });
      return r;
    },

    /** `write`, through `conn`: the transaction a caller already holds, or the database itself. */
    async writeWithin(conn: Db, companyId: string, input: WriteInput) {
      const title = input.title.trim();
      if (!title) throw new WikiError(400, "A page needs a title.");
      if (input.body.length > MAX_BODY) throw new WikiError(400, `A page can be at most ${MAX_BODY.toLocaleString("en-GB")} characters.`);
      // Writes inside a caller's transaction (append, restore) already hold the page and must not
      // queue again, or they would wait on a slot the queue can't hand them. A plain write reads the
      // page, checks the guards and saves through `serialiseWrite` and its own transaction (BOS-496).
      if (conn !== db) return writeWithinTx(conn, companyId, input, title);
      return serialiseWrite(() => db.transaction((tx) => writeWithinTx(tx, companyId, input, title)));
    },

    /**
     * Adds an entry to a page without re-sending the whole body (BOS-430). This is how a running log is
     * meant to grow: the page is read here, the entry inserted with appendToBody, and the result saved as
     * an ordinary write (so it keeps a version and the Lessons and shrink rules still apply). Throws when
     * the page or the named heading is missing, rather than creating a partial page.
     *
     * The read and the save run in one transaction with the page row locked, so two agents appending at
     * the same moment both land: without the lock the last save overwrote the other's entry, and both
     * callers were told it worked (BOS-430, adversarial round 2).
     */
    async append(companyId: string, input: { slug: string; entry: string; heading?: string; position?: AppendPosition; title?: string; ticketId?: string | null; isCeo?: boolean } & Author) {
      if (!input.entry.trim()) throw new WikiError(400, "Give the entry to add.");
      if (input.entry.length > MAX_ENTRY) throw new WikiError(400, `An entry can be at most ${MAX_ENTRY.toLocaleString("en-GB")} characters; a log entry is usually a line or two.`);
      const position = input.position ?? "top";
      const r = await db.transaction(async (tx) => {
        // SELECT … FOR UPDATE: another append to this page waits here and then reads the row it saved.
        const p = await findPage(tx, companyId, input.slug, true);
        if (!p) throw new WikiError(404, "There's no wiki page with that name.");
        const body = appendToBody(p.body, input.entry, input.heading, position);
        const title = input.title?.trim() || p.title;
        // An append only adds text, so it never trips the shrink guard; it keeps a version like any save.
        return this.writeWithin(tx, companyId, { slug: p.slug, folder: p.folder, title, body, ticketId: input.ticketId ?? null, isCeo: !!input.isCeo, agentId: input.agentId, runId: input.runId });
      });
      if (input.ticketId) await record(db, { companyId, agentId: input.agentId, ticketId: input.ticketId, kind: "artifact", summary: `Wrote wiki page "${input.title?.trim() || r.page.title}"` });
      // With no heading, "oldest" means the end of the page, so the reply must say so too.
      const where = input.heading ? ` under "${input.heading}"` : position === "top" ? " at the top" : " at the end";
      return { ...r, size: r.page.body.length, where };
    },

    async remove(companyId: string, slug: string) {
      const p = await page(companyId, slug);
      await db.delete(wikiPages).where(eq(wikiPages.id, p.id));
    },

    /**
     * A page's versions for the wiki tool's history action (BOS-430): every version, newest first, each
     * with its size and who saved it. Unlike the page screen this is never capped, so a long release log
     * still shows the version from before a wipe.
     */
    async history(companyId: string, slug: string) {
      const p = await page(companyId, slug);
      const revisions = await db
        .select({ id: wikiRevisions.id, createdAt: wikiRevisions.createdAt, agent: agents.name, agentId: wikiRevisions.agentId, runId: wikiRevisions.runId, size: sql<number>`length(${wikiRevisions.body})` })
        .from(wikiRevisions)
        .leftJoin(agents, eq(agents.id, wikiRevisions.agentId))
        .where(eq(wikiRevisions.pageId, p.id))
        .orderBy(desc(wikiRevisions.createdAt));
      return { slug: p.slug, title: p.title, size: p.body.length, revisions };
    },

    /**
     * Puts an old version back as the page's current text (BOS-430). The restore is saved through write,
     * so it is itself a new version (and can be undone) and keeps the Lessons rules. Only the CEO or the
     * page's last writer may restore: a restore is a replace, and one agent must not overwrite another's
     * page behind their back. The version must belong to this page, not just this company.
     */
    async restore(companyId: string, input: { slug: string; revisionId: string } & Author & { isCeo?: boolean }) {
      const p = await page(companyId, input.slug);
      const [rev] = await db.select().from(wikiRevisions).where(and(eq(wikiRevisions.id, input.revisionId), eq(wikiRevisions.pageId, p.id)));
      if (!rev) throw new WikiError(404, "That version isn't one of this page's. Use history to see its versions.");
      const isCeo = !!input.isCeo;
      const lastWriter = p.updatedByAgentId;
      const mine = !!input.agentId && lastWriter === input.agentId;
      if (!isCeo && !mine)
        throw new WikiError(403, "Only the CEO or the page's last writer can put an old version back. Ask the CEO, or the agent who last wrote it.");
      // A non-CEO may only undo their own latest change: the version just before it, while it is still
      // the page's latest. Anything else is an ordinary replace and gets the creator check, so appending
      // a line to become last writer no longer opens a way round that rule (BOS-499).
      let undoOwn = isCeo;
      if (!isCeo) {
        const [latest, before] = await db
          .select({ id: wikiRevisions.id, agentId: wikiRevisions.agentId, body: wikiRevisions.body })
          .from(wikiRevisions)
          .where(eq(wikiRevisions.pageId, p.id))
          .orderBy(desc(wikiRevisions.createdAt))
          .limit(2);
        undoOwn = !!latest && latest.agentId === input.agentId && latest.body === p.body && before?.id === rev.id;
      }
      const r = await this.write(companyId, { slug: p.slug, folder: p.folder, title: rev.title, body: rev.body, replace: true, fromRestore: undoOwn, isCeo, agentId: input.agentId, runId: input.runId });
      return { ...r, size: rev.body.length };
    },

    /** Links a repo file or a web address to a ticket as something it produced. */
    async attach(companyId: string, input: { ticketId: string; title: string; path?: string | null; ref?: string | null; url?: string | null } & Author) {
      await ownTicket(db, companyId, input.ticketId);
      if (!input.path === !input.url) throw new WikiError(400, "Give either a file path in the repo or a web address.");
      if (input.url && !/^https?:\/\//i.test(input.url)) throw new WikiError(400, "A web address must start with http:// or https://.");
      const [a] = await db
        .insert(ticketArtifacts)
        .values({
          companyId,
          ticketId: input.ticketId,
          kind: input.url ? "url" : "repo_file",
          title: input.title.trim() || input.path || input.url!,
          path: input.path ?? null,
          ref: input.ref ?? null,
          url: input.url ?? null,
          agentId: input.agentId,
          runId: input.runId,
        })
        .returning();
      await record(db, { companyId, agentId: input.agentId, ticketId: input.ticketId, kind: "artifact", summary: `Attached ${a!.title}` });
      return a!;
    },

    /** What a ticket produced, oldest first. */
    /** A ticket's outputs; with family, also its parent's and sub-tasks', each naming the ticket it came from. */
    async artifacts(ticketId: string, opts: { family?: boolean } = {}) {
      let ids = [ticketId];
      if (opts.family) {
        const [t] = await db.select({ parent: tickets.parentTicketId }).from(tickets).where(eq(tickets.id, ticketId));
        const kids = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.parentTicketId, ticketId));
        ids = [ticketId, ...(t?.parent ? [t.parent] : []), ...kids.map((k) => k.id)];
      }
      return db
        .select({
          ticketId: ticketArtifacts.ticketId,
          fromTitle: tickets.title,
          fromNumber: tickets.number,
          id: ticketArtifacts.id,
          kind: ticketArtifacts.kind,
          title: ticketArtifacts.title,
          slug: wikiPages.slug,
          path: ticketArtifacts.path,
          ref: ticketArtifacts.ref,
          url: ticketArtifacts.url,
          agent: agents.name,
          runId: ticketArtifacts.runId,
          createdAt: ticketArtifacts.createdAt,
        })
        .from(ticketArtifacts)
        .leftJoin(wikiPages, eq(wikiPages.id, ticketArtifacts.wikiPageId))
        .leftJoin(agents, eq(agents.id, ticketArtifacts.agentId))
        .innerJoin(tickets, eq(tickets.id, ticketArtifacts.ticketId))
        .where(inArray(ticketArtifacts.ticketId, ids))
        .orderBy(asc(ticketArtifacts.createdAt));
    },

    async removeArtifact(artifactId: string) {
      const rows = await db.delete(ticketArtifacts).where(eq(ticketArtifacts.id, artifactId)).returning({ id: ticketArtifacts.id });
      if (!rows.length) throw new WikiError(404, "No such item.");
    },
  };

  /**
   * The body of `writeWithin`, run through `conn`. A plain write calls it inside one transaction
   * and the write queue, so the page change and its saved version land together and no concurrent
   * save can slip between the read and the write (BOS-496). An append or a restore passes its own
   * transaction, which already holds the page.
   */
  async function writeWithinTx(conn: Db, companyId: string, input: WriteInput, title: string) {
    if (input.ticketId) {
      await ownTicket(conn, companyId, input.ticketId);
      // The skill-review guard lives here, not only in the tools, so every path that links a page to a
      // ticket is covered: write, append, restore and anything added later (BOS-430, security round 1).
      const refusal = await reviewTicketWriteRefusal(conn, companyId, input.ticketId, input.agentId ?? null);
      if (refusal) throw new WikiError(403, refusal);
    }
    const bySlug = async (slug: string) => (await conn.select().from(wikiPages).where(and(eq(wikiPages.companyId, companyId), eq(wikiPages.slug, slug))))[0];
    let existing = input.slug?.trim() ? await findPage(conn, companyId, input.slug) : undefined;
    // A new page's address: the given slug in its stored form. An existing page keeps its own.
    const given = existing ? existing.slug : input.slug?.trim() ? normalSlug(input.slug) : null;
    const folder = input.folder !== undefined ? cleanFolder(input.folder) : (existing?.folder ?? (given ? folderOf(given) : ""));
    let slug: string;
    if (existing) {
      // A different folder moves the page; it keeps the last part of its address.
      slug = folder === existing.folder ? existing.slug : pageSlug(folder, existing.slug.split("/").at(-1)!);
      const clash = slug !== existing.slug ? await bySlug(slug) : undefined;
      if (clash) throw new WikiError(409, `There's already a page at ${slug} ("${clash.title}").`);
    } else {
      // An explicit slug is the address, whatever the folder (a project's brief keeps its slug when the project is renamed).
      slug = given ?? pageSlug(folder, title);
      // Writing a new page where one already is updates that page.
      existing = await bySlug(slug);
    }
    const changed = !existing || existing.title !== title || existing.body !== input.body;
    // (R-review-lessons) A project brief's Lessons section holds owner-approved lessons; it can
    // only change through a lesson decision, so any other rewrite of the brief passes over it.
    if (existing && /^brief-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing.slug) && lessonsSection(existing.body) && lessonsSection(input.body) !== lessonsSection(existing.body))
      throw new WikiError(409, "The Lessons section of a project brief is owner-approved and can't be edited here; leave it exactly as it is.");
    // (BOS-430) No agent write may wipe a long page or its headings by accident: a rewrite that
    // removes a lot of text or any heading needs replace: true, and only the CEO or the owner may
    // replace a page someone else created.
    if (existing) {
      // The history baseline only matters to a write that cuts the page from what it holds now. A
      // write that grows the page (or an append) can't be a wipe in progress, so after a deliberate
      // trim (replace: true) the page is editable again instead of staying locked at its old peak
      // (BOS-430, adversarial round 3).
      const baseline = input.body.length < existing.body.length ? await largestEver(conn, existing.id, existing.body.length) : existing.body.length;
      const refusal = input.replace ? null : shrinkRefusalAgainst(existing.body, baseline, input.body);
      if (refusal) throw new WikiError(409, refusal);
      // (BOS-1280) A long page (a release log) is wiped by one whole-page write with replace: true
      // (BOS-447, BOS-1279). An agent write that makes such a page shorter needs replace: true AND
      // confirmReplace naming the page's slug, whoever the agent is. A restore and the owner's own
      // editor (no agentId) are exempt.
      if (input.agentId && !input.fromRestore && existing.body.length >= LONG_PAGE_CHARS && input.body.length < existing.body.length && input.confirmReplace !== existing.slug) {
        throw new WikiError(
          409,
          `"${existing.slug}" is a long page (${existing.body.length.toLocaleString("en-GB")} characters) and this write would shorten it to ${input.body.length.toLocaleString("en-GB")}. Do not re-send a long page: add to it with append. If you really mean to replace it, pass replace: true and confirmReplace: "${existing.slug}".`,
        );
      }
      if (input.replace && !input.isCeo && input.agentId) {
        const [first] = await conn
          .select({ agentId: wikiRevisions.agentId })
          .from(wikiRevisions)
          .where(eq(wikiRevisions.pageId, existing.id))
          .orderBy(asc(wikiRevisions.createdAt))
          .limit(1);
        // No revision row (or a first version with no agent) means the owner made the page, so an
        // ordinary agent may not replace it either. Only the CEO may (BOS-430, security round 1).
        // A restore is the exception: it has already checked that this agent is the page's last writer.
        const creator = first?.agentId ?? null;
        if (creator !== input.agentId && !input.fromRestore) throw new WikiError(403, "Only the CEO or the owner can replace a page another agent created. Add to it with append, or ask the CEO to replace it.");
      }
    }
    let p = existing;
    if (!p) {
      [p] = await conn.insert(wikiPages).values({ companyId, slug, folder, title, body: input.body, ticketId: input.ticketId ?? null, updatedByAgentId: input.agentId }).returning();
    } else if (changed || slug !== p.slug) {
      [p] = await conn.update(wikiPages).set({ slug, folder, title, body: input.body, updatedByAgentId: input.agentId, updatedAt: new Date() }).where(eq(wikiPages.id, p.id)).returning();
    }
    if (changed) await conn.insert(wikiRevisions).values({ pageId: p!.id, title, body: input.body, agentId: input.agentId, runId: input.runId });
    if (input.ticketId) {
      await conn
        .insert(ticketArtifacts)
        .values({ companyId, ticketId: input.ticketId, kind: "wiki_page", title, wikiPageId: p!.id, agentId: input.agentId, runId: input.runId })
        .onConflictDoNothing();
    }
    if (changed) semantic?.enqueue(companyId, p!.id);
    return { page: p!, created: !existing };
  }
}
