// Owner step text with copy-safe commands (BOS-269). The owner is not a developer and copies commands by hand,
// so a command is never written inside a sentence: it goes in its own fenced block under the sentence that
// explains it, and the block holds exactly what is to be pasted. The web app renders each block with a Copy
// button (apps/web/src/pages/Decisions.tsx, StepText). Plain text without a fence still renders as before.

import { OWNER_CONTROLS, type OwnerScreen } from "@boss-man/shared";

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
export type LintFinding = { step: number; rule: "R1" | "R2" | "R3" | "R4" | "R6" | "warn"; problem: string };
/** What a raised card keeps from the lint: warnings, and a CEO override with its reason and what it let through. */
export type CardLint = { warn: LintFinding[]; override?: { reason: string; findings: LintFinding[] } };

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

/** A label as compared: lower case, words only ("Saved ✓" is "saved", "Done: mark processed" is "done mark processed"). */
const norm = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ").trim();
/** Keys on the keyboard: "press Enter" is not a button. */
const KEYS = new Set(["enter", "return", "esc", "escape", "tab", "space", "spacebar", "ctrl", "control", "cmd", "command", "shift", "alt", "option", "delete", "backspace", "f5", "y", "n", "q"]);
/** Words that end a button's name in a sentence: "press Approve on the card", "click Save again". */
const AFTER_LABEL = /^(?:on|in|at|to|for|from|under|next|below|above|beside|near|again|and|then|when|once|if|so|or|until|button|link|tab|there|here|now|first|twice)\b/;
/**
 * Every control, normalised; a label ending in "…" is kept as its start and matches anything after it. A label
 * with a bracketed note ("Update runners (finish runs first)") also matches without it, as cards name it that way.
 */
const CONTROLS = (() => {
  const exact = new Set<string>();
  const prefix = new Set<string>();
  for (const labels of Object.values(OWNER_CONTROLS) as ReadonlyArray<readonly string[]>) {
    for (const l of labels) {
      if (l.endsWith("…")) { prefix.add(norm(l)); continue; }
      exact.add(norm(l));
      const bare = l.replace(/\s*\([^)]*\)$/, "");
      if (bare && bare !== l) exact.add(norm(bare));
    }
  }
  return { exact, prefix };
})();
const SCREENS = (Object.keys(OWNER_CONTROLS) as OwnerScreen[]).filter((k) => k !== "Any screen");

/**
 * Whether `name` is a control: a key, an exact label or card option, the start of a "…" label, or, when it wasn't
 * quoted (so the sentence may run on), a label followed by a word that ends it ("Approve on the card").
 */
function isControl(name: string, quoted: boolean, options: Set<string>): boolean {
  const n = norm(name);
  if (!n || KEYS.has(n.split(" ")[0]!) || CONTROLS.exact.has(n) || options.has(n)) return true;
  for (const p of CONTROLS.prefix) if (n === p || n.startsWith(`${p} `)) return true;
  if (quoted) return false;
  for (const l of [...CONTROLS.exact, ...options]) if (n.startsWith(`${l} `) && AFTER_LABEL.test(n.slice(l.length + 1))) return true;
  return false;
}

/**
 * The controls a step tells the owner to press that the app doesn't have (R6). A name counts when it follows
 * press/click/tap/hit and is quoted, bold or starts with a capital ("press Overrule and merge"), or when it is
 * "the X button". Lower-case words after the verb ("click the link", "press it") aren't taken as names: refusing
 * those would stop good cards, and a made-up button is written the way the screen would show it.
 */
function missingControls(prose: string, options: Set<string>): string[] {
  const out: string[] = [];
  const named = (raw: string, quoted: boolean) => {
    const n = raw.replace(/\s+/g, " ").trim();
    if (n && !isControl(n, quoted, options) && !out.includes(n)) out.push(n);
  };
  for (const m of prose.matchAll(/\b(?:press|click|tap|hit)\s+(?:on\s+)?(?:the\s+)?/gi)) {
    const rest = prose.slice(m.index + m[0].length);
    const q = /^(?:"([^"\n]+)"|“([^”\n]+)”|\*\*([^*\n]+)\*\*|`([^`\n]+)`|'([^'\n]+)'(?!\w))/.exec(rest);
    if (q) named(q[1] ?? q[2] ?? q[3] ?? q[4] ?? q[5]!, true);
    else if (/^\p{Lu}/u.test(rest)) {
      // Widest reading first: an option can hold a comma ("Yes, move it") or a bracket that is part of the label
      // ("Update runners (finish runs first)"). Only if none of those is a control, cut at a comma or bracket
      // ("Save (top right)", "Approve, then close") and judge the shorter name.
      const cut = (re: RegExp) => rest.split(re)[0]!;
      const end = String.raw`\s+(?:button|link|tab)\b`;
      const readings = [`[.;:!?\\n→>]|${end}`, `[.,;:!?\\n→>]|${end}`, `[.,;:!?()\\n→>]|${end}`].map((re) => cut(new RegExp(re)));
      if (!readings.some((r) => isControl(r, false, options))) named(readings[2]!, false);
    }
  }
  for (const m of prose.matchAll(/(?:"([^"\n]+)"|“([^”\n]+)”|\*\*([^*\n]+)\*\*)\s+button\b/g)) named(m[1] ?? m[2] ?? m[3]!, true);
  for (const m of prose.matchAll(/\bthe\s+(\p{Lu}[^.,;:!?()\n"“”*]*?)\s+button\b/gu)) named(m[1]!, false);
  return out;
}

/** The first screen a step names, for the list in a refusal; a ticket reference or the word "ticket" is Ticket. */
function screenIn(prose: string): OwnerScreen | null {
  let best: { at: number; s: OwnerScreen } | null = null;
  const consider = (at: number, s: OwnerScreen) => {
    if (at >= 0 && (!best || at < best.at)) best = { at, s };
  };
  for (const s of SCREENS) consider(prose.search(new RegExp(`\\b${s}\\b`)), s);
  consider(prose.search(/\b[A-Z]{2,6}-\d+\b|\bticket\b/i), "Ticket");
  return (best as { s: OwnerScreen } | null)?.s ?? null;
}

/**
 * Checks an agent's owner steps the way the owner will read them (BOS-417, DR-008 Q1): refuse what can't work
 * as written, warn about what might not. R1 a pointer to another document instead of the action; R2 a shell
 * variable no step up to this one sets; R3 a command that isn't copy-safe (`commandProblem`), or a placeholder
 * in inline code; R4 a `{{…}}` token, which Boss Man can't fill in yet (host facts are DR-008 ticket 2; R5,
 * contradicting a recorded fact, comes with them). Warnings: a wiki or ticket link, more than one command in a
 * step or more than 12 steps, and hedging next to a command. R6 (BOS-421, DR-009 L6): a button the app doesn't
 * have (`OWNER_CONTROLS`); `options` are the card's own buttons, which the owner can press too.
 */
export function lintOwnerSteps(steps: string[], options: readonly string[] = []): { refuse: LintFinding[]; warn: LintFinding[] } {
  const refuse: LintFinding[] = [];
  const warn: LintFinding[] = [];
  const set = new Set<string>();
  const own = new Set(options.map(norm));
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
    for (const name of missingControls(prose, own)) {
      const screen = screenIn(prose);
      const there = screen ? ` The buttons on ${screen} are: ${OWNER_CONTROLS[screen].join(", ")}.` : "";
      refuse.push({ step, rule: "R6", problem: `tells the owner to press "${name}", which isn't a button in the app.${there} Name a button exactly as the screen shows it, or one of this card's options` });
    }
    if (LINK.test(prose)) warn.push({ step, rule: "warn", problem: "links to a wiki page or ticket; fine as background, but the step itself must be complete" });
    if (blocks.length > 1) warn.push({ step, rule: "warn", problem: `has ${blocks.length} commands; one per step is easier to follow` });
    const hedge = code.length ? HEDGES.exec(prose) : null;
    if (hedge) warn.push({ step, rule: "warn", problem: `hedges ("${hedge[0]}") next to a command` });
  });
  return { refuse, warn };
}

/** Rules a CEO override can't let through: a command the owner can't paste as it is, or a value Boss Man doesn't have. */
export const NOT_OVERRIDABLE: ReadonlySet<LintFinding["rule"]> = new Set(["R3", "R4"]);

/** One line per finding, for the agent's refusal or the CEO's list. */
export const lintLines = (fs: LintFinding[]) => fs.map((f) => `- Step ${f.step}: ${f.problem}.`).join("\n");
