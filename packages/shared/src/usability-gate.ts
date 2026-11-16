// The usability gate (BOS-1571): a feature must deliver its value in real use, without the owner on
// hand, not just work once. The check worker passed five reviews and the owner's sign-off, yet went
// idle after every runner update until the owner hand-edited a file; nobody asked "what does the owner
// repeat, and how often?". These helpers decide which tickets carry that question, add it as a
// criterion, read a reviewer's "Real use:" walk-through, and flag wording that hands the owner a
// routine duty. Plain text matching on purpose: every refusal says exactly what to write.
import { criterionText, type Criterion } from "./acceptance.js";

/** The criterion every gated ticket carries. Checked before merge, like any plain criterion. */
export const USABILITY_CRITERION =
  "Usability gate: it delivers its value in real use without the owner on hand: day 1, after routine updates and restarts, and a week on. A step the owner must repeat routinely, or a feature that only works while someone watches it, fails.";

/** The label a reviewer's walk-through starts with. */
export const REAL_USE_LABEL = "Real use:";

/** A walk-through shorter than this ("Real use: fine") says nothing. */
export const REAL_USE_MIN_CHARS = 40;

/** What the walk-through covers, worded once for the refusals, the wake and the tool texts. */
export const REAL_USE_ASK =
  'walk the owner\'s life with it: day 1, after the next "Build and update runners" or server update, after a restart, a week on, and the owner away. Name every step the owner repeats and how often. A step they must repeat routinely, or one that only works while someone watches it, fails: request changes.';

/** The criteria cap (acceptanceCriteriaSchema). */
const MAX_CRITERIA = 10;

/** A usability-gate criterion, built in or written by hand ("USABILITY GATE (applies to this ticket too): …"). */
export const isUsabilityCriterion = (c: Criterion): boolean => /^\s*usability gate\b/i.test(criterionText(c));

export interface GateFields {
  featureId?: string | null;
  ownerSetup?: string | null;
  noCode?: boolean | null;
}

/** A feature's ticket, or one with steps the owner does once it is live; never a no-code ticket. */
export const needsUsabilityGate = (t: GateFields): boolean => !t.noCode && (!!t.featureId || !!t.ownerSetup?.trim());

/** The criteria with the built-in usability criterion added where the ticket needs it and has none.
 * At the 10-criterion cap the list is returned unchanged; the review gate still applies (usabilityGated). */
export function withUsabilityCriterion(criteria: readonly Criterion[], t: GateFields): Criterion[] {
  if (!needsUsabilityGate(t) || criteria.some(isUsabilityCriterion) || criteria.length >= MAX_CRITERIA) return [...criteria];
  return [...criteria, USABILITY_CRITERION];
}

/** True when withUsabilityCriterion added the criterion (so a reply can say so). */
export const addsUsabilityCriterion = (criteria: readonly Criterion[], t: GateFields): boolean => withUsabilityCriterion(criteria, t).length > criteria.length;

/** Files the owner installs or runs from: compose files, deploy/, any Dockerfile, and install or setup docs. */
const INSTALL_SURFACE = [/(^|\/)docker-compose[^/]*\.ya?ml$/i, /(^|\/)compose[^/]*\.ya?ml$/i, /^deploy\//, /(^|\/)Dockerfile[^/]*$/, /^docs\/[^/]*(install|setup|host|worker|upgrad|updat|truenas|proxmox|self-deploy)[^/]*\.md$/i];

/** True when a change touches how the owner installs, runs or updates something. */
export const touchesInstallSurface = (paths: readonly string[]): boolean => paths.some((p) => INSTALL_SURFACE.some((re) => re.test(p)));

/** A ticket the review gate applies to: it carries a usability criterion (stored or due), or its change touches an install surface. */
export function usabilityGated(t: GateFields & { acceptanceCriteria?: readonly Criterion[] | null }, files: readonly string[] = []): boolean {
  return (t.acceptanceCriteria ?? []).some(isUsabilityCriterion) || needsUsabilityGate(t) || touchesInstallSurface(files);
}

/** The walk-through after a "Real use:" label, or null when there is none or it is too short to say anything. */
export function realUseWalkthrough(text: string | null | undefined): string | null {
  const m = /\breal[ -]use\s*:\s*([\s\S]*)/i.exec(text ?? "");
  const said = m?.[1]?.trim() ?? "";
  return said.length >= REAL_USE_MIN_CHARS ? said : null;
}

/** Wording that hands the owner a routine duty: each one should say how often, or be automated. */
const RECURRING_DUTY: readonly RegExp[] = [
  /\b(after|on) (every|each) (update|upgrade|restart|rebuild|reboot|deploy|release|runner update)/i,
  /\beach time (you|the owner|the runner|a runner|the server|boss man) /i,
  /\buntil then\b[^.\n]{0,80}\b(idle|stopped|stops|won't|will not|doesn't|does not|can't|cannot|off)\b/i,
  /\bdo this soon\b/i,
  /\b(you|the owner) (must|need to|have to|should) [^.\n]{0,60}\b(every day|daily|weekly|every week|each day|regularly|again)\b/i,
  /\b(every day|daily|weekly|every week|each day|regularly)\b[^.\n]{0,40}\b(you|the owner) (must|need to|have to)\b/i,
  /\bremember to\b/i,
];

/** The lines of a text that read as a routine owner duty, each trimmed to 160 characters. */
export function recurringDutyHits(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && RECURRING_DUTY.some((re) => re.test(l)))
    .map((l) => (l.length > 160 ? `${l.slice(0, 157)}...` : l));
}

/** The added lines of a unified diff that read as a routine owner duty, with the file and new line number. */
export function recurringDutyInDiff(diff: string): Array<{ path: string; line: number; text: string }> {
  const out: Array<{ path: string; line: number; text: string }> = [];
  let path = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      path = raw.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      const hit = recurringDutyHits(raw.slice(1))[0];
      if (hit && path) out.push({ path, line, text: hit });
      line++;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) line++;
  }
  return out;
}

/** submit_plan's refusal on a gated ticket whose plan has no walk-through. */
export const PLAN_REAL_USE_REFUSAL = `This ticket carries the usability gate, so its plan ends with a "${REAL_USE_LABEL} ..." walk-through (at least ${REAL_USE_MIN_CHARS} characters) the plan approver can read before any code is written: ${REAL_USE_ASK} Add it and call submit_plan again.`;

/** The line a plan card gets when a gated ticket's plan has no walk-through (ExitPlanMode can't be refused cleanly). */
export const PLAN_REAL_USE_MISSING = `This plan has no "${REAL_USE_LABEL}" walk-through (day 1, after routine updates and restarts, a week on). Send it back with Keep planning unless it plainly needs none.`;

/** Told to whoever's write added the criterion. */
export const USABILITY_ADDED_NOTE = `Usability gate added as its last acceptance criterion (built in for feature tickets and tickets with owner setup steps): report it pass or fail at review like the others, and a reviewer can't approve without a "${REAL_USE_LABEL}" walk-through.`;

/** The refusal a reviewer sees when approving a gated ticket without a walk-through. */
export const REAL_USE_REFUSAL = `This ticket must pass the usability gate before it merges. Add to your summary "${REAL_USE_LABEL} ..." (at least ${REAL_USE_MIN_CHARS} characters): ${REAL_USE_ASK} If nothing the owner runs, sees or repeats changes, say that in one line.`;
