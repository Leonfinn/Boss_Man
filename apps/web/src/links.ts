// One place that turns what a person or agent typed into links (BOS-358). Chat, Markdown, a
// ticket's outputs and its activity all call this, so a link kind renders the same everywhere.
// Agents name things, the screen builds the address: [[slug]], [[slug#Heading]], a ticket
// reference (BOS-12), and an in-app route written by hand (#/tickets/…). A stored message is
// never changed; links are made when it is shown, so a fix here fixes old messages too.
import { ticketRef } from "@boss-man/shared";

/** Everything a link needs to know about where it is shown. */
export type LinkContext = {
  /** The company whose wiki the screen shows; without it a page name stays plain text. */
  companyId?: string;
  /** The ticket's prefix (BOS), so BOS-356 can become a link to that ticket. */
  prefix?: string | null;
  /** The ticket whose references can be resolved (the ticket is BOS-n when its number is known). */
  tickets?: { id: string; number: number | null; prefix?: string | null }[];
  /** The ticket being shown: "this ticket" becomes a link to it when the reference matches. */
  selfId?: string;
};

export type Piece =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "image"; alt: string; src: string }
  | { kind: "file"; text: string; href: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const COMPANY_SLUG = new RegExp(`^(${UUID})/`);

/** A page named with a company id in front is the same page here, so drop the id. */
export const shortSlug = (slug: string, companyId?: string) => (companyId && slug.startsWith(companyId + "/") ? slug.slice(companyId.length + 1) : slug);
/** True when a page name is prefixed with another company's id, which this screen can't show. */
export const otherCompany = (slug: string, companyId?: string) => COMPANY_SLUG.test(slug) && shortSlug(slug, companyId) === slug;

const section = (slug: string) => {
  const at = slug.indexOf("#");
  return at === -1 ? { path: slug, hash: "" } : { path: slug.slice(0, at), hash: slug.slice(at) };
};

/** The address of a wiki page; `page` may be "slug" or "slug#Heading" (BOS-358). */
export function wikiHref(page: string, companyId: string) {
  const { path, hash } = section(page.trim());
  return `#/wiki/${companyId}/${shortSlug(path, companyId)}${hash}`;
}

/** The address of a ticket or other in-app screen; anything else is left alone (BOS-358). */
export function routeHref(route: string) {
  return route.startsWith("#/") ? route : null;
}

/** The address of a ticket reference like BOS-356, when the screen can find that ticket. */
export function ticketHref(ref: string, ctx: LinkContext): string | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(ref);
  if (!m) return null;
  const number = Number(m[2]);
  // A ticket in this screen's list already covers "this ticket" too, so one lookup is enough.
  const known = ctx.tickets?.find((t) => t.number === number && (t.prefix ?? ctx.prefix ?? "T") === m[1]);
  if (known) return `#/tickets/${known.id}`;
  return null;
}

/** Everything a link builder must know, from what a screen has (BOS-358). */
export function linkContext(companyId?: string, prefix?: string | null, opts: { tickets?: LinkContext["tickets"]; selfId?: string } = {}): LinkContext {
  return { companyId, prefix, tickets: opts.tickets, selfId: opts.selfId };
}

const IMG = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// One pattern, in order of what wins: a pasted image or file, a Markdown link whose text and
// address are both written out, a bare in-app route, a page name in double brackets, and a
// ticket reference. A bare route must start the text or follow whitespace, an opening bracket or
// punctuation (not sit inside a URL or a word), and stops before whitespace or closing punctuation.
const PATTERN = new RegExp(
  [
    `(!?)\\[([^\\]]*)\\]\\((/api/ticket-images/${IMG})\\)`,
    `\\[([^\\]]+)\\]\\((#[\\/][a-z]+(?:\\/[^\\s)\\]]*)?)\\)`,
    `(?<![^\\s([{:;"'*\`])(#[\\/][a-z]+(?:\\/[0-9a-f-]{36})?(?:\\/[^\\s\`]*?(?=[.,;:!?)\\s\\]]|$))?)`,
    `\\[\\[([^\\]#|]+?)(#[^\\]]*)?\\]\\]`,
    `(?<![\\w/-])([A-Za-z][A-Za-z0-9]*-\\d+)(?![\\w-])`,
  ].join("|"),
  "g",
);

// Groups: 1-3 image/file, 4-5 [text](#/route), 6 bare #/route, 7-8 [[page#section]], 9 ticket ref.
const [, IMG_BANG, IMG_ALT, IMG_SRC, MD_TEXT, MD_HREF, BARE, PAGE, PAGE_HASH, REF] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

// Text that must be shown exactly as written: fenced code, inline code, and an existing Markdown
// link like [read this](https://…). Ranges are found up front and any match inside them is skipped,
// so a page name or ticket number in code or in a link's address is never turned into a link.
const VERBATIM = [/```[\s\S]*?```/g, /`[^`\n]*`/g, /\[[^\]]*\]\((?!#[\/]|\/api\/ticket-images\/)[^)\s]+\)/g];

function verbatimRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const re of VERBATIM) {
    for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  }
  return out;
}
const inside = (ranges: Array<[number, number]>, at: number) => ranges.some(([s, e]) => at >= s && at < e);

/** Splits text into plain runs and links, for a screen that renders each piece its own way. */
export function linkPieces(text: string, ctx: LinkContext = {}): Piece[] {
  const out: Piece[] = [];
  const ranges = verbatimRanges(text);
  let at = 0;
  const push = (piece: Piece) => {
    if (piece.kind === "text" && !piece.text) return;
    // Neighbouring plain runs are one run, so a screen shows plain text exactly as it was written.
    const last = out[out.length - 1];
    if (piece.kind === "text" && last?.kind === "text") last.text += piece.text;
    else out.push(piece);
  };
  for (const m of text.matchAll(PATTERN)) {
    // Code and existing links are left exactly as they were written.
    if (inside(ranges, m.index!)) continue;
    push({ kind: "text", text: text.slice(at, m.index!) });
    at = m.index! + m[0].length;
    // A pasted image shows as a thumbnail; a pasted file as a chip that downloads.
    if (m[IMG_SRC]) {
      push(m[IMG_BANG] ? { kind: "image", alt: m[IMG_ALT] || "image", src: m[IMG_SRC] } : { kind: "file", text: m[IMG_ALT] || "file", href: m[IMG_SRC] });
      continue;
    }
    if (m[MD_HREF]) {
      push({ kind: "link", text: m[MD_TEXT]!, href: m[MD_HREF] });
      continue;
    }
    if (m[PAGE]) {
      const page = m[PAGE].trim() + (m[PAGE_HASH] ?? "");
      // A page from another company, or any page when the screen has no company, stays plain text.
      if (!ctx.companyId || otherCompany(page, ctx.companyId)) {
        push({ kind: "text", text: m[0] });
        continue;
      }
      push({ kind: "link", text: shortSlug(page, ctx.companyId), href: wikiHref(page, ctx.companyId) });
      continue;
    }
    const href = m[BARE] ?? (m[REF] ? ticketHref(m[REF], ctx) : null);
    // A reference the screen can't place, or a bare route that is only "#/", is left as it was.
    if (!href || href === "#/") {
      push({ kind: "text", text: m[0] });
      continue;
    }
    const label = m[BARE] ? (href.startsWith("#/tickets/") ? "task" : href.slice(2)) : m[REF]!;
    push({ kind: "link", text: label, href });
  }
  push({ kind: "text", text: text.slice(at) });
  return out;
}

/** Markdown with page names and ticket references written as Markdown links, for react-markdown. */
export function linkMarkdown(text: string, ctx: LinkContext = {}): string {
  return linkPieces(text, ctx)
    .map((p) => {
      if (p.kind === "text") return p.text;
      if (p.kind === "image") return `![${p.alt}](${p.src})`;
      return `[${p.text}](${p.href})`;
    })
    .join("");
}
