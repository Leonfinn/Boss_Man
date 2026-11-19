// The owner-card checker (R19–R49): the pure functions that decide whether an agent's card, its text, steps and
// routing, may go to the owner. Moved out of decisions.ts unchanged (BOS-1842) so card-rule fixes stop clashing in
// that file; decisions.ts re-exports everything here, so callers and tests import it from either place.
import { splitOwnerSteps, type StepSource } from "@boss-man/shared";
import { type LintOverrideInput, cleanOverride, overrideTooShort, resolveOverride } from "./lint-override.js";
import { composeFactsFrom } from "./compose-steps.js";
import { type CardLint, type HostFacts, type SelfDeployFacts, NOT_OVERRIDABLE, fillHostTokens, fillHostTokensIn, fillServerHost, lintLines, ownerWhere, unfilledTokens, lintOwnerSteps, parseProof } from "./steps.js";
import { type CompanyFacts, fillCompanyFacts } from "./company-facts.js";
import { type OwnerRecordFacts, fillOwnerSetupTokens, usesOwnerSetupToken } from "./owner-record.js";
import type { Addon, AddonFacts } from "./addons.js";
import type { DecisionContext } from "./decisions.js";

/** The opening of a card with steps (BOS-1660): why and minutes come from the agent, where is generated from the steps. */
export type CardOpening = { why: string; minutes: number; where: string[] };
export const OPENING_WHY_MAX = 240;

/** The refusal for a card with steps whose why or minutes is missing or malformed, or null. */
export function cardOpeningProblem(why: string | undefined, minutes: number | undefined): string | null {
  const w = why?.trim() ?? "";
  const problems: string[] = [];
  if (!w) problems.push("why is missing: one sentence saying what the owner gets, or what breaks if they skip this.");
  else if (/[\r\n]/.test(w) || w.length > OPENING_WHY_MAX) problems.push(`why must be one line of at most ${OPENING_WHY_MAX} characters.`);
  if (minutes === undefined) problems.push("minutes is missing: a whole number, how long the steps take the owner.");
  else if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) problems.push("minutes must be a whole number from 1 to 480.");
  return problems.length ? `A card with steps opens with why and how long. ${problems.join(" ")} Boss Man writes the Where line itself from the steps.` : null;
}

/**
 * Fill host tokens in the owner-visible text around the steps (BOS-1660, extends DR-052), then refuse any `{{…}}` left,
 * naming the field. Without `hostValues` nothing is filled, so a token there is refused the same way (R4).
 */
export function fillCardText(f: { question?: string; options?: string[]; triedFirst: string }, hostValues?: Record<string, string>): { error: string } | { question?: string; options?: string[]; triedFirst: string } {
  const fill = (label: string, s: string): { text: string } | { error: string } => {
    let out = s;
    if (hostValues) {
      const r = fillHostTokensIn(s, hostValues);
      if (r.missing.length) return { error: `${label} uses host facts Boss Man doesn't have: ${r.missing.map((k) => `{{host.${k}}}`).join(", ")}. The host deployer hasn't reported them (it may not be applied yet, or the fact can't be detected). Ask the owner to confirm it in Settings → This host, or wait for the host's report, then raise the card again.` };
      out = r.text;
    }
    const left = unfilledTokens(out);
    return left.length ? { error: `${label} has ${left.join(", ")}, which Boss Man has no value for, so the owner would read it raw. Write the value itself, or use a {{host.…}} fact Boss Man has recorded.` } : { text: out };
  };
  const q = f.question === undefined ? undefined : fill("The question", f.question);
  if (q && "error" in q) return q;
  const options: string[] = [];
  for (const [i, o] of (f.options ?? []).entries()) {
    const r = fill(`Option ${i + 1}`, o);
    if ("error" in r) return r;
    options.push(r.text);
  }
  const tf = fill("triedFirst", f.triedFirst);
  if ("error" in tf) return tf;
  return { ...(q ? { question: q.text } : {}), ...(f.options ? { options } : {}), triedFirst: tf.text };
}

/**
 * Whether an agent's ask may be raised: it must say what was tried first, give steps when the owner has to act,
 * and its steps must work as written (BOS-417: `lintOwnerSteps`). `error` is the refusal; otherwise `lint` is what
 * the card keeps (warnings, and a CEO override). Every route that raises an agent card calls this, so the lint
 * can't be skipped: raise_decision, the CEO's reissue and escalate, and the Scrum Master's raise_decision.
 * `lintOverride` lets a refusal through with a reason; only the CEO may pass one (`byCeo`), and never past R3/R4/R10 (`NOT_OVERRIDABLE`).
 * `hosts` are the host facts Boss Man recorded (BOS-427): when given, R6 checks a login-run block against what the
 * host says it can read; without them it only checks that every block names a host and an account.
 * `serverHost` is the name the host deployer reports for the server itself (BOS-774): a card that names another host
 * is refused, a block with no host label gets this name, and `{{host}}` is filled from it; with no report yet a
 * named host is only warned about, and `{{host}}` is refused because there is nothing to fill.
 * `newHost` (DR-046) names the host a CEO-raised card is setting up, which the record has none for yet: only the CEO
 * may pass it, and only that one name may be unrecorded on the card.
 * `addons` are the add-on facts for R9 (DR-023); a route that has them passes them, and `setsUp` names the
 * add-on this card sets up, so its own setup steps aren't refused for it not running yet.
 * `proof` says how host commands were proven (R11, DR-024); a malformed one is refused before the lint runs,
 * and a good one is kept on the card for its banner.
 */
export function checkAsk(a: { ownerSetup?: OwnerRecordFacts; triedFirst: string; /** BOS-1660: the owner-visible text, filled and checked like the steps. */ question?: string; /** BOS-1660: one line on what the owner gets, or what breaks if they skip it; required with steps. */ why?: string; /** BOS-1660: a whole number of minutes; required with steps. */ minutes?: number; ownerMustDo?: boolean; steps?: string[]; options?: string[]; lintOverride?: LintOverrideInput; byCeo?: boolean; hosts?: HostFacts[]; serverHost?: string | null; newHost?: string; hostValues?: Record<string, string>; addons?: AddonFacts; setsUp?: Addon; selfDeploy?: SelfDeployFacts; proof?: string; company?: CompanyFacts; images?: Record<string, string>; mismatchedSites?: Record<string, string> }): { error: string; lint?: undefined; steps?: undefined; stepSources?: undefined; question?: undefined; options?: undefined; triedFirst?: undefined; opening?: undefined } | { error: null; lint?: CardLint; steps?: string[]; stepSources?: Array<StepSource | null>; /** The text as the owner reads it, host tokens filled (BOS-1660). */ question?: string; options?: string[]; triedFirst?: string; /** The card's opening: why and minutes from the agent, where generated from the steps (BOS-1660). */ opening?: CardOpening } {
  const t = a.triedFirst.trim();
  if (t.length < 20 || t.split(/\s+/).length < 4 || /^(n\/?a|none|nothing|no|nil|-+)\W*$/i.test(t)) {
    return { error: "triedFirst is too thin. Say what you tried yourself and why an agent can't do this (no host access, a secret only the owner can grant, owner sign-off). Try again once you have, or do it yourself." };
  }
  if (a.ownerMustDo && !a.steps?.length) {
    return { error: "The owner has to do something, so give steps: a short numbered list in plain words, with exact paths in the app (for example Settings → Server and runner → Updates → Build and update runners) and how to undo it. Prefer an in-app button over host commands." };
  }
  const override = cleanOverride(a.lintOverride);
  if (override !== undefined && !a.byCeo) return { error: "Only the CEO can pass lintOverride. Fix the steps instead, or ask the CEO to raise the card." };
  if (override !== undefined && overrideTooShort(override)) return { error: "lintOverride needs a reason the owner can read, at least 10 characters." };
  // BOS-1660: the question, the options and triedFirst are read by the owner as much as the steps, so host tokens are filled
  // there too, and one left over (no recorded fact, or a caller with none) refuses the card, naming the field.
  const text = fillCardText({ question: a.question, options: a.options, triedFirst: a.triedFirst.trim() }, a.hostValues);
  if ("error" in text) return { error: text.error };
  const shown = { question: text.question, options: text.options, triedFirst: text.triedFirst };
  if (!a.steps?.length) return { error: null, ...shown };
  const proof = a.proof?.trim() ? parseProof(a.proof) : undefined;
  if (typeof proof === "string") return { error: `The ${proof}.` };
  // `{{host.…}}` tokens (DR-008): filled from the recorded host facts before the lint, so the lint reads what the owner
  // will. A fact that isn't recorded stops the card; a caller with no facts leaves the token, which R4 refuses.
  // DR-057: another company's facts (tokens, "[if … exists]" branches, R18b) before the host facts, as on a setup card.
  const company = fillCompanyFacts(a.steps, a.company, "raise");
  let steps = company.steps;
  if (a.hostValues) {
    const filled = fillHostTokens(steps, a.hostValues);
    if (filled.missing.length) {
      return { error: `These steps use host facts Boss Man doesn't have: ${filled.missing.map((k) => `{{host.${k}}}`).join(", ")}. The host deployer hasn't reported them (it may not be applied yet, or the fact can't be detected). Ask the owner to confirm it in Settings → Server and runner → This server, or wait for the host's report, then raise the card again.` };
    }
    steps = filled.steps;
  }
  // BOS-1596: `{{checkWorkers.…}}` is filled from the record of what the owner has set up; a caller with no record leaves the token (R4 refuses it).
  if (a.ownerSetup && usesOwnerSetupToken(steps)) {
    const filled = fillOwnerSetupTokens(steps, a.ownerSetup);
    if (filled.missing.length) return { error: `These steps use worker facts Boss Man doesn't have: ${filled.missing.map((k) => `{{checkWorkers.${k}}}`).join(", ")}. Known: added, everConnected, online.` };
    steps = filled.steps;
  }
  // DR-046: a card that sets up a new host may name that one host, which isn't in the record yet. Only the CEO can
  // mark it, and only as a plain name (the same shape a fence line accepts).
  const newHost = a.newHost?.trim() || undefined;
  if (newHost !== undefined) {
    if (!a.byCeo) return { error: "Only the CEO can pass newHost: a host Boss Man has no record for may be named only on the card the CEO raises to set it up. Write host=\"{{host}}\" for the server Boss Man runs on, or leave the host out." };
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(newHost)) return { error: "newHost must be a plain host name (letters, digits, dot, dash, underscore), like the fence line's host." };
    // The new host's own name, where it is recorded, is the same as naming another host: refuse it, so a move card
    // can't quietly point at a host that already has a record under a different name.
    if (a.hosts?.some((h) => h.name.toLowerCase() === newHost.toLowerCase())) return { error: `newHost names "${newHost}", which Boss Man already has a record for, so the card can name it as host="${a.hosts.find((h) => h.name.toLowerCase() === newHost.toLowerCase())!.name}" directly.` };
  }
  // BOS-774: a block that names the account but leaves the host out runs on the server Boss Man runs on, so the
  // reported name is filled in rather than a default. A block that names no host and no account is left for R6.
  // DR-046: `{{host}}` names that same server, filled from the report; with no report it can't be filled, so say so
  // plainly rather than leave an unfilled token for R4.
  const usesHostToken = steps.some((s) => /\{\{\s*host\s*\}\}/.test(s));
  if (usesHostToken && !(a.serverHost?.trim())) {
    return { error: "These steps use {{host}} to name the server Boss Man runs on, but the host deployer hasn't reported a name yet (it may not be set up). Write the server's name yourself, or wait for the host's report, then raise the card again." };
  }
  steps = fillServerHost(steps, a.serverHost);
  const compose = composeFactsFrom(a.hostValues);
  const lint0 = lintOwnerSteps(steps, { ...(compose ? { compose } : {}), ...(a.options ? { options: a.options } : {}), ...(a.hosts ? { hosts: a.hosts } : {}), ...(a.serverHost ? { serverHost: a.serverHost } : {}), ...(newHost ? { newHost } : {}), ...(a.addons ? { addons: a.addons, setsUp: a.setsUp } : {}), ...(a.selfDeploy ? { selfDeploy: a.selfDeploy } : {}), ...(a.images ? { images: a.images } : {}), ...(a.mismatchedSites ? { mismatchedSites: a.mismatchedSites } : {}) }, proof);
  const refuse = [...company.findings, ...lint0.refuse];
  const warn = lint0.warn;
  const hard = refuse.filter((f) => NOT_OVERRIDABLE.has(f.rule));
  const soft = refuse.filter((f) => !NOT_OVERRIDABLE.has(f.rule));
  const tail = "Fix the steps and raise it again. The owner pastes each command exactly as written and has no other document open.";
  if (hard.length) return { error: `These steps can't go to the owner as written:\n${lintLines(refuse)}\n${tail}${override ? " lintOverride can't let through a command that isn't copy-safe, a value Boss Man doesn't have, or a command that waits for typed input, opens a pager or never returns." : ""}` };
  if (soft.length && !override) return { error: `These steps can't go to the owner as written:\n${lintLines(soft)}\n${tail}${a.byCeo ? " If a finding is wrong, pass lintOverride naming the step and the reason; the owner sees it on the card." : ""}` };
  // R35: the override must name each refused step; one it doesn't name stays refused.
  const resolved = resolveOverride(soft, override, { strict: true });
  if (resolved.error !== null) return { error: `These steps can't go to the owner as written:\n${resolved.uncovered?.length ? lintLines(resolved.uncovered) : resolved.error}\n${resolved.uncovered?.length ? `${resolved.error}\n` : ""}${tail}` };
  const covered = resolved.covered;
  // BOS-1660: after the lint, so a step that can't work as written is told so first. "Where" is worked out from the steps,
  // never typed; a step that names no place is refused, and the card opens with why and minutes.
  const openingProblem = cardOpeningProblem(a.why, a.minutes);
  if (openingProblem) return { error: openingProblem };
  const place = ownerWhere(steps, a.serverHost);
  if (place.missing.length) return { error: `${place.missing.length === 1 ? `Step ${place.missing[0]} doesn't` : `Steps ${place.missing.join(", ")} don't`} say where ${place.missing.length === 1 ? "it" : "they"} happen${place.missing.length === 1 ? "s" : ""}. Say where this step happens: a command block that names its host, a Settings → path, or the website it is on. Boss Man writes the card's Where line from these.` };
  const lint: CardLint = { warn, ...(covered.length ? { override: { reason: covered.map((c) => c.reason).join(" "), findings: covered.flatMap((c) => c.findings), entries: covered } } : {}), ...(proof ? { proof } : {}) };
  // BOS-1665: the checker read the tags above; the owner's steps leave here without them, and the source of each step
  // is kept beside them for the muted "Written from…" line. No screen or push has to remember to strip a tag.
  const owner = splitOwnerSteps(steps, a.images);
  return { error: null, ...shown, opening: { why: a.why!.trim(), minutes: a.minutes!, where: place.where }, steps: owner.steps, ...(owner.stepSources ? { stepSources: owner.stepSources } : {}), ...(lint.warn.length || lint.override || lint.proof ? { lint } : {}) };
}

/**
 * The only reasons an agent's card stays on the owner's queue without steps (BOS-1318): a fixed list,
 * never guessed from the card's wording, so a mistake errs toward the owner.
 */
export const OWNER_ONLY_KINDS = ["secret", "money", "host", "signoff", "owner_choice", "owner_setup"] as const;
export type OwnerOnlyKind = (typeof OWNER_ONLY_KINDS)[number];

/**
 * Where an agent's raise_decision card goes (BOS-1318), by structure only. "owner" unless nothing about the
 * card needs the owner: no ownerOnly kind, no steps, not ownerMustDo, not an add-on setup, not an after-merge
 * check, raised by an agent that is not the CEO, and a CEO that can take it.
 */
export function routeAgentCard(c: { ownerOnly?: OwnerOnlyKind; ownerMustDo?: boolean; steps?: string[]; setsUp?: unknown; criterionIndexes?: number[]; raiserRole: string | null; ceoAvailable: boolean; recordSays?: boolean }): { tier: "owner" | "ceo"; why: string } {
  if (c.ownerOnly) return { tier: "owner", why: `owner-only: ${c.ownerOnly}` };
  // BOS-1797: the card asks something Boss Man's record has a value for (raised anyway with stillNeeded, or the record
  // is stale). The CEO checks it against the record first, even when it has steps, so the owner isn't asked what
  // Boss Man may know. Not an after-merge check: only the owner's answer may record that.
  if (c.recordSays && !c.criterionIndexes?.length && c.raiserRole !== null && c.raiserRole !== "ceo" && c.ceoAvailable) return { tier: "ceo", why: "Boss Man's record already has a value for what it asks" };
  if (c.ownerMustDo || c.steps?.length) return { tier: "owner", why: "the owner has steps to do" };
  if (c.setsUp) return { tier: "owner", why: "an add-on setup card" };
  if (c.criterionIndexes?.length) return { tier: "owner", why: "the owner's after-merge check" };
  if (c.raiserRole === null || c.raiserRole === "ceo") return { tier: "owner", why: "the CEO can't answer its own card, or no agent raised it" };
  if (!c.ceoAvailable) return { tier: "owner", why: "the CEO can't take it now" };
  return { tier: "ceo", why: "a team question goes to the CEO first" };
}

// Who may answer a card (BOS-149, BOS-1318): the answer-side card rules, moved here unchanged with the
// option texts they check (BOS-1842). DecisionContext is a type import only, so there is no runtime cycle.
export const CHECK_AGAIN = "Run the check again";
export const CHECK_SEND_BACK = "Send it back to the agent";
export const CHECK_SKIP = "Merge without the check";
/** A stalled review (BOS-404, BOS-426): real actions on the review instead of "Got it". */
export const TAKE_REVIEW = "Take the review myself";
export const REASSIGN_REVIEW = "Give it to another reviewer";
export const SEND_BACK_FOR_MERGE = "Send it back to the author";
export const WAIT_ANOTHER_HOUR = "Leave it another hour";
export const REVIEW_STALL_ACTIONS = [TAKE_REVIEW, REASSIGN_REVIEW, SEND_BACK_FOR_MERGE, WAIT_ANOTHER_HOUR];

/**
 * Cards that answer an action rather than make an owner choice: a merge retry and Boss Man's own
 * "Got it" notices and alerts. The CEO may answer these even when they sit on the owner's tier.
 */
export function isSystemCard(d: { kind: string; tier: string; options: unknown; context: unknown }): boolean {
  const ctx = d.context as DecisionContext & { ladder?: unknown };
  if (ctx.type === "check_stuck") return true;
  // A card with steps asks the owner to do something, so it is never a system card (BOS-149),
  // even when its only option is "Got it": the ladder keeps the steps of what it escalated.
  const steps = (ctx as { steps?: unknown }).steps;
  if (Array.isArray(steps) && steps.length) return false;
  const options = Array.isArray(d.options) ? (d.options as string[]) : [];
  // Boss Man's alerts that only need acknowledging.
  if (ctx.ladder && options.length === 1 && options[0] === "Got it") return true;
  // Notices such as "your answer couldn't reach the runner".
  return ctx.type === "question" && options.length === 1 && options[0] === "Got it" && !ctx.steps?.length;
}

/**
 * Why the CEO may not answer this card, or null. Enforced in `answer()` itself, so it holds for every
 * caller, not just the MCP tool: owner sign-offs, deploys, hires, instruction changes, owner-only
 * permissions and the rest stay the owner's.
 */
export function ceoAnswerRefusal(d: { kind: string; tier: string; options: unknown; context: unknown }, answer?: string, opts: { ladder?: boolean } = {}): string | null {
  const ctx = d.context as DecisionContext & { ladder?: { rung?: string } };
  // An alert still with the Scrum Master is not the CEO's yet (BOS-64): settling it here would close it
  // and the owner would never see the escalation (BOS-149). The rung rule is for the CEO only, because
  // the Scrum Master settles its own alerts through the same path.
  if (opts.ladder !== false && ctx.ladder?.rung === "scrum_master") return "This alert is still with the Scrum Master, so it isn't yours to settle yet. Leave it for the ladder to hand over.";
  // An alert that has climbed to the owner has already failed the Scrum Master and the CEO, so it is
  // the owner's now: closing it here would take it off their queue without their seeing it (BOS-149).
  if (opts.ladder !== false && ctx.ladder?.rung === "owner") return "This alert is already with the owner, so it isn't yours to settle. Leave it for them.";
  if (OWNER_ONLY_ANSWER_TYPES.has(ctx.type)) return "Only the owner can answer this kind of decision. Leave it for them; if they asked for your advice, use action advise.";
  if (ctx.type === "question" && ctx.steps?.length) return "This asks the owner to do something, so only they can answer it. Leave it for them; if they asked for your advice, use action advise.";
  // BOS-1318: a card marked owner-only stays the owner's even if a row were ever left on the CEO's tier.
  if (ctx.type === "question" && (ctx.ownerOnly || ctx.ownerMustDo)) return "This card is marked as the owner's alone (a secret, money, a host step, a sign-off or an owner choice), so only they can answer it. Leave it for them; if they asked for your advice, use action advise.";
  if (ctx.type === "review_stall" && answer !== undefined && !REVIEW_STALL_ACTIONS.includes(answer)) return `On a stalled review, choose one of: ${REVIEW_STALL_ACTIONS.join(", ")}.`;
  if (d.tier === "owner" && !isSystemCard(d)) return "This card is the owner's to answer. Leave it for them; if they asked for your advice, use action advise.";
  if (isSystemCard(d)) {
    // An allow-list, not a single refusal: anything added to a system card later stays off the CEO's list.
    // On a merge card only the retry and the send-back are safe; "Merge without the check" is the owner's.
    const allowed = ctx.type === "check_stuck" ? [CHECK_AGAIN, CHECK_SEND_BACK] : ["Got it"];
    if (!answer || !allowed.includes(answer)) {
      return ctx.type === "check_stuck"
        ? `The CEO may only choose "${CHECK_AGAIN}" or "${CHECK_SEND_BACK}" on this card. Leave "${CHECK_SKIP}" and any other choice to the owner.`
        : "The CEO may only acknowledge this card with \"Got it\".";
    }
  }
  return null;
}

/** Context types that are always the owner's call, even if a row was somehow left at the CEO's tier. */
export const OWNER_ONLY_ANSWER_TYPES = new Set([
  "deploy",
  "self_deploy",
  "owner_todo",
  "owner_setup",
  "maintenance",
  "deploy_wait",
  "hire",
  "instructions",
  "rename",
  "standing_rules",
  "model_change",
  "team_plan",
  "risk_review",
  "budget_limit",
  "engagement",
  "project_cap",
  "run_time_limit",
  "fence_default",
  "fence_unavailable",
  "guard_unavailable",
  "ticket_cap",
  "rule_proposal",
  "goal_check",
  "feature_portal_hold",
]);

/** Files for a card, cut at whole names with a count of the rest, so a long list never looks complete. */
export function fileList(files: string[], max: number): string {
  let out = "";
  let shown = 0;
  for (const f of files) {
    const next = out ? `${out}, ${f}` : f;
    if (next.length > max) break;
    out = next;
    shown++;
  }
  return shown < files.length ? `${out}${out ? ", " : ""}…and ${files.length - shown} more` : out;
}
