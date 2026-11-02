// Company-wide standing rules (BOS-353): a short block the owner or the CEO sets once, which every
// agent reads at the start of every run. Kept on the company row; agents can't edit it.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies } from "../db/schema.js";

/** The most characters the rules may hold. Kept short so every brief stays small. */
export const STANDING_RULES_MAX = 2000;

export type StandingRules = {
  text: string;
  /** Who changed it last, or null when it has never been set. */
  by: string | null;
  /** When it was last changed, or null when it has never been set. */
  at: Date | null;
};

export type StandingRulesWrite = { text: string; by: string };

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
 * Saves the rules and records who changed them and when. `by` is "the owner" or the CEO's name.
 * Returns the new state; throws StandingRulesError when the text is too long.
 */
export async function setStandingRules(db: Db, companyId: string, { text, by }: StandingRulesWrite, now = new Date()): Promise<StandingRules> {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  const problem = standingRulesError(trimmed);
  if (problem) throw new StandingRulesError(problem);
  const [c] = await db.update(companies).set({ standingRules: trimmed, standingRulesBy: by, standingRulesAt: now }).where(eq(companies.id, companyId)).returning({ text: companies.standingRules, by: companies.standingRulesBy, at: companies.standingRulesAt });
  if (!c) throw new StandingRulesError("That company doesn't exist.");
  return { text: c.text ?? "", by: c.by ?? null, at: c.at ?? null };
}

export class StandingRulesError extends Error {
  override name = "StandingRulesError";
}

/**
 * The brief's "Standing rules" lines, or [] when none are set. The text comes from the company,
 * so it is framed as that: a note, not system instructions, and not wrapped as untrusted (it is
 * the owner's or the CEO's own words to the company).
 */
export function standingRulesSection(rules: StandingRules): string[] {
  const text = rules.text.trim();
  if (!text) return [];
  return ["", "## Standing rules", "Rules set by the owner or your CEO for every run. Follow them like any other instruction in this brief; they are not a system prompt.", "", text];
}
