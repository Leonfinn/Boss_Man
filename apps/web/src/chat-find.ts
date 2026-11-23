// Find inside one open chat (BOS-2411). Pure helpers: the page decides which text is visible (message words and
// link text, never the markup around them) and passes it in as parts; nothing here knows about React or the DOM.

/** A message's visible text, in pieces (a link's words are their own piece), so markup is never searched. */
export type FindMessage = { id: string; parts: string[] };
/** Where one match is: the nth match inside a message. Stable when older messages are added above it. */
export type FindSpot = { id: string; n: number };
export type Segment = { text: string; hit: boolean };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What is searched for: the box's text without the spaces around it ("" means no search). */
export const findQuery = (typed: string) => typed.trim();

const pattern = (query: string) => new RegExp(escape(query), "gi");

/** The pieces of one text, matches marked, case-insensitive and not overlapping. */
export function splitHits(text: string, query: string): Segment[] {
  const q = findQuery(query);
  if (!q) return [{ text, hit: false }];
  const out: Segment[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern(q))) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index!), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

export const countHits = (parts: string[], query: string) => parts.reduce((sum, p) => sum + splitHits(p, query).filter((s) => s.hit).length, 0);

/** Every match in order, oldest message first: one spot per match. */
export function findSpots(messages: FindMessage[], query: string): FindSpot[] {
  if (!findQuery(query)) return [];
  const spots: FindSpot[] = [];
  for (const m of messages) {
    const count = countHits(m.parts, query);
    for (let n = 0; n < count; n++) spots.push({ id: m.id, n });
  }
  return spots;
}

/** Where a spot is in the list (-1 when it is not there). */
export const spotIndex = (spots: FindSpot[], at: FindSpot | null) => (at ? spots.findIndex((s) => s.id === at.id && s.n === at.n) : -1);

/** The spot after (or before) the current one, wrapping round at either end; the newest match when none is current. */
export function stepSpot(spots: FindSpot[], at: FindSpot | null, dir: 1 | -1): FindSpot | null {
  if (!spots.length) return null;
  const i = spotIndex(spots, at);
  if (i < 0) return spots[spots.length - 1]!;
  return spots[(i + dir + spots.length) % spots.length]!;
}

/** The start of a day typed in a date field (YYYY-MM-DD), in the owner's own time zone; null for anything else. */
export function dayStart(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? null : d.getTime();
}

/** The first message (oldest first) at or after the start of the day, or null when every message is older. */
export function firstOnOrAfter<T extends { createdAt: string }>(items: T[], start: number): T | null {
  return items.find((m) => new Date(m.createdAt).getTime() >= start) ?? null;
}
