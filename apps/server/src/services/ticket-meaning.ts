// Meaning search over tickets and the CEO's own earlier advice (BOS-2116). Word search misses a ticket
// that says the same thing in other words (BOS-2114 filed again what BOS-1906 already shipped) and the
// CEO's own earlier "go ahead" that went stale. This embeds tickets (title, body, state note) and the CEO's
// go-ahead and card-order lines (chat replies and ticket comments) with the company's saved provider, and
// searches them by cosine distance. Nothing is copied: the embeddings point at the sources.
//
// Opt-in per company (its own box beside the owner-answers one, off by default). Every failure, a timeout,
// a missing key or the box being off returns "no meaning result", so callers keep their word search and
// never block or fail on this.
import { and, cosineDistance, eq, inArray, sql } from "drizzle-orm";
import { redact, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, meaningEmbeddings, ownerChatMessages, ticketMessages, tickets } from "../db/schema.js";
import type { Embedder, SemanticHit } from "./wiki-semantic.js";
import { stripCodeNotes } from "./reply-notes.js";

/** How long a meaning search waits for the provider before callers use word search alone. */
export const TICKET_MEANING_TIMEOUT_MS = 3000;
/**
 * Cosine similarity below which a match is not shown. A starting value (the owner-answer search keeps 0.5 and
 * calls 0.85 the same ask): two tickets about the same thing in other words sit well above it, and unrelated
 * ones well below. Tune it from the live provider's scores, which the lines show as a percentage.
 */
export const TICKET_MEANING_FLOOR = 0.6;
/** Open tickets are always searched; done ones only for this long (and never cancelled ones). Advice too. */
export const TICKET_MEANING_DONE_DAYS = 30;
const DAY_MS = 24 * 3_600_000;
const NEAREST = 20;
const BATCH = 64;
/** What counts as the CEO giving a go-ahead or ordering a card: a plain keyword filter, widened when it misses. */
export const ADVICE_FILTER = "go ahead|go-ahead|approve|release|deploy|merge|card|sign.?off|go live|safe to|ok to";

type Kind = "ticket" | "advice_chat" | "advice_comment";
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []));

/** Open tickets, and done ones (not cancelled) in the window: the tickets that are searched and embedded. */
const liveTicket = (since: Date) => sql`(t.system_state <> 'done' or (t.state_changed_at > ${since} and t.outcome is distinct from 'cancelled'))`;

/** The embedding rows to make or refresh: no row for this model, or the text changed. */
async function missingRows(db: Db, companyId: string, e: Embedder, kind: "ticket" | "advice", since: Date, batch: number) {
  const source =
    kind === "ticket"
      ? sql`select 'ticket' as kind, t.id::text as source_id, left(t.title || E'\n' || coalesce(t.body, '') || E'\n' || coalesce(t.state_note, ''), 4000) as text
          from tickets t where t.company_id = ${companyId} and ${liveTicket(since)}`
      : sql`select 'advice_chat' as kind, m.id::text as source_id, left(m.text, 1500) as text
          from owner_chat_messages m join agents a on a.id = m.agent_id and a.role = 'ceo'
          where m.company_id = ${companyId} and m.role = 'assistant' and m.created_at > ${since} and m.text ~* ${ADVICE_FILTER}
        union all
        select 'advice_comment', m.id::text, left(m.text, 1500)
          from ticket_messages m join agents a on a.id = m.agent_id and a.role = 'ceo'
          where m.company_id = ${companyId} and m.author = 'agent' and m.created_at > ${since} and m.text ~* ${ADVICE_FILTER}`;
  return rowsOf<{ kind: Kind; source_id: string; text: string; hash: string }>(
    await db.execute(sql`
      with src as (${source})
      select s.kind, s.source_id, s.text, md5(s.text) as hash from src s
      where not exists (select 1 from meaning_embeddings x where x.kind = s.kind and x.source_id = s.source_id::uuid and x.model = ${e.model} and x.dims = ${e.dims} and x.text_hash = md5(s.text))
      limit ${batch}`),
  );
}

/**
 * Embeds up to `batch` tickets and pieces of CEO advice that have no current embedding (new, edited or for
 * another model), and drops rows that left the window. Returns how many it embedded; 0 when up to date.
 * Throws the provider's error.
 */
export async function embedMissingMeaning(db: Db, companyId: string, e: Embedder, opts: { batch?: number; now?: Date } = {}): Promise<number> {
  const since = new Date((opts.now ?? new Date()).getTime() - TICKET_MEANING_DONE_DAYS * DAY_MS);
  await db.execute(sql`delete from meaning_embeddings x where x.company_id = ${companyId} and x.kind = 'ticket'
    and not exists (select 1 from tickets t where t.id = x.source_id and ${liveTicket(since)})`);
  await db.execute(sql`delete from meaning_embeddings x where x.company_id = ${companyId} and x.kind = 'advice_chat'
    and not exists (select 1 from owner_chat_messages t where t.id = x.source_id and t.created_at > ${since})`);
  await db.execute(sql`delete from meaning_embeddings x where x.company_id = ${companyId} and x.kind = 'advice_comment'
    and not exists (select 1 from ticket_messages t where t.id = x.source_id and t.created_at > ${since})`);
  const batch = opts.batch ?? BATCH;
  const rows = [...(await missingRows(db, companyId, e, "ticket", since, batch)), ...(await missingRows(db, companyId, e, "advice", since, batch))].slice(0, batch);
  if (!rows.length) return 0;
  const vectors = await e.embed(rows.map((r) => redact(r.text)));
  for (const [i, r] of rows.entries()) {
    const row = { companyId, kind: r.kind, sourceId: r.source_id, textHash: r.hash, model: e.model, dims: e.dims, embedding: vectors[i]!, updatedAt: new Date() };
    await db.insert(meaningEmbeddings).values(row).onConflictDoUpdate({ target: [meaningEmbeddings.kind, meaningEmbeddings.sourceId], set: row });
  }
  return rows.length;
}

/** Keeps the embeddings current for every company with the box ticked: each pass embeds what is new or changed, a batch at a time. */
export function ticketMeaningEmbedLoop(db: Db, deps: { companies: () => Promise<string[]>; embedder: (companyId: string) => Promise<Embedder | null>; intervalMs?: number; log?: (m: string) => void }) {
  let busy: Promise<void> | null = null;
  const pass = async () => {
    for (const companyId of await deps.companies()) {
      const e = await deps.embedder(companyId).catch(() => null);
      if (!e) continue;
      try {
        for (let i = 0; i < 20 && (await embedMissingMeaning(db, companyId, e)) > 0; i++);
      } catch (err) {
        deps.log?.(`ticket meaning embeddings: ${(err as Error).message}`);
      }
    }
  };
  const run = () => (busy ??= pass().finally(() => (busy = null)));
  // shortcut: an in-process timer; a restart just starts it again and the next pass catches up.
  const timer = setInterval(() => void run(), deps.intervalMs ?? 120_000);
  timer.unref();
  return { run, stop: () => clearInterval(timer), drain: async () => void (await busy) };
}

export type MeaningTicket = { id: string; ref: string | null; title: string; state: string; merged: boolean; live: boolean; score: number };
export type MeaningAdvice = { kind: "chat" | "comment"; sourceId: string; text: string; at: Date; ticketRef: string | null; score: number };
export type MeaningResult<T> = { ok: true; matches: T[] } | { ok: false; reason: string };
type Deps = { embedder?: (companyId: string) => Promise<Embedder | null>; timeoutMs?: number; now?: Date; floor?: number };

/** The query's vector with this company's embedder, or why there isn't one (off, no key, provider down, too slow). */
async function queryVector(companyId: string, text: string, deps: Deps): Promise<{ e: Embedder; v: number[] } | { reason: string }> {
  try {
    const e = (await deps.embedder?.(companyId)) ?? null;
    if (!e) return { reason: "off" };
    const v = (await e.embed([redact(text).slice(0, 2000)], deps.timeoutMs ?? TICKET_MEANING_TIMEOUT_MS))[0];
    return v ? { e, v } : { reason: "the provider sent no vector" };
  } catch (err) {
    return { reason: (err as Error).message };
  }
}

async function ticketsNear(db: Db, companyId: string, q: { e: Embedder; v: number[] }, deps: Deps, limit: number): Promise<MeaningTicket[]> {
  const since = new Date((deps.now ?? new Date()).getTime() - TICKET_MEANING_DONE_DAYS * DAY_MS);
  const dist = cosineDistance(meaningEmbeddings.embedding, q.v);
  const rows = await db
    .select({ id: tickets.id, number: tickets.number, prefix: companies.ticketPrefix, title: tickets.title, state: tickets.systemState, outcome: tickets.outcome, mergedAt: tickets.mergedAt, liveAt: tickets.liveAt, liveMarkedAt: tickets.liveMarkedAt, d: dist })
    .from(meaningEmbeddings)
    .innerJoin(tickets, eq(tickets.id, meaningEmbeddings.sourceId))
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(
      and(
        eq(meaningEmbeddings.companyId, companyId),
        eq(meaningEmbeddings.kind, "ticket"),
        eq(meaningEmbeddings.model, q.e.model),
        eq(meaningEmbeddings.dims, q.e.dims),
        sql`(${tickets.systemState} <> 'done' or (${tickets.stateChangedAt} > ${since} and ${tickets.outcome} is distinct from 'cancelled'))`,
      ),
    )
    .orderBy(dist)
    .limit(NEAREST);
  const floor = deps.floor ?? TICKET_MEANING_FLOOR;
  return rows
    .map((r) => ({ id: r.id, ref: ticketRef(r.prefix, r.number), title: r.title, state: r.state, merged: !!r.mergedAt, live: !!(r.liveAt ?? r.liveMarkedAt), score: 1 - Number(r.d) }))
    .filter((r) => r.score >= floor)
    .slice(0, limit);
}

async function adviceNear(db: Db, companyId: string, q: { e: Embedder; v: number[] }, deps: Deps, limit: number): Promise<MeaningAdvice[]> {
  const since = new Date((deps.now ?? new Date()).getTime() - TICKET_MEANING_DONE_DAYS * DAY_MS);
  const dist = cosineDistance(meaningEmbeddings.embedding, q.v);
  const near = await db
    .select({ kind: meaningEmbeddings.kind, sourceId: meaningEmbeddings.sourceId, d: dist })
    .from(meaningEmbeddings)
    .where(and(eq(meaningEmbeddings.companyId, companyId), inArray(meaningEmbeddings.kind, ["advice_chat", "advice_comment"]), eq(meaningEmbeddings.model, q.e.model), eq(meaningEmbeddings.dims, q.e.dims)))
    .orderBy(dist)
    .limit(NEAREST);
  const floor = deps.floor ?? TICKET_MEANING_FLOOR;
  const kept = near.map((n) => ({ ...n, score: 1 - Number(n.d) })).filter((n) => n.score >= floor);
  const chatIds = kept.filter((n) => n.kind === "advice_chat").map((n) => n.sourceId);
  const commentIds = kept.filter((n) => n.kind === "advice_comment").map((n) => n.sourceId);
  const chats = chatIds.length ? await db.select({ id: ownerChatMessages.id, text: ownerChatMessages.text, at: ownerChatMessages.createdAt }).from(ownerChatMessages).where(and(inArray(ownerChatMessages.id, chatIds), sql`${ownerChatMessages.createdAt} > ${since}`)) : [];
  const comments = commentIds.length
    ? await db
        .select({ id: ticketMessages.id, text: ticketMessages.text, at: ticketMessages.createdAt, number: tickets.number, prefix: companies.ticketPrefix })
        .from(ticketMessages)
        .innerJoin(tickets, eq(tickets.id, ticketMessages.ticketId))
        .innerJoin(companies, eq(companies.id, tickets.companyId))
        .where(and(inArray(ticketMessages.id, commentIds), sql`${ticketMessages.createdAt} > ${since}`))
    : [];
  const out: MeaningAdvice[] = [];
  for (const n of kept) {
    const c = chats.find((x) => x.id === n.sourceId);
    const m = comments.find((x) => x.id === n.sourceId);
    if (n.kind === "advice_chat" && c) out.push({ kind: "chat", sourceId: c.id, text: stripCodeNotes(c.text), at: c.at, ticketRef: null, score: n.score });
    if (n.kind === "advice_comment" && m) out.push({ kind: "comment", sourceId: m.id, text: m.text, at: m.at, ticketRef: ticketRef(m.prefix, m.number), score: n.score });
  }
  return out.slice(0, limit);
}

/** Tickets (open, and done in the last 30 days) close in meaning to `text`, best first. Never throws: {ok:false} means use word search alone. */
export async function ticketMeaningSearch(db: Db, companyId: string, text: string, deps: Deps & { limit?: number; excludeIds?: readonly string[] } = {}): Promise<MeaningResult<MeaningTicket>> {
  const q = await queryVector(companyId, text, deps);
  if ("reason" in q) return { ok: false, reason: q.reason };
  try {
    const skip = new Set(deps.excludeIds ?? []);
    return { ok: true, matches: (await ticketsNear(db, companyId, q, deps, (deps.limit ?? 3) + skip.size)).filter((t) => !skip.has(t.id)).slice(0, deps.limit ?? 3) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

const clip = (s: string, n: number) => {
  const t = redact(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const pct = (n: number) => `${Math.round(n * 100)}%`;
const stateWords = (t: MeaningTicket) => [t.state, t.merged ? "merged" : null, t.live ? "live" : null].filter(Boolean).join(", ");

/** One line per meaning match, for a create_ticket refusal. */
export function describeMeaningTicket(t: MeaningTicket): string {
  return `- ${t.ref ?? t.id} "${t.title}" (${stateWords(t)}); same idea in other words, ${pct(t.score)} match by meaning`;
}

/** A line to add to a create_feature answer: tickets that may already deliver it, found by meaning. Empty when off, failing or nothing close. */
export async function relatedTicketsNote(db: Db, companyId: string, text: string, deps: Deps): Promise<string> {
  const r = await ticketMeaningSearch(db, companyId, text, { ...deps, limit: 3 });
  return r.ok && r.matches.length ? `\nTickets that may already cover this (same idea in other words; check before building it again):\n${r.matches.map(describeMeaningTicket).join("\n")}` : "";
}

const MATCH_LINES = 5;
/**
 * The CEO brief's block: the closest tickets, wiki sections and the CEO's earlier go-aheads to what the owner just wrote,
 * above the relevance floor, at most five lines. Empty when the box is off or the provider fails (the brief is then unchanged).
 */
export async function meaningBriefLines(db: Db, companyId: string, ownerText: string, deps: Deps & { wiki?: (companyId: string, q: string) => Promise<Array<SemanticHit & { score?: number }> | null> }): Promise<string[]> {
  if (!ownerText.trim()) return [];
  const q = await queryVector(companyId, ownerText, deps);
  if ("reason" in q) return [];
  const floor = deps.floor ?? TICKET_MEANING_FLOOR;
  const found: Array<{ score: number; line: string }> = [];
  try {
    for (const t of await ticketsNear(db, companyId, q, deps, 5)) found.push({ score: t.score, line: `- ticket ${t.ref ?? t.id} "${clip(t.title, 120)}" (${stateWords(t)}), ${pct(t.score)}` });
    for (const a of await adviceNear(db, companyId, q, deps, 3)) found.push({ score: a.score, line: `- your own earlier advice${a.ticketRef ? ` on ${a.ticketRef}` : " in chat"}, ${a.at.toISOString().slice(0, 10)}: "${clip(a.text, 200)}" (${pct(a.score)}). Check it still holds before repeating it.` });
    const wiki = await Promise.race([deps.wiki?.(companyId, ownerText) ?? null, new Promise<null>((r) => setTimeout(() => r(null), deps.timeoutMs ?? TICKET_MEANING_TIMEOUT_MS).unref())]).catch(() => null);
    for (const w of wiki ?? []) if ((w.score ?? 0) >= floor) found.push({ score: w.score!, line: `- wiki page ${w.slug} (${clip(w.path, 80)}), ${pct(w.score!)}: ${clip(w.snippet, 140)}` });
  } catch {
    return [];
  }
  const top = found.sort((a, b) => b.score - a.score).slice(0, MATCH_LINES);
  return top.length ? ["", "## Possible matches by meaning (tickets, wiki pages and your own earlier advice close to what the owner just wrote; look them up before creating or promising anything)", ...top.map((f) => f.line)] : [];
}
