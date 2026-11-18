// The page clause of an after-merge criterion (R37, BOS-1682): `(page: https://example.com/x shows "Your roadmap")`.
// roadmap.bossman.website showed "This link is incomplete" while a "200 + title" check passed it (16 Nov). A status
// code and the static <title> say nothing about what a visitor sees, so a criterion about a live page names text only
// the working page shows, and its pass must cite a screenshot taken after go-live that shows it (host-fact-gate.ts).

/** One page clause: the address and the visible text the working page shows there. */
export type PageClause = { url: string; text: string };

// The address runs to the first space; the text sits in straight or curly double quotes.
const PAGE = /\(\s*page\s*:\s*(\S+?)\s+shows\s+["“]([^"”]*)["”]\s*\)/gi;
/** Any `(page: …` at all, readable or not, so a mistyped clause is refused rather than silently ignored. */
const PAGE_OPEN = /\(\s*page\s*:/gi;

/** The page clauses written in a criterion's text, in order. */
export function pageClauses(text: string): PageClause[] {
  return [...text.matchAll(PAGE)].map((m) => ({ url: m[1]!, text: m[2]!.trim() }));
}

/** The criterion text with its page clauses taken out, for the lints that read the rest of the words. */
export const withoutPageClauses = (text: string): string => text.replace(PAGE, "");

/** Lowercase, flattened whitespace and straight quotes: how a quoted text is matched in a note. */
export const normQuote = (s: string): string => s.toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/** A bare status line ("200", "200 OK", "OK", "302 → 200"): what a curl shows, not what a visitor reads. */
const STATUS_ONLY = /^(?:\d{3}(?:\s*(?:→|->)\s*\d{3})*(?:\s+[a-z ]{1,20})?|ok|success|loaded)$/i;

/**
 * Why one page clause can't be used, or null when it can. The server never fetches the page when a criterion is
 * written (an agent could name any address, including one inside the host's network), so the page's real <title> is
 * not known here. What is refused is what a title or a status check gives: empty text, a status line, or the site's
 * own name (its host, or the host's first part, e.g. "Roadmap" for roadmap.example.com), which is what a title says.
 */
export function pageClauseProblem(clause: PageClause): string | null {
  let url: URL;
  try {
    url = new URL(clause.url);
  } catch {
    return `"${clause.url}" isn't a full address: write it with https://.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `"${clause.url}" isn't a web address: write it with https://.`;
  const t = normQuote(clause.text);
  if (!t) return `the text to show is empty: quote words only the working page shows, e.g. a heading or a line of its content.`;
  if (t.length < 4 || STATUS_ONLY.test(t)) return `"${clause.text}" is a status, not something a visitor reads: quote words only the working page shows.`;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const site = [host, host.split(".")[0]!, normQuote(clause.url), normQuote(url.href)];
  if (site.includes(t) || site.includes(t.replace(/\s+/g, ""))) return `"${clause.text}" is the site's name, which is what its <title> says: an error page has the same title. Quote words only the working page shows.`;
  return null;
}

/**
 * The refusal when a criterion is written with a page clause that can't be checked, or null. A `(page:` that doesn't
 * read as `(page: <url> shows "<text>")` is refused too, so it can't fall back to closing on a status code.
 */
export function pageClauseRefusal(criteria: ReadonlyArray<string | { text: string; after?: string }>): string | null {
  const lines: string[] = [];
  for (const c of criteria) {
    const text = typeof c === "string" ? c : c.text;
    const clauses = pageClauses(text);
    if ((text.match(PAGE_OPEN)?.length ?? 0) > clauses.length) lines.push(`"${text}": a page clause is written (page: https://example.com/path shows "words on the page").`);
    for (const clause of clauses) {
      const problem = pageClauseProblem(clause);
      if (problem) lines.push(`"${text}": ${problem}`);
    }
  }
  return lines.length ? `A page clause can't be checked as written, so the criterion could still close on a status code and title:\n${lines.join("\n")}` : null;
}

/** An after-merge criterion that talks about a live page (an https:// address, or a page that opens, shows or loads). */
const NAMES_PAGE = /\bhttps?:\/\/\S|\b(?:pages?|site|link|url)\b[^.;]{0,60}?\b(?:opens?|shows?|loads?|renders?)\b/i;

/** Whether a criterion's words (outside any page clause) talk about a live page. */
export const namesPage = (text: string): boolean => NAMES_PAGE.test(withoutPageClauses(text));
