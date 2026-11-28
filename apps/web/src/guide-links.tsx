// "What's this?" links from the app screens to the website guides (BOS-2832). Every guide address
// lives here, so renaming a guide page is one edit. The link names its topic (never a bare "?"),
// opens the guide in a new tab, and says "(opens a guide)" to screen readers only. Add it right
// after the line it explains; on touch the row is at least 44 px tall (styles.css .guide-link).
import { forwardRef, type ReactNode } from "react";

/** The published website, where the guides live. Kept here so every link shares one origin. */
export const GUIDE_BASE = "https://bossman.website";

/** Every guide page the app links to, by the file name in apps/site/src/guides (without .md).
 *  A test fails if one of these is not a real page, so a renamed or removed guide is caught. */
export const GUIDE_SLUGS = [
  "the-ceo",
  "the-runner",
  "connect-a-claude-account",
  "what-agents-cost",
  "the-watchdog",
  "board-and-decisions",
  "tasks-and-the-board",
  "review-and-risk",
  "how-updates-work",
  "code-words",
  "hiring-your-first-team",
  "what-keeps-agents-fenced-in",
  "work-that-isnt-code",
] as const;

export type GuideSlug = (typeof GUIDE_SLUGS)[number];

/** The full address of a guide page, optionally at a section heading (its anchor). */
export function guideHref(slug: GuideSlug, anchor?: string): string {
  return `${GUIDE_BASE}/guides/${slug}${anchor ? `#${anchor}` : ""}`;
}

/**
 * A "What's this?" text link to a website guide (BOS-2832). The words name the topic; "(opens a guide)"
 * is read by screen readers only, so a sighted reader is not told what a new tab already shows.
 */
export const GuideLink = forwardRef<HTMLAnchorElement, { slug: GuideSlug; anchor?: string; children: ReactNode }>(function GuideLink({ slug, anchor, children }, ref) {
  return (
    <a ref={ref} className="guide-link" href={guideHref(slug, anchor)} target="_blank" rel="noreferrer">
      {children}
      <span className="sr-only"> (opens a guide)</span>
    </a>
  );
});
