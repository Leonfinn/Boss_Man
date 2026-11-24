// "Find in this run" and the "Show" choice on the Run page (BOS-2476). Pure helpers over the transcript's events;
// the matching itself is chat-find.ts's.
import type { TranscriptItem } from "./api";
import { findSpots, type FindSpot } from "./chat-find";
import { describe } from "./transcript";

export type RunShow = "all" | "messages" | "tools" | "problems";
export const RUN_SHOWS: { value: RunShow; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "messages", label: "Messages" },
  { value: "tools", label: "Tool calls" },
  { value: "problems", label: "Problems" },
];

/** The choice in the page link ("?show=problems"); anything unknown means Everything. */
export function parseRunShow(q: URLSearchParams): RunShow {
  const v = q.get("show");
  return RUN_SHOWS.some((s) => s.value === v) ? (v as RunShow) : "all";
}

const failedStatus = (s: string | undefined) => !!s && /^(failed|error|errored|cancelled|canceled|denied|rejected)$/i.test(s);

/** Whether one event belongs under a choice. Messages: the agent's text and the owner's delivered messages. */
export function inShow(item: TranscriptItem, show: RunShow): boolean {
  if (show === "all") return true;
  const d = describe(item);
  if (show === "messages") return d.tone === "text" || d.label === "Message delivered";
  if (show === "tools") return d.tone === "tool";
  return d.tone === "bad" || item.type === "run.permission_request" || (d.tone === "tool" && failedStatus(d.body));
}

export const shownItems = (items: TranscriptItem[], show: RunShow) => (show === "all" ? items : items.filter((i) => inShow(i, show)));

/** The text the rows draw for one event: its label and body (a tool's status is drawn with underscores as spaces). */
export function itemParts(item: TranscriptItem): string[] {
  const d = describe(item);
  return d.body ? [d.label, d.tone === "tool" ? d.body.replace(/_/g, " ") : d.body] : [d.label];
}

/** Every match in the shown events, in order; an event is named by its seq. */
export const runSpots = (items: TranscriptItem[], query: string): FindSpot[] =>
  findSpots(items.map((i) => ({ id: String(i.seq), parts: itemParts(i) })), query);
