// Owner-answer memory (BOS-1593): one search over everything the owner has already answered or told
// the team, so an agent (and the duplicate-ask check) can find "has the owner already decided X?"
// before asking again. Nothing is copied: the search runs over the sources themselves (answered
// cards, the owner's ticket messages, the owner's chat messages and the agents' lasting notes), so
// there is no second record to drift from the first.
//
// Word search is Postgres full text and always on. It ORs the question's stemmed words (an AND
// query misses a short question asked in other words) and scores each hit by how many of them it
// shares, the same overlap rule as similarQuestion but on stems, so "going public" meets "go public".
//
// Meaning search (embeddings) is opt-in per company and reuses the wiki's provider settings; it only
// adds hits and never stands alone, so a slow or failing provider leaves word search answering.
import { and, cosineDistance, eq, inArray, sql } from "drizzle-orm";
import { redact, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, ownerAnswerEmbeddings, tickets } from "../db/schema.js";
import { ANSWERED_LOOKBACK_MS, answeredBefore, answerHoldsAsFact, decisionTicketIds, quotedAnswer } from "./stale-requests.js";
import { PA_BRIEF_START } from "./pa.js";
import type { Embedder } from "./wiki-semantic.js";

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
  /** 0..1: the share of the ask's stemmed words the hit has anywhere (for a chat hit, with the agent's line before it). */
  score: number;
  /** 0..1: the same share, counting only the owner's own words (differs from score for chat hits). */
  ownerWords: number;
  /**
   * 0..1: for a card or a note, how close its own question (title) is to the ask, by the smaller word
   * count (the similarQuestion rule), so a long answer that happens to use the same words doesn't pass
   * for the same question. 0 for messages.
   */
  sameQuestion: number;
  /** Cosine similarity from meaning search, when it is on and found this hit; else null. */
  meaning: number | null;
  /** Which search found it. */
  method: "words" | "meaning" | "both";
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
  a_shared: number;
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
 * The owner's answers as one row set (kind, source_id, question, answer, owner_note, ticket_id, at, v, qv):
 * v is the full text searched, qv the card's question or note's title alone. Only the owner's own answers:
 * a card the CEO settled for the owner, and a card answer echoed onto its tickets, are left out. So are
 * the PA's escalation brief copied into the CEO's thread as an owner line (its "What the PA found" is the
 * PA model's words, read from wiki and ticket text) and a note kept at an agent's request (its why is
 * that agent's reason): neither is the owner's own words (security review, BOS-1593).
 */
function ownerAnswerSources(c: string, since: Date, kinds: ReadonlySet<OwnerAnswerKind>) {
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
  // A chat answer is searched together with the agent's line before it, as the owner often answers
  // "here it is" (13 Nov, issue 147). That line can be a long reply, so it is never compared as the
  // question (qv null): a chat hit is refused only when the owner's own words cover the ask.
  if (kinds.has("chat"))
    parts.push(sql`
      select 'chat', c.id, c.prev, c.text, null::text, null::text, c.at,
        to_tsvector('english', coalesce(c.prev, '') || ' ' || c.text), null::tsvector
      from (
        select o.id::text as id, o.text, o.created_at as at,
          (select p.text from owner_chat_messages p
            where p.company_id = o.company_id and p.agent_id is not distinct from o.agent_id and p.role = 'assistant' and p.created_at < o.created_at
            order by p.created_at desc limit 1) as prev
        from owner_chat_messages o
        where o.company_id = ${c} and o.role = 'owner' and o.created_at > ${since}
          and not exists (select 1 from pa_answers pa where pa.ceo_message_id = o.id)
          and o.text not like ${`${PA_BRIEF_START}%`}
      ) c`);
  if (kinds.has("note"))
    parts.push(sql`
      select 'note', n.id::text, n.title, n.why, n.text, n.ticket_id::text, n.created_at,
        to_tsvector('english', n.title || ' ' || n.text || ' ' || n.why), to_tsvector('english', n.title)
      from agent_notes n
      where n.company_id = ${c} and n.created_at > ${since} and n.source in ('chat', 'ticket', 'owner')`);
  return parts.length ? sql`src (kind, source_id, question, answer, owner_note, ticket_id, at, v, qv) as (${sql.join(parts, sql` union all `)})` : null;
}

const lexArrayOf = (lex: string[]) => sql`${`{${lex.map((l) => `"${l.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`}::text[]`;

/** Rows of `src` scored against the ask's stems; `where` picks the rows (a word match, or named ids). */
async function scoredRows(db: Db, src: ReturnType<typeof sql>, lex: string[], where: "words" | string[]): Promise<Row[]> {
  const lexArray = lexArrayOf(lex);
  const filter = where === "words" ? sql`s.v @@ q.tq` : sql`s.source_id = any(${`{${where.join(",")}}`}::text[])`;
  return rowsOf<Row>(
    await db.execute(sql`
    with q as (
      select ${lexArray} as lex,
        to_tsquery('simple', (select string_agg(quote_literal(l), ' | ') from unnest(${lexArray}) l)) as tq
    ),
    ${src}
    select s.kind, s.source_id, s.question, s.answer, s.owner_note, s.ticket_id, s.at,
      cardinality(array(select unnest(tsvector_to_array(s.v)) intersect select unnest(q.lex))) as shared,
      cardinality(tsvector_to_array(s.v)) as size,
      cardinality(array(select unnest(tsvector_to_array(to_tsvector('english', s.answer))) intersect select unnest(q.lex))) as a_shared,
      case when s.qv is null then null else cardinality(array(select unnest(tsvector_to_array(s.qv)) intersect select unnest(q.lex))) end as q_shared,
      case when s.qv is null then null else cardinality(tsvector_to_array(s.qv)) end as q_size
    from src s, q
    where ${filter}
    order by shared desc, ts_rank_cd(s.v, q.tq) desc nulls last, s.at desc
    limit 200`),
  );
}

function hitOf(r: Row, n: number): OwnerAnswerHit {
  // A card or a note has its own question: compare like with like, by the smaller (similarQuestion's rule).
  const sameQuestion = n && r.q_size ? Number(r.q_shared ?? 0) / Math.min(n, Number(r.q_size)) : 0;
  const cover = n ? Number(r.shared) / n : 0;
  // A chat hit's text includes the agent's line before it; only the owner's own words count towards a refusal.
  const ownerWords = n ? Number(r.kind === "chat" ? r.a_shared : r.shared) / n : 0;
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
    ownerWords: Math.min(1, ownerWords),
    sameQuestion: Math.min(1, sameQuestion),
    meaning: null,
    method: "words",
  };
}

const best = (a: OwnerAnswerHit, b: OwnerAnswerHit) =>
  Number(isRepeat(b)) - Number(isRepeat(a)) || b.sameQuestion - a.sameQuestion || (b.meaning ?? 0) - (a.meaning ?? 0) || b.score - a.score || b.at.getTime() - a.at.getTime();

type SearchInput = { companyId: string; q: string; since?: Date; kinds?: readonly OwnerAnswerKind[]; limit?: number; minScore?: number };

/** Everything the owner has answered or said that shares words with `q`, best first (word search only). */
export async function searchOwnerAnswers(db: Db, input: SearchInput): Promise<OwnerAnswerHit[]> {
  const lex = await stems(db, input.q);
  if (!lex.length) return [];
  const src = ownerAnswerSources(input.companyId, input.since ?? new Date(0), new Set(input.kinds?.length ? input.kinds : OWNER_ANSWER_KINDS));
  if (!src) return [];
  const hits = (await scoredRows(db, src, lex, "words")).map((r) => hitOf(r, lex.length)).sort(best);
  const min = input.minScore ?? 0;
  return withTicketRefs(db, hits.filter((h) => Math.max(h.score, h.sameQuestion) >= min).slice(0, Math.min(Math.max(input.limit ?? 10, 1), 50)));
}

/** How long a meaning search waits for the provider before it answers with word search alone. */
export const MEANING_TIMEOUT_MS = 3000;
/** Nearest owner answers by meaning that are considered at all (cosine similarity). */
const MEANING_FLOOR = 0.5;

export type OwnerAnswerSearch = {
  hits: OwnerAnswerHit[];
  /** off: not switched on for this company; used; or why it couldn't be used (word search answered alone). */
  meaning: "off" | "used" | { unavailable: string };
};

/**
 * Word search, plus meaning search when the company has switched it on (Settings, off by default). Any
 * provider failure, a timeout or a missing key leaves word search to answer alone, and says so.
 */
export async function ownerAnswerSearch(db: Db, input: SearchInput, deps: { embedder?: (companyId: string) => Promise<Embedder | null>; timeoutMs?: number } = {}): Promise<OwnerAnswerSearch> {
  const words = await searchOwnerAnswers(db, { ...input, limit: 50 });
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const done = async (hits: OwnerAnswerHit[], meaning: OwnerAnswerSearch["meaning"]) => ({ hits: hits.sort(best).slice(0, limit), meaning });
  let e: Embedder | null = null;
  try {
    e = (await deps.embedder?.(input.companyId)) ?? null;
  } catch (err) {
    return done(words, { unavailable: (err as Error).message });
  }
  if (!e) return done(words, "off");
  let qv: number[];
  try {
    qv = (await e.embed([input.q], deps.timeoutMs ?? MEANING_TIMEOUT_MS))[0]!;
  } catch (err) {
    return done(words, { unavailable: (err as Error).message });
  }
  const dist = cosineDistance(ownerAnswerEmbeddings.embedding, qv);
  const near = await db
    .select({ sourceId: ownerAnswerEmbeddings.sourceId, d: dist })
    .from(ownerAnswerEmbeddings)
    .where(and(eq(ownerAnswerEmbeddings.companyId, input.companyId), eq(ownerAnswerEmbeddings.model, e.model), eq(ownerAnswerEmbeddings.dims, e.dims)))
    .orderBy(dist)
    .limit(20);
  const sim = new Map(near.map((n) => [n.sourceId, 1 - Number(n.d)] as const).filter(([, s]) => s >= MEANING_FLOOR));
  const byId = new Map(words.map((h) => [h.sourceId, h]));
  for (const [id, s] of sim) {
    const h = byId.get(id);
    if (h) (h.meaning = s), (h.method = "both");
  }
  const extra = [...sim.keys()].filter((id) => !byId.has(id));
  if (extra.length) {
    const src = ownerAnswerSources(input.companyId, input.since ?? new Date(0), new Set(input.kinds?.length ? input.kinds : OWNER_ANSWER_KINDS));
    const lex = await stems(db, input.q);
    const rows = src ? await scoredRows(db, src, lex, extra) : [];
    const more = rows.map((r) => ({ ...hitOf(r, lex.length), meaning: sim.get(r.source_id) ?? null, method: "meaning" as const }));
    words.push(...(await withTicketRefs(db, more)));
  }
  return done(words, "used");
}

/** The text a source is embedded from: what was asked, then what the owner said. */
function embedText(r: { kind: string; question: string | null; answer: string; owner_note: string | null }) {
  const parts = r.kind === "card" ? [r.question, `Owner: ${r.answer}`, r.owner_note] : r.kind === "chat" ? [r.question, `Owner: ${r.answer}`] : r.kind === "note" ? [r.question, r.owner_note, r.answer] : [r.answer];
  return redact(parts.filter(Boolean).join("\n")).slice(0, 4000);
}

/**
 * Embeds up to `batch` owner answers that have no embedding for the current model yet, newest first.
 * Returns how many it embedded; 0 when everything is up to date. Throws the provider's error.
 */
export async function embedMissingOwnerAnswers(db: Db, companyId: string, e: Embedder, batch = 64): Promise<number> {
  const src = ownerAnswerSources(companyId, new Date(0), new Set(OWNER_ANSWER_KINDS));
  if (!src) return 0;
  const rows = rowsOf<{ kind: OwnerAnswerKind; source_id: string; question: string | null; answer: string; owner_note: string | null }>(
    await db.execute(sql`
      with ${src}
      select s.kind, s.source_id, s.question, s.answer, s.owner_note from src s
      where not exists (select 1 from owner_answer_embeddings x where x.kind = s.kind and x.source_id = s.source_id::uuid and x.model = ${e.model} and x.dims = ${e.dims})
      order by s.at desc
      limit ${batch}`),
  );
  if (!rows.length) return 0;
  const vectors = await e.embed(rows.map(embedText));
  for (const [i, r] of rows.entries()) {
    const row = { companyId, kind: r.kind, sourceId: r.source_id, model: e.model, dims: e.dims, embedding: vectors[i]!, updatedAt: new Date() };
    await db.insert(ownerAnswerEmbeddings).values(row).onConflictDoUpdate({ target: [ownerAnswerEmbeddings.kind, ownerAnswerEmbeddings.sourceId], set: row });
  }
  return rows.length;
}

/**
 * Keeps owner-answer embeddings current for every company that has meaning search on: every
 * `intervalMs` it embeds what is new since the last pass, a batch at a time. Word search covers the
 * minutes between an answer and its embedding. Errors are logged by the embedder and retried next pass.
 */
export function ownerAnswerEmbedLoop(db: Db, deps: { companies: () => Promise<string[]>; embedder: (companyId: string) => Promise<Embedder | null>; intervalMs?: number; log?: (m: string) => void }) {
  let busy: Promise<void> | null = null;
  const pass = async () => {
    for (const companyId of await deps.companies()) {
      const e = await deps.embedder(companyId).catch(() => null);
      if (!e) continue;
      try {
        for (let i = 0; i < 20 && (await embedMissingOwnerAnswers(db, companyId, e)) > 0; i++);
      } catch (err) {
        deps.log?.(`owner-answer embeddings: ${(err as Error).message}`);
      }
    }
  };
  const run = () => (busy ??= pass().finally(() => (busy = null)));
  // shortcut: an in-process timer; a restart just starts it again and the next pass catches up.
  const timer = setInterval(() => void run(), deps.intervalMs ?? 120_000);
  timer.unref();
  return { run, stop: () => clearInterval(timer), drain: async () => void (await busy) };
}

/**
 * Whether a hit is the owner having already answered this ask, so a new card is refused. A card
 * whose own question matches (the similarQuestion bar) is; so is a ticket or chat message or a note
 * that contains nearly every word of the ask; so is a meaning match above REPEAT_MEANING. A weaker
 * hit is shown to the asker, not refused.
 */
export const REPEAT_SAME_QUESTION = 0.6;
export const REPEAT_COVER = 0.85;
export function isRepeat(h: OwnerAnswerHit): boolean {
  if ((h.meaning ?? 0) >= REPEAT_MEANING) return true;
  if (h.sameQuestion >= REPEAT_SAME_QUESTION) return true;
  return h.kind !== "card" && h.ownerWords >= REPEAT_COVER;
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
/** Every quote shown to an agent goes through here, so a token the owner pasted into chat is redacted first. */
const clip = (s: string, n: number) => {
  const t = redact(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One line per hit, for a tool result or a refusal. */
export function describeOwnerAnswer(h: OwnerAnswerHit): string {
  const where = `${KIND_LABEL[h.kind]} ${h.sourceId.slice(0, 8)}${h.ticketRef ? ` on ${h.ticketRef}` : ""}, ${day(h.at)} UTC`;
  const asked = h.question ? ` Asked: "${clip(h.question, 160)}".` : "";
  const note = h.ownerNote && h.kind === "card" ? ` Owner's note: "${clip(h.ownerNote, 200)}".` : h.ownerNote && h.kind === "note" ? ` Note: "${clip(h.ownerNote, 200)}".` : "";
  const words = `${Math.round(Math.max(h.score, h.sameQuestion) * 100)}% of the words`;
  const match = h.meaning === null ? words : `meaning ${Math.round(h.meaning * 100)}%${h.method === "both" ? `, ${words}` : ""}`;
  return `- [${where}; ${match}]${asked} Owner: "${clip(h.answer, 300)}".${note}`;
}

export type OwnerAskCheck = {
  /** The owner already answered this: a quoted reading of that answer, and the ask is refused unless stillNeeded says why it no longer holds. */
  refusal: string | null;
  /** Earlier owner answers close to the ask but not counted as the same one: shown to the asker, not refused. */
  related: OwnerAnswerHit[];
  /** Answered owner step cards with nearly the same ask (R34): a warning to check the live state first, never a refusal. */
  doneSteps?: OwnerAnswerHit[];
  /** Whether meaning search took part, and why not when it couldn't. */
  meaning: OwnerAnswerSearch["meaning"];
};

/**
 * The duplicate-ask check every new owner card and "needs you" notice runs (BOS-123, BOS-1591, BOS-1593).
 * First the card check (answeredBefore: this ticket and its blockers, then any owner-answered question in
 * the company in the last 30 days); then the owner-answer search over the same 30 days, so an answer the
 * owner gave in chat, in a ticket message, in a correction kept as a note, or (meaning search on) in other
 * words also stops the repeat. Only an answer that stays true counts for a card (answerHoldsAsFact).
 */
export async function checkOwnerAsk(
  db: Db,
  input: { companyId: string; ticketId?: string | null; question: string },
  deps: { embedder?: (companyId: string) => Promise<Embedder | null>; timeoutMs?: number } = {},
): Promise<OwnerAskCheck> {
  const card = await answeredBefore(db, input);
  if (card) return { refusal: quotedAnswer(card), related: [], meaning: "off" };
  const since = new Date(Date.now() - ANSWERED_LOOKBACK_MS);
  const { hits, meaning } = await ownerAnswerSearch(db, { companyId: input.companyId, q: input.question, since, limit: 10 }, deps);
  const cardIds = hits.filter((h) => h.kind === "card").map((h) => h.sourceId);
  const ctxs = cardIds.length ? await db.select({ id: decisions.id, context: decisions.context }).from(decisions).where(inArray(decisions.id, cardIds)) : [];
  const fact = new Map(
    ctxs.map((d) => {
      const c = (d.context as { type?: string; settled?: unknown; plan?: boolean; ownerMustDo?: boolean; steps?: unknown[] } | null) ?? {};
      return [d.id, c.type === "question" && answerHoldsAsFact(c)] as const;
    }),
  );
  const counts = (h: OwnerAnswerHit) => h.kind !== "card" || fact.get(h.sourceId) === true;
  const repeat = hits.find((h) => isRepeat(h) && counts(h));
  const related = hits.filter((h) => h !== repeat && counts(h) && Math.max(h.score, h.sameQuestion, h.meaning ?? 0) >= 0.5).slice(0, 3);
  // R34 (BOS-1670): an answered step card is never a refusal (a step can need redoing), but the raiser is shown it,
  // so the ask isn't made without checking the live state first.
  const stepIds = new Set(
    ctxs
      .filter((d) => {
        const c = (d.context as { settled?: unknown; plan?: boolean; ownerMustDo?: boolean; steps?: unknown[] } | null) ?? {};
        return !c.settled && !c.plan && (c.ownerMustDo === true || !!c.steps?.length);
      })
      .map((d) => d.id),
  );
  const doneSteps = hits.filter((h) => h.kind === "card" && stepIds.has(h.sourceId) && Math.max(h.sameQuestion, h.meaning ?? 0) >= REPEAT_SAME_QUESTION).slice(0, 3);
  if (!repeat) return { refusal: null, related, doneSteps, meaning };
  const what = repeat.question ? `"${clip(repeat.question, 160)}"` : "this";
  const where = `${KIND_LABEL[repeat.kind]} ${repeat.sourceId}${repeat.ticketRef ? ` on ${repeat.ticketRef}` : ""}`;
  const said = repeat.kind === "note" && repeat.ownerNote ? `${clip(repeat.ownerNote, 300)} (${clip(repeat.answer, 200)})` : clip(repeat.answer, 300);
  const note = repeat.kind === "card" && repeat.ownerNote ? `; their note: "${clip(repeat.ownerNote, 200)}"` : "";
  return { refusal: `The owner already answered ${what} (${where}) on ${day(repeat.at)} UTC: "${said}"${note}`, related, doneSteps, meaning };
}

/** The lines added to a raise or notice that went through: related earlier answers, and a word on meaning search when it couldn't help. */
export function askCheckNotes(c: OwnerAskCheck): string {
  const out: string[] = [];
  if (c.related.length) out.push(`Possibly related earlier owner answers (not the same question, so this went through; withdraw it if one of these settles it):\n${c.related.map(describeOwnerAnswer).join("\n")}`);
  if (c.doneSteps?.length) {
    out.push(`The owner already did these steps on an earlier card. Check the live state first (the thing itself, not the answer); this went through, but if the step is done, withdraw it. If it must be redone, say why:\n${c.doneSteps.map((h) => `- the owner did this on card ${h.sourceId.slice(0, 8)}${h.ticketRef ? ` on ${h.ticketRef}` : ""} at ${day(h.at)} UTC (asked: "${clip(h.question ?? "", 160)}"; they answered: "${clip(h.answer, 120)}")`).join("\n")}`);
  }
  if (typeof c.meaning === "object") out.push(`Meaning search was unavailable (${clip(c.meaning.unavailable, 160)}), so only word search checked whether the owner already answered this.`);
  return out.join("\n\n");
}
