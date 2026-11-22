// BOS-1650 (rule R20): no branching in the owner's steps. "If no entry is marked, nothing to do" hands the owner a
// question the card should have settled (BOS-1582's go-live card). A step that only applies in some cases starts with a
// `[when <fact>]` marker instead, and Boss Man settles it from its own record when the card is raised, the way DR-057
// settles `[if company…]`:
//   - the fact is true: the marker comes off and the step stays;
//   - the fact is false: the step is dropped (and when every step drops, no card goes out and the ticket gets a note);
//   - the fact can't be settled (unknown key, or the record isn't there): the CEO gets a card; it is never dropped.
//
// A small table and fixed patterns, not a prose judge: each case is a test row.

import { parseStep } from "@boss-man/shared";
import type { LintFinding } from "./steps.js";

/** The start of a step Boss Man settles from its record: `[when network guard allow line can go]`. */
export const WHEN_MARKER = /^\s*\[when\s+([A-Za-z][A-Za-z0-9 _-]{2,80}?)\s*\]\s*/i;

/** The facts a marker may name, with what each means for the owner, and where the value comes from (see `whenFactsOf`). */
export const WHEN_FACTS = {
  "network guard allow line can go": "every address on the owner's network-guard allow line in .env is already allowed by Boss Man itself (server_status netguardAllow lineCanGo)",
} as const;
export const WHEN_FACT_KEYS: readonly string[] = Object.keys(WHEN_FACTS);

/** The settled value of each fact; a key that is absent or null couldn't be settled right now. */
export type WhenFacts = Record<string, boolean | null | undefined>;

/** A fact key as compared: lower case, single spaces. */
export const whenKey = (raw: string) => raw.toLowerCase().replace(/[\s_-]+/g, " ").trim();

/**
 * The first prose branch in a step's sentences (not its command blocks), or null. Patterns: a sentence that starts
 * "If …", "Only if …" or "Unless …"; ", only if" / ", unless" later in a sentence; "nothing to do"; and the
 * "if it isn't there" family (R18's IF_MISSING).
 */
const BRANCHING: RegExp[] = [
  /(?:^|[.!?:;]\s+|\n\s*)(?:only\s+)?if\b[^.!?\n]{0,60}/i,
  /(?:^|[.!?:;]\s+|\n\s*)unless\b[^.!?\n]{0,60}/i,
  /[,;]\s*(?:but\s+)?(?:only\s+if|unless)\b[^.!?\n]{0,60}/i,
  /\bnothing\s+(?:else\s+)?to\s+do\b[^.!?\n]{0,30}/i,
  /\bif\s+(?:[\w'’-]+\s+){0,5}?(?:isn't|is\s+not|aren't|are\s+not|doesn't|does\s+not|don't|do\s+not)\s+(?:there|listed|exist|shown|show|appear|have|marked)\b[^.!?\n]{0,30}/i,
  /\bif\s+there\s+(?:is|are)\s+no\b[^.!?\n]{0,40}/i,
];
export function branchingIn(prose: string): string | null {
  for (const re of BRANCHING) {
    const m = re.exec(prose);
    if (m) return m[0].replace(/^[.!?:;,\s]+/, "").trim();
  }
  return null;
}

/** R20 over a ticket's setup steps (as the owner will read them, markers settled): one finding per branching step. */
export function branchingFindings(steps: readonly string[]): LintFinding[] {
  const out: LintFinding[] = [];
  steps.forEach((text, i) => {
    const prose = parseStep(text).filter((p) => p.type === "text").map((p) => p.text).join("\n");
    const hit = branchingIn(prose);
    if (hit) out.push({ step: i + 1, rule: "R20", problem: `branches in prose ("${hit.slice(0, 80)}"), which leaves the owner to settle a question Boss Man should. Start the step with [when <fact>] (a fact Boss Man knows: ${WHEN_FACT_KEYS.join("; ")}) and Boss Man keeps or drops the step itself, or write only the case that applies` });
  });
  return out;
}

export type SettledWhen = {
  /** The steps the owner will read: markers off, steps whose fact is false gone. */
  steps: string[];
  /** Steps dropped because their fact is false (1-based, as written), with the fact key. */
  dropped: { step: number; fact: string }[];
  findings: LintFinding[];
};

/**
 * Settle `[when <fact>]` markers. `mode` "write" keeps every step (markers off) so the author's lint sees each, and
 * refuses an unknown fact; "raise" applies the facts. A fact that can't be settled at raise time is an R4 finding,
 * which sends the steps to the CEO instead of the owner (DR-052 point 4).
 */
export function settleWhen(steps: readonly string[], facts: WhenFacts | undefined, mode: "write" | "raise"): SettledWhen {
  const out: string[] = [];
  const dropped: SettledWhen["dropped"] = [];
  const findings: LintFinding[] = [];
  steps.forEach((raw, i) => {
    const m = WHEN_MARKER.exec(raw);
    if (!m) { out.push(raw); return; }
    const key = whenKey(m[1]!);
    const rest = raw.slice(m[0].length);
    const step = i + 1;
    if (!WHEN_FACT_KEYS.includes(key)) {
      findings.push({ step, rule: "R20", problem: `starts [when ${m[1]}], a fact Boss Man doesn't know. The facts it can settle are: ${WHEN_FACT_KEYS.join("; ")}` });
      out.push(rest);
      return;
    }
    if (mode === "write") { out.push(rest); return; }
    const value = facts?.[key];
    if (value === undefined || value === null) {
      findings.push({ step, rule: "R4", problem: `starts [when ${key}], a branch only Boss Man's own record can settle, and it couldn't right now (the record isn't available). The CEO is asked, and the card goes out once it can` });
      out.push(raw);
    } else if (value) out.push(rest);
    else dropped.push({ step, fact: key });
  });
  return { steps: out, dropped, findings };
}
