// The company wiki and what tickets produce (R69). Pages are Markdown, written by the owner
// or by agents through the wiki tool, and every save keeps a revision. A page written for a
// ticket shows on that ticket as something it produced, next to repo files and links an
// agent attaches, so "see the evidence" opens the work itself.
import { and, asc, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, ticketArtifacts, tickets, wikiPages, wikiRevisions } from "../db/schema.js";
import { record } from "./activity.js";
import type { WikiSemantic } from "./wiki-semantic.js";

export const MAX_BODY = 200_000;

export class WikiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** "2026 agent landscape!" → "2026-agent-landscape". */
export function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page"
  );
}

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

/** A heading's span in a page body. start..end is the section with its subsections; start..ownEnd is its own text. */
export type Section = { path: string; heading: string; level: number; start: number; ownEnd: number; end: number };

/** Markdown ATX headings, ignoring # lines inside ``` or ~~~ fences. Text before the first heading is "intro" (level 0). */
export function splitSections(body: string): Section[] {
  const out: Section[] = [];
  const stack: Section[] = [];
  let fence: string | null = null;
  let pos = 0;
  for (const line of body.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (f) fence = fence === null ? f : fence === f ? null : fence;
    const m = fence === null && !f ? /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line) : null;
    if (m) {
      const level = m[1]!.length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      const s: Section = { heading: m[2]!, level, path: [...stack.map((x) => x.heading), m[2]!].join(" > "), start: pos, ownEnd: body.length, end: body.length };
      out.push(s);
      stack.push(s);
    }
    pos += line.length + 1;
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
  return sections.find((s) => s.path.toLowerCase() === w) ?? sections.find((s) => s.heading.toLowerCase() === w);
}

/** [[slug]] and [[slug#Section heading]] in a page body: the slugs it links to. */
export const linkedSlugs = (body: string) => [...new Set([...body.matchAll(/\[\[([^\]#|]+?)(?:#[^\]]*)?\]\]/g)].map((m) => m[1]!.trim()))];

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

export function wikiService(db: Db, semantic?: Pick<WikiSemantic, "enqueue" | "similar">) {
  async function ownTicket(companyId: string, ticketId: string) {
    const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId)));
    if (!t) throw new WikiError(404, "No ticket with that ID in this company.");
  }

  async function page(companyId: string, slug: string) {
    const [p] = await db.select().from(wikiPages).where(and(eq(wikiPages.companyId, companyId), eq(wikiPages.slug, slug)));
    if (!p) throw new WikiError(404, "There's no wiki page with that name.");
    return p;
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
      const revisions = await db
        .select({ id: wikiRevisions.id, createdAt: wikiRevisions.createdAt, agent: agents.name, runId: wikiRevisions.runId })
        .from(wikiRevisions)
        .leftJoin(agents, eq(agents.id, wikiRevisions.agentId))
        .where(eq(wikiRevisions.pageId, p.id))
        .orderBy(desc(wikiRevisions.createdAt))
        .limit(100);
      const forTickets = await db
        .select({ id: tickets.id, title: tickets.title })
        .from(ticketArtifacts)
        .innerJoin(tickets, eq(tickets.id, ticketArtifacts.ticketId))
        .where(eq(ticketArtifacts.wikiPageId, p.id));
      return { ...p, updatedBy: by?.name ?? null, revisions, tickets: forTickets };
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
     */
    async write(companyId: string, input: { slug?: string; folder?: string; title: string; body: string; ticketId?: string | null } & Author) {
      const title = input.title.trim();
      if (!title) throw new WikiError(400, "A page needs a title.");
      if (input.body.length > MAX_BODY) throw new WikiError(400, `A page can be at most ${MAX_BODY.toLocaleString("en-GB")} characters.`);
      if (input.ticketId) await ownTicket(companyId, input.ticketId);
      const bySlug = async (slug: string) => (await db.select().from(wikiPages).where(and(eq(wikiPages.companyId, companyId), eq(wikiPages.slug, slug))))[0];
      const given = input.slug?.trim() ? input.slug.split("/").map(slugify).join("/") : null;
      let existing = given ? await bySlug(given) : undefined;
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
      let p = existing;
      if (!p) {
        [p] = await db.insert(wikiPages).values({ companyId, slug, folder, title, body: input.body, ticketId: input.ticketId ?? null, updatedByAgentId: input.agentId }).returning();
      } else if (changed || slug !== p.slug) {
        [p] = await db.update(wikiPages).set({ slug, folder, title, body: input.body, updatedByAgentId: input.agentId, updatedAt: new Date() }).where(eq(wikiPages.id, p.id)).returning();
      }
      if (changed) await db.insert(wikiRevisions).values({ pageId: p!.id, title, body: input.body, agentId: input.agentId, runId: input.runId });
      if (input.ticketId) {
        await db
          .insert(ticketArtifacts)
          .values({ companyId, ticketId: input.ticketId, kind: "wiki_page", title, wikiPageId: p!.id, agentId: input.agentId, runId: input.runId })
          .onConflictDoNothing();
        await record(db, { companyId, agentId: input.agentId, ticketId: input.ticketId, kind: "artifact", summary: `Wrote wiki page "${title}"` });
      }
      if (changed) semantic?.enqueue(companyId, p!.id);
      return { page: p!, created: !existing };
    },

    async remove(companyId: string, slug: string) {
      const p = await page(companyId, slug);
      await db.delete(wikiPages).where(eq(wikiPages.id, p.id));
    },

    /** Links a repo file or a web address to a ticket as something it produced. */
    async attach(companyId: string, input: { ticketId: string; title: string; path?: string | null; ref?: string | null; url?: string | null } & Author) {
      await ownTicket(companyId, input.ticketId);
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
}
