// The CEO chat's named-things lookup (DR-069 D2, BOS-1854). Morph's BOS-1782 measurement found chat slips where the owner had
// already answered, or the record already said, something about a thing the conversation names (a check worker, a ticket, a
// card, an add-on, an outside site, a setting, the git token). So before the CEO answers, each thing the owner's messages and
// the CEO's last reply name is looked up live: one line from the record, then the owner's newest answers that name it.
// One table, one row per kind of thing, recognised from the record (never a hand list of instances); matching is literal and
// case-insensitive, so it needs no ranking; newest answer first; at most MAX_LINES lines. Nothing is stored.
import { and, eq, inArray, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkWorkers, companies, decisions, tickets } from "../db/schema.js";
import { ADDON_LABELS, ADDONS, type AddonFacts } from "./addons.js";
import { isWorkerOnline } from "./check-workers.js";
import { clip, day, searchOwnerAnswers, type OwnerAnswerHit } from "./owner-answers.js";
import { kindsOf, type GitTokenProbe } from "./owner-record.js";
import { screenMismatchSites } from "./outside-site-mismatch.js";
import { ANSWERED_LOOKBACK_MS } from "./stale-requests.js";
import { outsideSiteKeys } from "./steps.js";

export const NAMED_MAX_LINES = 8;
export const NAMED_LINE_MAX = 300;
const ANSWERS_PER_THING = 2;
const TITLE = "What the record and the owner already say about the things named here (read live; check this before you advise)";

/** What the lookup may read besides the database; each is optional, and a missing source says nothing. */
export type NamedSources = {
  addons?: () => Promise<AddonFacts>;
  gitTokenProbe?: GitTokenProbe;
  serverHost?: () => Promise<string | null | undefined>;
  now?: () => Date;
};

/** One thing the text names: what to call it, the words that name it (literal), and what the record says about it, if anything. */
export type NamedThing = { kind: string; name: string; needles: string[]; record: string | null; own?: OwnerAnswerHit[] };

type Ctx = { db: Db; companyId: string; text: string; lower: string; sources: NamedSources };
type Kind = { kind: string; find: (c: Ctx) => Promise<NamedThing[]> };

const has = (lower: string, needle: string) => needle.length > 0 && lower.includes(needle.toLowerCase());
/** A name as a whole word (so a worker called "ci" is not found inside "decision"). */
const hasWord = (lower: string, needle: string) => {
  const n = needle.toLowerCase().trim();
  if (!n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${esc}(?![\p{L}\p{N}])`, "u").test(lower);
};

const KINDS: Kind[] = [
  {
    kind: "Worker",
    async find({ db, companyId, lower }) {
      const rows = (await db.select({ id: checkWorkers.id, name: checkWorkers.name, takes: checkWorkers.takes, mergeKept: checkWorkers.mergeKept, enabled: checkWorkers.enabled, companyIds: checkWorkers.companyIds }).from(checkWorkers)).filter((w) => w.companyIds.includes(companyId));
      return rows
        .filter((w) => hasWord(lower, (w.name ?? "").trim()))
        .map((w) => ({ kind: "Worker", name: (w.name ?? "").trim(), needles: [(w.name ?? "").trim()], record: `${kindsOf(w)} · ${w.enabled ? "on" : "switched off"} · ${isWorkerOnline(w.id) ? "online" : "offline"}` }));
    },
  },
  {
    kind: "Ticket",
    async find({ db, companyId, text }) {
      const [co] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
      const prefix = co?.prefix?.trim();
      if (!prefix) return [];
      const numbers = [...new Set([...text.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}-])${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\d+)\b`, "giu"))].map((m) => Number(m[1])))].slice(0, 4);
      if (!numbers.length) return [];
      const rows = await db.select({ number: tickets.number, state: tickets.systemState, mergedAt: tickets.mergedAt, liveAt: tickets.liveAt, title: tickets.title }).from(tickets).where(and(eq(tickets.companyId, companyId), inArray(tickets.number, numbers)));
      return rows.map((t) => {
        const ref = ticketRef(prefix, t.number) ?? `${prefix}-${t.number}`;
        const merged = t.mergedAt ? `merged ${day(t.mergedAt).slice(0, 10)}, ${t.liveAt ? "live" : "not recorded as live"}` : "not merged";
        return { kind: "Ticket", name: ref, needles: [ref], record: `${clip(t.title, 80)} · ${t.state.replace(/_/g, " ")} · ${merged}` };
      });
    },
  },
  {
    kind: "Card",
    async find({ db, companyId, lower }) {
      const ids = [...new Set(lower.match(/(?<![0-9a-f-])[0-9a-f]{8}(?![0-9a-f])/g) ?? [])].filter((s) => /[a-f]/.test(s) && /\d/.test(s)).slice(0, 4);
      if (!ids.length) return [];
      const all = await db.select({ id: decisions.id, status: decisions.status, tier: decisions.tier, question: decisions.question, answer: decisions.answer, answeredAt: decisions.answeredAt }).from(decisions).where(and(eq(decisions.companyId, companyId), inArray(sql<string>`left(${decisions.id}::text, 8)`, ids)));
      return all
        .map((d) => ({
          kind: "Card",
          name: d.id.slice(0, 8),
          needles: [d.id.slice(0, 8)],
          record: `${d.status}${d.tier === "owner" ? "" : ` (for the ${d.tier})`} · asked "${clip(d.question, 100)}"${d.status === "answered" && d.answer ? ` · its answer: "${clip(d.answer, 100)}"${d.answeredAt ? ` ${day(d.answeredAt).slice(0, 10)}` : ""}` : ""}`,
        }));
    },
  },
  {
    kind: "Add-on",
    async find({ lower, sources }) {
      const named = ADDONS.filter((a) => hasWord(lower, a) || hasWord(lower, ADDON_LABELS[a]));
      if (!named.length) return [];
      const facts = await sources.addons?.().catch(() => undefined);
      return named.map((a) => {
        const f = facts?.[a];
        return { kind: "Add-on", name: ADDON_LABELS[a], needles: [ADDON_LABELS[a]], record: f && f.state !== "unknown" ? `${f.state.replace(/_/g, " ")}${f.since ? ` since ${day(new Date(f.since)).slice(0, 10)}` : ""}` : null };
      });
    },
  },
  {
    kind: "Outside site",
    async find({ db, companyId, text, sources }) {
      const host = await sources.serverHost?.().catch(() => null);
      const keys = outsideSiteKeys(text, host);
      if (!keys.length) return [];
      const misled = await screenMismatchSites(db, companyId, [text], host, sources.now?.()).catch(() => undefined);
      return keys.slice(0, 3).map((k) => ({ kind: "Outside site", name: k, needles: [k], record: misled?.[k] ? `its docs didn't match the owner's screen on ${misled[k]!.slice(0, 10)}` : null }));
    },
  },
  {
    kind: "Setting",
    // A Settings path as the owner reads it: "Settings → Server and runner → Limits and checks". The path itself is the name.
    async find({ text }) {
      const paths = [...text.matchAll(/\bSettings(?:\s*(?:→|->|>|›)\s*[A-Z][\p{L}\p{N}' ]{1,40}?)+(?=\s*(?:→|->|>|›|[.,;:)\n"']|$|\s[a-z]))/gu)].map((m) => m[0].trim());
      return [...new Set(paths)].slice(0, 3).map((p) => ({ kind: "Setting", name: p, needles: [p], record: null }));
    },
  },
  {
    kind: "Git token",
    async find({ lower, companyId, sources }) {
      if (!/\b(?:git|github|gitlab)\s+(?:access\s+)?token\b/.test(lower)) return [];
      const v = await sources.gitTokenProbe?.(companyId).catch(() => "unknown" as const);
      return [{ kind: "Git", name: "token", needles: ["git token", "github token", "gitlab token"], record: v === "yes" ? "can read GitHub Actions runs (a live check)" : v === "no" ? "cannot read GitHub Actions runs (a live check)" : null }];
    },
  },
];

/** The owner's newest answers (last 30 days) whose text names the thing, newest first, at most 2. Answered action cards are marked. */
async function ownersLastWord(db: Db, companyId: string, t: NamedThing, now: Date, exclude: ReadonlySet<string>): Promise<OwnerAnswerHit[]> {
  const since = new Date(now.getTime() - ANSWERED_LOOKBACK_MS);
  const names = (h: OwnerAnswerHit) => `${h.question ?? ""} ${h.answer} ${h.ownerNote ?? ""}`.toLowerCase();
  const hits = await searchOwnerAnswers(db, { companyId, q: t.name, since, limit: 50 }).catch(() => [] as OwnerAnswerHit[]);
  return hits
    .filter((h) => !(h.kind === "chat" && exclude.has(h.answer.trim()))) // the message being answered is not a past answer
    .filter((h) => t.needles.some((n) => has(names(h), n)) || (t.kind === "Ticket" && h.ticketRef === t.name))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, ANSWERS_PER_THING);
}

const hitWords = (h: OwnerAnswerHit) =>
  h.kind === "card" ? `card ${h.sourceId.slice(0, 8)}${h.ticketRef ? ` (${h.ticketRef})` : ""}, asked "${clip(h.question ?? "", 30)}", owner${h.ownerDid ? " (owner did this)" : ""}: "${clip(h.answer, 100)}"` : `${h.kind === "chat" ? "chat" : h.kind === "note" ? "note" : "ticket message"}${h.ticketRef ? ` (${h.ticketRef})` : ""}: "${clip(h.answer, 120)}"`;

/** The lines for the things already found: the record line, then the owner's last words, as one line each, at most NAMED_LINE_MAX characters. */
export async function namedThingLines(db: Db, companyId: string, things: NamedThing[], now: Date = new Date(), exclude: ReadonlySet<string> = new Set()): Promise<string[]> {
  const lines: string[] = [];
  for (const t of things) {
    const said = t.own ?? (await ownersLastWord(db, companyId, t, now, exclude));
    if (!t.record && !said.length) continue; // unknown says nothing
    const parts = [t.record ? `record: ${t.record}` : null, ...said.map((h) => `owner ${day(h.at).slice(0, 10)}, ${hitWords(h)}`)].filter(Boolean);
    lines.push(clip(`- ${t.kind} ${t.name}: ${parts.join(" · ")}`, NAMED_LINE_MAX));
  }
  return lines;
}

/** Every thing of every kind that the text names. A kind that fails reads as naming nothing. */
export async function findNamedThings(db: Db, companyId: string, texts: Array<string | null | undefined>, sources: NamedSources = {}): Promise<NamedThing[]> {
  const text = texts.filter(Boolean).join("\n");
  if (!text.trim()) return [];
  const c: Ctx = { db, companyId, text, lower: text.toLowerCase(), sources };
  const found: NamedThing[] = [];
  for (const k of KINDS) found.push(...(await k.find(c).catch(() => [] as NamedThing[])));
  return found;
}

/**
 * The chat prompt section for the things the owner's messages (and the CEO's own last reply) name. Empty when nothing is named
 * or nothing is known about what is named, so a message that names nothing costs no section.
 */
export async function namedThingsSection(db: Db, companyId: string, texts: Array<string | null | undefined>, sources: NamedSources = {}): Promise<string[]> {
  const things = await findNamedThings(db, companyId, texts, sources);
  const lines = (await namedThingLines(db, companyId, things, sources.now?.() ?? new Date(), new Set(texts.filter((t): t is string => !!t).map((t) => t.trim())))).slice(0, NAMED_MAX_LINES);
  return lines.length ? ["", `## ${TITLE}`, ...lines] : [];
}

export const YOU_SAID_MAX = 2;

/**
 * After a CEO reply (DR-069 D3, BOS-1855): for things the reply names that the owner's messages never did, up to two lines
 * "You said ... on card ...", so advice that brings up something new is shown next to what the owner last said about it.
 * Like missingPageNote it only adds lines under the saved reply; it never holds or rewrites the reply. Each line needs an
 * owner answer (a thing with only a record line is not an owner's word), and a failed lookup says nothing.
 */
export async function youSaidLines(db: Db, companyId: string, reply: string, ownerTexts: string[], sources: NamedSources = {}): Promise<string[]> {
  const ownerLower = ownerTexts.join("\n").toLowerCase();
  const now = sources.now?.() ?? new Date();
  const first = (await findNamedThings(db, companyId, [reply], sources)).filter((t) => !t.needles.some((n) => has(ownerLower, n)));
  const lines: string[] = [];
  const seen: string[] = [];
  for (const t of first) {
    if (lines.length >= YOU_SAID_MAX) break;
    const hit = (t.own ?? (await ownersLastWord(db, companyId, t, now, new Set(ownerTexts.map((x) => x.trim()))))).find((h) => !seen.includes(`${h.kind}:${h.sourceId}`));
    if (!hit) continue;
    seen.push(`${hit.kind}:${hit.sourceId}`);
    const where = hit.kind === "card" ? `on card ${hit.sourceId.slice(0, 8)}${hit.ticketRef ? ` (${hit.ticketRef})` : ""}` : hit.kind === "chat" ? "in chat" : hit.kind === "note" ? "in a note" : `on ${hit.ticketRef ?? "a ticket"}`;
    lines.push(clip(`You said "${clip(hit.answer, 100)}" ${where}, ${day(hit.at).slice(0, 10)}, about ${t.name}, which your messages here didn't name.`, NAMED_LINE_MAX));
  }
  return lines;
}
