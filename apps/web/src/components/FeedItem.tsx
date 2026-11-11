import type { ReactNode } from "react";

/** The feed's own words for a notice's level (what kind of message it is). */
export const LEVEL_LABEL: Record<string, string> = { note: "Note", flag: "Flag", page: "Page", ask: "Ask" };

/**
 * What a feed item is about (BOS-1124, Q6). A decision card is titled "<Company> needs a decision" and carries
 * the question as its body; the question is the useful part, so it becomes the title and the company moves
 * to the small line above. Any other notice keeps its own title.
 */
export function feedTitle(title: string, body: string | null | undefined): string {
  const question = body?.trim().split(/\n/)[0]?.trim();
  return question && /\bneeds a decision$/.test(title) ? question : title;
}

/**
 * One item of the Notifications list and the Dashboard's Recent activity: a small line above (company, type,
 * time, anything else) and the headline under it, cut to one line with the full text on hover.
 */
export function FeedItem({ small, title, href, onClick, lines = 1 }: { small: ReactNode; title: string; href?: string; onClick?: () => void; lines?: 1 | 2 }) {
  const cls = `feed-title${lines === 2 ? " two" : ""}`;
  return (
    <div className="feed-item">
      <div className="feed-small">{small}</div>
      {href ? (
        <a className={cls} href={href} title={title} onClick={onClick}>
          {title}
        </a>
      ) : (
        <strong className={cls} title={title}>
          {title}
        </strong>
      )}
    </div>
  );
}
