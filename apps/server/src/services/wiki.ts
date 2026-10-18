// The company wiki and what tickets produce (R69). Pages are Markdown, written by the owner
// or by agents through the wiki tool, and every save keeps a revision. A page written for a
// ticket shows on that ticket as something it produced, next to repo files and links an
// agent attaches, so "see the evidence" opens the work itself.
import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, ticketArtifacts, tickets, wikiPages, wikiRevisions } from "../db/schema.js";
import { record } from "./activity.js";

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

type Author = { agentId: string | null; runId: string | null };

export function wikiService(db: Db) {
  async function ownTicket(companyId: string, ticketId: string) {
    const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId)));
    if (!t) throw new WikiError(404, "No ticket with that ID in this company.");
  }

  async function page(companyId: string, slug: string) {
    const [p] = await db.select().from(wikiPages).where(and(eq(wikiPages.companyId, companyId), eq(wikiPages.slug, slug)));
    if (!p) throw new WikiError(404, "There's no wiki page with that name.");
    return p;
  }

  return {
    slugify,

    /** Pages, most recently changed first; q matches titles and text. */
    async list(companyId: string, q?: string) {
      const like = q?.trim() ? `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
      return db
        .select({ id: wikiPages.id, slug: wikiPages.slug, folder: wikiPages.folder, title: wikiPages.title, ticketId: wikiPages.ticketId, updatedAt: wikiPages.updatedAt, updatedBy: agents.name })
        .from(wikiPages)
        .leftJoin(agents, eq(agents.id, wikiPages.updatedByAgentId))
        .where(and(eq(wikiPages.companyId, companyId), like ? or(ilike(wikiPages.title, like), ilike(wikiPages.body, like)) : undefined))
        .orderBy(desc(wikiPages.updatedAt))
        .limit(2000);
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
        slug = given && input.folder === undefined ? given : pageSlug(folder, given?.split("/").at(-1) ?? title);
        // Writing a new page where one already is updates that page.
        existing = await bySlug(slug);
      }
      const changed = !existing || existing.title !== title || existing.body !== input.body;
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
    async artifacts(ticketId: string) {
      return db
        .select({
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
        .where(eq(ticketArtifacts.ticketId, ticketId))
        .orderBy(asc(ticketArtifacts.createdAt));
    },

    async removeArtifact(artifactId: string) {
      const rows = await db.delete(ticketArtifacts).where(eq(ticketArtifacts.id, artifactId)).returning({ id: ticketArtifacts.id });
      if (!rows.length) throw new WikiError(404, "No such item.");
    },
  };
}
