// A wiki page's "On this page" outline and its section links (BOS-2443).
//
// The outline is read from the rendered page, not parsed from the Markdown again: the ids are the ones the
// Markdown renderer gave the headings (headingId), so an outline entry, a copied section link and the landing
// code in PageView can never disagree about where "slug#Heading" goes.

/** A page needs at least this many headings before the outline is worth showing. */
export const OUTLINE_MIN = 3;

/** One heading on the page: its level (1 to 6), its id, its text, and its place among the page's headings. */
export type OutlineEntry = { level: number; id: string; text: string; index: number };

const HEADINGS = "h1, h2, h3, h4, h5, h6";

/**
 * The headings under `root`, in page order, with the words each shows (the copy button inside a heading is an
 * icon with no text, so it adds none). A heading whose id is empty (only marks, like "## ✨") has no address to
 * link to, so it is left out.
 */
export function readOutline(root: ParentNode): OutlineEntry[] {
  return [...root.querySelectorAll<HTMLElement>(HEADINGS)]
    .map((h, index) => ({ level: Number(h.tagName.slice(1)), id: h.id, text: (h.textContent ?? "").trim(), index }))
    .filter((e) => e.id);
}

/** The heading an outline entry stands for, found by its place, so two headings with the same words each get their own jump. */
export const headingAt = (root: ParentNode, index: number): HTMLElement | undefined => root.querySelectorAll<HTMLElement>(HEADINGS)[index];

/** The app's route to one section of a page: `#/wiki/<company>/<slug>#<heading id>`, which PageView lands on. */
export const sectionHash = (companyId: string, slug: string, id: string) => `#/wiki/${companyId}/${slug}#${id}`;

/** The full address of a section, to share: this app's origin and path, then the section's route. */
export const sectionLink = (companyId: string, slug: string, id: string, loc: Pick<Location, "origin" | "pathname"> = window.location) =>
  `${loc.origin}${loc.pathname}${sectionHash(companyId, slug, id)}`;
