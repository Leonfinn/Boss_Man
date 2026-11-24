// The Feedback inbox's summary line and list order (BOS-2455).

export type FeedbackOrder = "newest" | "oldest";

export type FeedbackSummary = {
  waiting: number;
  oldest: { id: string; title: string; createdAt: string } | null;
  week: { portal: number; github: number; owner: number };
};

/** How many notes one press of "Show older" / "Show newer" adds, and the first page's size. */
export const FEEDBACK_PAGE = 50;

/** The order kept in the page address (`?order=oldest`); anything else is the newest first. */
export const readFeedbackOrder = (params: URLSearchParams): FeedbackOrder => (params.get("order") === "oldest" ? "oldest" : "newest");

/** The address of the inbox in this order, keeping the company and note part. */
export function feedbackOrderHref(hash: string, order: FeedbackOrder): string {
  const base = hash.split("?")[0] || "#/feedback";
  return order === "oldest" ? `${base}?order=oldest` : base;
}

/** The list URL's paging part: the first page, or the page after the last row shown, in the chosen order. */
export function feedbackPageQuery(order: FeedbackOrder, last: string | null, limit = FEEDBACK_PAGE): string {
  const cursor = last ? `&${order === "oldest" ? "after" : "before"}=${encodeURIComponent(last)}` : "";
  return `&order=${order}&limit=${limit}${cursor}`;
}

/** Whole days between two times, never negative. */
export const daysWaited = (from: string, now: number): number => Math.max(0, Math.floor((now - new Date(from).getTime()) / 86_400_000));

/** "oldest waiting 3 days" / "oldest waiting less than a day". */
export function waitedText(createdAt: string, now: number): string {
  const d = daysWaited(createdAt, now);
  return d < 1 ? "less than a day" : d === 1 ? "1 day" : `${d} days`;
}
