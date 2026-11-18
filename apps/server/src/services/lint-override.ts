import { z } from "zod";
import { type LintFinding, lintLines } from "./steps.js";

/**
 * R35: what a CEO's lintOverride covers. One reason used to clear every refused step on a card; now each entry names
 * the steps (and, if it wants, the rules) it is for, and a refused step no entry names stays refused.
 */
export type OverrideEntry = { steps: number[]; rules?: string[]; reason: string };
/** A plain string is the old form: it only works when every refusal is on one step. */
export type LintOverrideInput = string | OverrideEntry[];
/** What the card (and the ticket) keeps: the reason, with the findings it let through. */
export type CoveredOverride = { reason: string; findings: LintFinding[] };

const ENTRY = z.object({
  steps: z.array(z.number().int().min(1).max(50)).min(1).max(12),
  rules: z.array(z.string().min(1).max(5)).max(8).optional(),
  reason: z.string().max(500),
});
/** The tool schema, shared by raise_decision, escalate/reissue and ownerSetup. */
export const lintOverrideSchema = z.union([z.string().max(500), z.array(ENTRY).min(1).max(8)]);
export const LINT_OVERRIDE_HELP = "CEO only. A list of { steps: [step numbers], rules: [optional rule names, like R19], reason } entries: each names the refused step(s) it covers, and a refused step no entry names stays refused. An entry naming a step or rule with no refusal is itself refused. A plain string is accepted only when every refusal is on one step.";

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Whitespace-normalised, so lengths and stored text don't depend on line breaks. */
export function cleanOverride(o: LintOverrideInput | undefined): LintOverrideInput | undefined {
  if (o === undefined) return undefined;
  return typeof o === "string" ? clean(o) : o.map((e) => ({ steps: [...new Set(e.steps)].sort((a, b) => a - b), ...(e.rules?.length ? { rules: [...new Set(e.rules)] } : {}), reason: clean(e.reason) }));
}

/** The text stored on a ticket: a plain reason as is, a list as JSON. */
export function serializeOverride(o: LintOverrideInput): string {
  return typeof o === "string" ? o : JSON.stringify(o);
}

/** The reverse, for a stored value; anything that isn't a valid list is the old plain reason. */
export function parseStoredOverride(s: string | null | undefined): LintOverrideInput | undefined {
  const t = s?.trim();
  if (!t) return undefined;
  if (t.startsWith("[")) {
    try {
      const r = z.array(ENTRY).min(1).safeParse(JSON.parse(t));
      if (r.success) return cleanOverride(r.data);
    } catch { /* a reason that merely starts with "[" */ }
  }
  return t;
}

/** A reason shorter than 10 characters is no reason the owner can read. */
export function overrideTooShort(o: LintOverrideInput): boolean {
  return typeof o === "string" ? o.length < 10 : o.some((e) => e.reason.length < 10);
}

const where = (f: LintFinding) => `step ${f.step} (${f.rule})`;

/**
 * Match the soft refusals against the override. `strict` is the write-time check: an entry that matches no refusal is
 * itself refused, so an override can't be written ahead to cover a later edit. At go-live and on the move to review
 * (`strict` false) an entry whose refusal has since gone is simply unused.
 */
export function resolveOverride(soft: readonly LintFinding[], input: LintOverrideInput | undefined, o: { strict: boolean }): { error: string; uncovered?: LintFinding[] } | { error: null; covered: CoveredOverride[] } {
  if (input === undefined && soft.length) return { error: "No override covers these refusals.", uncovered: [...soft] };
  if (input === undefined || !soft.length) {
    if (input !== undefined && typeof input !== "string" && o.strict) return { error: `lintOverride names ${input.map((e) => `step ${e.steps.join(", ")}`).join("; ")}, but nothing was refused, so there is nothing to override. Leave lintOverride out.` };
    return { error: null, covered: [] };
  }
  let entries: OverrideEntry[];
  if (typeof input === "string") {
    const steps = [...new Set(soft.map((f) => f.step))];
    if (steps.length > 1) {
      return { error: `lintOverride as one reason can't cover refusals on steps ${steps.join(", ")}: name the steps it covers. Pass a list, for example [{ "steps": [${steps[0]}], "reason": "…" }]; any refused step it doesn't name stays refused.`, uncovered: [...soft] };
    }
    entries = [{ steps, reason: input }];
  } else entries = input;
  const covered: CoveredOverride[] = entries.map((e) => ({ reason: e.reason, findings: [] }));
  const uncovered: LintFinding[] = [];
  for (const f of soft) {
    const i = entries.findIndex((e) => e.steps.includes(f.step) && (!e.rules || e.rules.includes(f.rule)));
    if (i < 0) uncovered.push(f);
    else covered[i]!.findings.push(f);
  }
  if (uncovered.length) {
    const named = entries.map((e) => `step ${e.steps.join(", ")}${e.rules ? ` (${e.rules.join(", ")})` : ""}`).join("; ");
    return { error: `Your override covers ${named}; ${[...new Set(uncovered.map(where))].join(", ")} ${uncovered.length === 1 ? "isn't" : "aren't"} covered, so ${uncovered.length === 1 ? "it stays" : "they stay"} refused.`, uncovered };
  }
  if (o.strict) {
    for (const e of entries) {
      const missingStep = e.steps.find((s) => !soft.some((f) => f.step === s));
      if (missingStep !== undefined) return { error: `Your override for step ${missingStep} matches nothing: no refusal is on that step. Remove it from lintOverride.` };
      const missingRule = e.rules?.find((r) => !soft.some((f) => f.rule === r && e.steps.includes(f.step)));
      if (missingRule !== undefined) return { error: `Your override names ${missingRule} on step ${e.steps.join(", ")}, but no ${missingRule} refusal is there. Remove it from lintOverride.` };
    }
  }
  return { error: null, covered: covered.filter((c) => c.findings.length) };
}

/** The refusal text for uncovered findings, in the shape the callers already print. */
export function uncoveredLines(r: { error: string; uncovered?: LintFinding[] }): string {
  return r.uncovered?.length ? `${r.error}\n${lintLines(r.uncovered)}` : r.error;
}

/** The one-line "Step 3 (R19): reason" lines for a banner or a card. */
export function overrideLines(covered: readonly CoveredOverride[]): string {
  return covered.map((c) => `${c.findings.map(where).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(", ")}: ${c.reason}`).join("\n");
}
