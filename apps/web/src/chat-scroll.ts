// BOS-2440: the maths behind "Jump to newest" and a message's own link, kept apart from the page so it can be tested.

/** How far the reader is from the end of the log, in pixels. */
export const distanceFromBottom = (box: { scrollHeight: number; scrollTop: number; clientHeight: number }) => Math.max(0, box.scrollHeight - box.scrollTop - box.clientHeight);

/** Scrolled up by more than about one screen: the "Jump to newest" button shows. */
export const isFarUp = (box: { scrollHeight: number; scrollTop: number; clientHeight: number }) => distanceFromBottom(box) > box.clientHeight;

/** How many messages arrived after the one that was newest when the reader scrolled up. */
export function newSince(ids: string[], anchorId: string | null): number {
  if (!anchorId) return 0;
  const at = ids.lastIndexOf(anchorId);
  return at < 0 ? 0 : ids.length - 1 - at;
}

/** The address of one message: the same route a search result opens (`#/chat/<company>/<agent>/<message>`). */
export const messageLink = (loc: { origin: string; pathname: string }, companyId: string, agentId: string, messageId: string) =>
  `${loc.origin}${loc.pathname}#/chat/${companyId}/${agentId}/${messageId}`;
