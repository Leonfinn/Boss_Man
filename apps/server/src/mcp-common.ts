// Small helpers every MCP tool file shares (BOS-298 step 15): kept here so the tool files split out of
// mcp.ts import them without importing mcp.ts back.
import { isAfterMerge, readVerdicts, type Criterion } from "@boss-man/shared";

export type Scope = { companyId: string; agentId: string | null; runId: string };

export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
export const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** A lossless cap: at most n chars of s from offset; when there's more, says how much and how to get it. */
export const cut = (s: string, n: number, how: (next: number) => string, offset = 0) =>
  s.length <= offset + n ? s.slice(offset) : `${s.slice(offset, offset + n)}\n\n… ${s.length - offset - n} more chars; ${how(offset + n)}`;
export const CAP = 40_000;

/** Shared wording for every tool that takes the "fixes live" marker (BOS-639). */
export const FIXES_LIVE_HELP =
  "Only for a ticket that fixes a problem on the live server now: one sentence naming the symptom the owner sees, e.g. \"server freezes as memory climbs\". When it merges the CEO is woken, and the deploy card is headed \"Urgent: contains the fix for <symptom> (BOS-n)\", pages the owner once and sorts first. Set it by hand; never because the ticket is high priority or urgent.";

/** A reference like HOL-12 (any prefix: an old one still finds the number). */
export const REF = /^[A-Za-z0-9]{1,10}-(\d{1,9})$/;

/** One line per criterion with the author's verdict, the after-merge ones marked so they read as skippable (DR-024 #5). */
export function criterionLines(criteria: readonly Criterion[], note: string | null): string[] {
  return readVerdicts(criteria, note).map((r, i) => `- [${r.verdict ?? "not reported"}] ${r.criterion}${isAfterMerge(criteria[i]!) ? " (checked after merge; don't fail the review on it)" : ""}`);
}
