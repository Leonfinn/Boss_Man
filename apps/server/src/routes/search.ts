// The app-wide search box (BOS-2192): one owner route that finds tickets, wiki pages and chat
// messages in one company, and since BOS-2326 features, decisions (owner cards) and runs, which come back as
// titles and short status words only (no answer text, no run outcome detail); since BOS-2347 agents (by name and job,
// never their instructions) and skills (by name and description, this company's library only). Plain case-insensitive matching (ILIKE), no index or embeddings: a
// company's few thousand rows scan in milliseconds, and meaning search is BOS-2116's.
// Every query filters on the company in the address, so no other company's rows can come back.
import { ticketRef } from "@boss-man/shared";
import { and, desc, eq, gte, isNotNull, ne, or, sql, type AnyColumn } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, features, ownerChatMessages, runs, skills, tickets, wikiPages } from "../db/schema.js";
import { liveWikiPage } from "../services/wiki.js";

/** At most this many results per group in the box. */
export const SEARCH_GROUP_MAX = 8;
/** Below this many characters the box doesn't ask (the web side holds back too). */
export const SEARCH_MIN = 2;
const SNIPPET_AROUND = 60;

/** At most this many features, decisions and runs (BOS-2326), agents and skills (BOS-2347): they come after the main three groups. */
export const SEARCH_EXTRA_MAX = 5;
/** A decision's title is the first line of its question, cut to this length. */
const DECISION_TITLE_MAX = 160;

/** The kinds of result, in the order the box and the Search page show them. */
export const SEARCH_KINDS = ["tickets", "wiki", "chats", "features", "decisions", "runs", "agents", "skills"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
/** The Search page (BOS-2378) asks for one kind a page at a time: this many by default, never more than the max. */
export const SEARCH_PAGE = 25;
export const SEARCH_PAGE_MAX = 100;
/** How many of each kind the box shows when no kind is picked. */
const GROUP_MAX: Record<SearchKind, number> = { tickets: SEARCH_GROUP_MAX, wiki: SEARCH_GROUP_MAX, chats: SEARCH_GROUP_MAX, features: SEARCH_EXTRA_MAX, decisions: SEARCH_EXTRA_MAX, runs: SEARCH_EXTRA_MAX, agents: SEARCH_EXTRA_MAX, skills: SEARCH_EXTRA_MAX };

/**
 * (BOS-2378) `kind` asks for that kind only, `limit` of them from `offset` (the other kinds come back empty, with their
 * counts). `since` keeps only what changed from then on, by the date each kind is sorted by: a ticket's last move, a wiki
 * page's or feature's or skill's last edit, a message's or decision's or agent's creation, a run's start.
 */
export type SearchOptions = { kind?: SearchKind; offset?: number; limit?: number; since?: Date };

export type SearchHit = { id: string; title: string; snippet: string; link: string; ref?: string | null; exact?: boolean; who?: string; at?: string };
/** `counts` is every match of each kind (with `since` applied), not just the ones returned. */
export type SearchResults = { q: string; tickets: SearchHit[]; wiki: SearchHit[]; chats: SearchHit[]; features: SearchHit[]; decisions: SearchHit[]; runs: SearchHit[]; agents: SearchHit[]; skills: SearchHit[]; counts: Record<SearchKind, number> };

/** An agent's job in the Agents page's words (web Agents.tsx jobOf; the server can't import web code). */
export function agentJob(a: { role: string; title: string | null; duty: string | null }): string {
  if (a.role === "ceo") return "CEO";
  return a.title ?? (a.duty === "wiki" ? "Wiki Maintainer" : a.role === "manager" ? "Manager" : "Agent");
}

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

export async function search(db: Db, companyId: string, rawQ: string, opts: SearchOptions = {}): Promise<SearchResults> {
  const q = rawQ.trim();
  const counts = Object.fromEntries(SEARCH_KINDS.map((k) => [k, 0])) as Record<SearchKind, number>;
  const empty: SearchResults = { q, tickets: [], wiki: [], chats: [], features: [], decisions: [], runs: [], agents: [], skills: [], counts };
  if (q.length < SEARCH_MIN) return empty;
  const [company] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
  if (!company) return empty;
  const like = likePattern(q);
  const ref = refOf(q);
  // An exact reference jumps first; a prefix that isn't this company's names nothing here.
  const exactNumber = ref && (!ref.prefix || ref.prefix === (company.prefix || "T").toUpperCase()) ? ref.number : null;
  const since = (col: AnyColumn) => (opts.since ? gte(col, opts.since) : undefined);
  // How many rows of a kind to read, and from where. With a kind picked, the other kinds read one row each: only
  // their count is wanted, and the count rides on a row (`count(*) over()` is every match before the limit).
  const page = (k: SearchKind) =>
    !opts.kind ? { limit: GROUP_MAX[k], offset: 0 } : k === opts.kind ? { limit: opts.limit ?? SEARCH_PAGE, offset: opts.offset ?? 0 } : { limit: 1, offset: 0 };
  const shown = (k: SearchKind) => !opts.kind || k === opts.kind;
  const total = sql<number>`count(*) over()`.mapWith(Number);

  const ticketCols = { id: tickets.id, title: tickets.title, number: tickets.number, body: around(tickets.body, q), titleHit: sql<boolean>`${tickets.title} ilike ${like}` };
  const [top] =
    exactNumber === null
      ? []
      : await db.select(ticketCols).from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.number, exactNumber), since(tickets.stateChangedAt))).limit(1);
  // The exact ticket is the list's first entry, so the text matches (which leave it out) start one later. At least
  // one row is read even when the exact ticket fills the page, so the count still comes back.
  const tp = page("tickets");
  const ticketLimit = Math.max(1, top && tp.offset === 0 ? tp.limit - 1 : tp.limit);
  const ticketOffset = top && tp.offset > 0 ? tp.offset - 1 : tp.offset;
  const [ticketRows, wikiRows, chatRows, featureRows, decisionRows, runRows, agentRows, skillRows] = await Promise.all([
    db
      .select({ ...ticketCols, total })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), or(sql`${tickets.title} ilike ${like}`, sql`${tickets.body} ilike ${like}`), since(tickets.stateChangedAt), top ? ne(tickets.id, top.id) : undefined))
      // Title matches first, then the most recently moved; the id keeps pages from overlapping on a tie.
      .orderBy(sql`(${tickets.title} ilike ${like}) desc`, desc(tickets.stateChangedAt), tickets.id)
      .limit(ticketLimit)
      .offset(ticketOffset),
    db
      .select({ slug: wikiPages.slug, title: wikiPages.title, body: around(wikiPages.body, q), titleHit: sql<boolean>`${wikiPages.title} ilike ${like}`, total })
      .from(wikiPages)
      .where(and(eq(wikiPages.companyId, companyId), liveWikiPage, or(sql`${wikiPages.title} ilike ${like}`, sql`${wikiPages.body} ilike ${like}`), since(wikiPages.updatedAt)))
      .orderBy(sql`(${wikiPages.title} ilike ${like}) desc`, desc(wikiPages.updatedAt), wikiPages.id)
      .limit(page("wiki").limit)
      .offset(page("wiki").offset),
    db
      .select({ id: ownerChatMessages.id, agentId: ownerChatMessages.agentId, role: ownerChatMessages.role, text: around(ownerChatMessages.text, q), createdAt: ownerChatMessages.createdAt, agent: agents.name, total })
      .from(ownerChatMessages)
      // The agent must be this company's too: a message row can't point at another company's agent, but the join says so outright.
      .innerJoin(agents, and(eq(agents.id, ownerChatMessages.agentId), eq(agents.companyId, companyId)))
      // Only messages in an agent's conversation: the chat page shows nothing else.
      .where(and(eq(ownerChatMessages.companyId, companyId), isNotNull(ownerChatMessages.agentId), sql`${ownerChatMessages.text} ilike ${like}`, since(ownerChatMessages.createdAt)))
      .orderBy(desc(ownerChatMessages.createdAt), ownerChatMessages.id)
      .limit(page("chats").limit)
      .offset(page("chats").offset),
    // (BOS-2326) Features by title or description; only the title and status come back.
    db
      .select({ id: features.id, title: features.title, status: features.status, total })
      .from(features)
      .where(and(eq(features.companyId, companyId), or(sql`${features.title} ilike ${like}`, sql`${features.description} ilike ${like}`), since(features.updatedAt)))
      .orderBy(sql`(${features.title} ilike ${like}) desc`, desc(features.updatedAt), features.id)
      .limit(page("features").limit)
      .offset(page("features").offset),
    // Decisions (owner cards) by question, open and closed; open ones first. The answer is never read: it can be
    // the owner's own free text.
    db
      .select({ id: decisions.id, question: sql<string>`left(${decisions.question}, 1000)`, status: decisions.status, createdAt: decisions.createdAt, total })
      .from(decisions)
      .where(and(eq(decisions.companyId, companyId), sql`${decisions.question} ilike ${like}`, since(decisions.createdAt)))
      .orderBy(sql`(${decisions.status} = 'open') desc`, desc(decisions.createdAt), decisions.id)
      .limit(page("decisions").limit)
      .offset(page("decisions").offset),
    // Runs by the agent's name or the ticket's title or reference (the ticket it was on, else the one it was about).
    // Both joins name the company too, so a row can't borrow another company's ticket or agent.
    db
      .select({ id: runs.id, outcome: runs.outcome, origin: runs.origin, startedAt: runs.startedAt, agent: agents.name, ticketTitle: tickets.title, ticketNumber: tickets.number, total })
      .from(runs)
      .leftJoin(agents, and(eq(agents.id, runs.agentId), eq(agents.companyId, companyId)))
      .leftJoin(tickets, and(sql`${tickets.id} = coalesce(${runs.ticketId}, ${runs.runTicketId})`, eq(tickets.companyId, companyId)))
      .where(
        and(
          eq(runs.companyId, companyId),
          or(sql`${agents.name} ilike ${like}`, sql`${tickets.title} ilike ${like}`, ...(exactNumber === null ? [] : [eq(tickets.number, exactNumber)])),
          since(runs.startedAt),
        ),
      )
      .orderBy(desc(runs.startedAt), runs.id)
      .limit(page("runs").limit)
      .offset(page("runs").offset),
    // (BOS-2347) Agents by name, job title or role ("ceo", "manager"); never the instructions. Working agents
    // before retired ones, name matches first.
    db
      .select({ id: agents.id, name: agents.name, role: agents.role, title: agents.title, duty: agents.duty, retiredAt: agents.retiredAt, total })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), or(sql`${agents.name} ilike ${like}`, sql`${agents.title} ilike ${like}`, sql`${agents.role}::text ilike ${like}`), since(agents.createdAt)))
      .orderBy(sql`(${agents.retiredAt} is null) desc`, sql`(${agents.name} ilike ${like}) desc`, agents.name, agents.id)
      .limit(page("agents").limit)
      .offset(page("agents").offset),
    // Skills in this company's library by name or description (the files are never read).
    db
      .select({ id: skills.id, name: skills.name, description: around(skills.description, q), nameHit: sql<boolean>`${skills.name} ilike ${like}`, total })
      .from(skills)
      .where(and(eq(skills.companyId, companyId), or(sql`${skills.name} ilike ${like}`, sql`${skills.description} ilike ${like}`), since(skills.updatedAt)))
      .orderBy(sql`(${skills.name} ilike ${like}) desc`, skills.name, skills.id)
      .limit(page("skills").limit)
      .offset(page("skills").offset),
  ]);

  // A page past the last match has no row to carry the count: it reads as 0 there, and the page keeps its first count.
  const countOf = (rows: Array<{ total: number }>) => rows[0]?.total ?? 0;
  counts.tickets = countOf(ticketRows) + (top ? 1 : 0);
  counts.wiki = countOf(wikiRows);
  counts.chats = countOf(chatRows);
  counts.features = countOf(featureRows);
  counts.decisions = countOf(decisionRows);
  counts.runs = countOf(runRows);
  counts.agents = countOf(agentRows);
  counts.skills = countOf(skillRows);
  // Rows read only for their count are not shown.
  const only = <T,>(k: SearchKind, rows: T[]): T[] => (shown(k) ? rows : []);

  const ticketHit = (t: NonNullable<typeof top>, isExact: boolean): SearchHit => {
    const ref = ticketRef(company.prefix, t.number);
    return { id: t.id, title: t.title, ref, snippet: t.titleHit || !t.body ? "" : snippetOf(t.body, q), link: `tickets/${t.id}`, ...(isExact ? { exact: true } : {}) };
  };
  return {
    q,
    counts,
    tickets: only("tickets", [...(top && tp.offset === 0 ? [ticketHit(top, true)] : []), ...ticketRows.map((t) => ticketHit(t, false))].slice(0, tp.limit)),
    wiki: only("wiki", wikiRows).map((p) => ({ id: p.slug, title: p.title, snippet: snippetOf(p.body, q), link: `wiki/${companyId}/${p.slug}` })),
    chats: only("chats", chatRows).map((m) => ({
      id: m.id,
      title: `${m.role === "owner" ? "You" : m.role === "assistant" ? m.agent : "Boss Man"}, chat with ${m.agent}`,
      who: m.agent,
      at: m.createdAt.toISOString(),
      snippet: snippetOf(m.text, q),
      link: `chat/${companyId}/${m.agentId}/${m.id}`,
    })),
    features: only("features", featureRows).map((f) => ({ id: f.id, title: f.title, snippet: FEATURE_STATUS_WORD[f.status] ?? "", link: `features/${companyId}/${f.id}` })),
    // The Decisions screen opens a card from #/decisions/<id>: an open one in the queue, a closed one in its Answered list.
    decisions: only("decisions", decisionRows).map((d) => ({ id: d.id, title: decisionTitle(d.question), snippet: DECISION_STATUS_WORD[d.status] ?? "", at: d.createdAt.toISOString(), link: `decisions/${d.id}` })),
    runs: only("runs", runRows).map((r) => {
      const ref = r.ticketNumber == null ? null : ticketRef(company.prefix, r.ticketNumber);
      const what = r.ticketTitle ?? (r.origin ? r.origin.replace(/_/g, " ") : "no ticket");
      return { id: r.id, title: `${r.agent ?? "An agent"} on ${what}`, ref, who: r.agent ?? undefined, snippet: runResultWord(r.outcome), at: r.startedAt.toISOString(), link: `runs/${r.id}` };
    }),
    // The Agents page opens an agent's panel from #/agents/<id>; the Skills page shows a skill from #/skills/<id>.
    // Neither page carries the company in the address: both show the company on screen, which is the one searched.
    agents: only("agents", agentRows).map((a) => ({ id: a.id, title: a.name, snippet: `${agentJob(a)}${a.retiredAt ? " · Retired" : ""}`, link: `agents/${a.id}` })),
    skills: only("skills", skillRows).map((s) => ({ id: s.id, title: s.name, snippet: snippetOf(s.description, s.nameHit ? "" : q), link: `skills/${s.id}` })),
  };
}

/** Owner route: app.ts registers it inside its owner scope, so a signed-out request gets 401 there. */
export function searchRoutes(owner: FastifyInstance, db: Db) {
  owner.get("/api/companies/:id/search", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // kind, offset, limit and since are the Search page's (BOS-2378); offset and limit count only with a kind.
    const { q, ...opts } = z
      .object({
        q: z.string().max(200).default(""),
        kind: z.enum(SEARCH_KINDS).optional(),
        offset: z.coerce.number().int().min(0).max(100_000).optional(),
        limit: z.coerce.number().int().min(1).max(SEARCH_PAGE_MAX).optional(),
        since: z.coerce.date().optional(),
      })
      .parse(req.query);
    return search(db, id, q, opts);
  });
}
