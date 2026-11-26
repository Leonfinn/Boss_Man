// DR-052: one card check for a ticket's owner setup steps (the "it's live, now do this" card, DR-011), used both
// when the steps are written (create_ticket, update_ticket, set_ticket_state ownerSetup and the move to review)
// and when the card is raised at go-live (raiseOwnerSetup). The same fill and the same lint run both times, so
// the author finds out while they still have the ticket, and the owner only ever sees steps that passed.
//
// Host values come from the host deployer's report (host-facts.ts), never from text: authors write
// `{{host.env.file}}` or `{{host.compose.cmd}} restart <service>`, and the card shows this server's real values.
import { type CompanyFacts, fillCompanyFacts } from "./company-facts.js";
import { composeFactsFrom } from "./compose-steps.js";
import { type WhenFacts, branchingFindings, settleWhen } from "./owner-setup-when.js";
import { type LintOverrideInput, type OverrideEntry, cleanOverride, overrideTooShort, resolveOverride, serializeOverride } from "./lint-override.js";
import { type HostFacts, type LintFinding, NOT_OVERRIDABLE, THIS_HOST_POINTER, fillServerHost, lintLines, lintOwnerSteps, placeFindings } from "./steps.js";

/**
 * The host facts a setup step may name, and the plain words the card uses when the host hasn't reported one
 * (DR-052 point 5, the DR-046 "unconfirmed, not refused" rule): a fresh install with no deployer still gets a
 * card, which says where Boss Man shows the value once it knows it.
 */
export const HOST_FACT_LABELS: Readonly<Record<string, string>> = {
  "env.file": "the .env file the stack starts with",
  "compose.cmd": "the docker compose command for this stack",
  "compose.files": "the compose files",
  "paths.install": "the install folder",
  "paths.src": "the source folder (the checkout Boss Man runs from)",
  "paths.deployer": "the host deployer's folder",
  "ntfy.container": "the ntfy container",
};

/** What authors are told to write, for refusals and tool help. */
export const HOST_TOKEN_HELP =
  "Name host files and commands with tokens, never a host path, address or container name: {{host.env.file}} (the .env the stack starts with), {{host.compose.cmd}} restart <service> (the docker compose command for this host), {{host.paths.install}}, {{host.paths.src}}, {{host.paths.deployer}}, {{host.ntfy.container}}. Boss Man fills in this server's values when the card goes out; a button in the app is written as its path (Settings → …). A step on one of Boss Man's forms (a deploy target, tool server, secret or funding source) gives every field's value; another company's deploy target is {{company.<slug>.deployTarget.name}} (also kind, address, tagName), and a value only that company knows cites engagement:<id> of their answer.";

const TOKEN = /\{\{\s*host\.([A-Za-z0-9_.]{1,80})\s*\}\}/g;
/** A value that can go into a step as it is: one line, no backtick (it would end inline code). */
const usable = (v: string | undefined): v is string => v !== undefined && !!v.trim() && !/[\n\r`]/.test(v);

/**
 * Fill each `{{host.KEY}}` from the facts. A known fact the host hasn't reported becomes its plain label plus where
 * Boss Man shows it, but only in the words: inside inline code a label would break the command, so the token stays
 * and R4 refuses it (at go-live that sends the steps to the CEO; when written it is let through, see below).
 * `generic` says a label was used, so the card can say Boss Man doesn't know this server's folders yet.
 */
export function fillOwnerSetup(steps: readonly string[], values: Readonly<Record<string, string>>): { steps: string[]; generic: boolean } {
  let generic = false;
  const out = steps.map((s) => {
    const code: [number, number][] = [...s.matchAll(/`[^`\n]+`/g)].map((m) => [m.index, m.index + m[0].length]);
    return s.replace(TOKEN, (token, key: string, at: number) => {
      const v = Object.hasOwn(values, key) ? values[key] : undefined;
      if (usable(v)) return v;
      const label = Object.hasOwn(HOST_FACT_LABELS, key) ? HOST_FACT_LABELS[key] : undefined;
      if (!label || code.some(([a, b]) => at >= a && at < b)) return token;
      generic = true;
      return `${label} (${THIS_HOST_POINTER} shows it)`;
    });
  });
  return { steps: out, generic };
}

/** `company` (DR-057): other companies' records for `{{company.…}}` tokens, branches and R18b (company-facts.ts). */
export type OwnerSetupFacts = { values?: Record<string, string>; serverHost?: string | null; hosts?: HostFacts[]; company?: CompanyFacts; /** BOS-1650: settled `[when <fact>]` values (owner-setup-when.ts); read at raise time only. */ when?: WhenFacts;
  /** BOS-2336: a to-do card (raiseOwnerTodo) gives its own options, so R19 and R19c check the stop it offers; a ticket's setup steps give none. */ options?: readonly string[];
  /** BOS-2336: ticket image id → created-at, for R19's 30-day rule. */ images?: Record<string, string>;
  /** BOS-2336: sites whose docs misled the owner lately (outside-site-mismatch.ts), for R19b. */ mismatchedSites?: Record<string, string>;
  /** The clock for R19; tests set it. */ now?: Date;
  /**
   * BOS-2336: set for a Boss Man-written to-do (raiseOwnerTodo). Its R20 (a prose branch) and R21 (every step names a
   * place) are not applied: they exist so a ticket author's setup steps read as one flat list with a "Where" line, but
   * Boss Man's own hand-apply and service cards carry informational lines and "if it says standby, run this next"
   * branches by design. R19, R19b, R19c, the host fences (R6, R31) and every other rule still run.
   */
  todo?: boolean };

/** The one-line limit for the "why" and "if skipped" fields of a ticket's owner setup (BOS-1650). */
export const SETUP_LINE_MAX = 240;
/** What the card says when a ticket was written before these fields existed: raised anyway, never dropped. */
export const NOT_GIVEN = "not given";

/**
 * BOS-1650: a ticket with owner setup steps says why (what it changes for the owner) and what happens if skipped
 * ("nothing breaks" is an answer). Checks presence and shape (one line), not prose quality. Null when fine or when
 * there are no steps.
 */
export function ownerSetupShapeProblem(steps: readonly string[], why: string | null | undefined, ifSkipped: string | null | undefined): string | null {
  if (!steps.length) return null;
  const bad = (label: string, field: string, v: string | null | undefined) => {
    const t = v?.trim() ?? "";
    if (!t) return `${field} is missing: one line saying ${label}.`;
    if (/[\r\n]/.test(t) || t.length > SETUP_LINE_MAX) return `${field} must be one line of at most ${SETUP_LINE_MAX} characters.`;
    return null;
  };
  const problems = [bad("what this changes for the owner", "ownerSetupWhy", why), bad('what happens if they skip it (write "nothing breaks" if that is true)', "ownerSetupIfSkipped", ifSkipped)].filter((p): p is string => !!p);
  return problems.length ? `The owner setup needs two one-line fields besides its steps, and the card opens with them. ${problems.join(" ")}` : null;
}

/** The facts both checks use, read from the host-facts service: every recorded fact's value, the server's
 * reported name and the hosts for R6. The same inputs raise_decision gives checkAsk. */
export async function ownerSetupFacts(hf: { sync: () => Promise<{ facts: Record<string, { value: string }> }>; serverHost: () => Promise<string | null>; hosts: () => Promise<HostFacts[]> }): Promise<OwnerSetupFacts> {
  const rec = await hf.sync();
  return { values: Object.fromEntries(Object.entries(rec.facts).map(([k, f]) => [k, f.value])), serverHost: await hf.serverHost(), hosts: await hf.hosts() };
}
export type OwnerSetupCheck = {
  /** The steps as the owner will read them: tokens filled, or their labels. */
  steps: string[];
  generic: boolean;
  /** Refusals no override lets through (R3, R4, R10, R14, R15). */
  hard: LintFinding[];
  /** Refusals a CEO override can let through, with a reason. */
  soft: LintFinding[];
  warn: LintFinding[];
  /** BOS-1880: the card's "Where" lines, one per place in the order first met. */
  where: string[];
  /** BOS-1650: steps left out because their `[when <fact>]` is false (raise mode). */
  dropped: { step: number; fact: string }[];
};

/**
 * Fill and lint a ticket's setup steps. `mode` is "write" while the ticket is being worked on and "raise" at go-live.
 * Two rules differ from an agent's card (checkAsk), each for a reason:
 * - R11 (a host command needs a rehearsal proof) never runs: a ticket has no proof field, and the steps are
 *   checked by review and by this lint instead.
 * - When written, an R4 on a known host token is dropped: the host may simply not have reported that fact yet (a
 *   dev install, an older deployer). At go-live it stays, and the steps go to the CEO rather than the owner.
 */
export function checkOwnerSetup(steps: readonly string[], facts: OwnerSetupFacts, mode: "write" | "raise"): OwnerSetupCheck {
  // Company facts first (DR-057): a branch the record settles is dropped before anything else reads the steps.
  const settled = settleWhen(steps, facts.when, mode);
  const company = fillCompanyFacts(settled.steps, facts.company, mode);
  const filled = fillOwnerSetup(company.steps, facts.values ?? {});
  const shown = fillServerHost(filled.steps, facts.serverHost);
  const compose = composeFactsFrom(facts.values);
  const lint = lintOwnerSteps(shown, { ...(compose ? { compose } : {}), ...(facts.hosts ? { hosts: facts.hosts } : {}), ...(facts.serverHost ? { serverHost: facts.serverHost } : {}), ...(facts.options ? { options: facts.options } : {}), ...(facts.images ? { images: facts.images } : {}), ...(facts.mismatchedSites ? { mismatchedSites: facts.mismatchedSites } : {}), ...(facts.now ? { now: facts.now } : {}) });
  // R20 (BOS-1650) runs on the steps as the owner will read them, after every marker is settled.
  // BOS-1880: the same place check a card gets (BOS-1660), on the steps as the owner reads them, so a go-live card
  // can't send the owner to "the card" for a place. Its Where lines go on the card.
  const place = placeFindings(shown, facts.serverHost);
  const refuse = [...settled.findings, ...company.findings, ...lint.refuse, ...branchingFindings(shown), ...place.findings];
  const warn = lint.warn;
  // When written, a company token may have no record yet (the other company adds its target before go-live); a
  // known host fact may be unreported. At go-live both stay, and the steps go to the CEO.
  const knownGap = (f: LintFinding) => f.rule === "R4" && (Object.hasOwn(HOST_FACT_LABELS, /^has \{\{host\.([A-Za-z0-9_.]+)\}\}/.exec(f.problem)?.[1] ?? "") || /^has \{\{company\.[a-z0-9-]+\.deployTarget\.(?:name|kind|address|tagName)\}\}/.test(f.problem));
  // R32 (BOS-2730) is a write-time rule: steps saved before it existed are not re-checked at go-live, and steps written
  // since passed it when written.
  const kept = refuse.filter((f) => f.rule !== "R11" && !(mode === "raise" && f.rule === "R32") &&!(mode === "write" && knownGap(f)) && !(facts.todo && (f.rule === "R20" || f.rule === "R21")));
  return { steps: shown, generic: filled.generic, where: place.where, hard: kept.filter((f) => NOT_OVERRIDABLE.has(f.rule)), soft: kept.filter((f) => !NOT_OVERRIDABLE.has(f.rule)), warn, dropped: settled.dropped };
}

/**
 * The write-time check (DR-052 point 1). Returns the refusal, or the override to store with the steps (null when
 * nothing needed one). `lintOverride` is the CEO's alone, with a reason of 10 characters or more, as on raise_decision
 * (DR-008); it can't let through a hard refusal.
 */
export function ownerSetupWriteCheck(steps: readonly string[], facts: OwnerSetupFacts, o: { lintOverride?: LintOverrideInput; byCeo: boolean; /** R35: false when re-checking an override stored earlier, where an entry whose refusal has since gone is just unused. */ strict?: boolean }): { error: string } | { error: null; override: string | null } {
  const override = cleanOverride(o.lintOverride);
  if (override !== undefined && !o.byCeo) return { error: "Only the CEO can pass lintOverride. Fix the setup steps instead." };
  if (override !== undefined && overrideTooShort(override)) return { error: "lintOverride needs a reason the owner can read, at least 10 characters." };
  if (!steps.length) return { error: null, override: null };
  const c0 = checkOwnerSetup(steps, facts, "write");
  // `strict: false` is the re-check of steps already stored (the move to review): R32 only judges what is written now.
  const c = o.strict === false ? { ...c0, soft: c0.soft.filter((f) => f.rule !== "R32") } : c0;
  const head = "These owner setup steps can't go to the owner as written (one step per line):";
  const tail = `The owner pastes each command exactly as written and has no other document open. ${HOST_TOKEN_HELP}`;
  if (c.hard.length) return { error: `${head}\n${lintLines([...c.hard, ...c.soft])}\n${tail}` };
  if (c.soft.length && !override) return { error: `${head}\n${lintLines(c.soft)}\n${tail}${o.byCeo ? " If a finding is wrong, pass lintOverride with the reason; the owner sees it on the card." : ""}` };
  // R35: the override must name each refused step; one it doesn't name stays refused.
  const resolved = resolveOverride(c.soft, override, { strict: o.strict !== false });
  if (resolved.error !== null) return { error: `${head}\n${resolved.uncovered?.length ? lintLines(resolved.uncovered) : resolved.error}\n${resolved.uncovered?.length ? `${resolved.error}\n` : ""}${tail}` };
  // What is stored is what was let through, step by step, so go-live reads the same scope.
  const kept: OverrideEntry[] = resolved.covered.map((cv) => ({ steps: [...new Set(cv.findings.map((f) => f.step))].sort((a, b) => a - b), rules: [...new Set(cv.findings.map((f) => f.rule))], reason: cv.reason }));
  return { error: null, override: kept.length ? serializeOverride(kept) : null };
}
