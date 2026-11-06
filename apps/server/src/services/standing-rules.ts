// Company-wide standing rules (BOS-353): a short block the owner or the CEO sets once, which every
// agent reads at the start of every run. Kept on the company row; agents can't edit it. Every change
// is kept in the company's change history so it can be undone (BOS-353 security review).
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentChanges, companies } from "../db/schema.js";

/** The most characters the rules may hold. Kept short so every brief stays small. */
export const STANDING_RULES_MAX = 2000;
/** The `agent_changes.field` value a standing-rules save is kept under. */
export const STANDING_RULES_FIELD = "standing_rules";

export type StandingRules = {
  text: string;
  /** Who changed it last, or null when it has never been set. */
  by: string | null;
  /** When it was last changed, or null when it has never been set. */
  at: Date | null;
};

export type StandingRulesWrite = { text: string; by: string; byAgentId?: string | null };

/**
 * The text as it is saved: line endings made consistent and blank space stripped from both ends, so
 * what a reviewer reads is what is stored (a run of blank lines can't hide the real text).
 */
export function normalizeStandingRules(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/** What is wrong with a set of rules, or null when it is fine. */
export function standingRulesError(text: string): string | null {
  if (text.length > STANDING_RULES_MAX) return `The standing rules can be at most ${STANDING_RULES_MAX} characters; that is ${text.length}.`;
  return null;
}

/** The company's current rules; an empty text when none are set. */
export async function getStandingRules(db: Db, companyId: string): Promise<StandingRules> {
  const [c] = await db.select({ text: companies.standingRules, by: companies.standingRulesBy, at: companies.standingRulesAt }).from(companies).where(eq(companies.id, companyId));
  return { text: c?.text ?? "", by: c?.by ?? null, at: c?.at ?? null };
}

/**
 * Saves the rules, records who changed them and when, and keeps the previous text in the change
 * history so the change can be undone. `by` is "the owner" or the CEO's name; `byAgentId` is the
 * CEO's id (null for the owner). Returns the new state; throws StandingRulesError when refused.
 */
export async function setStandingRules(db: Db, companyId: string, { text, by, byAgentId = null }: StandingRulesWrite, now = new Date()): Promise<StandingRules> {
  const trimmed = normalizeStandingRules(text);
  const problem = standingRulesError(trimmed);
  if (problem) throw new StandingRulesError(problem);
  const before = await getStandingRules(db, companyId);
  const [c] = await db.update(companies).set({ standingRules: trimmed, standingRulesBy: by, standingRulesAt: now }).where(eq(companies.id, companyId)).returning({ text: companies.standingRules, by: companies.standingRulesBy, at: companies.standingRulesAt });
  if (!c) throw new StandingRulesError("That company doesn't exist.");
  // Kept against the CEO (for an agent's change) or, when the owner makes it, the CEO's own history is
  // skipped: `agentId` is the CEO so the owner's undo has one place to live; the `by` text says who it was.
  if (byAgentId) await db.insert(agentChanges).values({ companyId, agentId: byAgentId, byAgentId, field: STANDING_RULES_FIELD, before: { text: before.text }, after: { text: trimmed } });
  return { text: c.text ?? "", by: c.by ?? null, at: c.at ?? null };
}

export class StandingRulesError extends Error {
  override name = "StandingRulesError";
}

/** The most recent standing-rules change that hasn't been undone, or null. */
export async function latestStandingRulesChange(db: Db, companyId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(agentChanges)
    .where(and(eq(agentChanges.companyId, companyId), eq(agentChanges.agentId, agentId), eq(agentChanges.field, STANDING_RULES_FIELD), isNull(agentChanges.undoneAt)))
    .orderBy(desc(agentChanges.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Puts the rules back to the text before the latest change, unless they've been changed again
 * since. Returns the restored state; throws StandingRulesError when there is nothing to undo.
 */
export async function undoStandingRules(db: Db, companyId: string, agentId: string, now = new Date()): Promise<StandingRules> {
  const change = await latestStandingRulesChange(db, companyId, agentId);
  if (!change) throw new StandingRulesError("There is no standing rules change to undo.");
  const current = await getStandingRules(db, companyId);
  const after = (change.after as { text?: string } | null)?.text ?? "";
  if (current.text !== after) throw new StandingRulesError("The standing rules have changed again since; edit them instead of undoing.");
  const before = (change.before as { text?: string } | null)?.text ?? "";
  const [c] = await db.update(companies).set({ standingRules: before, standingRulesBy: "undo", standingRulesAt: now }).where(eq(companies.id, companyId)).returning({ text: companies.standingRules, by: companies.standingRulesBy, at: companies.standingRulesAt });
  if (!c) throw new StandingRulesError("That company doesn't exist.");
  await db.update(agentChanges).set({ undoneAt: now }).where(eq(agentChanges.id, change.id));
  return { text: c.text ?? "", by: c.by ?? null, at: c.at ?? null };
}

/**
 * The brief's "Standing rules" lines, or [] when none are set. The text comes from the company and
 * is inside the brief's untrusted block like the rest of it, so the wording never tells agents to
 * obey it over anything else: it is the owner's or the CEO's notes, to weigh like the rest.
 */
export function standingRulesSection(rules: StandingRules): string[] {
  const text = rules.text.trim();
  if (!text) return [];
  return ["", "## Standing rules", `Notes the owner or your CEO set for every run${rules.by && rules.by !== "undo" ? ` (last changed by ${rules.by})` : ""}. Weigh them against the rest of the brief like any other note here.`, "", text];
}
