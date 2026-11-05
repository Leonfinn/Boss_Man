// Owner step text with copy-safe commands (BOS-269). The owner is not a developer and copies commands by hand,
// so a command is never written inside a sentence: it goes in its own fenced block under the sentence that
// explains it, and the block holds exactly what is to be pasted. The web app renders each block with a Copy
// button (apps/web/src/pages/Decisions.tsx, StepText). Plain text without a fence still renders as before.
//
// Since BOS-427 every block also says where it runs and as whom: a fence line like
// ```sh host="nas01" as="login". That line is not part of what the owner pastes; the web app reads it and shows
// "On nas01, as the logged-in account." above the command. A block with neither is refused (R6).

export type Where = { host: string; as: "root" | "login" };
export type Command = { sh: string; where?: Where };

/** Marks a command inside `step(...)`: it is rendered as its own block. `where` says where and as whom it runs. */
export const sh = (command: string, where?: Where): Command => ({ sh: command, ...(where ? { where } : {}) });

/** The fence line naming a block's host and account, e.g. sh host="nas01" as="root". It is not part of what the owner pastes. */
export function whereFence(where: Where): string {
  // A recorded host's name is a plain DNS-style name: no spaces, quotes or shell syntax, so it can't break the fence.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(where.host)) throw new Error(`Host is not a plain name (letters, digits, dot, dash, underscore): ${where.host}`);
  if (where.as !== "root" && where.as !== "login") throw new Error(`A block runs as root or login, not ${String(where.as)}`);
  return `sh host="${where.host}" as="${where.as}"`;
}

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
 * more sentences (to explain the next command); `sh("...")` is a command, and `sh("...", { host, as })`
 * says where and as whom it runs. A command that is not copy-safe throws, so a card with a broken command
 * is a bug found by the tests and never shown to the owner.
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
      return "```" + (p.where ? whereFence(p.where) : "sh") + "\n" + p.sh + "\n```";
    })
    .join("\n\n");
}

export type StepPiece = { type: "text"; text: string } | { type: "command"; text: string; where?: Where };

/**
 * The fence line's host and account. `sh` alone means an older block that names neither (R6 refuses it); a
 * fence line that isn't one of the two forms is not read as a guess, it is read as "no host" and R6 says so.
 */
function fenceWhere(lang: string): { where?: Where } {
  if (lang === "sh") return {};
  const m = /^sh\s+host="([A-Za-z0-9][A-Za-z0-9_.-]{0,63})"\s+as="(root|login)"$/.exec(lang);
  return m ? { where: { host: m[1]!, as: m[2] as Where["as"] } } : {};
}

/** Splits a step into sentences and command blocks; the web app has the same logic for rendering. */
export function parseStep(text: string): StepPiece[] {
  const out: StepPiece[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)\n```/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ type: "text", text: before });
    const { where } = fenceWhere(m[1]!.trim());
    out.push({ type: "command", text: m[2]!, ...(where ? { where } : {}) });
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

/** Fenced blocks (with their host and account), then inline `code` spans in the sentences: everything the owner might paste. */
function pieces(text: string) {
  const parts = parseStep(text);
  const blockPieces = parts.filter((p): p is Extract<StepPiece, { type: "command" }> => p.type === "command");
  const blocks = blockPieces.map((p) => p.text);
  const prose = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
  return { blocks, blockPieces, inline, prose };
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
 * in inline code; R4 a `{{…}}` token, which Boss Man can't fill in yet. Warnings: a wiki or ticket link, more
 * than one command in a step or more than 12 steps, and hedging next to a command.
 *
 * R6 (BOS-427) is the host and account check: every command block says where it runs and as whom, and a block
 * run by the owner's login may not read a recorded folder that login can't read unless an earlier block on the
 * card stages a readable copy for it. Pass `hosts` (the host facts Boss Man recorded) to check the paths;
 * without them only the host/account presence is checked, so a caller that hasn't been taught the facts keeps
 * working. Backups are never made world-readable.
 */
export function lintOwnerSteps(steps: string[], hosts?: HostFacts[]): { refuse: LintFinding[]; warn: LintFinding[] } {
  const refuse: LintFinding[] = [];
  const warn: LintFinding[] = [];
  // not state: scratch for one call over one card; nothing is kept between calls.
  const set = new Set<string>();
  /** What earlier blocks on this card made readable for the login (BOS-427), per host and folder. */
  // not state: scratch for one call over one card; nothing is kept between calls.
  const staged = new Map<string, Set<string>>();
  if (steps.length > STEP_LIMIT) warn.push({ step: STEP_LIMIT + 1, rule: "warn", problem: `has ${steps.length} steps, which suggests one card doing several stages' work` });
  steps.forEach((text, i) => {
    const step = i + 1;
    const { blocks, blockPieces, inline, prose } = pieces(text);
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
    const host = lintHost(blockPieces, step, hosts, staged, step === 1);
    refuse.push(...host.refuse);
    warn.push(...host.warn);
    if (LINK.test(prose)) warn.push({ step, rule: "warn", problem: "links to a wiki page or ticket; fine as background, but the step itself must be complete" });
    if (blocks.length > 1) warn.push({ step, rule: "warn", problem: `has ${blocks.length} commands; one per step is easier to follow` });
    const hedge = code.length ? HEDGES.exec(prose) : null;
    if (hedge) warn.push({ step, rule: "warn", problem: `hedges ("${hedge[0]}") next to a command` });
  });
  return { refuse, warn };
}

// ---------------------------------------------------------------------------------------------------
// R6 (BOS-427): where a command runs and as whom, and whether that account can read what it opens.
// Ownership is a host fact (host.json, written by the host deployer from `stat`); nothing here guesses.
// ---------------------------------------------------------------------------------------------------

/** A folder's ownership as the host recorded it: owner (a name or uid), group, and the mode as 3 or 4 octal digits. */
export type Ownership = { path: string; owner: string; group: string; mode: string };
/** One host as Boss Man recorded it: its name, the owner's login account there, and its known folders. */
export type HostFacts = { name: string; login?: string; ownership: Ownership[] };

/** An absolute path with `.` and `..` worked out; null for anything only the shell knows (a variable, a glob, quotes). */
function normPath(p: string): string | null {
  if (!p.startsWith("/") || /[$~`*?[\]{}<>|&;()'"]/.test(p)) return null;
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return `/${out.join("/")}`;
}

const inside = (p: string, folder: string) => p === folder || p.startsWith(`${folder}/`);

/** A path R6 can reason about: one absolute path, with `.` and `..` worked out; null for a flag, a relative path or a hidden one. */
const pathArg = (a: string): string | null => (a.startsWith("/") ? normPath(a) : null);

/** The most specific recorded folder holding a path; ownership is recorded for folders, so a file is covered by its folder. */
function recordedFolder(path: string, facts: HostFacts): (Ownership & { folder: string }) | null {
  let best: (Ownership & { folder: string }) | null = null;
  for (const f of facts.ownership) {
    const folder = normPath(f.path);
    if (!folder || !inside(path, folder)) continue;
    if (!best || folder.length > best.folder.length) best = { ...f, folder };
  }
  return best;
}

/** Read and search bits the login gets: the owner's if it is the owner, the group's if it is in the group, else everyone's. */
function canRead(login: string | undefined, o: Ownership): boolean {
  const mode = parseInt(o.mode, 8);
  if (Number.isNaN(mode)) return false;
  const [read, search] = login && login === o.owner ? [0o400, 0o100] : login && login === o.group ? [0o040, 0o010] : [0o004, 0o001];
  return (mode & read) !== 0 && (mode & search) !== 0;
}

/** True when a mode is opened to everyone: the "other" bits are set at all (a backup left 644 or 755 by a default umask). */
const opensToAll = (mode: string) => {
  const m = parseInt(mode, 8);
  return !Number.isNaN(m) && (m & 0o007) !== 0;
};

/** A recorded folder the owner never wants open to the world (the ticket: "never make backups world-readable"). */
const PRIVATE_FOLDER = /(^|\/)(backups?|secrets?)(\/|$)/i;

/**
 * Split one command into simple commands at the shell's separators, keeping each one's quoted words whole.
 * Only the separators R6 needs are honoured (`;`, `&&`, `||`, `|`, newline); a block that hides a command from
 * this (a substitution, backticks) is left alone rather than guessed at. This is a word split, not a parser.
 */
function simpleCommands(command: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  const endWord = () => {
    if (started || word) cur.push(word);
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      word += command[++i]!;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      if (c === "\n") endCommand();
      continue;
    }
    if (c === ";") {
      endCommand();
      continue;
    }
    if ((c === "&" || c === "|") && command[i + 1] === c) {
      endCommand();
      i++;
      continue;
    }
    if (c === "|" || c === "&") {
      endCommand();
      continue;
    }
    word += c;
    started = true;
  }
  endCommand();
  return out;
}

/** The options of a command that take a value, so `-o root` doesn't read `root` as a folder. */
const VALUE_OPTS = new Set(["-o", "--owner", "-g", "--group", "-m", "--mode", "-t", "--target-directory", "-u", "--user", "-p", "--parents"]);

/** One program R6 reads: its name and every operand (so the path, and for a copy the destination, can be read). */
type Prog = { name: string; args: string[]; mode?: string; owner?: string };

/**
 * Read one simple command as root or as the login, and the program it runs. `sudo <cmd>` runs that command as
 * root; `sudo -i`/`sudo -s`/`su -` is a root shell for the rest of the block, so the whole block counts as root
 * from there. A wrapper (`env`, `nice`, `nohup`, `time`, `command`, `exec`) is walked past to the real program.
 */
function readCommand(words: string[]): { asRoot: boolean; shellRoot: boolean; prog: Prog | null } {
  let shellRoot = false;
  const rest = [...words];
  while (rest.length && /^[A-Za-z_]\w*=/.test(rest[0]!)) rest.shift(); // leading assignments (X=1 cmd)
  if (!rest.length) return { asRoot: false, shellRoot, prog: null };
  if (rest[0] === "sudo") {
    let j = 1;
    while (j < rest.length && rest[j]!.startsWith("-")) {
      const opt = rest[j]!;
      if (opt === "-i" || opt === "-s" || opt === "--login" || opt === "--shell") shellRoot = true;
      j += VALUE_OPTS.has(opt) ? 2 : 1;
    }
    if (j < rest.length && rest[j] === "su") return { asRoot: true, shellRoot: true, prog: null };
    const inner = rest.slice(j);
    const r = readCommand(inner);
    return { asRoot: true, shellRoot: shellRoot || r.shellRoot, prog: r.prog };
  }
  if (rest[0] === "su") {
    const target = rest.slice(1).find((a) => !a.startsWith("-"));
    if (target === undefined || target === "root") return { asRoot: true, shellRoot: true, prog: null };
    return { asRoot: false, shellRoot, prog: readCommand(rest.slice(1)).prog };
  }
  if (["env", "nice", "nohup", "time", "command", "exec"].includes(rest[0]!)) {
    let j = 1;
    while (j < rest.length && (rest[j]!.startsWith("-") || /^[A-Za-z_]\w*=/.test(rest[j]!))) j += VALUE_OPTS.has(rest[j]!) ? 2 : 1;
    const r = readCommand(rest.slice(j));
    return { asRoot: false, shellRoot: shellRoot || r.shellRoot, prog: r.prog };
  }
  const args: string[] = [];
  let mode: string | undefined;
  let owner: string | undefined;
  for (let j = 1; j < rest.length; j++) {
    const a = rest[j]!;
    if (VALUE_OPTS.has(a)) {
      const v = rest[j + 1];
      if ((a === "-m" || a === "--mode") && v) mode = v;
      if ((a === "-o" || a === "--owner") && v) owner = v;
      j++;
      continue;
    }
    // `--mode=700` carries its value in the same word.
    const eq = /^(--mode|-m|--owner|-o)=(.*)$/.exec(a);
    if (eq) {
      if (eq[1] === "-m" || eq[1] === "--mode") mode = eq[2];
      continue;
    }
    if (a.startsWith("-")) continue;
    args.push(a);
  }
  return { asRoot: false, shellRoot, prog: { name: rest[0]!.split("/").pop() ?? "", args, ...(mode !== undefined ? { mode } : {}), ...(owner !== undefined ? { owner } : {}) } };
}

/** Commands that read a folder (so R6 checks a login can open it). */
const READS = new Set(["ls", "cat", "cp", "rsync", "scp", "tar", "find", "du", "stat", "head", "tail", "less", "more", "grep", "rg", "diff", "sha256sum", "sha512sum", "wc", "file", "sed", "awk", "zgrep", "zcat", "gunzip", "base64", "cmp", "md5sum"]);
/** Commands that put a copy somewhere (so R6 checks the destination, and remembers a copy staged for the login). */
const STAGES = new Set(["install", "chown", "cp", "rsync", "mv"]);
/** Commands whose mode option can open a folder to everyone. */
const MODES = new Set(["chmod", "install", "umask"]);

/** True when a command's mode opens it to everyone (an octal whose other bits are set, or o+rX / a+rX). */
function modeOpensUp(p: Prog): boolean {
  const mode = p.name === "umask" ? p.args[0] : p.mode ?? p.args.find((a) => /^[0-7]{3,4}$/.test(a) || /^[ugoa]*[+=][rwxX]+$/.test(a));
  if (!mode) return false;
  if (/^[0-7]{3,4}$/.test(mode)) return (parseInt(mode, 8) & 0o007) !== 0;
  return /[ao][+=]?[rwxX]/.test(mode);
}

/**
 * R6: every block says where and as whom it runs; a block run by the login may not read a recorded folder the
 * login can't read unless an earlier block on the card made a readable copy for it (a `sudo install -o <login>`
 * or a `cp`/`rsync` by the login); and a block that opens a backup folder to everyone is refused.
 * `staged` carries the folders earlier blocks made readable, so the check runs across the whole card.
 */
function lintHost(blockPieces: Array<Extract<StepPiece, { type: "command" }>>, step: number, hosts: HostFacts[] | undefined, staged: Map<string, Set<string>>, first: boolean): { refuse: LintFinding[]; warn: LintFinding[] } {
  const refuse: LintFinding[] = [];
  const warn: LintFinding[] = [];
  for (const piece of blockPieces) {
    const where = piece.where;
    if (!where) {
      refuse.push({ step, rule: "R6", problem: `has a command that doesn't say where it runs or as which account. Put it in its own block as sh host="<name>" as="root" or as="login"` });
      continue;
    }
    const known = hosts?.find((h) => h.name === where.host);
    if (hosts && !known) {
      // A host with no deployer yet (the move's new host) has no ownership record, so R6 can't check a step's
      // paths. The card is allowed, but its first step should be a read-only check that shows what to look for.
      if (first) warn.push({ step, rule: "warn", problem: `runs on "${where.host}", which Boss Man hasn't recorded, so it can't check what the owner's login can read there. Start with a read-only check (ls -ld, df -h) and say what the owner should see before anything is changed` });
      continue;
    }
    if (!hosts || !known) continue;
    for (const words of simpleCommands(piece.text)) {
      const r = readCommand(words);
      const asRoot = where.as === "root" || r.shellRoot || r.asRoot;
      const p = r.prog;
      if (!p) continue;
      const abs = p.args.map((a) => pathArg(a)).filter((a): a is string => a !== null);
      if (!abs.length) continue;
      if (STAGES.has(p.name)) {
        // A copy writes at its last operand; that is the path R6 warns about and remembers.
        const dest = abs[abs.length - 1]!;
        const rec = recordedFolder(dest, known);
        if (!rec) {
          warn.push({ step, rule: "warn", problem: `${p.name} puts a copy at ${dest}, which has no recorded ownership on ${known.name}; R6 can't tell whether the owner's login can use it` });
          continue;
        }
        // Remember the folder a copy made for the login, so a later login block can read it. `install -o` names
        // the login; a copy the login runs itself is readable by it; a copy by root that keeps the mode closed is not.
        const owner = p.owner;
        if (owner || !asRoot) stagedForLogin(where.host, rec.folder);
        // An install or chown that opens a backup folder's mode to everyone is refused, like chmod below.
        if (MODES.has(p.name) && modeOpensUp(p) && PRIVATE_FOLDER.test(rec.folder))
          refuse.push({ step, rule: "R6", problem: `opens ${dest} to everyone with ${p.name}. Backups and secrets stay readable only by their owner` });
        continue;
      }
      if (MODES.has(p.name) && modeOpensUp(p)) {
        for (const target of abs) {
          const rec = recordedFolder(target, known);
          if (rec && PRIVATE_FOLDER.test(rec.folder)) refuse.push({ step, rule: "R6", problem: `opens ${target} to everyone with ${p.name}. Backups and secrets stay readable only by their owner` });
        }
        continue;
      }
      if (!READS.has(p.name) || asRoot) continue;
      // A read opens its first path (the file, or the folder it lists).
      const target = abs[0]!;
      const rec = recordedFolder(target, known);
      if (!rec) continue;
      const can = canRead(known.login, rec);
      const made = staged.get(where.host)?.has(rec.folder) ?? false;
      if (!can && !made)
        refuse.push({ step, rule: "R6", problem: `runs as the login on ${where.host} and reads ${target}, which the login can't read (${rec.path} is mode ${rec.mode}, owned by ${rec.owner}). Run this block as root, or make a copy for the login in an earlier step (sudo install -o <login> -m 700 -D <source> <folder>)` });
    }
    function stagedForLogin(host: string, folder: string) {
      const set = staged.get(host) ?? new Set<string>();
      set.add(folder);
      staged.set(host, set);
    }
  }
  return { refuse, warn };
}

/** Rules a CEO override can't let through: a command the owner can't paste as it is, or a value Boss Man doesn't have. */
export const NOT_OVERRIDABLE: ReadonlySet<LintFinding["rule"]> = new Set(["R3", "R4"]);

/** One line per finding, for the agent's refusal or the CEO's list. */
export const lintLines = (fs: LintFinding[]) => fs.map((f) => `- Step ${f.step}: ${f.problem}.`).join("\n");
