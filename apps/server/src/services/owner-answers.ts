// Owner-answer memory (BOS-1593): one search over everything the owner has already answered or told
// the team, so an agent (and the duplicate-ask check) can find "has the owner already decided X?"
// before asking again. Nothing is copied: the search runs over the sources themselves (answered
// cards, the owner's ticket messages, the owner's chat messages and the agents' lasting notes), so
// there is no second record to drift from the first.
//
// Word search is Postgres full text and always on. It ORs the question's stemmed words (an AND
// query misses a short question asked in other words) and scores each hit by how many of them it
// shares, the same overlap rule as similarQuestion but on stems, so "going public" meets "go public".
import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, tickets } from "../db/schema.js";
import { decisionTicketIds } from "./stale-requests.js";

export type OwnerAnswerKind = "card" | "ticket_reply" | "chat" | "note";
export const OWNER_ANSWER_KINDS: readonly OwnerAnswerKind[] = ["card", "ticket_reply", "chat", "note"];

export type OwnerAnswerHit = {
  kind: OwnerAnswerKind;
  /** The card, message or note id. */
  sourceId: string;
  /** What was asked: the card's question, the agent's chat line just before the owner's, or a note's title. Null for a ticket message. */
  question: string | null;
  /** What the owner said: the card's answer, the message, or the note's quote of the owner. */
  answer: string;
  /** The owner's note on a card answer, or a note's text. */
  ownerNote: string | null;
  ticketId: string | null;
  ticketRef: string | null;
  at: Date;
  /** 0..1: the share of the ask's words the hit has anywhere (words), or the cosine similarity (meaning). */
  score: number;
  /**
   * 0..1: for a card or a note, how close its own question (title) is to the ask, by the smaller word
   * count (the similarQuestion rule), so a long answer that happens to use the same words doesn't pass
   * for the same question. 0 for messages.
   */
  sameQuestion: number;
  method: "words" | "meaning";
};

/** A card answer posted on its tickets (decisions.ts postAnswerOnTickets) is the card again, not a new owner message. */
const MIRRORED_ANSWER = /^The (owner|CEO) answered your card on this ticket:/;

type Row = {
  kind: OwnerAnswerKind;
  source_id: string;
  question: string | null;
  answer: string;
  owner_note: string | null;
  ticket_id: string | null;
  at: Date | string;
  shared: number;
  size: number;
  q_shared: number | null;
  q_size: number | null;
  rank: number;
};

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []));

/** The stemmed, stop-word-free words of a text, as Postgres full text sees them. */
export async function stems(db: Db, text: string): Promise<string[]> {
  const [r] = rowsOf<{ lex: string[] | null }>(await db.execute(sql`select tsvector_to_array(to_tsvector('english', ${text})) as lex`));
  return r?.lex ?? [];
}

/**
 * Everything the owner has answered or said that shares words with `q`, best first. Only the owner's
 * own answers count: a card the CEO settled for the owner is left out.
 */
export async function searchOwnerAnswers(
  db: Db,
  input: { companyId: string; q: string; since?: Date; kinds?: readonly OwnerAnswerKind[]; limit?: number; minScore?: number },
): Promise<OwnerAnswerHit[]> {
  const lex = await stems(db, input.q);
  if (!lex.length) return [];
  const kinds = new Set(input.kinds?.length ? input.kinds : OWNER_ANSWER_KINDS);
  const since = input.since ?? new Date(0);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const c = input.companyId;
  const parts = [];
  if (kinds.has("card"))
    parts.push(sql`
      select 'card' as kind, d.id::text as source_id, d.question, d.answer, d.context ->> 'answerNote' as owner_note,
        d.context ->> 'ticketId' as ticket_id, d.answered_at as at,
        to_tsvector('english', d.question || ' ' || d.answer || ' ' || coalesce(d.context ->> 'answerNote', '')) as v,
        to_tsvector('english', d.question) as qv
      from decisions d
      where d.company_id = ${c} and d.status = 'answered' and d.answer is not null and d.answered_at > ${since}
        and (d.context -> 'settled') is null`);
  if (kinds.has("ticket_reply"))
    parts.push(sql`
      select 'ticket_reply', m.id::text, null::text, m.text, null::text, m.ticket_id::text, m.created_at,
        to_tsvector('english', m.text), null::tsvector
      from ticket_messages m
      where m.company_id = ${c} and m.author = 'owner' and m.created_at > ${since}
        and m.text !~ ${MIRRORED_ANSWER.source}`);
  if (kinds.has("chat"))
    parts.push(sql`
      select 'chat', o.id::text,
        (select p.text from owner_chat_messages p
          where p.company_id = o.company_id and p.agent_id is not distinct from o.agent_id and p.role = 'assistant' and p.created_at < o.created_at
          order by p.created_at desc limit 1),
        o.text, null::text, null::text, o.created_at, to_tsvector('english', o.text), null::tsvector
      from owner_chat_messages o
      where o.company_id = ${c} and o.role = 'owner' and o.created_at > ${since}`);
  if (kinds.has("note"))
    parts.push(sql`
      select 'note', n.id::text, n.title, n.why, n.text, n.ticket_id::text, n.created_at,
        to_tsvector('english', n.title || ' ' || n.text || ' ' || n.why), to_tsvector('english', n.title)
      from agent_notes n
      where n.company_id = ${c} and n.created_at > ${since}`);
  if (!parts.length) return [];

  const lexArray = sql`${`{${lex.map((l) => `"${l.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`}::text[]`;
  const res = await db.execute(sql`
    with q as (
      select ${lexArray} as lex,
        to_tsquery('simple', (select string_agg(quote_literal(l), ' | ') from unnest(${lexArray}) l)) as tq
    ),
    src (kind, source_id, question, answer, owner_note, ticket_id, at, v, qv) as (${sql.join(parts, sql` union all `)})
    select s.kind, s.source_id, s.question, s.answer, s.owner_note, s.ticket_id, s.at,
      cardinality(array(select unnest(tsvector_to_array(s.v)) intersect select unnest(q.lex))) as shared,
      cardinality(tsvector_to_array(s.v)) as size,
      case when s.qv is null then null else cardinality(array(select unnest(tsvector_to_array(s.qv)) intersect select unnest(q.lex))) end as q_shared,
      case when s.qv is null then null else cardinality(tsvector_to_array(s.qv)) end as q_size,
      ts_rank_cd(s.v, q.tq) as rank
    from src s, q
    where s.v @@ q.tq
    order by shared desc, rank desc, s.at desc
    limit 200`);

  const n = lex.length;
  const hits: OwnerAnswerHit[] = rowsOf<Row>(res).map((r) => {
    // A card or a note has its own question: compare like with like, by the smaller (similarQuestion's rule).
    const sameQuestion = r.q_size ? Number(r.q_shared ?? 0) / Math.min(n, Number(r.q_size)) : 0;
    const cover = Number(r.shared) / n;
    return {
      kind: r.kind,
      sourceId: r.source_id,
      question: r.question,
      answer: r.answer,
      ownerNote: r.owner_note,
      ticketId: r.ticket_id,
      ticketRef: null,
      at: new Date(r.at),
      score: Math.min(1, cover),
      sameQuestion: Math.min(1, sameQuestion),
      method: "words" as const,
    };
  });
  hits.sort((a, b) => b.sameQuestion - a.sameQuestion || b.score - a.score || b.at.getTime() - a.at.getTime());
  const min = input.minScore ?? 0;
  return withTicketRefs(db, hits.filter((h) => Math.max(h.score, h.sameQuestion) >= min).slice(0, limit));
}

/**
 * Whether a hit is the owner having already answered this ask, so a new card is refused. A card
 * whose own question matches (the similarQuestion bar) is; so is a ticket or chat message or a note
 * that contains nearly every word of the ask. A weaker hit is shown to the asker, not refused.
 */
export const REPEAT_SAME_QUESTION = 0.6;
export const REPEAT_COVER = 0.85;
export function isRepeat(h: OwnerAnswerHit): boolean {
  if (h.method === "meaning") return h.score >= REPEAT_MEANING;
  if (h.sameQuestion >= REPEAT_SAME_QUESTION) return true;
  return h.kind !== "card" && h.score >= REPEAT_COVER;
}
/** Cosine similarity at or above which a meaning match counts as the same ask (set from the BOS-1593 study). */
export const REPEAT_MEANING = 0.85;

/** Fills each hit's ticket and its reference (BOS-976): a card's ticket comes from what it was about. */
async function withTicketRefs(db: Db, hits: OwnerAnswerHit[]): Promise<OwnerAnswerHit[]> {
  for (const h of hits) {
    if (h.kind !== "card" || h.ticketId) continue;
    const [d] = await db.select({ id: decisions.id, context: decisions.context }).from(decisions).where(eq(decisions.id, h.sourceId));
    if (d) h.ticketId = (await decisionTicketIds(db, d))[0] ?? null;
  }
  const ids = [...new Set(hits.map((h) => h.ticketId).filter((x): x is string => !!x))];
  if (!ids.length) return hits;
  const rows = await db
    .select({ id: tickets.id, number: tickets.number, prefix: companies.ticketPrefix })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(and(inArray(tickets.id, ids)));
  const refs = new Map(rows.map((r) => [r.id, ticketRef(r.prefix, r.number)]));
  for (const h of hits) h.ticketRef = h.ticketId ? (refs.get(h.ticketId) ?? null) : null;
  return hits;
}

const KIND_LABEL: Record<OwnerAnswerKind, string> = { card: "card", ticket_reply: "ticket message", chat: "chat", note: "lasting note" };
const day = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One line per hit, for a tool result or a refusal. */
export function describeOwnerAnswer(h: OwnerAnswerHit): string {
  const where = `${KIND_LABEL[h.kind]} ${h.sourceId.slice(0, 8)}${h.ticketRef ? ` on ${h.ticketRef}` : ""}, ${day(h.at)} UTC`;
  const asked = h.question ? ` Asked: "${clip(h.question, 160)}".` : "";
  const note = h.ownerNote && h.kind === "card" ? ` Owner's note: "${clip(h.ownerNote, 200)}".` : h.ownerNote && h.kind === "note" ? ` Note: "${clip(h.ownerNote, 200)}".` : "";
  const match = h.method === "meaning" ? `meaning match ${Math.round(h.score * 100)}%` : `${Math.round(Math.max(h.score, h.sameQuestion) * 100)}% of the words`;
  return `- [${where}; ${match}]${asked} Owner: "${clip(h.answer, 300)}".${note}`;
}
