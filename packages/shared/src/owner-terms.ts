// The owner terms list (BOS-2709): every Boss Man word the owner reads on a screen, with one plain meaning.
// "points" sat on the Roadmap with no explanation because the people who built and reviewed it already knew
// what a point is. The meaning is written once, here; the screen help (apps/web <Term>, and the Roadmap's
// "How the status is worked out" list) and the website glossary (apps/site/src/guides/glossary.md, held
// to this list by a test) both read it. A reviewer approving a change to an owner screen names its new
// words on a "New words:" line, and each name has to be in this list.

export interface OwnerTerm {
  /** Stable key, used by `<Term id>` and the render test. */
  id: string;
  /** The word as the owner reads it, capitalised for a heading or glossary entry. */
  term: string;
  /** One plain sentence or two, for someone who has never used Boss Man. At least OWNER_TERM_MIN_CHARS. */
  meaning: string;
  /** Matches the word in a screen's text. The render test uses it to find the word on a screen. */
  pattern: RegExp;
  /** The glossary entry's link: the guide number and its section, when the glossary carries this term. */
  glossary?: { guide: number; path: string };
}

export const OWNER_TERM_MIN_CHARS = 20;

export const OWNER_TERMS: readonly OwnerTerm[] = [
  {
    id: "points",
    term: "Points",
    meaning: "How big a ticket is: a number it is given when it is planned. A bigger number means more work. The Roadmap adds up the points still to do to forecast when a milestone finishes.",
    pattern: /\bpoints?\b/i,
    glossary: { guide: 1, path: "/guides/how-boss-man-works#features-tasks-and-sub-tasks" },
  },
  {
    id: "no-size",
    term: "No size",
    meaning: "A ticket nobody has given points yet. It adds nothing to the points left, so a forecast with unsized tickets is only as good as the sized ones.",
    pattern: /\bno size\b/i,
    glossary: { guide: 1, path: "/guides/how-boss-man-works#features-tasks-and-sub-tasks" },
  },
  {
    id: "pace",
    term: "Pace",
    meaning: "How many points of a milestone were finished each week over the last 4 weeks. Boss Man uses it to guess when the rest will be finished.",
    pattern: /\bpace\b/i,
    glossary: { guide: 1, path: "/guides/how-boss-man-works#features-tasks-and-sub-tasks" },
  },
];

const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s_]+/g, "-");

/** A term by id or by its words ("Points", "no size"), or undefined. */
export const ownerTerm = (idOrName: string): OwnerTerm | undefined => {
  const k = norm(idOrName);
  return OWNER_TERMS.find((t) => t.id === k || norm(t.term) === k);
};

/** The terms whose word appears in a screen's text. */
export const ownerTermsIn = (text: string): OwnerTerm[] => OWNER_TERMS.filter((t) => t.pattern.test(text));

/** The glossary line for a term, as it stands in apps/site/src/guides/glossary.md. */
export const glossaryLine = (t: OwnerTerm): string | null => (t.glossary ? `- **${t.term}**: ${t.meaning} ([Guide ${t.glossary.guide}](${t.glossary.path}))` : null);

// --- The "New words:" line on an approval of work that touches an owner screen ---

/** The label a reviewer's line starts with. */
export const NEW_WORDS_LABEL = "New words:";

/** Owner screens: the web app's pages and components. Tests, the API client and styles are not screens. */
const OWNER_SCREEN = /^apps\/web\/src\/(pages|components)\/.+\.tsx$/;

/** True when a change touches an owner screen. */
export const touchesOwnerScreen = (paths: readonly string[]): boolean => paths.some((p) => OWNER_SCREEN.test(p));

/** The reading of a "New words:" line: `none`, or the names listed. null when there is no such line. */
export function newWordsLine(text: string | null | undefined): { none: boolean; words: string[] } | null {
  const m = /\bnew words\s*:[ \t]*([^\n]*)/i.exec(text ?? "");
  if (!m) return null;
  const said = m[1]!.trim().replace(/[.\s]+$/, "");
  if (!said) return null;
  if (/^(none|no new words|nothing)\b/i.test(said)) return { none: true, words: [] };
  const words = said
    .split(/[,;]/)
    .map((w) => w.replace(/^\s*(and\s+)?["'“”]?|["'“”]?\s*$/gi, "").trim())
    .filter(Boolean);
  return words.length ? { none: false, words } : null;
}

/** Why a "New words:" line is refused, or null when it is fine. Named words must each be in OWNER_TERMS. */
export function newWordsProblem(text: string | null | undefined): string | null {
  const l = newWordsLine(text);
  if (!l) return NEW_WORDS_REFUSAL;
  const unknown = l.words.filter((w) => !ownerTerm(w));
  if (unknown.length) return `Your "${NEW_WORDS_LABEL}" line names ${unknown.map((w) => `"${w}"`).join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not in the owner terms list (packages/shared/src/owner-terms.ts). Add each word there with its plain meaning, show the meaning on the screen, and approve again.`;
  return null;
}

export const NEW_WORDS_REFUSAL = `This change touches an owner screen, so the approval needs a "${NEW_WORDS_LABEL}" line in your summary: "${NEW_WORDS_LABEL} none" when no screen shows a Boss Man word the owner has not met before, or "${NEW_WORDS_LABEL} word one, word two" naming each new word. Every named word must have its plain meaning in packages/shared/src/owner-terms.ts and be explained on the screen where it first appears. Walk it as a new owner.`;
