// Owner step text with copy-safe commands (BOS-269). The owner is not a developer and copies commands by hand,
// so a command is never written inside a sentence: it goes in its own fenced block under the sentence that
// explains it, and the block holds exactly what is to be pasted. The web app renders each block with a Copy
// button (apps/web/src/pages/Decisions.tsx, StepText). Plain text without a fence still renders as before.
//
// Since BOS-427 every block also says where it runs and as whom: a fence line like
// ```sh host="nas01" as="login". That line is not part of what the owner pastes; the web app reads it and shows
// "On nas01, as the logged-in account." above the command. A block with neither is refused (R6).

import { HOST_NAME, OWNER_CONTROLS, parseStep, recurringDutyHits, strayFence, type OwnerScreen, type StepPiece, type Where } from "@boss-man/shared";
import { ADDONS, type Addon, type AddonFacts, type AddonState } from "./addons.js";
import { BRANCH_MARKER, formStepFindings } from "./owner-form-steps.js";
import { norm, screenFindings, type Pressed } from "./owner-screens.js";
import { WHEN_MARKER } from "./owner-setup-when.js";

// The one reading of a step's fences, shared with the web app's renderer so the two can't disagree (BOS-550).
export { parseStep, strayFence, type StepPiece, type Where };
export type Command = { sh: string; where?: Where };

/** Marks a command inside `step(...)`: it is rendered as its own block. `where` says where and as whom it runs. */
export const sh = (command: string, where?: Where): Command => ({ sh: command, ...(where ? { where } : {}) });

/** The fence line naming a block's host and account, e.g. sh host="nas01" as="root". It is not part of what the owner pastes. */
export function whereFence(where: Where): string {
  // A recorded host's name is a plain DNS-style name: no spaces, quotes or shell syntax, so it can't break the fence.
  if (!HOST_NAME.test(where.host)) throw new Error(`Host is not a plain name (letters, digits, dot, dash, underscore): ${where.host}`);
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

/** One thing the owner-step lint found (BOS-417, DR-008 Q1). `step` counts from 1. */
export type LintFinding = { step: number; rule: "R1" | "R2" | "R3" | "R4" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11" | "R12" | "R13" | "R14" | "R15" | "R16" | "R17" | "R18" | "R18b" | "R19" | "R20" | "warn"; problem: string };

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
/** What the lint can be given: add-on facts for R9 (and the add-on this card sets up, whose steps are exempt),
 * the host facts for R6 (BOS-427) and the name the server runs on (BOS-774), the host a CEO-marked card is setting
 * up and that Boss Man has no record for yet (`newHost`, DR-046), the card's options, and the machine's own update
 * card for R15 (DR-036) with the drain in progress (`selfDeploy.hold`, for R16, DR-046 part 2). Each may be absent,
 * and then that rule only checks what it can without them. */
export type LintFacts = { addons?: AddonFacts; setsUp?: Addon; hosts?: HostFacts[]; serverHost?: string | null; newHost?: string; options?: readonly string[]; selfDeploy?: SelfDeployFacts; /** Ticket image id (lower case) → created-at, for R19's 30-day rule; absent when the caller couldn't look them up. */ images?: Record<string, string>; /** Sites (siteKey) whose docs misled the owner → when (ISO), for R19b; absent when the caller has no record to give. */ mismatchedSites?: Record<string, string>; /** The clock for R19; tests set it. */ now?: Date };

/**
 * The drain state R16 needs (DR-046 part 2): a runner image update or setting change that is waiting for runs to
 * finish. It is `getHold`'s record, narrowed to what the lint reads: `kind` ("update", the default, or "settings")
 * and when the wait started (`since`). `null` says Boss Man looked and found nothing pending.
 */
export type RunnerHold = { kind?: "update" | "settings"; since?: string; swapped?: Record<string, string> };

/** R9: a step that relies on an add-on that isn't running is refused; one Boss Man can't see is warned about. */
function addonFindings(step: number, text: string, addons: AddonFacts, setsUp: Addon | undefined, refuse: LintFinding[], warn: LintFinding[]) {
  for (const addon of ADDONS) {
    if (addon === setsUp) continue;
    const m = ADDON_WORDS[addon].re.exec(text);
    if (!m) continue;
    const { label } = ADDON_WORDS[addon];
    const f = addons[addon];
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
 * One simple command of a piece of shell: its words (quotes kept), and whether its output goes into a pipe or
 * its input comes from one or a `<` redirect. The R10 forms below and R12 judge commands, not text, so the
 * `;` or `|` inside `$(…)` or quotes doesn't split a command, and `D=$(psql …)` (output captured, no terminal)
 * isn't read as a psql in the terminal.
 */
type SimpleCommand = { words: string[]; pipedOut: boolean; pipedIn: boolean };

/**
 * Splits shell into simple commands at ; & | && || newlines and ( ), outside quotes, `$(…)` and backticks.
 * Not R6's `simpleCommands` (below): that one unquotes words for path checks and has no pipe or `$(…)` sense,
 * and R10 needs both (a psql into `| cat` or inside `$(…)` has no terminal).
 */
export function shellCommands(code: string): SimpleCommand[] {
  const src = code.replace(/\\\n/g, " ");
  const out: SimpleCommand[] = [];
  let words: string[] = [];
  let word = "";
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let pipedIn = false;
  const endWord = () => { if (word) words.push(word); word = ""; };
  const endCommand = (pipe: boolean) => {
    endWord();
    if (words.length) out.push({ words, pipedOut: pipe, pipedIn });
    words = [];
    pipedIn = pipe;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      word += ch;
      if (ch === "\\" && quote !== "'" && i + 1 < src.length) word += src[++i]!;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < src.length) { word += ch + src[++i]!; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; word += ch; continue; }
    if (ch === "$" && src[i + 1] === "(") { depth++; word += "$("; i++; continue; }
    if (depth) {
      word += ch;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (ch === "#" && !word) { while (i + 1 < src.length && src[i + 1] !== "\n") i++; continue; }
    if (ch === "|" && src[i + 1] !== "|") { endCommand(true); continue; }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")") {
      if ((ch === "&" || ch === "|") && src[i + 1] === ch) i++;
      // `2>&1` and `&>` are redirects, not a separator.
      if (ch === "&" && (word.endsWith(">") || src[i + 1] === ">")) { word += ch; continue; }
      endCommand(false);
      continue;
    }
    if (/\s/.test(ch)) { endWord(); continue; }
    word += ch;
  }
  endCommand(false);
  return out;
}

/** A word without its quotes, for comparing (`"$D/x"` → `$D/x`). */
const bare = (w: string) => w.replace(/^(['"])(.*)\1$/s, "$2");
/** sudo's options that take a value (`sudo -u postgres psql`). */
const SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-U", "-C", "-D", "-h", "-p", "-r", "-t"]);
/** Words that start a command without being it: shell keywords, sudo, env, nohup, time, and leading VAR=value. */
function commandWords(words: string[]): { env: string[]; rest: string[] } {
  const env: string[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_]\w*=/.test(w)) { env.push(w); i++; continue; }
    if (["!", "if", "then", "else", "elif", "do", "while", "until", "{", "}", "time", "nohup", "exec", "command"].includes(w)) { i++; continue; }
    if (w === "env") { i++; while (i < words.length && /^-/.test(words[i]!)) i++; continue; }
    if (w === "sudo") {
      i++;
      while (i < words.length && /^-/.test(words[i]!)) i += SUDO_VALUE_FLAGS.has(words[i]!) ? 2 : 1;
      continue;
    }
    break;
  }
  return { env, rest: words.slice(i) };
}

/**
 * The command a `docker exec`, `docker compose exec` or `kubectl exec` runs inside the container, and whether it
 * gets a terminal (`-t`; compose exec gives one unless `-T`). Null when `words` isn't one of those.
 */
function execInner(words: string[]): { inner: string[]; tty: boolean } | null {
  let i: number;
  let tty: boolean;
  let valueFlags: Set<string>;
  if (words[0] === "docker" && words[1] === "exec") { i = 2; tty = false; valueFlags = new Set(["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--detach-keys"]); }
  else if ((words[0] === "docker" && words[1] === "compose") || words[0] === "docker-compose") {
    i = words[0] === "docker" ? 2 : 1;
    while (i < words.length && /^-/.test(words[i]!)) i += ["-f", "--file", "-p", "--project-name", "--env-file", "--profile", "--project-directory"].includes(words[i]!) ? 2 : 1;
    if (words[i] !== "exec" && words[i] !== "run") return null;
    i++;
    tty = true;
    valueFlags = new Set(["-e", "--env", "-u", "--user", "-w", "--workdir", "--index", "--name", "--entrypoint", "-p", "--publish", "-v", "--volume", "-l", "--label"]);
  } else if (words[0] === "kubectl" && words[1] === "exec") { i = 2; tty = false; valueFlags = new Set(["-n", "--namespace", "-c", "--container", "--context"]); }
  else return null;
  const compose = tty;
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") { i++; break; }
    if (!w.startsWith("-")) break;
    if (valueFlags.has(w)) { i++; continue; }
    if (compose && (w === "-T" || w === "--no-TTY" || w === "--no-tty")) tty = false;
    else if (w === "--tty" || (/^-[A-Za-z]+$/.test(w) && w.includes("t"))) tty = true;
  }
  // The container (or service, or pod) comes next, then the command; kubectl puts the command after `--`.
  const inner = words[0] === "kubectl" ? words.slice(words.indexOf("--") + 1 || words.length) : words.slice(i + 1);
  return { inner, tty };
}

/** A short-option cluster or long option: `has("-n 5 -f", "f", "--follow")`. */
// The letters of a cluster stop at a digit: `-bn1` is -b and -n 1, `-n50` is -n 50.
const hasFlag = (args: string[], short: string, long?: string) =>
  args.some((a) => (long !== undefined && (a === long || a.startsWith(`${long}=`))) || (/^-([A-Za-z]+)\w*$/.exec(a)?.[1]?.includes(short) ?? false));

/** Database clients that open a prompt unless given what to run; each with the options that make it one-shot. */
const DB_ONE_SHOT: Record<string, RegExp> = {
  // -c, -f or -l, also in a cluster (`-tAc`).
  psql: /^--(?:command|file|list)(?:=|$)|^-[A-Za-z]*[cfl]/,
  mysql: /^--execute(?:=|$)|^-[A-Za-z]*e/,
  mariadb: /^--execute(?:=|$)|^-[A-Za-z]*e/,
};
const SHELLS = new Set(["sh", "bash", "ash", "zsh", "dash"]);

/** psql's pager is off: `-P pager=off`, `--pset=pager=off`, a PAGER/PSQL_PAGER prefix, or `\pset pager off` in the same command. */
function psqlPagerOff(args: string[], env: string[], code: string): boolean {
  if (env.some((e) => /^(?:PSQL_)?PAGER=/.test(e))) return true;
  if (/\\pset\s+pager\s+(?:off|0)\b/.test(code)) return true;
  for (let i = 0; i < args.length; i++) {
    const a = bare(args[i]!);
    const val = a === "-P" || a === "--pset" ? bare(args[i + 1] ?? "") : /^(?:-P|--pset=)(.*)$/.exec(a)?.[1];
    if (val !== undefined && /^pager=(?:off|0)$/.test(val)) return true;
  }
  return false;
}

/** systemctl verbs that print through a pager. */
const SYSTEMCTL_PAGES = /^(?:status|show|cat|help|list-[\w-]+)$/;
/** git's options before the verb that take a value. */
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/**
 * R10, the forms DR-024's amendment adds (BOS-543): a pager the owner gets stuck in ("(END)", ":"), a prompt
 * the owner would type queries into, and a command that never returns by itself. Each says what to use instead.
 * A command whose output goes into a pipe or `$(…)` has no terminal, so it never pages.
 */
function waitsIn(code: string): string[] {
  const found: string[] = [];
  for (const c of shellCommands(code)) {
    const { env, rest } = commandWords(c.words);
    if (!rest.length) continue;
    const exec = execInner(rest);
    // Inside a container the command has a terminal only with -t; outside, the owner's terminal.
    const run = exec ? commandWords(exec.inner) : { env, rest };
    const words = run.rest.map(bare);
    const tty = exec ? exec.tty : true;
    const [cmd, ...args] = words;
    if (!cmd) continue;
    const name = cmd.replace(/^.*\//, "");
    const toTerminal = tty && !c.pipedOut;
    const stdinGiven = c.pipedIn || args.some((a) => a.startsWith("<"));
    if (name in DB_ONE_SHOT && !stdinGiven && !args.some((a) => DB_ONE_SHOT[name]!.test(a))) {
      found.push(`opens a ${name} prompt the owner would type queries into (${name} without a query). Give the query in the command: ${name} ${name === "psql" ? '-P pager=off -c "…"' : '-e "…"'}`);
      continue;
    }
    if (exec && exec.tty && SHELLS.has(name) && !args.some((a) => a === "-c" || /^-\w*c$/.test(a)) && !args.some((a) => !a.startsWith("-"))) {
      found.push(`opens a shell inside the container that the owner would type into (${name}). Run the command itself instead: docker exec <container> ${name} -c "…" or the command directly`);
      continue;
    }
    if (toTerminal) {
      if (name === "psql" && !psqlPagerOff(run.rest, [...env, ...run.env], code)) {
        found.push("shows long output in a pager (psql), where the owner is stuck at \"(END)\" or \":\". Add -P pager=off");
      } else if (name === "git") {
        let i = 0;
        let noPager = false;
        while (i < args.length && args[i]!.startsWith("-")) {
          if (args[i] === "--no-pager" || args[i] === "-P") noPager = true;
          i += GIT_VALUE_FLAGS.has(args[i]!) ? 2 : 1;
        }
        const verb = args[i];
        const pagerEnv = [...env, ...run.env].some((e) => /^(?:GIT_)?PAGER=/.test(e));
        if (verb && ["log", "diff", "show"].includes(verb) && !noPager && !pagerEnv && !args.includes("--quiet")) {
          found.push(`shows its output in a pager (git ${verb}), where the owner is stuck at "(END)" or ":". Write git --no-pager ${verb} …`);
        }
      } else if (name === "systemctl" && !args.includes("--no-pager") && SYSTEMCTL_PAGES.test(args.find((a) => !a.startsWith("-")) ?? "status")) {
        found.push(`shows its output in a pager (systemctl ${args.find((a) => !a.startsWith("-")) ?? "status"}), where the owner is stuck at "(END)" or ":". Add --no-pager: systemctl --no-pager …`);
      } else if (name === "journalctl" && !args.includes("--no-pager") && !hasFlag(args, "f", "--follow")) {
        found.push("shows the log in a pager (journalctl), where the owner is stuck at \"(END)\" or \":\". Add --no-pager, and -n 50 to show only the last lines");
      }
    }
    if (name === "less" || name === "more" || name === "man") {
      found.push(`is a pager (${name}), where the owner is stuck at "(END)" or ":". Print the text itself (cat, or the command's own output; --help instead of man)`);
    } else if (name === "journalctl" && hasFlag(args, "f", "--follow")) {
      found.push("follows the log and never returns by itself (journalctl -f). Show the last lines instead: journalctl --no-pager -n 50 …");
    } else if (name === "docker" && args[0] === "stats" && !args.includes("--no-stream")) {
      found.push("keeps updating and never returns by itself (docker stats). Add --no-stream");
    } else if (((name === "docker" && (args[0] === "logs" || (args[0] === "compose" && args.includes("logs")))) || (name === "docker-compose" && args.includes("logs"))) && hasFlag(args.slice(args.indexOf("logs") + 1), "f", "--follow")) {
      found.push("follows the log and never returns by itself (logs -f). Drop -f and show the last lines: docker logs --tail 50 …");
    } else if (name === "tail" && (hasFlag(args, "f", "--follow") || hasFlag(args, "F"))) {
      found.push("follows the file and never returns by itself (tail -f). Drop -f: tail -n 50 …");
    } else if (name === "watch") {
      found.push("repeats until it is stopped and never returns by itself (watch). Run the command once instead");
    } else if (name === "htop" || (name === "top" && !hasFlag(args, "n"))) {
      found.push(`keeps updating and never returns by itself (${name}). Use a one-shot command: top -b -n 1 | head -n 20, or docker stats --no-stream`);
    } else if (name === "ping" && !hasFlag(args, "c") && !hasFlag(args, "w")) {
      found.push("keeps going and never returns by itself (ping without -c). Add -c 3");
    }
  }
  return found;
}

/**
 * R12 (BOS-550 answer, DR-024 amendment): a command block made only of commands that print nothing when they
 * work looks to the owner as if it failed. Silent commands: assignments, cd, export, and file commands without -v.
 * The step must say so ("This prints nothing.") or show the result (`D=$(…); echo "$D"`). Overridable: the
 * wording is a judgement.
 */
const SILENT_FILE_COMMANDS = new Set(["cp", "mv", "install", "mkdir", "chmod", "chown", "ln", "touch", "rm"]);
const SAYS_SILENT = /\b(?:prints?|shows?|outputs?|says?|returns?) nothing\b|\bno output\b|\b(?:doesn'?t|does not|won'?t|will not) (?:print|show|output) anything\b|\bnothing (?:is |will be |gets )?(?:printed|shown)\b|\bsilent(?:ly)?\b/i;

/** What a block is when it prints nothing: "assignment" when one of its commands sets a variable, else "silent"; null when it prints. */
function silentBlock(code: string): "assignment" | "silent" | null {
  const cmds = shellCommands(code);
  if (!cmds.length) return null;
  let assignment = false;
  for (const c of cmds) {
    const { env, rest } = commandWords(c.words);
    if (!rest.length) {
      if (!env.length) return null;
      assignment = true;
      continue;
    }
    const [cmd, ...args] = rest.map(bare);
    if (cmd === "cd") { if (args[0] === "-") return null; continue; }
    if (cmd === "export") { if (!args.length || args.some((a) => a.startsWith("-"))) return null; continue; }
    if (SILENT_FILE_COMMANDS.has(cmd!) && !hasFlag(args, "v", "--verbose")) continue;
    return null;
  }
  return assignment ? "assignment" : "silent";
}

/**
 * R11 (DR-024 D): a host command, so the card must say how it was proven. A fixed list: docker and compose,
 * systemctl, tailscale, chown/chmod, and anything that names the .env file.
 */
const HOST_COMMAND = new RegExp(CMD + String.raw`(?:docker(?:-compose)?|systemctl|tailscale|chown|chmod)\b|(?:^|[\s/"'=>])\.env\b`, "m");
/** A look-only command (DR-024 kind 1): what a "not rehearsed" card ends with, so its answer closes the part that was untried. */
const LOOK_ONLY = new RegExp(CMD + String.raw`(?:docker(?:-compose)?\s+(?:compose\s+(?:-f\s+\S+\s+)*)?(?:ps|inspect|logs|images|version)|tailscale\s+(?:status|ip|version)|systemctl\s+(?:--no-pager\s+status|is-active|is-enabled)|curl|cat|ls|grep|df|du|ping|getent)\b`, "m");

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
/**
 * R15 (BOS-594): a command that recreates or restarts the runners at once cuts off every run in progress, with no
 * drain and no wake afterwards (6 Nov 16:00: a setting change applied with recreate-all). Setting changes go through
 * `scripts/update-runner.sh --settings`, new images through Build and update runners; both drain first.
 */
const RUNNER_RECREATE: Array<[RegExp, string]> = [
  [/\brecreate-all\b/, "recreates every runner at once"],
  [/\bupdate-runner\.sh\b[^\n|;&]*\s--now\b/, "recreates every runner at once (--now)"],
  [/\bdocker\s+(?:restart|stop|rm(?:\s+-f)?)\s+[^\n|;&]*\bboss-man-runner-/, "restarts or removes a runner container directly"],
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
  return { blocks, blockPieces, inline, prose, stray: strayFence(parts) };
}

// ---------------------------------------------------------------------------------------------------
// R17 (DR-052): a vague host step. "Delete X from .env" or "restart the notifications add-on" passes every other
// rule but leaves the owner asking where the file is and how to restart anything. A small phrase table, not a
// prose judge: each row is tested on its own, and a false refusal costs the author one rewrite (or a CEO override).
// ---------------------------------------------------------------------------------------------------

/** The host files a step may name, each of which needs a location. Not after a `/` (then it is a path) or a word
 * character (`.envrc`, `my.env`). */
const HOST_FILE = /(?<![\w/.}-])(\.env|(?:docker-)?compose[\w.-]*\.ya?ml|host\.json)(?![\w.-])/gi;
/** The verbs that make a step ask the owner to work on a file. */
const FILE_VERB = /\b(?:add|set|edit|open|change|remove|delete|put|copy|append|replace|update|write|uncomment|comment|look|check|find|create|paste|type)\b/i;
/** A host action aimed at something on the host: the verb, up to three words, then what it acts on. */
const HOST_ACTION = /\b(?:re-?start|stop|start|re-?create|pull|edit)\s+(?:[\w.-]+\s+){0,3}?(?:containers?|add-?ons?|services?|stacks?|files?)\b/i;
/** "delete/remove … from" a host file or thing. */
const HOST_REMOVE = /\b(?:delete|remove)\b[^.;\n]{1,80}?\bfrom\s+(?:[\w-]+\s+){0,3}?(?:\.env(?![\w.-])|(?:docker-)?compose[\w.-]*\.ya?ml|host\.json|containers?|add-?ons?|services?|stacks?|files?)\b/i;
/** A Boss Man button path: the owner does it in the app, so no command is needed. */
const SETTINGS_PATH = /\bSettings\s*(?:→|->)\s*\S/;
/** The pointer the go-live card writes in place of a host fact Boss Man hasn't been told yet (DR-052 point 5). */
export const THIS_HOST_POINTER = "Settings → Server and runner → This host";

/**
 * R17: refuse a step that names a host file with no location, or asks for a host action with neither a command
 * nor a button path. A command here is code with a space in it (`docker compose restart ntfy`), so a bare
 * `` `.env` `` in backticks is still a name, not a command. A `{{host.…}}` token is a location (filled in at go-live).
 */
function vagueHostFindings(step: number, prose: string, blocks: string[], refuse: LintFinding[]) {
  const commands = [...blocks, ...[...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)].filter((c) => /\S\s+\S/.test(c));
  // The words the owner reads, with every command taken out: a file named inside a command is the command's business.
  const words = prose.replace(/`([^`\n]+)`/g, (all, c: string) => (/\S\s+\S/.test(c) ? " " : c));
  const pointer = words.includes(THIS_HOST_POINTER);
  const before = refuse.length;
  // Only a step that asks the owner to do something with the file: "Your .env needs nothing new" names it harmlessly.
  for (const m of FILE_VERB.test(words) ? words.matchAll(HOST_FILE) : []) {
    const file = m[1]!;
    // A command that names the file, or a host token (filled with its real path at go-live), says where it is.
    if (pointer || commands.some((c) => c.toLowerCase().includes(file.toLowerCase()) || /\{\{\s*host\./.test(c))) continue;
    const token = /^\.env$/i.test(file) ? "{{host.env.file}}" : /compose/i.test(file) ? "{{host.compose.cmd}} (the docker compose command for this host)" : "its folder as a token ({{host.paths.deployer}}, {{host.paths.install}} or {{host.paths.src}}) followed by /" + file;
    refuse.push({ step, rule: "R17", problem: `names ${file} without saying where it is, so the owner can't find it. Write ${token} instead (Boss Man fills in this server's real path when the card goes out), or give a command that does it` });
    break;
  }
  const action = HOST_ACTION.exec(words) ?? HOST_REMOVE.exec(words);
  // One finding a step is enough: "delete X from .env" is already refused for the file.
  if (action && refuse.length === before && !commands.length && !SETTINGS_PATH.test(words)) {
    refuse.push({ step, rule: "R17", problem: `says "${action[0]}" with no command and no Settings → path, so the owner can't tell how. Give the command (for a service in the stack: \`{{host.compose.cmd}} restart <service>\`, with the service's name from the compose file) or the button path in the app` });
  }
}

// ---------------------------------------------------------------------------------------------------
// R19: a step on someone else's website says where its clicks came from. Vendor docs go out of date and an agent
// can't see the owner's screen, so a step is either `seen: <ticket image id>` (a screenshot of that screen) or
// `not seen: <doc URL>, <YYYY-MM-DD>` (read from a doc on that date). A card with a not-seen step must also offer
// the owner a way to say the screen differs.
// ---------------------------------------------------------------------------------------------------

/** A screenshot older than this many days no longer proves the screen looks that way. */
export const SEEN_MAX_DAYS = 30;
/** The option a card with a not-seen step must offer (matched by the words, so the writer can phrase the rest). */
export const SCREEN_DIFFERENT_OPTION = "My screen looks different (I'll attach a screenshot)";
const SCREEN_DIFFERENT = /\bmy screen looks different\b/i;
/** Generic web consoles a step may send the owner to. Short on purpose: a URL in the step catches the rest. */
const OUTSIDE_VENDORS = /\b(?:cloudflare|aws console|aws management console|google cloud console|azure portal|github|gitlab|stripe dashboard|namecheap|godaddy|vercel|netlify|digitalocean|hetzner)\b/i;
const SEEN_MARK = /(?<!not )\bseen:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const NOT_SEEN_MARK = /\bnot seen:\s*(https?:\/\/[^\s,]+)\s*,\s*(\d{4}-\d{2}-\d{2})/i;
const ANY_SEEN_WORD = /\b(?:not )?seen:/i;

/** True for a host that is the Boss Man server or the owner's own network, so a link to it is not "outside". */
function ownHost(host: string, serverHost: string | null | undefined): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (serverHost && h === serverHost.toLowerCase()) return true;
  return h === "localhost" || h === "::1" || /\.(?:local|lan|internal|home\.arpa|ts\.net)$/.test(h) || /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(h) || !h.includes(".");
}

/** The outside host a step sends the owner to: the first URL not on this server, else a vendor named in words. */
function outsideSite(prose: string, serverHost: string | null | undefined): string | null {
  // The doc URL inside a `not seen:` mark is where the writer read it, not where the owner is sent.
  const text = prose.replace(new RegExp(NOT_SEEN_MARK.source, "gi"), " ");
  for (const m of text.matchAll(/https?:\/\/([^\s/?#)>\]`'"]+)/gi)) if (!ownHost(m[1]!, serverHost)) return m[1]!.toLowerCase();
  return OUTSIDE_VENDORS.exec(text)?.[0] ?? null;
}

// R19b: once a vendor's docs have misled the owner, the next card for that vendor is written from their screenshot.
const COUNTRY_SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);
const SITE_ALIASES: Record<string, string> = { amazon: "aws", amazonaws: "aws" };
/** One key for a vendor however it is written: "dash.cloudflare.com" and "Cloudflare" are both "cloudflare". */
export function siteKey(hostOrVendor: string): string {
  const v = hostOrVendor.toLowerCase().trim().replace(/:\d+$/, "");
  if (!v.includes(".")) {
    const first = v.split(/\s+/)[0]!;
    return SITE_ALIASES[first] ?? first;
  }
  const labels = v.split(".");
  const sld = labels.length >= 3 && labels[labels.length - 1]!.length === 2 && COUNTRY_SECOND_LEVEL.has(labels[labels.length - 2]!) ? labels[labels.length - 3]! : labels[labels.length - 2]!;
  return SITE_ALIASES[sld] ?? sld;
}
/** Every outside site a step sends the owner to (URLs not on this server and vendors named in words), as `siteKey`s. */
export function outsideSiteKeys(prose: string, serverHost: string | null | undefined): string[] {
  const text = prose.replace(new RegExp(NOT_SEEN_MARK.source, "gi"), " ");
  const keys: string[] = [];
  for (const m of text.matchAll(/https?:\/\/([^\s/?#)>\]`'"]+)/gi)) if (!ownHost(m[1]!, serverHost)) keys.push(siteKey(m[1]!));
  for (const m of text.matchAll(new RegExp(OUTSIDE_VENDORS.source, "gi"))) keys.push(siteKey(m[0]));
  return [...new Set(keys)];
}
/** The refusal for a `not seen` step on a site whose docs misled the owner within SEEN_MAX_DAYS, or null. */
function mismatchRefusal(prose: string, facts: LintFacts, now: Date): string | null {
  if (!facts.mismatchedSites) return null;
  for (const key of outsideSiteKeys(prose, facts.serverHost)) {
    const at = facts.mismatchedSites[key];
    if (at === undefined) continue;
    const ageDays = (now.getTime() - Date.parse(at)) / 86_400_000;
    if (!(ageDays <= SEEN_MAX_DAYS)) continue;
    return `reads ${key}'s docs, but on ${at.slice(0, 10)} ${key}'s docs didn't match the owner's screen, so for ${SEEN_MAX_DAYS} days after that a step there needs "seen: <ticket image id>" from the owner's own screenshot (under ${SEEN_MAX_DAYS} days old), not "not seen:": ask the owner for one screenshot of their starting page first, attach it (attach_image), and write the steps from it`;
  }
  return null;
}

/** A checkpoint step: says what the owner should see before going on. */
const CHECKPOINT = /\byou should see\b|\bcheck that\b[^\n]*?\b(?:is|are) (?:listed|shown|visible)\b/i;
/** Something the owner can match on their screen: a quoted or backticked name, or a domain name. */
const CONCRETE_NAME = /["“`][^"”`\n]{2,}["”`]|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;
/** R19c: a card with outside-site steps opens with a checkpoint that names something concrete, and offers the stop. */
function checkpointFinding(first: string | undefined, options: readonly string[]): string | null {
  // The raw step, not `pieces().prose`: that takes out backticked text, which is a fine way to name what the owner sees.
  const prose = first ?? "";
  const m = CHECKPOINT.exec(prose);
  if (!m) return `is the first step of a card that sends the owner to someone else's website, so it must open with a checkpoint: say what they should see there ("You should see "<a project, domain or repo name they will recognise>" listed"), and offer the option "${SCREEN_DIFFERENT_OPTION}" as the stop if they don't`;
  if (!CONCRETE_NAME.test(prose.slice(m.index))) return `is a checkpoint that names nothing concrete. Name something the owner will see on their screen, in quotes or backticks (a project, domain or repo name), not "your account" or "the dashboard"`;
  if (!options.some((o) => SCREEN_DIFFERENT.test(o))) return `is a checkpoint with no stop: the card must offer the option "${SCREEN_DIFFERENT_OPTION}" for when the owner doesn't see what it names`;
  return null;
}

/**
 * R19: per step. Returns whether the step is "not seen" (explicitly, or because its image is older than SEEN_MAX_DAYS),
 * which the card-level option check needs. `images` maps ticket image ids to their created-at; with none given an
 * image id is accepted as it is (the caller could not look it up) and only its form is checked.
 */
function outsideSiteFindings(step: number, prose: string, facts: LintFacts, refuse: LintFinding[]): boolean {
  const site = outsideSite(prose, facts.serverHost);
  if (!site) return false;
  const now = facts.now ?? new Date();
  const seen = SEEN_MARK.exec(prose);
  const notSeen = NOT_SEEN_MARK.exec(prose);
  if (seen) {
    const created = facts.images?.[seen[1]!.toLowerCase()];
    if (facts.images && created === undefined) {
      refuse.push({ step, rule: "R19", problem: `says "seen: ${seen[1]}", but that is not an image attached to this ticket. Attach the screenshot of the ${site} screen (attach_image) and use its id, or write "not seen: <doc URL>, <YYYY-MM-DD>"` });
      return false;
    }
    const ageDays = created === undefined ? 0 : (now.getTime() - Date.parse(created)) / 86_400_000;
    if (ageDays <= SEEN_MAX_DAYS) return false;
    const stale = mismatchRefusal(prose, facts, now);
    if (stale) {
      refuse.push({ step, rule: "R19", problem: `says "seen: ${seen[1]}", but that screenshot is ${Math.floor(ageDays)} days old, and it ${stale}` });
      return true;
    }
    refuse.push({ step, rule: "R19", problem: `says "seen: ${seen[1]}", but that screenshot is ${Math.floor(ageDays)} days old (more than ${SEEN_MAX_DAYS}), so it counts as not seen. Attach a newer screenshot, or write "not seen: <doc URL>, <YYYY-MM-DD>" and offer the option "${SCREEN_DIFFERENT_OPTION}"` });
    return true;
  }
  if (notSeen) {
    if (Number.isNaN(Date.parse(notSeen[2]!)) || Date.parse(notSeen[2]!) > now.getTime() + 86_400_000) {
      refuse.push({ step, rule: "R19", problem: `has "not seen: …, ${notSeen[2]}", which is not a real past date. Write the date you read the doc as YYYY-MM-DD` });
    }
    const misled = mismatchRefusal(prose, facts, now);
    if (misled) refuse.push({ step, rule: "R19", problem: misled });
    return true;
  }
  refuse.push({ step, rule: "R19", problem: `sends the owner to ${site}, a site Boss Man can't see, and doesn't say where its clicks came from. Add "seen: <ticket image id>" if you have a screenshot of that screen (attach_image first, and it must be under ${SEEN_MAX_DAYS} days old), or "not seen: <doc URL>, <YYYY-MM-DD>" if you only read a doc${ANY_SEEN_WORD.test(prose) ? " (the mark you wrote isn't in that form)" : ""}. A card with a not-seen step must also offer the option "${SCREEN_DIFFERENT_OPTION}"` });
  return false;
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

/** Keys on the keyboard: "press Enter" is not a button. */
const KEYS = new Set(["enter", "return", "esc", "escape", "tab", "space", "spacebar", "ctrl", "control", "cmd", "command", "shift", "alt", "option", "delete", "backspace", "f5", "y", "n", "q"]);
/** Words that end a button's name in a sentence: "press Approve on the card", "click Save again". */
const AFTER_LABEL = /^(?:on|in|at|to|for|from|under|next|below|above|beside|near|again|and|then|when|once|if|so|or|until|button|link|tab|there|here|now|first|twice)\b/;
/**
 * Every control, normalised; a label ending in "…" is kept as its start and matches anything after it. A label
 * with a bracketed note ("Update runners (finish runs first)") also matches without it, as cards name it that way.
 */
const CONTROLS = (() => {
  const exact = new Set<string>(); // not state: local to the CONTROLS lookup-table builder
  const prefix = new Set<string>(); // not state: local to the CONTROLS lookup-table builder
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
/**
 * Which control `name` is: the listed label it names (normalised), "" for a key or one of the card's own options
 * (real, but not on any screen's list), or null when it isn't a control. A "…" label matches anything after its
 * start; when the name wasn't quoted (so the sentence may run on), a label followed by a word that ends it
 * ("Approve on the card") counts too.
 */
function controlLabel(name: string, quoted: boolean, options: Set<string>): string | null {
  const n = norm(name);
  if (!n || KEYS.has(n.split(" ")[0]!) || options.has(n)) return "";
  if (CONTROLS.exact.has(n)) return n;
  for (const p of CONTROLS.prefix) if (n === p || n.startsWith(`${p} `)) return p;
  if (quoted) return null;
  for (const l of [...CONTROLS.exact, ...options]) if (n.startsWith(`${l} `) && AFTER_LABEL.test(n.slice(l.length + 1))) return options.has(l) ? "" : l;
  return null;
}

/**
 * The controls a step tells the owner to press: `missing` are names the app doesn't have (R7), `pressed` the listed
 * buttons it names, with where (for R8). A name counts when it follows press/click/tap/hit and is quoted, bold or
 * starts with a capital ("press Overrule and merge"), or when it is "the X button". Lower-case words after the verb
 * ("click the link", "press it") aren't taken as names: refusing those would stop good cards, and a made-up button
 * is written the way the screen would show it.
 */
function controlsIn(prose: string, options: Set<string>): { missing: string[]; pressed: Pressed[] } {
  const missing: string[] = [];
  const pressed: Pressed[] = [];
  const named = (raw: string, quoted: boolean, at: number) => {
    const n = raw.replace(/\s+/g, " ").trim();
    if (!n) return;
    const label = controlLabel(n, quoted, options);
    if (label === null) { if (!missing.includes(n)) missing.push(n); }
    else if (label) pressed.push({ label, at });
  };
  for (const m of prose.matchAll(/\b(?:press|click|tap|hit)\s+(?:on\s+)?(?:the\s+)?/gi)) {
    const rest = prose.slice(m.index + m[0].length);
    const q = /^(?:"([^"\n]+)"|“([^”\n]+)”|\*\*([^*\n]+)\*\*|`([^`\n]+)`|'([^'\n]+)'(?!\w))/.exec(rest);
    if (q) named(q[1] ?? q[2] ?? q[3] ?? q[4] ?? q[5]!, true, m.index);
    else if (/^\p{Lu}/u.test(rest)) {
      // Widest reading first: an option can hold a comma ("Yes, move it") or a bracket that is part of the label
      // ("Update runners (finish runs first)"). Only if none of those is a control, cut at a comma or bracket
      // ("Save (top right)", "Approve, then close") and judge the shorter name.
      const cut = (re: RegExp) => rest.split(re)[0]!;
      const end = String.raw`\s+(?:button|link|tab)\b`;
      const readings = [`[.;:!?\\n→>]|${end}`, `[.,;:!?\\n→>]|${end}`, `[.,;:!?()\\n→>]|${end}`].map((re) => cut(new RegExp(re)));
      const label = readings.map((r) => controlLabel(r, false, options)).find((l) => l !== null);
      if (label === undefined) named(readings[2]!, false, m.index);
      else if (label) pressed.push({ label, at: m.index });
    }
  }
  for (const m of prose.matchAll(/(?:"([^"\n]+)"|“([^”\n]+)”|\*\*([^*\n]+)\*\*)\s+button\b/g)) named(m[1] ?? m[2] ?? m[3]!, true, m.index);
  for (const m of prose.matchAll(/\bthe\s+(\p{Lu}[^.,;:!?()\n"“”*]*?)\s+button\b/gu)) named(m[1]!, false, m.index);
  return { missing, pressed };
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

/** A `{{host.network.port.web}}`-style token: a recorded host fact (host-facts.ts) to fill in when a card is raised. */
const HOST_TOKEN = /\{\{\s*host\.([A-Za-z0-9_.]{1,80})\s*\}\}/g;

/** The fact names the steps use, without filling anything in. */
export function hostTokensIn(steps: readonly string[]): string[] {
  return [...new Set(steps.flatMap((s) => [...s.matchAll(HOST_TOKEN)].map((m) => m[1]!)))];
}

/** Fill each `{{host.KEY}}` with the recorded fact. `missing` names the facts with no usable value (not recorded, or
 * a value that would break a command block: a newline or a backtick); those tokens are left as they are, so the lint
 * and the card can't go out with a hole in it. */
export function fillHostTokens(steps: readonly string[], values: Readonly<Record<string, string>>): { steps: string[]; missing: string[] } {
  const missing = new Set<string>(); // not state: local to fillHostTokens
  const filled = steps.map((s) =>
    s.replace(HOST_TOKEN, (token, key: string) => {
      const v = Object.hasOwn(values, key) ? values[key]! : undefined;
      if (v === undefined || !v.trim() || /[\n\r`]/.test(v)) { missing.add(key); return token; }
      return v;
    }),
  );
  return { steps: filled, missing: [...missing] };
}

/** A fence line that names the account but not the host, e.g. `sh as="root"` (BOS-774): the agent left the host out. */
const FENCE_NO_HOST = /^([ \t]*```)sh\s+as="(root|login)"[ \t]*$/m;
/** A fence line that names the server's own name as the `{{host}}` token, e.g. `sh host="{{host}}" as="root"`
 * (DR-046): filled in from what the host deployer reports, never a name typed from memory. */
const FENCE_HOST_TOKEN = /^([ \t]*```)sh\s+host="\{\{\s*host\s*\}\}"\s+as="(root|login)"[ \t]*$/m;

/**
 * Fill the server's reported name into a fence line that names the account but leaves the host out, or that names
 * the server as the `{{host}}` token (BOS-774, DR-046): the block then runs on the server that runs Boss Man, which
 * is what the owner is told, not a guess. A block that names neither the host nor the account is left alone, so R6
 * still refuses it (the account can't be guessed). A fence that names another host, even a wrong one, is left alone
 * so R6 can refuse it. Without a reported name nothing is filled in, and an unfilled `{{host}}` is then refused by R4.
 */
export function fillServerHost(steps: readonly string[], serverHost: string | null | undefined): string[] {
  const name = serverHost?.trim();
  // No report yet: nothing is filled in. A `{{host}}` token is then refused by `checkAsk` with a message saying the
  // host deployer hasn't reported a name (DR-046): Boss Man won't guess the server it runs on.
  if (!name) return [...steps];
  // not state: a per-step rewrite for one call
  return steps.map((s) => s.replace(FENCE_HOST_TOKEN, `$1sh host="${name}" as="$2"`).replace(FENCE_NO_HOST, `$1sh host="${name}" as="$2"`));
}

/**
 * Checks an agent's owner steps the way the owner will read them (BOS-417, DR-008 Q1): refuse what can't work
 * as written, warn about what might not. R1 a pointer to another document instead of the action; R2 a shell
 * variable no step up to this one sets; R3 a command that isn't copy-safe (`commandProblem`), a placeholder
 * in inline code, or a ``` that isn't a complete block and would show as raw text (BOS-550); R4 a `{{…}}` token, which Boss Man can't fill in yet. Warnings: a wiki or ticket link, more
 * than one command in a step or more than 12 steps, and hedging next to a command.
 *
 * R7 (BOS-421, DR-009 L6): a step that tells the owner to press a button the app doesn't have
 * (`OWNER_CONTROLS`) is refused; `options` (the card's own buttons, which the owner can press too) count as real.
 *
 * R8 and R13 (BOS-442, owner-screens.ts): a path ("Settings → Secrets") must follow the app's menus and tabs, and a
 * button or field it names must be on the screen the path reaches (`OWNER_FIELDS` lists the fields); a step that
 * tells the owner to fill in a field must give the value or say that any value works. Both can be overridden.
 *
 * R6 (BOS-427) is the host and account check: every command block says where it runs and as whom, a block that
 * names the server says the name the host deployer reports (BOS-774: another name, like a remembered "truenas", is
 * refused; with no report yet it is only warned about), and a block
 * run by the owner's login may not read a recorded folder that login can't read unless an earlier block on the
 * card stages a readable copy for it. Pass `hosts` (the host facts Boss Man recorded) and `serverHost` (the name it
 * runs on) to check the paths;
 * without them only the host/account presence is checked, so a caller that hasn't been taught the facts keeps
 * working. Backups are never made world-readable.
 *
 * R9 (DR-023), only when `addons` are given: a step that names an add-on (ADDON_WORDS) that is not set up,
 * stopped or waiting for a login is refused, and one whose state is unknown is warned about; the add-on the
 * card itself sets up (`setsUp`) is exempt.
 *
 * R14 (DR-028) runs on every card: a git command that writes the checkout must run inside a `(umask 022 && …)`
 * subshell (`gitUmaskFindings`), and a `umask` outside a subshell is refused, since it stays set in the owner's terminal.
 * A CEO override can't let it through.
 *
 * R15 (DR-036), only when `selfDeploy` is given and the host deployer is installed: an agent card may not bring
 * the machine that runs Boss Man to a commit (`updateCardFindings`). That job belongs to Boss Man's own "Main has
 * moved" card, which is pinned, kept current and cleared by itself; the refusal points the agent to it.
 *
 * R16 (DR-046 part 2), only when `selfDeploy` is given and the host deployer is installed: a step that asks the
 * owner to press Build and update runners while a runner image update is already waiting for runs is refused
 * (`runnerUpdateFindings`), naming the wait; the CEO can let it through with a reason. A look-only check of the
 * runners Boss Man already shows is only warned about, never refused.
 *
 * `facts` is either the host facts array (R6 alone, the older call shape) or a `LintFacts` object carrying
 * `hosts`, `addons`, `setsUp` and `selfDeploy`. Each rule runs only when its facts are there.
 *
 * R10 (DR-024): a command that waits for typed input (INTERACTIVE), and since BOS-543 one that opens a pager, a
 * database or container-shell prompt, or never returns by itself (`waitsIn`). R11 (DR-024): steps with a host command
 * (HOST_COMMAND) need `proof`; a "not rehearsed" proof also needs the last step to be a look-only check.
 * R12 (BOS-543): a command block that prints nothing when it works must say so or show its result (`silentBlock`).
 * R17 (DR-052): a vague host step, a host file named with no location or a host action with neither a command nor a
 * Settings → path (`vagueHostFindings`). It can be overridden by the CEO.
 * R18 (DR-057): a step that adds, edits or offers "if it isn't there" on one of Boss Man's own forms (OWNER_FORMS)
 * without a value for every field it needs, or that names a "Settings → … form" the registry doesn't know
 * (`formStepFindings`). It can be overridden by the CEO. A `[if company.….deployTarget …]` branch still here wasn't
 * settled from the record (company-facts.ts), so it is R4.
 */
export function lintOwnerSteps(steps: string[], facts?: LintFacts | HostFacts[], proof?: Proof): { refuse: LintFinding[]; warn: LintFinding[] } {
  const given: LintFacts = Array.isArray(facts) ? { hosts: facts } : facts ?? {};
  const refuse: LintFinding[] = [];
  const warn: LintFinding[] = [];
  // not state: scratch for one call over one card; nothing is kept between calls.
  const set = new Set<string>();
  const own = new Set((given.options ?? []).map(norm));
  /** What earlier blocks on this card made readable for the login (BOS-427), per host and folder. */
  // not state: scratch for one call over one card; nothing is kept between calls.
  const staged = new Map<string, Set<string>>();
  let hostStep = 0;
  let notSeenStep = 0;
  let anyOutside = false;
  if (steps.length > STEP_LIMIT) warn.push({ step: STEP_LIMIT + 1, rule: "warn", problem: `has ${steps.length} steps, which suggests one card doing several stages' work` });
  steps.forEach((text, i) => {
    const step = i + 1;
    const { blocks, blockPieces, inline, prose, stray } = pieces(text);
    // A ``` the parser couldn't pair would reach the owner as raw text, with no Copy button (BOS-550).
    if (stray !== null) refuse.push({ step, rule: "R3", problem: `has a \`\`\` that isn't a complete command block, so the owner would see it as raw text ("${stray.slice(0, 80)}"). Put the opening fence line, the command and a closing \`\`\` each on a line of its own` });
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
    for (const c of code)
      for (const [re, what] of RUNNER_RECREATE)
        if (re.test(c)) {
          refuse.push({ step, rule: "R15", problem: `${what}, which cuts off every agent run in progress with no drain and no wake afterwards. For a runner setting change use \`scripts/update-runner.sh --settings\` (it waits for runs to finish, then wakes the agents); for a new runner image use Settings → Server and runner → Updates → Build and update runners. In a real emergency only the CEO can raise it, with lintOverride saying why` });
          break;
        }
    // A `{{host.…}}` token is filled in by `fillHostTokens` before this lint runs (checkAsk), so one left here had no
    // recorded fact behind it, or the caller has no host facts; any other token never has a value.
    for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) refuse.push({ step, rule: "R4", problem: `has {{${m[1]}}}, which Boss Man has no value for. Write the value itself` });
    const { missing, pressed } = controlsIn(prose, own);
    const screens = screenFindings(prose, pressed);
    for (const name of missing) {
      const screen = screens.screen ?? screenIn(prose);
      const there = screen ? ` The buttons on ${screen} are: ${OWNER_CONTROLS[screen].join(", ")}.` : "";
      refuse.push({ step, rule: "R7", problem: `tells the owner to press "${name}", which isn't a button in the app.${there} Name a button exactly as the screen shows it, or one of this card's options` });
    }
    for (const problem of screens.r8) refuse.push({ step, rule: "R8", problem });
    for (const problem of screens.r13) refuse.push({ step, rule: "R13", problem });
    const host = lintHost(blockPieces, step, given.hosts, given.serverHost, given.newHost, staged, step === 1);
    refuse.push(...host.refuse);
    warn.push(...host.warn);
    for (const c of code) refuse.push(...gitUmaskFindings(step, c));
    if (given.selfDeploy) updateCardFindings(step, code, given.selfDeploy, refuse);
    runnerUpdateFindings(step, text, code, given, refuse, warn);
    if (given.addons) addonFindings(step, text, given.addons, given.setsUp, refuse, warn);
    vagueHostFindings(step, prose, blocks, refuse);
    if (outsideSiteFindings(step, prose, given, refuse) && !notSeenStep) notSeenStep = step;
    if (!anyOutside && outsideSite(prose, given.serverHost)) anyOutside = true;
    for (const c of code) {
      const hit = INTERACTIVE.find(([re]) => re.test(c));
      if (hit) refuse.push({ step, rule: "R10", problem: `has a command that ${hit[1]}, which the owner would have to answer by typing: ${c.slice(0, 120)}. Give the value in the command, or for a secret an editor step naming the exact line (TS_AUTHKEY= in .env) or Boss Man's Secrets screen` });
      for (const w of new Set(waitsIn(c))) refuse.push({ step, rule: "R10", problem: `has a command that ${w}: ${c.slice(0, 120)}` });
    }
    // R12: only command blocks (what the owner runs), and the step's own sentences.
    if (!SAYS_SILENT.test(prose)) {
      for (const b of blocks) {
        const kind = silentBlock(b);
        if (kind) refuse.push({ step, rule: "R12", problem: `has a command that prints nothing when it works, so the owner may think it failed: ${b.slice(0, 120)}. Say so in the sentence ("This prints nothing.")${kind === "assignment" ? ', or show the value: D=$(…); echo "$D"' : ", or show the result (cp -v, mv -v…, or an ls or pwd after it)"}` });
      }
    }
    if (!hostStep && code.some((c) => HOST_COMMAND.test(c))) hostStep = step;
    if (LINK.test(prose)) warn.push({ step, rule: "warn", problem: "links to a wiki page or ticket; fine as background, but the step itself must be complete" });
    if (blocks.length > 1) warn.push({ step, rule: "warn", problem: `has ${blocks.length} commands; one per step is easier to follow` });
    const hedge = code.length ? HEDGES.exec(prose) : null;
    if (hedge) warn.push({ step, rule: "warn", problem: `hedges ("${hedge[0]}") next to a command` });
    // BOS-1571 usability gate: a duty the owner repeats is a cost that grows with every update; name how often, or automate it.
    const duty = recurringDutyHits(prose)[0];
    if (duty) warn.push({ step, rule: "warn", problem: `reads as something the owner must repeat ("${duty.slice(0, 80)}"); say how often, or make Boss Man do it so the owner needn't` });
  });
  // R19: a card built on a doc nobody saw on a screen must let the owner say the screen differs. Only checked when
  // the caller gave the card's options (a setup-steps check has none).
  if (notSeenStep && given.options && !given.options.some((o) => SCREEN_DIFFERENT.test(o))) {
    refuse.push({ step: notSeenStep, rule: "R19", problem: `is a "not seen" step on someone else's website, so the card must offer the option "${SCREEN_DIFFERENT_OPTION}" for when the owner's screen doesn't match` });
  }
  // R19c: a card that sends the owner to an outside site opens with a checkpoint they can match on screen. Only when
  // the caller gave the card's options (a setup-steps check has none, so no stop to offer).
  if (anyOutside && given.options) {
    const problem = checkpointFinding(steps[0], given.options);
    if (problem) refuse.push({ step: 1, rule: "R19", problem });
  }
  // R18 (DR-057): a step on one of Boss Man's own forms gives every value. Read over the whole card, as one visit to
  // a form can take two steps; only the sentences, as a command block is never a form.
  refuse.push(...formStepFindings(steps.map((s) => pieces(s).prose)));
  steps.forEach((text, i) => {
    const m = BRANCH_MARKER.exec(text);
    if (m) refuse.push({ step: i + 1, rule: "R4", problem: `starts "${m[0].trim()}", a branch only Boss Man's own record can settle, and it couldn't (no such company, or no single deploy target to read). Write the step without the branch, with every value` });
  });
  // BOS-1650: a `[when <fact>]` marker is settled from Boss Man's record when a ticket's setup card is raised
  // (owner-setup-when.ts) and is gone by now; one still here would reach the owner as raw text. (R20, prose
  // branching, is checked on ticket setup steps only: owner-setup-check.ts.)
  steps.forEach((text, i) => {
    const m = WHEN_MARKER.exec(text);
    if (m) refuse.push({ step: i + 1, rule: "R4", problem: `starts "${m[0].trim()}", a branch only Boss Man's own record can settle, and it hasn't (only a ticket's setup steps are settled that way). Write the step without the branch` });
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

// ---------------------------------------------------------------------------------------------------
// R6 (BOS-427): where a command runs and as whom, and whether that account can read what it opens.
// Ownership is a host fact (host.json, written by the host deployer from `stat`); nothing here guesses.
// ---------------------------------------------------------------------------------------------------

/** What a host uses a recorded folder for, as host-deployer.sh writes it (BOS-541). Order matters: it is the
 * precedence when one folder has several roles, and the private ones come first so R6 reads the strictest. */
export const FOLDER_ROLES = ["backups", "data", "secrets", "install", "deployer"] as const;
export type FolderRole = (typeof FOLDER_ROLES)[number];

/** Roles the owner never wants open to everyone: a backup copy, the database's files and secrets belong to their owner. */
const PRIVATE_ROLES: ReadonlySet<FolderRole> = new Set<FolderRole>(["backups", "data", "secrets"]);

/** A folder's ownership as the host recorded it: owner (a name or uid), group, and the mode as 3 or 4 octal digits.
 * `role` is what the host says the folder is for; absent on a record from an older deployer. */
export type Ownership = { path: string; owner: string; group: string; mode: string; role?: FolderRole };
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

/**
 * Read and search bits the login gets: the owner's if it is the owner, the group's if it is in the group, else
 * everyone's. When the host hasn't recorded which account the login is (an older deployer), a folder owned by an
 * ordinary account could well be the login's own, so only the "everyone" bits are trusted: a 700 folder owned by
 * uid 1000 is not refused as unreadable, since it may be the login's home. The check is then a safe under-refusal,
 * not a wrong one.
 */
function canRead(login: string | undefined, o: Ownership): boolean {
  const mode = parseInt(o.mode, 8);
  if (Number.isNaN(mode)) return false;
  if (!login) {
    // No login recorded: a root-owned folder is never the login's own, so only the "everyone" bits can help it
    // (the root-only backups case is refused); a folder an ordinary account owns is let through, since it may be
    // the login's own and refusing would be wrong.
    if (o.owner === "root" || o.owner === "0") return (mode & 0o004) !== 0 && (mode & 0o001) !== 0;
    return true;
  }
  const [read, search] = login === o.owner ? [0o400, 0o100] : login === o.group ? [0o040, 0o010] : [0o004, 0o001];
  return (mode & read) !== 0 && (mode & search) !== 0;
}

/** True when a mode is opened to everyone: the "other" bits are set at all (a backup left 644 or 755 by a default umask). */
const opensToAll = (mode: string) => {
  const m = parseInt(mode, 8);
  return !Number.isNaN(m) && (m & 0o007) !== 0;
};

/**
 * A recorded folder the owner never wants open to the world (the ticket: "never make backups world-readable").
 * Its role decides when the host recorded one (BOS-541: backups live in the install folder by default, so a name
 * is not enough); a folder from an older deployer, with no role, is still judged by its name.
 */
const PRIVATE_FOLDER = /(^|\/)(backups?|secrets?)(\/|$)/i;
const isPrivate = (rec: Ownership & { folder: string }) => (rec.role ? PRIVATE_ROLES.has(rec.role) : PRIVATE_FOLDER.test(rec.folder));

/** What R6 calls a private folder in its refusal, so the owner knows why it was refused. */
const privateWhat = (rec: Ownership & { folder: string }) => (rec.role === "backups" ? "Backups" : rec.role === "secrets" ? "Secrets" : rec.role === "data" ? "The database's files" : "Backups and secrets");

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
/** Commands whose mode option can open a folder to everyone. Not umask: its value means the opposite of a mode (umask 077 is private), and R14 checks it (DR-028). */
const MODES = new Set(["chmod", "install"]);

/** True when a command's mode opens it to everyone (an octal whose other bits are set, or o+rX / a+rX). */
function modeOpensUp(p: Prog): boolean {
  const mode = p.mode ?? p.args.find((a) => /^[0-7]{3,4}$/.test(a) || /^[ugoa]*[+=][rwxX]+$/.test(a));
  if (!mode) return false;
  if (/^[0-7]{3,4}$/.test(mode)) return (parseInt(mode, 8) & 0o007) !== 0;
  return /[ao][+=]?[rwxX]/.test(mode);
}

/**
 * R6: every block says where and as whom it runs; a block that names the server must name the one the host
 * deployer reports (BOS-774); a block run by the login may not read a recorded folder the login can't read
 * unless an earlier block on the card made a readable copy for it (a `sudo install -o <login>` or a
 * `cp`/`rsync` by the login); and a block that opens a backup folder to everyone is refused.
 * `staged` carries the folders earlier blocks made readable, so the check runs across the whole card.
 */
function lintHost(blockPieces: Array<Extract<StepPiece, { type: "command" }>>, step: number, hosts: HostFacts[] | undefined, serverHost: string | null | undefined, newHost: string | undefined, staged: Map<string, Set<string>>, first: boolean): { refuse: LintFinding[]; warn: LintFinding[] } {
  const refuse: LintFinding[] = [];
  const warn: LintFinding[] = [];
  // R6 runs only when the caller has the host facts (BOS-427): `checkAsk` always passes them, so every card is
  // checked there; a caller that only wanted another rule (R9) and passes none keeps working, as before.
  if (hosts === undefined) return { refuse, warn };
  /** The server's own name as the host deployer reports it. `serverHost` given as a name is that name; given as
   * null means Boss Man has no report yet; left undefined, the one host it has a record for stands in (the older
   * call shape). Never a default like "the server". */
  const ownName = serverHost !== undefined ? serverHost?.trim() || null : hosts.length === 1 ? hosts[0]!.name : null;
  /** A host a CEO-marked card is setting up (DR-046 `newHost`): the only unrecorded name that may appear, and only
   * on that card. Matched case-insensitively, like the server's own name. */
  const setUpName = newHost?.trim() || null;
  const isSetUp = (host: string) => setUpName !== null && host.toLowerCase() === setUpName.toLowerCase();
  /** The first command block that names a host Boss Man has no record for at all (BOS-774): an agent's remembered
   * host, an old runbook or a compose file name must never send the owner to a machine Boss Man no longer runs on.
   * A name another recorded host carries is that host, checked below; the server's own name and the `newHost` card's
   * new host match case-insensitively. */
  const named = blockPieces.find((p) => p.where !== undefined && !hosts.some((h) => h.name === p.where!.host) && !(ownName !== null && p.where.host.toLowerCase() === ownName.toLowerCase()) && !isSetUp(p.where.host))?.where?.host;
  if (named !== undefined) {
    if (ownName) return { refuse: [{ step, rule: "R6", problem: `runs on "${named}", but Boss Man runs on "${ownName}" (what the host deployer reports). Use host="${ownName}" in the block` }], warn };
    // No report yet (no deployer, or it hasn't ticked): the name can't be confirmed, so the card says so instead.
    return { refuse, warn: [...warn, { step, rule: "warn" as const, problem: `runs on "${named}", but Boss Man has no host report yet, so it can't confirm that is the server it runs on. Check it is, then go on` }] };
  }
  // A block on the host this card is setting up (DR-046): said plainly on the card, and the first step must only
  // look, because R6 has no record to check what the owner's login can read there.
  if (blockPieces.some((p) => p.where !== undefined && isSetUp(p.where.host))) {
    warn.push({ step, rule: "warn", problem: `runs on "${setUpName}", which isn't known to Boss Man yet (this card sets it up). Start with a read-only check (ls -ld, df -h) that says what the owner should see before anything is changed` });
  }
  /** A block that names the server itself (the reported name, whatever the case) is the one R6 reads. */
  const onServer = (host: string) => ownName !== null && host.toLowerCase() === ownName.toLowerCase();
  const stagedForLogin = (host: string, folder: string) => {
    const set = staged.get(host) ?? new Set<string>();
    set.add(folder);
    staged.set(host, set);
  };
  /** Refuse a login-run read of a recorded folder the login can't read, unless an earlier block made a copy it can. */
  const refusesLoginRead = (host: string, login: string | undefined, target: string, rec: Ownership & { folder: string }): boolean => {
    const can = canRead(login, rec);
    const made = staged.get(host)?.has(rec.folder) ?? false;
    if (can || made) return false;
    refuse.push({ step, rule: "R6", problem: `runs as the login on ${host} and reads ${target}, which the login can't read (${rec.path} is mode ${rec.mode}, owned by ${rec.owner}). Run this block as root, or make a copy for the login in an earlier step (sudo install -o <login> -m 700 -D <source> <folder>)` });
    return true;
  };
  for (const piece of blockPieces) {
    const where = piece.where;
    if (!where) {
      refuse.push({ step, rule: "R6", problem: `has a command that doesn't say where it runs or as which account. Put it in its own block as sh host="<name>" as="root" or as="login"` });
      continue;
    }
    const known = ownName && onServer(where.host) ? hosts.find((h) => h.name === ownName) : hosts.find((h) => h.name === where.host);
    if (hosts && !known) {
      // A host with no record (a second host the deployer hasn't written one for yet) has no ownership facts, so
      // R6 can't check a step's paths. The card is allowed, but its first step should be a read-only check. The
      // server's own name is never this case (BOS-774: it is refused above, or it has a record under that name).
      if (first && !ownName) warn.push({ step, rule: "warn", problem: `runs on "${where.host}", which Boss Man hasn't recorded, so it can't check what the owner's login can read there. Start with a read-only check (ls -ld, df -h) and say what the owner should see before anything is changed` });
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
        // A copy reads its source operands (all but the last) and writes at the last one. Run by the login, it
        // has to be able to read every source, or the copy fails (and must not stage anything). Split on the raw
        // operands by position first, so a relative destination is never mistaken for a source.
        const operands = p.args.map((a) => pathArg(a));
        const sources = operands.slice(0, -1).filter((a): a is string => a !== null);
        let sourceReadable = true;
        for (const source of sources) {
          const rec = recordedFolder(source, known);
          if (rec && !asRoot && refusesLoginRead(where.host, known.login, source, rec)) sourceReadable = false;
        }
        // Only an absolute destination names the folder a copy can stage; a relative one (`.`, `~/x`) is a
        // path the shell works out, so R6 neither warns about it nor treats it as a folder made readable.
        const dest = operands.at(-1) ?? null;
        // A copy out of a private folder is refused when its mode opens it to everyone, whatever the destination
        // (BOS-541: `install -m 644 <backups>/db.sql.gz /home/<login>/` is a world-readable backup). The mode is
        // the copy's own (-m), else the login's umask or `install`'s default 755; a copy by root with no mode
        // keeps the source's mode, so it is refused only when the source is already open. This runs even for a
        // relative destination, because the source is what makes it a backup.
        const privateRec = sources.map((s) => recordedFolder(s, known)).find((r): r is Ownership & { folder: string } => r !== null && isPrivate(r));
        if (privateRec) {
          const sourceOpen = opensToAll(privateRec.mode);
          const opens = p.mode !== undefined ? opensToAll(p.mode) : p.name === "install" ? true : asRoot ? sourceOpen : modeOpensUp(p);
          if (opens)
            refuse.push({ step, rule: "R6", problem: `copies ${sources.find((s) => inside(s, privateRec.folder))} out of a private folder (${privateRec.folder}) with a mode that opens it to everyone. ${privateWhat(privateRec)} stay readable only by their owner` });
        }
        if (!dest) continue;
        const rec = recordedFolder(dest, known);
        if (!rec) {
          warn.push({ step, rule: "warn", problem: `${p.name} puts a copy at ${dest}, which has no recorded ownership on ${known.name}; R6 can't tell whether the owner's login can use it` });
          continue;
        }
        // Remember the folder a copy made for the login, so a later login block can read it. `install -o` names
        // the account it hands the copy to: that stages it only when the owner isn't root (a copy by root that
        // stays root's is not readable by the login). A copy the login runs itself is readable by it, but only
        // if it could read the source.
        const namesLogin = p.owner !== undefined && p.owner !== "root";
        if (sourceReadable && (namesLogin || (!asRoot && p.owner === undefined))) stagedForLogin(where.host, rec.folder);
        // An install or chown that opens a private folder's mode to everyone is refused, like chmod below.
        if (MODES.has(p.name) && modeOpensUp(p) && isPrivate(rec))
          refuse.push({ step, rule: "R6", problem: `opens ${dest} to everyone with ${p.name}. ${privateWhat(rec)} stay readable only by their owner` });
        continue;
      }
      if (MODES.has(p.name) && modeOpensUp(p)) {
        for (const target of abs) {
          const rec = recordedFolder(target, known);
          if (rec && isPrivate(rec)) refuse.push({ step, rule: "R6", problem: `opens ${target} to everyone with ${p.name}. ${privateWhat(rec)} stay readable only by their owner` });
        }
        continue;
      }
      if (!READS.has(p.name) || asRoot) continue;
      // A read opens its first path (the file, or the folder it lists).
      const target = abs[0]!;
      const rec = recordedFolder(target, known);
      if (!rec) continue;
      refusesLoginRead(where.host, known.login, target, rec);
    }
  }
  return { refuse, warn };
}

// ---------------------------------------------------------------------------------------------------
// R14 (DR-028, the 6 Nov outage): git writes files with the terminal's umask. Under a root shell's 077 the
// checkout came out root-only, the image built from it couldn't read its own code, and both colours went down.
// So a git step that writes the checkout runs as (umask 022 && cd <src> && git …): the subshell keeps 022 from
// staying set in the owner's root terminal, where it would make their later hand-made backups world-readable.
// ---------------------------------------------------------------------------------------------------

/** git subcommands that write files in the working tree. */
const GIT_WRITES = new Set(["checkout", "switch", "merge", "pull", "reset", "restore", "rebase", "cherry-pick", "revert", "stash", "am", "apply", "clone", "worktree", "submodule"]);
/** Their read-only forms (`git stash list`), which write nothing. */
const GIT_READ_ONLY = new Set(["list", "show", "status", "summary"]);
/** git's own options that take the next word as their value (`git -C <dir> checkout`). */
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
/** The subshell R14 accepts: it opens with umask 022 (or 0022), then && or ;. */
const UMASK_SUBSHELL = /^\(\s*umask\s+0?022\s*(?:&&|;)/;

/** The index of the ) closing the ( at `open`, skipping quoted text; -1 if it never closes. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (c === "\"") {
      for (i++; i < text.length && text[i] !== "\""; i++) if (text[i] === "\\") i++;
    } else if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * A command with its subshells cut out: every one, or with `only` just those it matches (the accepted umask
 * subshells), so what is left runs under the terminal's own umask. Any parenthesis not cut (a plain subshell,
 * `$(…)`) becomes a command separator, so the git inside it is still seen.
 */
function outsideSubshells(command: string, only?: RegExp): string {
  let out = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'" || c === "\"") {
      let j = i + 1;
      while (j < command.length && command[j] !== c) j += c === "\"" && command[j] === "\\" ? 2 : 1;
      out += command.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(") {
      const end = closingParen(command, i);
      if (end !== -1 && (!only || only.test(command.slice(i, end + 1)))) {
        out += " ; ";
        i = end;
        continue;
      }
    }
    out += c === "(" || c === ")" ? " ; " : c;
  }
  return out;
}

/**
 * R14: refuse a git command that writes the checkout outside a `(umask 022 && …)` subshell, and a `umask` set
 * at the top level, where it stays set in the owner's terminal. A umask inside any subshell ends with it, so
 * `(umask 077; pg_dump … >backup)`, the private-backup form our own scripts use, passes. A word split, not a
 * parser: git hidden in a quoted `sh -c` string is not seen.
 */
export function gitUmaskFindings(step: number, command: string): LintFinding[] {
  const out: LintFinding[] = [];
  for (const words of simpleCommands(outsideSubshells(command))) {
    const prog = readCommand(words).prog;
    if (prog?.name === "umask" && prog.args.length)
      out.push({ step, rule: "R14", problem: `sets umask outside a subshell, so it stays set in the owner's terminal: ${command.slice(0, 120)}. Put it with the command it is for, in a subshell: (umask 022 && cd <folder> && git …)` });
  }
  for (const words of simpleCommands(outsideSubshells(command, UMASK_SUBSHELL))) {
    const prog = readCommand(words).prog;
    if (prog?.name !== "git") continue;
    let j = words.findIndex((w) => w.split("/").pop() === "git") + 1;
    while (j < words.length && words[j]!.startsWith("-")) j += GIT_VALUE_OPTS.has(words[j]!) ? 2 : 1;
    const sub = words[j];
    if (!sub || !GIT_WRITES.has(sub)) continue;
    if (["stash", "worktree", "submodule"].includes(sub) && GIT_READ_ONLY.has(words[j + 1] ?? "")) continue;
    out.push({ step, rule: "R14", problem: `runs git ${sub} outside a (umask 022 && …) subshell, so the files it writes take the terminal's umask (a root shell's 077 leaves the checkout unreadable by the server, as on 6 Nov): ${command.slice(0, 120)}. Write it as (umask 022 && cd <folder> && git ${sub} …)` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// R15 (DR-036, the 7 Nov duplicate update cards). The machine's own update, pinning it to a commit,
// rebuilding it and rolling it back are Boss Man's job: its "Main has moved" card is pinned, kept current
// and cleared by itself. An agent card that also does it has no commit behind it, so nothing supersedes
// it, and the owner is asked twice. So that card is refused here, pointed at Boss Man's own.
// ---------------------------------------------------------------------------------------------------

/** What the machine's own update card is, as far as this rule needs it: whether the host deployer is
 * installed at all (an install without one only ever gets an agent's card), the install folder the host
 * reported (so a git there is recognised, never guessed), and the open card's commit for the refusal to name. */
export type SelfDeployFacts = {
  /** The deployer folder is set, so Boss Man raises its own update card. */
  enabled: boolean;
  /** The install folder the host reported (`paths.src`, where the checkout lives). */
  installDir?: string;
  /** The commit that card offers, for the refusal to name; absent when none is open. */
  openCommit?: string;
  /** The drain in progress (`getHold`), for R16 (DR-046 part 2): a runner image update already waiting for runs.
   * `null` says Boss Man looked and found none pending. */
  hold?: RunnerHold | null;
};

/** The scripts that bring the machine up to a commit or roll it back: they run from the install folder. */
const UPDATE_SCRIPTS = /(?:^|\/)(?:rebuild-live|deploy|update-runner|host-deployer)\.sh$/;
/** git's own options that take the next word as their value (`git -C <dir> checkout`). */
const GIT_SELF_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** The program's name as it was written, folder dropped (`/mnt/bm/src/scripts/deploy.sh` → `deploy.sh`). */
const progName = (words: string[], p: Prog) => words.find((w) => (w.split("/").pop() ?? "") === p.name) ?? p.name;

/**
 * How a program names an update script: its own name, or the first argument that is one (`sh scripts/deploy.sh`).
 * The argument has to be a word, not an option (`--rollback` isn't a script), and the folder in front is kept
 * so `…/rebuild-live.sh` is recognised wherever the install lives.
 */
const updateScriptOf = (p: Prog): string | null => {
  if (UPDATE_SCRIPTS.test(`/${p.name}`)) return p.name;
  return p.args.find((a) => !a.startsWith("-") && UPDATE_SCRIPTS.test(`/${a}`)) ?? null;
};

/**
 * Where a `git` in this word list would write the checkout: the `-C` path if it names one, else the `cd` the
 * command runs after. Both are made absolute against `/` only when they are paths; a bare word is `null`, so the
 * rule falls back to the install folder the host reported.
 */
function gitAt(words: string[], p: Prog): string | null {
  const rest = words.slice(words.indexOf(progName(words, p)) + 1);
  let j = 0;
  while (j < rest.length && rest[j]!.startsWith("-")) {
    if (rest[j] === "-C" && rest[j + 1]) return normPath(rest[j + 1]!);
    j += GIT_SELF_OPTS.has(rest[j]!) ? 2 : 1;
  }
  return null;
}

/** The folder a command's own `cd`/`pushd` goes to before a git runs there, or null when it doesn't go anywhere. */
function commandCd(command: string): string | null {
  for (const words of simpleCommands(unparen(command))) {
    const p = readCommand(words).prog;
    if (p?.name === "cd" || p?.name === "pushd") {
      const target = p.args.at(-1);
      if (target) return normPath(target);
    }
  }
  return null;
}

/** A subshell's parentheses as command separators, so `(cd X && git …)` is read as `cd X` and `git …` (R15 reads through them). */
const unparen = (command: string) => command.replace(/[()]/g, " ; ");

/**
 * R15 (DR-036): refuse an agent card whose steps bring this machine's Boss Man to a commit or rebuild it, when
 * the host deployer is installed. Two things count: a step that runs an update script (rebuild-live.sh,
 * deploy.sh, update-runner.sh, host-deployer.sh — directly, or as `sh scripts/deploy.sh`), and a git write
 * (checkout, switch, merge, pull, reset, restore, rebase, …) run on the install folder. The refusals point the
 * agent at Boss Man's own card instead.
 *
 * Where a git runs: a `-C` path, else the step's own `cd`, else the install folder the host reported. Without
 * an install folder a bare `git checkout` can't be told from one in an agent's own checkout, so only the update
 * scripts are refused — the rule never guesses a folder. A `sh -c` string is not read, as with R14: it guards
 * against an agent copying an update card by accident, not against someone hiding one.
 */
export function updateCardFindings(step: number, commands: string[], facts: SelfDeployFacts, out: LintFinding[]): void {
  if (!facts.enabled) return;
  let reported = false;
  for (const command of commands) {
    const cd = commandCd(command);
    for (const words of simpleCommands(unparen(command))) {
      const p = readCommand(words).prog;
      if (!p) continue;
      const script = updateScriptOf(p);
      if (script) {
        if (!reported) out.push({ step, rule: "R15", problem: `runs the machine's own update script (${script}), which brings the machine that runs Boss Man to a commit or rebuilds it. ${updateCardHint(facts)}` });
        reported = true;
        continue;
      }
      if (p.name !== "git") continue;
      const rest = words.slice(words.indexOf(progName(words, p)) + 1);
      let j = 0;
      while (j < rest.length && rest[j]!.startsWith("-")) j += GIT_SELF_OPTS.has(rest[j]!) ? 2 : 1;
      const sub = rest[j];
      if (!sub || !GIT_WRITES.has(sub)) continue;
      if (["stash", "worktree", "submodule"].includes(sub) && GIT_READ_ONLY.has(rest[j + 1] ?? "")) continue;
      const at = gitAt(words, p) ?? cd ?? facts.installDir ?? null;
      if (!at) continue; // no folder to go by: can't tell an agent's checkout from the install, so leave it
      if (!facts.installDir || normPath(at) !== facts.installDir) continue; // a git in another folder is the agent's own work
      if (!reported) out.push({ step, rule: "R15", problem: `runs git ${sub} in the install folder (${at}), which would bring the machine that runs Boss Man to a commit. ${updateCardHint(facts)}` });
      reported = true;
    }
  }
}

/** Where an agent's update work goes instead: Boss Man's own card, named when one is open. */
function updateCardHint(facts: SelfDeployFacts): string {
  const open = facts.openCommit ? `the open "Main has moved to ${facts.openCommit.slice(0, 8)}" card` : `Boss Man's own "Main has moved" card (one is raised when main moves past what runs)`;
  return `Updating the machine that runs Boss Man is Boss Man's own job: approve ${open}, which is pinned to the commit and clears itself once applied. Fix the steps to leave the update out, and raise this card again${facts.openCommit ? "" : " if it has another purpose"}. If the update card's steps are missing something, have the change make it into the server's step builder (self-deploy.ts) rather than around it.`;
}

/** The "Build and update runners" button, as a step names it (DR-046 part 2). Matched on the button's words in the
 * whole step, so a sentence that opens the path to it ("Settings → Server and runner → Updates → Build and update
 * runners") counts, not only one that says "press". */
const REBUILD_BUTTON = /\bbuild and update runners\b/i;
/** A command that only looks at what Boss Man already shows (DR-046 part 4): it reads containers or images and prints them. */
const LOOK_ONLY_DOCKER = /\bdocker\s+(?:ps|images|inspect)\b/;

/**
 * R16 (DR-046 part 2): refuse a step that asks the owner to press Settings → Server and runner → Updates → Build and
 * update runners while a runner image update is already under way. Boss Man raised that update itself and swaps each
 * runner onto the new image as its company goes idle; asking the owner to press it again does nothing useful, and the
 * second ask is what Brian's card d8983eb1 did. A pending setting change (`kind: "settings"`) is not an image update,
 * so it doesn't refuse the button (the button only builds and swaps an image). A CEO can let it through with a reason
 * for the rare case the pending image is itself broken, so this rule is overridable, not in `NOT_OVERRIDABLE`.
 *
 * The hold is only read when the host deployer is installed (`selfDeploy.enabled`), the same condition R15 uses: an
 * install without one has no Boss Man update of its own to point at.
 *
 * A look-only host check that Boss Man already shows (`docker ps`, `docker images`) is warned about, never refused
 * (DR-046 part 4): the card should point the owner at server_status or Settings → Server and runner instead.
 */
export function runnerUpdateFindings(step: number, text: string, commands: string[], facts: LintFacts, refuse: LintFinding[], warn: LintFinding[]): void {
  if (!facts.selfDeploy?.enabled) return;
  const hold = facts.selfDeploy.hold;
  const pendingImage = !!hold && hold.kind !== "settings";
  if (pendingImage && REBUILD_BUTTON.test(text)) {
    const since = hold.since ? ` (waiting for runs since ${hold.since})` : "";
    refuse.push({ step, rule: "R16", problem: `asks the owner to press Build and update runners, but a runner update is already under way${since}. Boss Man swaps each runner onto the new image by itself as its company goes idle; don't ask the owner to press it again. Leave the step out (say the update is in progress and will finish on its own), or the CEO can let it through with a reason if the pending image is itself broken` });
    return;
  }
  if (commands.some((c) => LOOK_ONLY_DOCKER.test(c)) && /\brunners?\b/i.test(text)) {
    warn.push({ step, rule: "warn", problem: "runs a look-only check of the runners that Boss Man already shows in server_status and Settings → Server and runner; point the owner there instead of asking them to paste the output back" });
  }
}

// R14 too (DR-028): its fix is always the same subshell, so there is never a reason to let a bare git step through.
// R15 too (DR-036): the fix is to leave the update to Boss Man's own card, never to hand-write it.
// R10 too (DR-024 D and its amendment): an override can't bypass a command that waits for typed input, pages
// or never returns. R12 (prints nothing) stays overridable: whether a sentence says enough is a judgement.
export const NOT_OVERRIDABLE: ReadonlySet<LintFinding["rule"]> = new Set(["R3", "R4", "R10", "R14", "R15"]);

/** One line per finding, for the agent's refusal or the CEO's list. */
export const lintLines = (fs: LintFinding[]) => fs.map((f) => `- Step ${f.step}: ${f.problem}.`).join("\n");
