// The app-wide search box (BOS-2192): one owner route that finds tickets, wiki pages and chat
// messages in one company, and since BOS-2326 features, decisions (owner cards) and runs, which come back as
// titles and short status words only (no answer text, no run outcome detail). Plain case-insensitive matching (ILIKE), no index or embeddings: a
// company's few thousand rows scan in milliseconds, and meaning search is BOS-2116's.
// Every query filters on the company in the address, so no other company's rows can come back.
import { ticketRef } from "@boss-man/shared";
import { and, desc, eq, isNotNull, or, sql, type AnyColumn } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, features, ownerChatMessages, runs, tickets, wikiPages } from "../db/schema.js";
import { liveWikiPage } from "../services/wiki.js";

/** At most this many results per group. */
export const SEARCH_GROUP_MAX = 8;
/** Below this many characters the box doesn't ask (the web side holds back too). */
export const SEARCH_MIN = 2;
const SNIPPET_AROUND = 60;

/** At most this many features, decisions and runs (BOS-2326): they come after the main three groups. */
export const SEARCH_EXTRA_MAX = 5;
/** A decision's title is the first line of its question, cut to this length. */
const DECISION_TITLE_MAX = 160;

export type SearchHit = { id: string; title: string; snippet: string; link: string; ref?: string | null; exact?: boolean; who?: string; at?: string };
export type SearchResults = { q: string; tickets: SearchHit[]; wiki: SearchHit[]; chats: SearchHit[]; features: SearchHit[]; decisions: SearchHit[]; runs: SearchHit[] };

/** A run's result in the Runs page's words (Runs.tsx outcomeTag): never the raw outcome, which can carry an error's text. */
export function runResultWord(outcome: string | null): string {
  if (!outcome) return "Running";
  if (outcome.startsWith("error")) return "Failed";
  if (outcome === "interrupted") return "Interrupted";
  if (outcome === "cancelled" || outcome.startsWith("stopped")) return "Stopped";
  if (outcome.startsWith("lost")) return "Lost";
  return "Finished";
}

/** The first non-empty line of a card's question, cut short: the card's face, not its detail. */
export function decisionTitle(question: string): string {
  const line = question.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > DECISION_TITLE_MAX ? `${line.slice(0, DECISION_TITLE_MAX - 1)}…` : line;
}

const DECISION_STATUS_WORD: Record<string, string> = { open: "Open", answered: "Answered", withdrawn: "Withdrawn" };
/** The Features page's words for a status (web api.ts FEATURE_STATUS_LABEL; the server can't import web code). */
const FEATURE_STATUS_WORD: Record<string, string> = { idea: "Idea", considering: "Considering", planned: "Planned", in_progress: "In progress", released: "Released", declined: "Declined" };

/** LIKE treats % and _ as wildcards and \ as its escape: a query containing them matches them as typed. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * A short piece of text around the first match, on one line, with "…" where it was cut. The database
 * sends only a window of the text around the match (see `around`), so a long wiki page isn't read whole.
 */
export function snippetOf(window: string | null, q: string): string {
  const flat = (window ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return flat.length > SNIPPET_AROUND * 2 ? `${flat.slice(0, SNIPPET_AROUND * 2)}…` : flat;
  const start = Math.max(0, at - SNIPPET_AROUND);
  const end = Math.min(flat.length, at + q.length + SNIPPET_AROUND);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Up to 200 characters of `col` either side of the first match (the whole start when it doesn't match). */
const around = (col: AnyColumn, q: string) =>
  sql<string | null>`substring(${col} from greatest(strpos(lower(${col}), lower(${q})) - 200, 1) for ${q.length + 400}::int)`;

/** "BOS-12" or "#12": the ticket number it names, with the prefix if one was typed. */
export function refOf(q: string): { prefix: string | null; number: number } | null {
  const m = /^(?:([a-z][a-z0-9]*)-|#)(\d{1,9})$/i.exec(q.trim());
  return m ? { prefix: m[1]?.toUpperCase() ?? null, number: Number(m[2]) } : null;
}

export async function search(db: Db, companyId: string, rawQ: string): Promise<SearchResults> {
  const q = rawQ.trim();
  const empty: SearchResults = { q, tickets: [], wiki: [], chats: [], features: [], decisions: [], runs: [] };
  if (q.length < SEARCH_MIN) return empty;
  const [company] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
  if (!company) return empty;
  const like = likePattern(q);
  const ref = refOf(q);
  // An exact reference jumps first; a prefix that isn't this company's names nothing here.
  const exactNumber = ref && (!ref.prefix || ref.prefix === (company.prefix || "T").toUpperCase()) ? ref.number : null;

  const ticketCols = { id: tickets.id, title: tickets.title, number: tickets.number, body: around(tickets.body, q), titleHit: sql<boolean>`${tickets.title} ilike ${like}` };
  const [exact, ticketRows, wikiRows, chatRows, featureRows, decisionRows, runRows] = await Promise.all([
    exactNumber === null ? Promise.resolve([]) : db.select(ticketCols).from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.number, exactNumber))).limit(1),
    db
      .select(ticketCols)
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), or(sql`${tickets.title} ilike ${like}`, sql`${tickets.body} ilike ${like}`)))
      // Title matches first, then the most recently moved.
      .orderBy(sql`(${tickets.title} ilike ${like}) desc`, desc(tickets.stateChangedAt))
      .limit(SEARCH_GROUP_MAX),
    db
      .select({ slug: wikiPages.slug, title: wikiPages.title, body: around(wikiPages.body, q), titleHit: sql<boolean>`${wikiPages.title} ilike ${like}` })
      .from(wikiPages)
      .where(and(eq(wikiPages.companyId, companyId), liveWikiPage, or(sql`${wikiPages.title} ilike ${like}`, sql`${wikiPages.body} ilike ${like}`)))
      .orderBy(sql`(${wikiPages.title} ilike ${like}) desc`, desc(wikiPages.updatedAt))
      .limit(SEARCH_GROUP_MAX),
    db
      .select({ id: ownerChatMessages.id, agentId: ownerChatMessages.agentId, role: ownerChatMessages.role, text: around(ownerChatMessages.text, q), createdAt: ownerChatMessages.createdAt, agent: agents.name })
      .from(ownerChatMessages)
      // The agent must be this company's too: a message row can't point at another company's agent, but the join says so outright.
      .innerJoin(agents, and(eq(agents.id, ownerChatMessages.agentId), eq(agents.companyId, companyId)))
      // Only messages in an agent's conversation: the chat page shows nothing else.
      .where(and(eq(ownerChatMessages.companyId, companyId), isNotNull(ownerChatMessages.agentId), sql`${ownerChatMessages.text} ilike ${like}`))
      .orderBy(desc(ownerChatMessages.createdAt))
      .limit(SEARCH_GROUP_MAX),
    // (BOS-2326) Features by title or description; only the title and status come back.
    db
      .select({ id: features.id, title: features.title, status: features.status })
      .from(features)
      .where(and(eq(features.companyId, companyId), or(sql`${features.title} ilike ${like}`, sql`${features.description} ilike ${like}`)))
      .orderBy(sql`(${features.title} ilike ${like}) desc`, desc(features.updatedAt))
      .limit(SEARCH_EXTRA_MAX),
    // Decisions (owner cards) by question, open and closed; open ones first. The answer is never read: it can be
    // the owner's own free text.
    db
      .select({ id: decisions.id, question: sql<string>`left(${decisions.question}, 1000)`, status: decisions.status, createdAt: decisions.createdAt })
      .from(decisions)
      .where(and(eq(decisions.companyId, companyId), sql`${decisions.question} ilike ${like}`))
      .orderBy(sql`(${decisions.status} = 'open') desc`, desc(decisions.createdAt))
      .limit(SEARCH_EXTRA_MAX),
    // Runs by the agent's name or the ticket's title or reference (the ticket it was on, else the one it was about).
    // Both joins name the company too, so a row can't borrow another company's ticket or agent.
    db
      .select({ id: runs.id, outcome: runs.outcome, origin: runs.origin, startedAt: runs.startedAt, agent: agents.name, ticketTitle: tickets.title, ticketNumber: tickets.number })
      .from(runs)
      .leftJoin(agents, and(eq(agents.id, runs.agentId), eq(agents.companyId, companyId)))
      .leftJoin(tickets, and(sql`${tickets.id} = coalesce(${runs.ticketId}, ${runs.runTicketId})`, eq(tickets.companyId, companyId)))
      .where(
        and(
          eq(runs.companyId, companyId),
          or(sql`${agents.name} ilike ${like}`, sql`${tickets.title} ilike ${like}`, ...(exactNumber === null ? [] : [eq(tickets.number, exactNumber)])),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(SEARCH_EXTRA_MAX),
  ]);

  const ticketHit = (t: (typeof ticketRows)[number], isExact: boolean): SearchHit => {
    const ref = ticketRef(company.prefix, t.number);
    return { id: t.id, title: t.title, ref, snippet: t.titleHit || !t.body ? "" : snippetOf(t.body, q), link: `tickets/${t.id}`, ...(isExact ? { exact: true } : {}) };
  };
  const top = exact[0];
  return {
    q,
    tickets: [...(top ? [ticketHit(top, true)] : []), ...ticketRows.filter((t) => t.id !== top?.id).map((t) => ticketHit(t, false))].slice(0, SEARCH_GROUP_MAX),
    wiki: wikiRows.map((p) => ({ id: p.slug, title: p.title, snippet: snippetOf(p.body, q), link: `wiki/${companyId}/${p.slug}` })),
    chats: chatRows.map((m) => ({
      id: m.id,
      title: `${m.role === "owner" ? "You" : m.role === "assistant" ? m.agent : "Boss Man"}, chat with ${m.agent}`,
      who: m.agent,
      at: m.createdAt.toISOString(),
      snippet: snippetOf(m.text, q),
      link: `chat/${companyId}/${m.agentId}/${m.id}`,
    })),
    features: featureRows.map((f) => ({ id: f.id, title: f.title, snippet: FEATURE_STATUS_WORD[f.status] ?? "", link: `features/${companyId}/${f.id}` })),
    // The Decisions screen opens a card from #/decisions/<id>: an open one in the queue, a closed one in its Answered list.
    decisions: decisionRows.map((d) => ({ id: d.id, title: decisionTitle(d.question), snippet: DECISION_STATUS_WORD[d.status] ?? "", at: d.createdAt.toISOString(), link: `decisions/${d.id}` })),
    runs: runRows.map((r) => {
      const ref = r.ticketNumber == null ? null : ticketRef(company.prefix, r.ticketNumber);
      const what = r.ticketTitle ?? (r.origin ? r.origin.replace(/_/g, " ") : "no ticket");
      return { id: r.id, title: `${r.agent ?? "An agent"} on ${what}`, ref, who: r.agent ?? undefined, snippet: runResultWord(r.outcome), at: r.startedAt.toISOString(), link: `runs/${r.id}` };
    }),
  };
}

/** Owner route: app.ts registers it inside its owner scope, so a signed-out request gets 401 there. */
export function searchRoutes(owner: FastifyInstance, db: Db) {
  owner.get("/api/companies/:id/search", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { q } = z.object({ q: z.string().max(200).default("") }).parse(req.query);
    return search(db, id, q);
  });
}
