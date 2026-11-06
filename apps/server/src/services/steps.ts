// Owner step text with copy-safe commands (BOS-269). The owner is not a developer and copies commands by hand,
// so a command is never written inside a sentence: it goes in its own fenced block under the sentence that
// explains it, and the block holds exactly what is to be pasted. The web app renders each block with a Copy
// button (apps/web/src/pages/Decisions.tsx, StepText). Plain text without a fence still renders as before.

import { ADDONS, type Addon, type AddonFacts, type AddonState } from "./addons.js";

export type Command = { sh: string };
/** Marks a command inside `step(...)`: it is rendered as its own block. */
export const sh = (command: string): Command => ({ sh: command });

/** Why a command is not copy-safe, or null. A command is one trimmed line with nothing but the text to paste. */
export function commandProblem(command: string): string | null {
  if (command !== command.trim() || !command) return "has spaces around it or is empty";
  if (/[\r\n]/.test(command)) return "spans more than one line";
  if (command.includes("```")) return "contains a code fence";
  if (/^[$#>%]\s/.test(command)) return "starts with a prompt character";
  if (/[.,;:]$/.test(command)) return "ends with punctuation";
  if (/<[A-Za-z][\w.-]*>/.test(command) || /\b(?:YOUR|REPLACE|TODO)[_-]?\w*/.test(command)) return "has a placeholder the owner would have to edit";
  return null;
}

/**
 * One step: the sentence in plain words, then each command in its own block. Strings after the first are
 * more sentences (to explain the next command); `sh("...")` is a command. A command that is not copy-safe
 * throws, so a card with a broken command is a bug found by the tests and never shown to the owner.
 */
export function step(sentence: string, ...rest: Array<string | Command>): string {
  const parts = [sentence, ...rest];
  return parts
    .map((p) => {
      if (typeof p === "string") {
        if (p.includes("```")) throw new Error("A sentence must not contain a code fence");
        return p;
      }
      const problem = commandProblem(p.sh);
      if (problem) throw new Error(`Command is not copy-safe (${problem}): ${p.sh}`);
      return "```sh\n" + p.sh + "\n```";
    })
    .join("\n\n");
}

export type StepPiece = { type: "text"; text: string } | { type: "command"; text: string };

/** Splits a step into sentences and command blocks; the web app has the same logic for rendering. */
export function parseStep(text: string): StepPiece[] {
  const out: StepPiece[] = [];
  const re = /```[a-z]*\n([\s\S]*?)\n```/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ type: "text", text: before });
    out.push({ type: "command", text: m[1]! });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push({ type: "text", text: rest });
  return out;
}

/** One thing the owner-step lint found (BOS-417, DR-008 Q1). `step` counts from 1. */
export type LintFinding = { step: number; rule: "R1" | "R2" | "R3" | "R4" | "R9" | "R10" | "R11" | "warn"; problem: string };

/**
 * The words that mean a step relies on an add-on (R9, DR-023). A fixed table, so what triggers the rule
 * is reviewable; matched on the whole step, sentences and commands alike.
 */
const ADDON_WORDS: Record<Addon, { label: string; re: RegExp }> = {
  tailscale: { label: "Tailscale", re: /\btailscale\b|\bts\.net\b|\btailnet\b/i },
  ntfy: { label: "ntfy", re: /\bntfy\b|\btest push(?:es)?\b|\btest notifications?\b|\bphone notifications?\b/i },
  penpot: { label: "Penpot", re: /\bpenpot\b/i },
};
const ADDON_STATE_WORDS: Record<AddonState, string> = { not_set_up: "not set up", stopped: "stopped", needs_login: "waiting for a login", running: "running", unknown: "unknown" };
/** What R9 needs: each add-on's state, and the add-on this card sets up, whose own steps are exempt. */
export type LintFacts = { addons: AddonFacts; setsUp?: Addon };

/** R9: a step that relies on an add-on that isn't running is refused; one Boss Man can't see is warned about. */
function addonFindings(step: number, text: string, facts: LintFacts, refuse: LintFinding[], warn: LintFinding[]) {
  for (const addon of ADDONS) {
    if (addon === facts.setsUp) continue;
    const m = ADDON_WORDS[addon].re.exec(text);
    if (!m) continue;
    const { label } = ADDON_WORDS[addon];
    const f = facts.addons[addon];
    if (f.state === "running") continue;
    if (f.state === "unknown") {
      warn.push({ step, rule: "warn", problem: `relies on ${label} ("${m[0]}"), which Boss Man can't confirm is running (${f.source}). Don't tell the owner it carries over or is back up` });
    } else {
      refuse.push({ step, rule: "R9", problem: `relies on ${label} ("${m[0]}"), which is ${ADDON_STATE_WORDS[f.state]} (${f.source}${f.detail ? `: ${f.detail}` : ""}). Set ${label} up first with its own card (raise_decision with setsUp: "${addon}"), or leave it out of these steps` });
    }
  }
}
/**
 * How a card with host commands was proven (R11, DR-024 C): rehearsed by a script in CI at a commit, or not
 * rehearsed, naming the part that is the first time on a real machine. The card shows it as a banner.
 */
export type Proof = { rehearsed: true; script: string; commit: string } | { rehearsed: false; part: string };

/** Reads an agent's `proof` field: "rehearsed <script> @ <commit>" or "not rehearsed: <what and why>". A string is why it can't. */
export function parseProof(text: string): Proof | string {
  const t = text.replace(/\s+/g, " ").trim();
  const r = /^rehearsed (\S+) ?@ ?([0-9a-f]{7,40})$/i.exec(t);
  if (r) return { rehearsed: true, script: r[1]!, commit: r[2]!.toLowerCase() };
  const n = /^not rehearsed: ?(.+)$/i.exec(t);
  if (n && n[1]!.trim().length >= 10) return { rehearsed: false, part: n[1]!.trim() };
  return `proof must be "rehearsed <script> @ <commit>" (the CI rehearsal script under scripts/rehearse/ and the commit it passed on) or "not rehearsed: <what hasn't been tried and why>", at least 10 characters after the colon`;
}

/** What a raised card keeps from the lint: warnings, a CEO override with its reason and what it let through, and the proof (R11). */
export type CardLint = { warn: LintFinding[]; override?: { reason: string; findings: LintFinding[] }; proof?: Proof };

/**
 * R10 (DR-024 D): commands that stop and wait for typed input. The owner reads every prompt as something to
 * fill in, and a secret typed into a terminal is the wrong channel: it goes in an editor step naming the exact
 * line, or through Boss Man's Secrets screen. Matched where a command starts (line start, after ; & | ( or `),
 * also behind sudo and VAR=value prefixes.
 */
const CMD = String.raw`(?:^|[;&|(\`])\s*(?:sudo\s+(?:-\S+\s+)*)?(?:[A-Za-z_]\w*=\S*\s+)*`;
const INTERACTIVE: Array<[RegExp, string]> = [
  [new RegExp(CMD + String.raw`read\b(?!-)`, "m"), "reads typed input (read)"],
  [/\bsudo\s+(?:-\w*\s+)*-\w*S/, "reads a password from typed input (sudo -S)"],
  [new RegExp(CMD + String.raw`passwd\b(?!-)`, "m"), "asks for a password (passwd)"],
  [new RegExp(CMD + String.raw`ssh-keygen\b(?![^;&|\n]*\s-(?:N|[a-zA-Z]*[lFR]))`, "m"), "asks for a file name and passphrase (ssh-keygen without -N)"],
  [new RegExp(CMD + String.raw`docker\s+login\b(?![^;&|\n]*--password-stdin)`, "m"), "asks for a user name and password (docker login)"],
];

/**
 * R11 (DR-024 D): a host command, so the card must say how it was proven. A fixed list: docker and compose,
 * systemctl, tailscale, chown/chmod, and anything that names the .env file.
 */
const HOST_COMMAND = new RegExp(CMD + String.raw`(?:docker(?:-compose)?|systemctl|tailscale|chown|chmod)\b|(?:^|[\s/"'=>])\.env\b`, "m");
/** A look-only command (DR-024 kind 1): what a "not rehearsed" card ends with, so its answer closes the part that was untried. */
const LOOK_ONLY = new RegExp(CMD + String.raw`(?:docker(?:-compose)?\s+(?:compose\s+(?:-f\s+\S+\s+)*)?(?:ps|inspect|logs|images|version)|tailscale\s+(?:status|ip|version)|systemctl\s+(?:status|is-active|is-enabled)|curl|cat|ls|grep|df|du|ping|getent)\b`, "m");

/** Variables the owner's shell always has; using them unset is not a mistake. */
const SHELL_ENV = new Set(["HOME", "PATH", "PWD", "OLDPWD", "USER", "SHELL", "HOSTNAME", "UID", "LANG", "TERM"]);
const STEP_LIMIT = 12;

/** Text that points the owner somewhere else instead of giving the action (R1). Matched on the sentences, not the commands. */
const DOC_POINTERS: Array<[RegExp, string]> = [
  [/\bdocs\/\d{2}/i, "points to a doc in docs/"],
  [/\b[\w./-]+\.md\b/i, "points to a Markdown document"],
  [/\b(?:follow|see|as (?:in|per)|per|according to)\s+(?:the\s+|our\s+|that\s+|this\s+)?(?:[\w/-]+\s+){0,2}(?:guide|doc|docs|document|documentation|runbook|readme|wiki(?: page)?)\b/i, "sends the owner to a guide or document"],
  [/\b(?:follow|see|repeat|do|as in)\s+steps?\s+\d+\s+(?:of|from|on|in)\b/i, "sends the owner to steps somewhere else"],
  [/\b(?:follow|see)\s+\[\[/i, "sends the owner to a wiki page"],
  [/\bwith (?:the |your |some )?changes\b/i, "asks the owner to adapt instructions (\"with changes\")"],
  [/\b(?:same as|as) (?:before|last time|usual)\b/i, "relies on what the owner did before"],
  [/\b(?:previous|earlier|other|last|old) card\b/i, "sends the owner to another card"],
];
const HEDGES = /\b(?:probably|should be|if it'?s still|i think|maybe|hopefully|might need)\b/i;
const LINK = /\[\[|#\/(?:wiki|tickets)\/|\b[A-Z]{2,6}-\d+\b/;
const PLACEHOLDER = /<[A-Za-z][\w.-]*>|\b(?:YOUR|REPLACE|TODO)[_-]?\w*/;

/** Fenced blocks, then inline `code` spans in the sentences: everything the owner might paste. */
function pieces(text: string) {
  const parts = parseStep(text);
  const blocks = parts.filter((p) => p.type === "command").map((p) => p.text);
  const prose = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
  return { blocks, inline, prose };
}

/** Names a piece of shell sets: `X=…` (also inline, `X=1 cmd`, and after export/local), `read X Y`, `for X in`. */
function setsIn(code: string, into: Set<string>) {
  for (const m of code.matchAll(/(?:^|[\s;&|(`])([A-Za-z_]\w*)=/g)) into.add(m[1]!);
  for (const m of code.matchAll(/\bread\b([^;&|\n]*)/g)) for (const w of m[1]!.split(/\s+/)) if (/^[A-Za-z_]\w*$/.test(w)) into.add(w);
  for (const m of code.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) into.add(m[1]!);
}

/** Names a piece of shell reads. Single-quoted text is literal (awk '{print $2}'), `\$X` is escaped, and `${X:-y}` has a default. */
function usesIn(code: string): string[] {
  const live = code.replace(/\\\$/g, "").replace(/'[^']*'/g, "''");
  const out: string[] = [];
  for (const m of live.matchAll(/\$\{([A-Za-z_]\w*)(:?[-=+?])?/g)) if (!m[2] || /\?/.test(m[2])) out.push(m[1]!);
  for (const m of live.matchAll(/\$([A-Za-z_]\w*)/g)) out.push(m[1]!);
  return out;
}

/**
 * Checks an agent's owner steps the way the owner will read them (BOS-417, DR-008 Q1): refuse what can't work
 * as written, warn about what might not. R1 a pointer to another document instead of the action; R2 a shell
 * variable no step up to this one sets; R3 a command that isn't copy-safe (`commandProblem`), or a placeholder
 * in inline code; R4 a `{{…}}` token, which Boss Man can't fill in yet (host facts are DR-008 ticket 2; R5,
 * contradicting a recorded fact, comes with them). Warnings: a wiki or ticket link, more than one command in a
 * step or more than 12 steps, and hedging next to a command.
 * R9 (DR-023), only when `facts` are given: a step that names an add-on (ADDON_WORDS) that is not set up,
 * stopped or waiting for a login is refused, and one whose state is unknown is warned about; the add-on the
 * card itself sets up (`facts.setsUp`) is exempt.
 * R10 (DR-024): a command that waits for typed input (INTERACTIVE). R11 (DR-024): steps with a host command
 * (HOST_COMMAND) need `proof`; a "not rehearsed" proof also needs the last step to be a look-only check.
 */
export function lintOwnerSteps(steps: string[], facts?: LintFacts, proof?: Proof): { refuse: LintFinding[]; warn: LintFinding[] } {
  const refuse: LintFinding[] = [];
  const warn: LintFinding[] = [];
  const set = new Set<string>(); // not state: variables set by earlier steps, local to one lint call
  let hostStep = 0;
  if (steps.length > STEP_LIMIT) warn.push({ step: STEP_LIMIT + 1, rule: "warn", problem: `has ${steps.length} steps, which suggests one card doing several stages' work` });
  steps.forEach((text, i) => {
    const step = i + 1;
    const { blocks, inline, prose } = pieces(text);
    const code = [...blocks, ...inline];
    for (const [re, problem] of DOC_POINTERS) {
      const m = re.exec(prose);
      if (m) {
        refuse.push({ step, rule: "R1", problem: `${problem} ("${m[0]}"). Write the exact action in the step itself` });
        break;
      }
    }
    // Sets first, so an inline assignment (X=1 cmd) or one earlier in the same step counts.
    for (const c of [...code, prose]) setsIn(c, set);
    const unset = new Set<string>();
    for (const c of code) for (const n of usesIn(c)) if (!set.has(n) && !SHELL_ENV.has(n)) unset.add(n);
    // In a sentence only an upper-case $NAME is read as a variable: "$5" or "$x" in prose is too often not one.
    for (const m of prose.replace(/`[^`\n]*`/g, "").matchAll(/\$\{?([A-Z_][A-Z0-9_]+)\b/g)) if (!set.has(m[1]!) && !SHELL_ENV.has(m[1]!)) unset.add(m[1]!);
    for (const n of unset) refuse.push({ step, rule: "R2", problem: `uses $${n}, which no step up to here sets. Write the value itself, or set it in this or an earlier step (${n}=…)` });
    for (const b of blocks) {
      const p = commandProblem(b);
      if (p) refuse.push({ step, rule: "R3", problem: `has a command that ${p}: ${b.slice(0, 120)}` });
    }
    for (const c of inline) if (PLACEHOLDER.test(c)) refuse.push({ step, rule: "R3", problem: `has a placeholder the owner would have to edit: ${c.slice(0, 120)}` });
    for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) refuse.push({ step, rule: "R4", problem: `has {{${m[1]}}}, which Boss Man has no value for. Write the value itself` });
    if (facts) addonFindings(step, text, facts, refuse, warn);
    for (const c of code) {
      const hit = INTERACTIVE.find(([re]) => re.test(c));
      if (hit) refuse.push({ step, rule: "R10", problem: `has a command that ${hit[1]}, which the owner would have to answer by typing: ${c.slice(0, 120)}. Give the value in the command, or for a secret an editor step naming the exact line (TS_AUTHKEY= in .env) or Boss Man's Secrets screen` });
    }
    if (!hostStep && code.some((c) => HOST_COMMAND.test(c))) hostStep = step;
    if (LINK.test(prose)) warn.push({ step, rule: "warn", problem: "links to a wiki page or ticket; fine as background, but the step itself must be complete" });
    if (blocks.length > 1) warn.push({ step, rule: "warn", problem: `has ${blocks.length} commands; one per step is easier to follow` });
    const hedge = code.length ? HEDGES.exec(prose) : null;
    if (hedge) warn.push({ step, rule: "warn", problem: `hedges ("${hedge[0]}") next to a command` });
  });
  if (hostStep && !proof) {
    refuse.push({ step: hostStep, rule: "R11", problem: `has a host command, so the card needs proof: "rehearsed <script> @ <commit>" once a CI rehearsal passed, or "not rehearsed: <what and why>" with a look-only check as the last step` });
  } else if (proof && !proof.rehearsed) {
    const last = steps.length ? pieces(steps[steps.length - 1]!) : null;
    if (!last || ![...last.blocks, ...last.inline].some((c) => LOOK_ONLY.test(c))) {
      refuse.push({ step: steps.length, rule: "R11", problem: "is the last step of a card that is the first time on a real machine, so it must be a check that only looks (docker compose ps, docker logs, tailscale status, curl…) and say what to paste back" });
    }
  }
  return { refuse, warn };
}

/**
 * Rules a CEO override can't let through: a command the owner can't paste as it is, a value Boss Man doesn't
 * have, or a command that waits for typed input (R10; DR-024 D says an override can't bypass it).
 */
export const NOT_OVERRIDABLE: ReadonlySet<LintFinding["rule"]> = new Set(["R3", "R4", "R10"]);

/** One line per finding, for the agent's refusal or the CEO's list. */
export const lintLines = (fs: LintFinding[]) => fs.map((f) => `- Step ${f.step}: ${f.problem}.`).join("\n");
