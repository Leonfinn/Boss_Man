// Plain-English explanations of permission requests, worked out from the command itself
// (no model): what the owner is being asked to allow, and the worst thing it could do.

import { BUILTIN_GUARDS, commandOf, DESTRUCTIVE, looksLikeBossmanTool, PUSHING, type PermissionInfo, type PolicyMatch } from "./policy.js";
import { commandRisks } from "./destructive.js";

export type Effect = "reads" | "changes" | "deletes" | "network" | "pushes" | "unknown";

/** Worst first. */
const WORST: Effect[] = ["deletes", "pushes", "changes", "unknown", "network", "reads"];

export type PermissionExplanation = {
  /** "Wiki Maintainer wants to run a command" */
  title: string;
  /** One plain sentence on what it would do. */
  summary: string;
  effect: Effect;
  /** The exact shell command, when it is one. */
  command?: string;
  /** What the agent says it's for (its claim, not ours). */
  reason?: string;
  /** Why "Allow always" isn't offered, when it isn't. */
  alwaysNote?: string;
  /** Every file it changes or deletes is under /tmp: the plain reassurance, and programs Boss Man couldn't check. */
  scratch?: { note: string; unchecked: string[] };
  /** Where a `git push` goes, and what is dangerous about it (BOS-208). */
  push?: PushReading;
  /** One plain line on why the card is with the owner and not the CEO (BOS-793). Set only on owner-tier cards. */
  ownerWhy?: string;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Why a card went to the owner and not the CEO, in one plain sentence (BOS-793). Display only: it
 * changes no routing. `rule` is the name of the rule that sent it; `command` is the shell command, if any.
 */
export function ownerWhy(command: string | null, rule: string): string {
  const lead = "Sent to you, not the CEO, because";
  if (command) {
    const risks = commandRisks(command);
    const risk = risks.find((r) => r.kind === "destroys") ?? risks.find((r) => r.kind === "pushes");
    if (risk) return `${lead} the destructive-command guard caught part of it (${risk.why})${risk.text ? `: ${clip(risk.text, 100)}` : ""}.`;
    if (new RegExp(DESTRUCTIVE, "i").test(command)) return `${lead} the destructive-command guard matched it.`;
    if (new RegExp(PUSHING, "i").test(command)) return `${lead} it pushes or publishes.`;
  }
  const guard = BUILTIN_GUARDS.find((g) => g.name === rule);
  return guard ? `${lead} the built-in rule "${rule}" applies.` : `${lead} the rule "${rule}" sends it to you.`;
}

/** A standing rule the owner can pick instead of "Allow once". */
export type AlwaysChoice = {
  label: string;
  name: string;
  match: PolicyMatch;
  /** What the rule allows, finishing "Always allow <who> to …"; the card shows the whole sentence before saving. */
  what: string;
};

/** Who a saved "always" rule covers: only the agent that asked (the default) or every agent in the company. */
export type AlwaysScope = "agent" | "company";

/** How long a saved "always" rule lasts (BOS-2188): one hour, until the server's midnight, or with no end (the default). */
export type AlwaysTtl = "hour" | "midnight" | "always";

/** Shell grammar, not programs: skipped to find the program that follows. */
const KEYWORDS = new Set("if then else elif fi for do done while until case esac function { } ! [[ ]] (( ))".split(" "));
const SHELLS = new Set("bash sh zsh dash python python3 node".split(" "));
const READS = new Set("set export local declare readonly unset shift return exit printf read trap break continue cat grep egrep rg ls head tail wc stat du df free ps which pwd echo cd date whoami uname sort uniq cut tr diff file test [ true sleep".split(" "));
const CHANGES = new Set("tee mv cp mkdir touch chmod chown ln".split(" "));
const DELETES = new Set("rm rmdir unlink shred".split(" "));
const NETWORK = new Set("curl wget ssh scp nc ncat rsync agent-browser".split(" "));
const GIT_READS = new Set("status log diff show branch rev-parse ls-files blame remote grep describe merge-base show-ref cat-file shortlog rev-list for-each-ref ls-tree reflog name-rev symbolic-ref check-ignore count-objects merge-tree range-diff whatchanged version help fsck cherry".split(" "));
const GIT_CHANGES = new Set("add commit checkout switch merge reset rebase stash restore cherry-pick tag apply mv revert am notes init gc prune config sparse-checkout bisect format-patch update-ref".split(" "));
const GIT_NETWORK = new Set(["fetch", "pull", "clone", "ls-remote", "submodule"]);
/** git options that take the next word as their value, so it isn't the subcommand. */
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PKG = new Set(["npm", "pnpm", "yarn"]);
const PKG_INSTALL = new Set(["install", "i", "add", "ci", "remove", "uninstall"]);
/**
 * Package-manager subcommands that are the project's own work (an install, its scripts and the
 * project's build/test/lint), so their writes belong to the project and never aim at a named
 * target. An allow-list, not a denylist (BOS-165 security round 4): anything else — dlx, exec,
 * create, publish, an unknown subcommand — runs a program on any folder, so it is not exempt.
 * Only a subcommand right after the program counts (round 6): any leading option, whatever its
 * arity, means not exempt. Counting options' values was a losing game — rounds 3-5 each found one
 * more spelling that slipped a runner past — and losing Allow on `pnpm --silent run build` costs
 * little.
 */
const PKG_SCRIPTS = new Set(["install", "i", "add", "ci", "remove", "uninstall", "run", "run-script", "build", "test", "t", "typecheck", "lint", "start"]);

/** Paths the owner will recognise, in friendly words. */
const FRIENDLY: Array<[RegExp, string]> = [
  [/^\/proc\/meminfo$/, "the machine's memory"],
  [/^\/sys\/fs\/cgroup\/memory[./]/, "the container's memory limit"],
];
const friendly = (p: string) => FRIENDLY.find(([re]) => re.test(p))?.[1] ?? p;

/** Splits on ; && || | and newlines outside quotes, leaving out heredoc bodies (text fed to a program, not commands). shortcut: no escapes or subshells; commands that use $( ) or backticks are flagged unknown instead. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  const heredocs: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    // A backslash outside single quotes escapes the next character: \" stays inside the quote, \; is not a separator, and \ at the end of a line joins it to the next (BOS-752).
    if (c === "\\" && quote !== "'" && i + 1 < command.length) {
      cur += command[i + 1] === "\n" ? " " : c + command[i + 1];
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "<" && command.startsWith("<<", i) && command[i + 2] !== "<") {
      const m = /^<<-?\s*(['"]?)(\w+)\1/.exec(command.slice(i));
      if (m) {
        heredocs.push(m[2]!);
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    } else if (c === ";" || c === "|" || c === "\n" || (c === "&" && (command[i + 1] === "&" || (command[i - 1] !== ">" && command[i + 1] !== ">")))) {
      if ((c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) i++;
      out.push(cur);
      cur = "";
      // Skip each heredoc's body, up to its closing word on a line of its own.
      if (c === "\n") {
        for (const end of heredocs.splice(0)) {
          const lines = command.slice(i + 1).split("\n");
          const stop = lines.findIndex((l) => l.trim() === end);
          i += stop < 0 ? command.length : lines.slice(0, stop + 1).join("\n").length + 1;
        }
      }
      continue;
    }
    cur += c;
  }
  return [...out, cur].map((s) => s.trim()).filter(Boolean);
}

const unquote = (t: string) => t.replace(/^(['"])(.*)\1$/, "$2");

type Part = { effect: Effect; text: string; targets: string[]; env?: boolean; program?: string; local?: boolean; /** Also writes the repository its folder belongs to. */ repo?: boolean; /** Installs packages, so runs the project's install scripts. */ install?: boolean; /** Every word is plain and every option is on SCRATCH_OPTS, so targets are all there is to check. */ safe?: boolean; /** Files its output is redirected to (not /dev/null or another fd), whatever the effect. */ writes?: string[] };

/**
 * The programs that may appear in a "/tmp only" command, and the options each may use (BOS-111
 * adversarial round 5). An allow-list: an option can carry the real target (cp -t /home, sort -o,
 * diff --output=, find -fprint, git log --output=), so any option not listed, or a program not
 * listed, means no note. Left off on purpose: sed (its script can w a file or e a command), uniq
 * (its second operand is an output file), trap (runs a command), shred (always Deny) and every
 * program not named here. So are the shell's variable commands (export, set, unset, read, declare
 * and the like): PATH=/tmp/x points every later program at a script planted in /tmp (BOS-111
 * security round 11). For the same reason a segment with any NAME=value assignment, prefix or
 * alone, is never scratchSafe, whichever variable it sets.
 */
const SCRATCH_OPTS: Record<string, RegExp> = {
  rm: /^(?:-[rRfvd]+|--(?:recursive|force|verbose|dir)|--)$/,
  rmdir: /^(?:-v|--verbose|--)$/,
  unlink: /^--$/,
  mkdir: /^(?:-[pv]+|--parents|--verbose)$/,
  touch: /^-c$/,
  cp: /^(?:-[rRafvpn]+|--recursive)$/,
  mv: /^-[fvn]+$/,
  ln: /^-[sfnv]+$/,
  tee: /^-a$/,
  chmod: /^-[Rv]+$/,
  chown: /^-[Rv]+$/,
  find: /^-(?:name|iname|type|path|delete|mindepth|maxdepth|mtime|mmin|newer|empty|print)$/,
  ls: /^-[a-zA-Z1]+$/,
  cat: /^-[nAvE]+$/,
  head: /^-(?:n|c|\d+)$/,
  tail: /^-(?:n|c|\d+)$/,
  wc: /^-[lwc]+$/,
  du: /^-[shc]+$/,
  df: /^-h$/,
  grep: /^-[rRinvlcwEFqsHo]+$/,
  diff: /^-[urqN]+$/,
  sort: /^-[rnu]+$/,
  echo: /^-[ne]+$/,
  stat: /^$/, pwd: /^$/, date: /^$/, whoami: /^$/, uname: /^-[a]$/, which: /^$/, file: /^$/, cut: /^$/, tr: /^$/,
  true: /^$/, sleep: /^$/, test: /^$/, "[": /^$/, exit: /^$/,
};
/** git subcommands that only read, with the options they may use; git's own options before the subcommand (-C, -c) aren't allowed. */
const GIT_SCRATCH_OPTS: Record<string, RegExp> = {
  status: /^(?:-s|--short|--porcelain|-b)$/,
  log: /^(?:--oneline|-p|--stat|--name-only|--name-status|-\d+|-n)$/,
  diff: /^(?:--stat|--name-only|--name-status|--cached|--staged)$/,
  show: /^(?:--stat|--name-only|--name-status)$/,
  "rev-parse": /^(?:--abbrev-ref|--short|--show-toplevel|--git-dir)$/,
  "ls-files": /^$/,
};
/** Plain words only: no $ ` \ globs, braces, ~, # or ( ), and quotes only around a whole word, so the words read are the words that run. */
const PLAIN_SEGMENT = /^(?:\s*(?:[A-Za-z0-9._+@%:=,/<>&-]+|'[^'$`\\]*'|"[^"$`\\]*")(?=\s|$))*\s*$/;

function scratchSafe(seg: string, program: string, rest: string[]): boolean {
  if (!PLAIN_SEGMENT.test(seg)) return false;
  if (program === "git") {
    const [sub, ...args] = rest;
    const ok = GIT_SCRATCH_OPTS[sub ?? ""];
    return Boolean(ok) && args.every((a) => !a.startsWith("-") || ok!.test(a));
  }
  if (program === "") return true;
  const ok = SCRATCH_OPTS[program];
  return Boolean(ok) && rest.every((a) => !a.startsWith("-") || ok!.test(a));
}
/**
 * The segment's first word, as written, must be the bare name of the program scratchSafe judged
 * (BOS-111 security round 12). An allow-list rather than another assignment pattern: X+=, X[0]=,
 * keywords, redirects and ./x or /tmp/x as the program all fail it, however they're spelt.
 */
const SAFE_FIRST_WORD = /^[a-z0-9_-]+$/;

function explainSegment(seg: string): Part {
  const all = (seg.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) ?? []).map(unquote);
  const comment = all.findIndex((t) => t.startsWith("#"));
  const inline = all.some((t) => t.startsWith("<<") && !t.startsWith("<<<"));
  const tokens = all.slice(0, comment < 0 ? all.length : comment).filter((t) => !t.startsWith("<<") || t.startsWith("<<<"));
  const args: string[] = [];
  const writes: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    // >, >>, >|, &>, &>>, <> (opens for writing, creating the file) with any fd number.
    const m = /^(?:\d*|&)(?:>>|>\||>|<>)(.*)$/.exec(tokens[i]!);
    if (!m) {
      args.push(tokens[i]!);
      continue;
    }
    const target = m[1] || tokens[++i] || "";
    // >&1, 2>&- copy or close an fd; >&word sends both streams to the file word.
    if (target && target !== "/dev/null" && !/^&(?:\d+|-)$/.test(target)) writes.push(target.replace(/^&/, ""));
  }
  const nested = /^\w+\+?=\$\((.+)$/.exec(args[0] ?? "");
  if (nested) args[0] = nested[1]!.replace(/\)$/, "");
  let assigns = Boolean(nested);
  while (args[0] && (/^\w+\+?=/.test(args[0]) || KEYWORDS.has(args[0]) || /^[\w-]+\(\)$|^[\w-]*\)$/.test(args[0]))) assigns = /^\w+\+?=/.test(args.shift()!) || assigns;
  const program = (args[0] ?? "").split("/").pop() ?? "";
  const first = seg.trimStart().split(/\s+/)[0] ?? "";
  const rest = args.slice(1);
  const flags = rest.filter((a) => a.startsWith("-"));
  const operands = rest.filter((a) => !a.startsWith("-"));
  const paths = operands.filter((a) => a.includes("/"));
  const part = (effect: Effect, text: string, targets: string[] = []): Part => ({ effect, text, targets });

  let p: Part;
  if (!program) p = part("reads", "");
  else if (program === "env" || program === "printenv") p = { ...part("reads", ""), env: true };
  else if (DELETES.has(program)) p = part("deletes", "Deletes files", operands);
  else if (program === "find") {
    p = flags.includes("-delete") ? part("deletes", "Deletes files", paths) : flags.some((f) => f.startsWith("-exec")) ? part("unknown", "Runs other programs through find -exec") : part("reads", "", paths);
  } else if (program === "sed") {
    // Without -e the first operand is the script, not a file.
    const files = flags.some((f) => f === "-e" || f === "-f") ? operands : operands.slice(1);
    // `sed -i <script> /dev/null` (or no file) edits nothing, unless the script writes/runs (w, W, e) or is read from a file (-f) (BOS-680).
    const nothing = files.every((f) => f === "/dev/null") && !flags.some((f) => f === "-f" || /^--file/.test(f)) && !/(^|[;\n{}!\d$/,])\s*[wWe](\s|\/|$)|\bs([^\w\s\\]).*\2[gpiImM\d]*[weW]/.test(operands.slice(0, 1).join(" ") + " " + flags.join(" "));
    p = flags.some((f) => /^-\w*i/.test(f)) && nothing ? part("reads", "") : flags.some((f) => /^-\w*i/.test(f)) ? part("changes", "Edits files in place", files) : part("reads", "", files.filter((a) => a.includes("/")));
  }
  else if (program === "git") {
    const at = rest.findIndex((a, i) => !a.startsWith("-") && !GIT_VALUE_OPTS.has(rest[i - 1] ?? ""));
    const sub = at < 0 ? "" : rest[at]!;
    const subArgs = at < 0 ? [] : rest.slice(at + 1);
    p =
      sub === "push" ? part("pushes", "Pushes code to the repository")
      : sub === "clean" || sub === "rm" ? part("deletes", "Deletes files from the project")
      : sub === "clone" && rest.filter((a) => !a.startsWith("-"))[1]?.startsWith("/") ? { ...part("changes", "Copies a repository on this machine", rest.filter((a) => !a.startsWith("-")).slice(2)), local: true }
      // A worktree also writes into the repository's .git (and add -b makes the branch there), so it never counts as /tmp-only work.
      : sub === "worktree" ? (subArgs[0] === "list" ? part("reads", "") : { ...part("changes", "Adds or removes a second checkout of the project (git worktree)"), repo: true })
      : sub === "branch" && subArgs.some((a) => /^-[a-zA-Z]*[dDmM]|^--(delete|move)$/.test(a)) ? part("changes", "Changes the project's files or history")
      : GIT_NETWORK.has(sub) ? part("network", "Uses the network (git)")
      : GIT_CHANGES.has(sub) ? part("changes", "Changes the project's files or history")
      : GIT_READS.has(sub) ? part("reads", "", paths)
      : part("unknown", `Runs a git command Boss Man doesn't recognise: ${sub || "git"}`);
  } else if (PKG.has(program) && PKG_INSTALL.has(rest[0] ?? "")) p = { ...part("changes", `Installs or removes packages (${program})`), install: true };
  else if (program === "node" && flags.length && flags.every((f) => f === "--version" || f === "-v") && !operands.length) p = part("reads", "");
  else if (NETWORK.has(program)) p = part("network", `Uses the network (${program})`);
  else if (CHANGES.has(program)) p = part("changes", "Changes files", program === "cp" || program === "tee" ? operands.slice(program === "cp" ? -1 : 0) : program === "chmod" || program === "chown" ? operands.slice(1) : operands);
  else if (READS.has(program)) p = part("reads", "", paths);
  else if (inline && SHELLS.has(program)) p = part("unknown", `Runs a script written into the command (${program})`);
  // A word that is an option, a variable or a piece of quoted text is not a program name: say the command couldn't be read, and don't list it as a program (BOS-752).
  else if (!/^[\w.+@-]+$/.test(program) || program.startsWith("-")) p = part("unknown", "Runs a command Boss Man couldn't read");
  else p = part("unknown", "Runs a program Boss Man doesn't recognise", [program]);

  if (/\$\(|`/.test(nested ? seg.slice(seg.indexOf("$(") + 2) : seg) && p.effect === "reads") p = part("unknown", "Runs a command nested inside another");
  p.program = program;
  // A > inside a word (rm /tmp/a>/home/x) is a redirect the whitespace split above didn't see.
  p.safe = !assigns && SAFE_FIRST_WORD.test(first) && first === program && !args.some((a) => a.includes(">")) && scratchSafe(seg, program, rest);
  if (writes.length) {
    const worse = WORST.indexOf(p.effect) < WORST.indexOf("changes") ? p : null;
    p = worse ?? { ...part("changes", "Changes files", writes), env: p.env, repo: p.repo, install: p.install, program: p.program, safe: p.safe };
  }
  // Kept apart from targets: a delete keeps its own targets above, and scratchOnly checks these for every part (BOS-111 security round 14).
  p.writes = writes;
  return p;
}

const list = (xs: string[]) => {
  const all = [...new Set(xs.map(friendly))];
  return all.slice(0, 4).join(", ") + (all.length > 4 ? ` and ${all.length - 4} more` : "");
};

/** An absolute path with . and .. worked out; null for ~, $VARS and other things only the shell knows. */
function norm(p: string): string | null {
  if (!p.startsWith("/") || /[$~`]/.test(p)) return null;
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return `/${out.join("/")}`;
}

/**
 * Whether everything the command changes or deletes is named by an absolute path under /tmp. Null
 * when anything could reach further: a push, the network, a program it can't see into, a relative
 * path, a change with no named target, or any cd.
 *
 * It doesn't follow cd's (BOS-111 security re-checks). Working out where a cd lands keeps missing
 * cases: a failed cd followed by ; runs the rest from the agent's own folder, and cd -, cd -- dir,
 * cd -P and CDPATH= all go somewhere other than the first word. So any cd, pushd or popd means
 * "not /tmp-only", and `cd /tmp/x && rm -rf y` loses the note. CEO routing (tempCleanup) doesn't
 * rely on this. unchecked stays in the result's shape but is now always empty.
 *
 * Every segment, reads included, must also be scratchSafe: a listed program using only listed
 * options, in plain words. Otherwise an option's value (cp -t /home, sort -o/home/x) is a target
 * this function never sees (BOS-111 adversarial round 5).
 *
 * Writes and deletes, narrowed further (BOS-165): paths are checked as written, and the runner's
 * filesystem would be needed to tell whether /tmp/NAME is a symlink pointing outside /tmp. So the
 * note (and the owner's "/tmp only" switch) vouches only for programs that never follow a link at
 * their target — rm, rmdir, unlink (a delete removes the link, not its target) and mkdir of a new
 * name — and only when the target is exactly one level below /tmp with no trailing slash. tee, cp,
 * mv, ln, touch, chmod, chown, find -delete and any redirect to a file all follow a link at the
 * destination, so they lose the note; so do deeper paths (/tmp/a/b) and a trailing slash
 * (/tmp/a/). Only the part that writes or deletes is held to this: reading through a link doesn't
 * falsify "every file it changes or deletes is there".
 */
function scratchOnly(parts: Part[]): { unchecked: string[] } | null {
  let wrote = false;
  for (const p of parts) {
    if (p.program === "cd" || p.program === "pushd" || p.program === "popd") return null;
    if (!p.safe) return null;
    // A file the output is redirected to could be a link; /dev/null and fd copies aren't in writes.
    if (p.writes?.length) return null;
    if (p.effect === "pushes" || p.effect === "network" || p.effect === "unknown" || p.repo) return null;
    if (p.effect !== "changes" && p.effect !== "deletes") continue;
    wrote = true;
    if (!SCRATCH_WRITES.has(p.program ?? "")) return null;
    // Test the raw target, not norm(t): norm removes ".." as plain text, but the kernel resolves
    // a/../b from where the link at a points (security round: rm -rf /tmp/lnk/../x, mkdir -p /tmp/lnk/../x).
    // TEMP_PATH holds the target to one plain entry directly in /tmp, so a trailing slash, //, a glob
    // or brace (/tmp/*, /tmp/{a,../home}), and any . or .. part all fail the test.
    if (!p.targets.length || p.targets.some((t) => !TEMP_ONLY.test(t))) return null;
  }
  return wrote ? { unchecked: [] } : null;
}

/** Programs whose write or delete at one level below /tmp can't follow a symlink at the target (BOS-165). */
const SCRATCH_WRITES = new Set(["rm", "rmdir", "unlink", "mkdir"]);

/** One plain entry directly in /tmp: not /tmp itself, no deeper path, nothing the shell would expand or resolve. */
const TEMP_PATH = String.raw`/tmp/(?!\.+(?:\s|$))[A-Za-z0-9._+@-]+`;
/** A plain rm/rmdir/unlink: options first, then its paths (group 1); output may only go to /dev/null. */
/** A delete that touches only TEMP_PATHs, as written: only these clear a /tmp entry for later writes. Exported for recommendedVerdict (BOS-165). */
export const TEMP_DELETE = new RegExp(String.raw`^(?:rm|rmdir|unlink)(?:\s+(?:--?[A-Za-z][A-Za-z-]*|--))*(?:\s+${TEMP_PATH})+(?:\s+(?:(?:[12]|&)?>>?\s*/dev/null|2>&1))*$`);
const DELETE = /^(?:rm|rmdir|unlink)(?:\s+(?:--?[A-Za-z][A-Za-z-]*|--))*((?:\s+[^\s>&]+)+)(?:\s+(?:(?:[12]|&)?>>?\s*\/dev\/null|2>&1))*$/;
/**
 * A plain relative path in the agent's working copy (BOS-120): no leading / - or ~, and no . .. or
 * .git part at any depth (so not a submodule's .git either). Other dot folders (.turbo, .cache) are fine.
 * No trailing slash (BOS-150): rm -rf NAME/ follows a symlink as if NAME were the target, while
 * rm -rf NAME removes the link itself; `rm -rf dist` cleans up just the same.
 */
const WORKING_PATH = /^[A-Za-z0-9_+@.][A-Za-z0-9._+@-]*(?:\/[A-Za-z0-9._+@-]+)*$/;
const inWorkingCopy = (p: string) => WORKING_PATH.test(p) && p.split("/").every((part) => part !== "." && part !== ".." && part.toLowerCase() !== ".git");

/** Any word that deletes, wherever it is: a second guard behind the allow-list, which must find none outside the accepted rm's. */
const DELETING = String.raw`\b(?:rm|rmdir|unlink|shred|truncate|rmtree|rmSync|unlinkSync)\b|\s--?delete\b|\bgit\s+clean\b`;

/**
 * The only characters a temp cleanup may contain. Nothing the shell quotes, escapes, expands or
 * substitutes ($ ` \ ' " ~ * ? [ { ( < # !), so every word is exactly what runs, and no heredoc
 * or script can hide inside (BOS-111 security review: "r"m, r\m and ${x}m all spell rm).
 */
const PLAIN = /^[A-Za-z0-9._+@%:=,/ \t\n;&|>-]+$/;
/** A redirect: optional fd at the start of a word, then its target. */
const REDIRECT = /(?:(?<=^|\s)[12&])?>>?\s*(&[12](?![^\s])|[^\s>&]*)/g;
const TEMP_ONLY = new RegExp(`^${TEMP_PATH}$`);
/** rm flags that can't leave the entry in place while still succeeding (-i would answer "no" and exit 0). */
const CLEARING_FLAG = /^(?:-[rRfvd]+|--(?:recursive|force|verbose|dir)|--)$/;
const INSTALL_FLAGS = new Set(["--frozen-lockfile", "--no-frozen-lockfile", "--prefer-offline", "--offline", "--silent", "-s", "--reporter=silent", "--ignore-scripts"]);

/**
 * Whether one segment is known to change nothing outside /tmp. An allow-list of programs and the
 * shapes of their arguments; anything not on it is not temp cleanup. mv, cp, tee, ln, touch, dd,
 * sed, interpreters and shells are left off on purpose: each can move, overwrite or delete
 * anywhere (mv /home/x /tmp/b followed by rm -rf /tmp/b is a delete outside /tmp).
 * Anything that writes (cd for an install, mkdir, git worktree add) must aim at a /tmp entry in
 * `cleared`: one this command has just deleted, so it can't be a shortcut link to somewhere else.
 */
function safeBeside(words: string[], cwd: { tmp: boolean }, cleared: Set<string>): boolean {
  const [program, ...rest] = words;
  const operands = rest.filter((w) => !w.startsWith("-"));
  switch (program) {
    case "true": case "echo": case "pwd": case "ls": case "sleep": case "date":
      return true;
    case "cd":
      cwd.tmp = rest.length === 1 && cleared.has(rest[0]!);
      return rest.length <= 1;
    case "mkdir":
      return operands.length > 0 && operands.every((w) => cleared.has(w)) && rest.every((w) => !w.startsWith("-") || w === "-p");
    case "pnpm": case "npm":
      // Install writes node_modules into the current folder, so only in a /tmp checkout. No -C, --dir or --prefix to point it elsewhere.
      return cwd.tmp && ["install", "i", "ci"].includes(rest[0] ?? "") && rest.slice(1).every((w) => INSTALL_FLAGS.has(w));
    case "git": {
      // The subcommand comes straight after git: no -c, -C or --exec-path, which can run programs or point it elsewhere.
      const [sub, action, ...args] = rest;
      if (sub === "status" || sub === "rev-parse") return true;
      if (sub !== "worktree") return false;
      if (action === "list") return args.every((w) => w.startsWith("-"));
      // Only add. remove follows a symlink at /tmp/NAME and deletes its target (BOS-111 security review),
      // and prune deletes worktree records in the repository's .git (adversarial round 5). No -B: it resets an existing branch.
      if (action !== "add") return false;
      // The checkout's folder is the first operand, after the value of -b; it must be an entry directly in /tmp.
      const ops: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const w = args[i]!;
        if (w === "-b") i++;
        else if (w === "--detach" || w === "--no-checkout" || w === "-q" || w === "--quiet") continue;
        else if (w.startsWith("-")) return false;
        else ops.push(w);
      }
      if (!ops.length || !cleared.has(ops[0]!)) return false;
      return ops.length <= 2 && !(ops[1] ?? "").startsWith("/") && !(ops[1] ?? "").includes("..");
    }
    default:
      return false;
  }
}

export type CleanupScope = { tmp: string[]; workingCopy: string[] };

/**
 * What a cleanup command deletes, when every delete in it is of temp files (BOS-111) or of plain
 * relative paths in the agent's working copy (BOS-120), and nothing else in it changes anything
 * outside /tmp; otherwise null. An allow-list, per segment: each is either a plain rm/rmdir/unlink
 * of such paths or a known-safe command (safeBeside), its output going only to /dev/null or a /tmp
 * entry cleared as below. Temp deletes are one level only, because rm then removes a symlink as a
 * link and never follows it. Working-copy paths go deeper, so a symlinked folder on the way would
 * be followed: only the runner's filesystem could tell, which is why these still need the CEO.
 * A trailing slash is refused in both (BOS-150): rm -rf NAME/ follows the link into its target.
 * With any working-copy path there may be no cd anywhere, so the paths are relative to the folder
 * each shell command starts in. The server sends these to the CEO only when the runner reported it
 * started the run in its ticket's worktree and the tool input names no other folder; it can't see
 * where the shell is now, so that and the CEO's approval are what keep them inside.
 * The destructive-word counts stay as a second guard.
 *
 * Writes have the same symlink problem, so they may only go to a /tmp entry the command deleted
 * earlier in one unbroken && chain (BOS-111 adversarial review: git worktree add, mkdir or an
 * install through /tmp/lnk wrote into the link's target). Once rm -rf /tmp/NAME has succeeded the
 * name is gone, and anything there afterwards was made by this chain. Any other separator ends
 * the chain: after ; or || the rm or cd may have failed, and & or | run alongside it. Only a delete
 * of /tmp entries alone clears them: a working-copy delete never does. Left open: another process
 * recreating the name as a link in between, which needs a hostile agent racing it.
 */
export function cleanupScope(command: string): CleanupScope | null {
  if (!PLAIN.test(command)) return null;
  if (/\(\)\s*\{|\bfunction\s|\balias\b|\bPATH\+?=/.test(command)) return null;
  if (new RegExp(PUSHING, "i").test(command)) return null;
  // PLAIN rules out quotes and heredocs, so this splits exactly where segments() does, keeping the separators.
  const pieces = command.split(/(&&|\|\||[;|\n]|(?<!>)&(?!>))/);
  const segs = segments(command);
  if (pieces.filter((_, i) => i % 2 === 0).map((s) => s.trim()).filter(Boolean).join("\0") !== segs.join("\0")) return null;
  const deletePaths = (s: string) => {
    const paths = DELETE.exec(s)?.[1]?.trim().split(/\s+/);
    return paths?.every((p) => TEMP_ONLY.test(p) || inWorkingCopy(p)) ? paths : null;
  };
  const deletes = segs.filter((s) => deletePaths(s));
  if (!deletes.length) return null;
  const scope: CleanupScope = { tmp: [], workingCopy: [] };
  for (const p of deletes.flatMap((s) => deletePaths(s)!)) (TEMP_ONLY.test(p) ? scope.tmp : scope.workingCopy).push(p);
  if (scope.workingCopy.length && segs.some((s) => /^cd(\s|$)/.test(s))) return null;
  const cwd = { tmp: false };
  const cleared = new Set<string>();
  let chained = true;
  for (let i = 0; i < pieces.length; i += 2) {
    const sep = pieces[i - 1] ?? ";";
    if (sep !== "&&") {
      cleared.clear();
      cwd.tmp = false;
      chained = sep === ";" || sep === "\n";
    }
    const s = pieces[i]!.trim();
    if (!s) continue;
    if (deletePaths(s)) {
      if (!TEMP_DELETE.test(s)) continue;
      const words = s.replace(REDIRECT, " ").trim().split(/\s+/);
      if (chained && words.slice(1).every((w) => TEMP_ONLY.test(w) || CLEARING_FLAG.test(w))) for (const w of words) if (TEMP_ONLY.test(w)) cleared.add(w);
      continue;
    }
    let ok = true;
    const rest = s.replace(REDIRECT, (_, to: string) => {
      // In temp cleanup a log by redirect may also go to a plain /tmp/NAME this command didn't delete (BOS-111 adversarial
      // round 14: the ticket's own pnpm install > /tmp/rv86-install.log). It could be a planted link, so this only lets the
      // CEO see it. Program targets (mkdir, git worktree add, the install folder) still need cleared, and so does every
      // write beside a working-copy delete (security round 2).
      if (!(to === "/dev/null" || to === "&1" || to === "&2" || cleared.has(to) || (!scope.workingCopy.length && TEMP_ONLY.test(to)))) ok = false;
      return " ";
    });
    if (!ok || /[>&]/.test(rest) || !safeBeside(rest.trim().split(/\s+/), cwd, cleared)) return null;
  }
  const counted = [DESTRUCTIVE, DELETING].every((re) => {
    const count = (s: string) => s.match(new RegExp(re, "gi"))?.length ?? 0;
    return count(command) === deletes.reduce((n, s) => n + count(s), 0);
  });
  return counted ? { tmp: [...new Set(scope.tmp)], workingCopy: [...new Set(scope.workingCopy)] } : null;
}

/** True when every delete in the command is of entries directly in /tmp (BOS-111): see cleanupScope. */
export function tempCleanup(command: string): boolean {
  const scope = cleanupScope(command);
  return Boolean(scope && !scope.workingCopy.length);
}

/** Words that change nothing, so they may sit beside a delete in an automatic temp cleanup. */
const NO_WRITE_WORDS = new Set(["true", "echo", "pwd", "ls", "date", "sleep"]);
const DEVNULL_REDIRECT = /(?:(?<=^|\s)[12&])?>>?\s*\/dev\/null|2>&1/g;
/**
 * /tmp entries that belong to Boss Man, the harness, the system or another run's check, not to the asking agent
 * (BOS-1523). /tmp is shared by every run and all run as one user, so the sticky bit doesn't keep them apart:
 * bossman* (the skills root of every live run, check slots and holders, scratch logs, MCP token folders),
 * bm-* (runner temp folders), guard-* (ci-launcher), claude* (the harness's /tmp/claude-<uid>, BOS-1067),
 * tmp.* (mktemp -d folders, such as a running check's HOME) and dot names (.X11-unix and other sockets).
 * A delete naming one keeps today's CEO-first route. Prefixes, case-insensitive: a lookalike goes to the CEO too.
 */
const RESERVED_TMP_ENTRY = /^\/tmp\/(?:bossman|bm-|guard-|claude|tmp\.|\.)/i;
const RESERVED_TMP_PREFIXES = ["bossman", "bm-", "guard-", "claude", "tmp.", "."];

/** Whether a /tmp entry name (the first component under /tmp) is, or with its glob or variable could be, a reserved one. Fails closed: a name that starts with a wildcard could be anything. */
function mayBeReservedName(name: string): boolean {
  const wild = name.search(/[*?[{$`]/);
  const lower = (wild < 0 ? name : name.slice(0, wild)).toLowerCase();
  if (wild < 0) return RESERVED_TMP_PREFIXES.some((p) => lower.startsWith(p));
  return RESERVED_TMP_PREFIXES.some((p) => p.startsWith(lower) || lower.startsWith(p));
}

/** Words that remove a file: rm, unlink, rmdir (also by path, or after git/command), and an interpreter's own delete call. */
const REMOVER = /(?<![\w.-])(?:\S*\/)?(?:rm|unlink|rmdir)(?![\w-])|unlinkSync|rmSync|rmtree|os\.(?:remove|unlink)/;
/** A path under /tmp (or $TMPDIR, or a relative ../tmp) with the first component after it captured. */
const TMP_CHILD = /(?:^|[\s=:(,])(?:\/tmp|\$\{?TMPDIR\}?|(?:\.\.\/)+tmp)\/([^\s/;|&)]*)/g;
const CD_TMP = /(?:^|[\s;&|])(?:cd|pushd)\s+(?:\/tmp|\$\{?TMPDIR\}?)\/?(?=$|[\s;&|])/;

/** Quotes, escapes, "//", "/./" and "/x/../" removed, so a lookalike spelling reads as the path it is. */
function plainPaths(s: string): string {
  let t = s.replace(/["'\\]/g, "").replace(/\/{2,}/g, "/");
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/\/\.(?=\/|$)/g, "").replace(/\/[^/\s.][^/\s]*\/\.\.(?=\/|$)/g, "");
  }
  return t;
}

/**
 * Whether a command removes (rm, unlink, rmdir, with or without flags) an entry Boss Man reserves in /tmp (BOS-1545):
 * a plain `rm /tmp/bossman-check-all.slot.1` isn't destructive, but it frees a check slot another run holds, so it
 * goes to the CEO like the flagged forms. Judged per command segment, and fails closed: a glob or variable that
 * could name a reserved entry, a bare name after `cd /tmp`, and xargs or an unresolved operand beside a reserved
 * path elsewhere in the command all count. Plain removes of other paths are untouched. Shortcut: a symlink in /tmp
 * that points at a reserved entry isn't followed, and a bare name is judged only after a `cd /tmp` (cwd is unknown).
 */
export function removesReservedTmpEntry(command: string): boolean {
  const segs = segments(command).map(plainPaths);
  const cdTmp = CD_TMP.test(plainPaths(command));
  const reservedNamed = (s: string) => [...s.matchAll(TMP_CHILD)].some((m) => mayBeReservedName(m[1] ?? ""));
  const mentionsReserved = segs.some(reservedNamed);
  for (const s of segs) {
    if (!REMOVER.test(s)) continue;
    if (reservedNamed(s)) return true;
    if (cdTmp && s.split(/[\s;&|()`]+/).some((w) => w && !w.startsWith("-") && !w.includes("/") && mayBeReservedName(w) && !REMOVER.test(w) && w !== "sudo" && w !== "command")) return true;
    if (mentionsReserved && (/\bxargs\b/.test(s) || /[$`]/.test(s.replace(/\$\{?TMPDIR\}?/g, "")))) return true;
  }
  return false;
}

/**
 * Whether a command is a temp cleanup that Boss Man may allow without asking anyone (BOS-1453). Narrower than
 * tempCleanup, on purpose: every segment is a plain rm/rmdir/unlink of entries directly in /tmp (TEMP_DELETE:
 * no "..", variables, globs, trailing slash or deeper path, which a symlink at the entry could carry out of /tmp,
 * BOS-150 and BOS-165) or a word that changes nothing, with output only to /dev/null. No cd, mkdir, git or install:
 * those can write or run code, so they keep going to the CEO. cleanupScope has already refused pushes, a working-copy
 * path and any destructive word it can't account for.
 */
export function autoTempCleanup(command: string): boolean {
  const scope = cleanupScope(command);
  if (!scope || scope.workingCopy.length || !scope.tmp.length) return false;
  return segments(command).every((s) => {
    // Checked on the segment's own words, so every path the delete names is seen, whatever cleanupScope collected.
    if (TEMP_DELETE.test(s)) return !s.split(/\s+/).some((w) => RESERVED_TMP_ENTRY.test(w));
    const rest = s.replace(DEVNULL_REDIRECT, " ").trim();
    return !/[<>&]/.test(rest) && NO_WRITE_WORDS.has(rest.split(/\s+/)[0] ?? "");
  });
}

/**
 * The subcommand a package-manager segment runs (BOS-165 security round 4, simplified in round 6):
 * the word right after the program, and only that word. `pnpm --silent dlx rimraf …` reads
 * "--silent", not "dlx" or "test", so a leading option can never smuggle a program runner past
 * PKG_SCRIPTS — whatever the option's arity. Empty when the segment is just the program or the
 * first word is an option.
 */
function pkgSubcommand(seg: string): string {
  const first = seg.trim().split(/\s+/)[1] ?? "";
  return first.startsWith("-") ? "" : first;
}

/**
 * True when the command could change or delete something whose target isn't an absolute path
 * under /tmp (BOS-165). recommendedVerdict relaxes Deny for a vouched /tmp delete; this is the
 * other half of that relax, so it never whitewashes the rest of the command (cp -t /home, a
 * redirect to /home/word, an option that carries the real target). Every segment must be one
 * scratchSafe vouches for, and a change's or delete's every target — options' values included,
 * hence the safe check — must normalize to under /tmp. An install or a package-manager script is
 * exempt: its writes are the project's node_modules, not a named target it could aim elsewhere.
 */
export function writesBeyondTmp(command: string): boolean {
  for (const seg of segments(command)) {
    const p = explainSegment(seg);
    // An install or a project script (pnpm build, pnpm --silent run test) is exempt: its writes
    // are the project's own folders (node_modules, dist), not a named target it could aim at
    // /home. Anything else a package manager is asked to run (dlx, exec, create) is exempt only
    // when its subcommand is on the allow-list, found past any leading options (round 4).
    if (p.install || (PKG.has(p.program ?? "") && PKG_SCRIPTS.has(pkgSubcommand(seg)))) continue;
    if (!p.safe) return true;
    const targets = [...p.targets, ...(p.writes ?? [])];
    if ((p.effect === "changes" || p.effect === "deletes") && !targets.length) return true;
    if (targets.some((t) => { const w = norm(t); return !w || !/^\/tmp(?:\/|$)/.test(w); })) return true;
  }
  return false;
}

/** How a `git push` reads on a permission card (BOS-208): where it goes and what would be dangerous. */
export type PushReading = {
  /** ticket: its own bossman/<ticket> branch; branch: one other named branch; many; unnamed; unreadable. */
  kind: "ticket" | "branch" | "many" | "unnamed" | "unreadable";
  /** One plain line, without the ticket reference (that is resolved from the database). */
  headline: string;
  /** The ticket branch this targets, when it is a bossman/<ticket> branch. */
  ticketId?: string;
  /** The ticket reference, filled in by the server when the ticket can be found. */
  ref?: string;
  /** Red lines: main, force, delete, all/mirror/tags, more than one branch, an unnamed branch. */
  warnings: string[];
  /** Any warning, or a command it couldn't read, so it is never treated as safe. */
  dangerous: boolean;
};

const PUSH_TICKET = /^bossman\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const PUSH_SAFE_LONG = new Set([
  "--porcelain", "--no-verify", "--verbose", "--progress", "--quiet", "--atomic", "--no-atomic",
  "--follow-tags", "--no-follow-tags", "--signed", "--no-signed", "--ipv4", "--ipv6",
  "--set-upstream", "--dry-run", "--thin", "--no-thin", "--recurse-submodules", "--no-recurse-submodules",
  "--push-option", "--repo",
]);
const PUSH_DANGER_LONG = new Set(["--force", "--force-with-lease", "--force-if-includes", "--delete", "--all", "--mirror", "--tags", "--prune"]);
const PUSH_SAFE_SHORT = new Set("uvqn");
const PUSH_DANGER_SHORT = new Set("fd");
const PUSH_VALUE_OPTS = new Set(["-o", "--push-option", "--repo"]);

/** A bare word scan, ignoring quoted text (a commit message mentioning git push is not a push). */
function mentionsPush(command: string): boolean {
  let outside = "";
  let quote = "";
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    outside += c;
  }
  return /\bgit\s+push\b/.test(outside);
}

/**
 * Reads one plain `git push` command (BOS-208). Any shell syntax around it, or an option it doesn't
 * know, reads as "couldn't read" rather than guessing: the card must never call a push it doesn't
 * understand safe. A refspec is src:dst; dst is where it lands, and a leading + forces, a leading :
 * deletes.
 */
export function readPush(command: string): PushReading | null {
  if (!mentionsPush(command)) return null;
  const unreadable = (): PushReading => ({ kind: "unreadable", headline: "Couldn't read this push, check the exact command", warnings: [], dangerous: true });
  const cmd = command.trim();
  // Quotes, expansions, redirects and chaining all hide what the shell will run.
  if (/[;&|`$<>()'"\\\r\n]/.test(cmd)) return unreadable();
  if (!/^git\s+push(?:\s|$)/.test(cmd)) return unreadable();
  const tokens = cmd.slice(cmd.indexOf("push") + 4).trim().split(/\s+/).filter(Boolean);
  const operands: string[] = [];
  const flags: string[] = [];
  let repo: string | undefined;
  let endOptions = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!endOptions && t === "--") {
      endOptions = true;
      continue;
    }
    if (!endOptions && t.startsWith("-") && t !== "-") {
      flags.push(t);
      if (PUSH_VALUE_OPTS.has(t)) {
        const value = tokens[++i];
        if (value === undefined) return unreadable();
        if (t === "--repo") repo = value;
      }
      continue;
    }
    operands.push(t);
  }

  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const force = "Force push: this can overwrite the remote branch's history.";
  const deletes = "Deletes a branch on the remote.";
  let every: "all" | "mirror" | "tags" | null = null;
  for (const f of flags) {
    if (f.startsWith("--")) {
      const [name, value] = f.split("=", 2) as [string, string | undefined];
      if (name === "--repo" && value) repo = value;
      if (PUSH_DANGER_LONG.has(name)) {
        if (name === "--all") {
          every = every ?? "all";
          warn("--all pushes every branch.");
        } else if (name === "--mirror") {
          every = "mirror";
          warn("--mirror pushes every branch and tag.");
        } else if (name === "--tags") {
          every = every ?? "tags";
          warn("--tags pushes every tag.");
        } else if (name === "--delete") warn(deletes);
        else if (name === "--prune") warn("Deletes remote branches that no longer exist locally (--prune).");
        else warn(force);
      } else if (!PUSH_SAFE_LONG.has(name)) return unreadable();
      continue;
    }
    for (const ch of f.slice(1)) {
      if (PUSH_DANGER_SHORT.has(ch)) warn(ch === "f" ? force : deletes);
      else if (!PUSH_SAFE_SHORT.has(ch)) return unreadable();
    }
  }

  const refspecs = repo ? operands : operands.slice(1);
  if (refspecs.includes("-")) return unreadable();
  const branches: string[] = [];
  let unnamed = refspecs.length === 0;
  let deleted = false;
  for (const refspec of refspecs) {
    if (refspec.startsWith(":")) {
      deleted = true;
      warn(deletes);
      continue;
    }
    const forced = refspec.startsWith("+");
    if (forced) warn(force);
    const spec = forced ? refspec.slice(1) : refspec;
    const [src, dst] = spec.includes(":") ? spec.split(":", 2) : [spec, spec];
    const target = (dst || src || "").replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
    if (!target || target === "HEAD") {
      unnamed = true;
      continue;
    }
    branches.push(target);
  }
  if (branches.some((b) => b.toLowerCase() === "main")) warn("Pushes to main.");
  if (branches.length > 1) warn(`Pushes more than one branch: ${branches.join(", ")}.`);

  if (every === "mirror") return { kind: "many", headline: "Pushes every branch and tag (mirror)", warnings, dangerous: true };
  if (every === "all") return { kind: "many", headline: "Pushes every branch", warnings, dangerous: true };
  if (every === "tags") return { kind: "many", headline: "Pushes all tags", warnings, dangerous: true };
  if (branches.length > 1) return { kind: "many", headline: "Pushes to more than one branch", warnings, dangerous: true };
  if (branches.length === 1 && !unnamed) {
    const ticket = PUSH_TICKET.exec(branches[0]!);
    if (ticket) return { kind: "ticket", headline: "Pushes to its ticket branch", ticketId: ticket[1]!.toLowerCase(), warnings, dangerous: warnings.length > 0 };
    return { kind: "branch", headline: `Pushes to ${branches[0]}`, warnings, dangerous: warnings.length > 0 };
  }
  if (deleted && !unnamed && !branches.length) return { kind: "branch", headline: "Deletes a branch on the remote", warnings, dangerous: true };
  warn("Branch not named: may push to main");
  return { kind: "unnamed", headline: "Pushes without naming the branch", warnings, dangerous: true };
}

/** What a shell command would do, in one sentence led by the worst thing in it. */
export function explainCommand(command: string): { summary: string; effect: Effect; push?: PushReading; scratch?: PermissionExplanation["scratch"] } {
  const segs = segments(command);
  const parts = segs.map(explainSegment);
  // Read the whole command, not each segment: a push chained with anything else is "couldn't read".
  const push = readPush(command) ?? undefined;
  const effect = WORST.find((e) => parts.some((p) => p.effect === e)) ?? "reads";
  const sentences: string[] = [];
  for (const e of WORST) {
    const group = parts.filter((p) => p.effect === e && (p.text || e === "reads"));
    if (!group.length) continue;
    const targets = list(group.flatMap((p) => p.targets));
    if (e === "reads") {
      if (group.every((p) => p.env && !p.targets.length)) continue;
      sentences.push(`${effect === "reads" ? "Only reads" : "Reads"} information${targets ? ` (${targets})` : ""}${effect === "reads" ? "; it doesn't change anything" : ""}.`);
    } else if (e === "pushes" && push) {
      sentences.push([push.headline, ...push.warnings].join(". ") + ".");
    } else {
      const many = new Set(group.flatMap((p) => p.targets)).size > 1;
      sentences.push([...new Set(group.map((p) => (many ? p.text.replace("a program", "programs") : p.text)))].join("; ") + (targets ? ` (${targets})` : "") + ".");
    }
  }
  if (parts.some((p) => p.env)) sentences.push("Shows environment variables, which can include secrets.");
  // Temp-file cleanup may include these two, and both reach outside /tmp: say so on the card, not only in the CEO's wake note (BOS-111 adversarial round 5).
  if (parts.some((p) => p.repo)) sentences.push("The git worktree step also writes into the project's repository (.git), and can create a branch there.");
  if (parts.some((p) => p.install)) sentences.push("The install runs the project's own install scripts, which can change files outside this folder.");
  const tmp = parts.some((p) => p.env) ? null : scratchOnly(parts);
  const scratch = tmp && {
    unchecked: tmp.unchecked,
    note: `Works only in a temporary folder (/tmp): every file it changes or deletes is there, so your project, its branch and the repository aren't touched.${tmp.unchecked.length ? ` It also runs ${tmp.unchecked.join(", ")} in that folder; Boss Man can't see inside ${tmp.unchecked.length === 1 ? "that program" : "those programs"}.` : ""}`,
  };
  return { summary: sentences.join(" ") || "Does nothing visible.", effect, ...(push ? { push } : {}), ...(scratch ? { scratch } : {}) };
}

const TOOL: Record<string, { what: string; effect: Effect; verb: string }> = {
  read: { what: "read a file", effect: "reads", verb: "Read" },
  edit: { what: "change a file", effect: "changes", verb: "Change" },
  delete: { what: "delete a file", effect: "deletes", verb: "Delete" },
  move: { what: "move a file", effect: "changes", verb: "Move" },
  fetch: { what: "fetch a web page", effect: "network", verb: "Fetch" },
  search: { what: "search the project", effect: "reads", verb: "Search" },
  think: { what: "think", effect: "reads", verb: "Think" },
};

const text = (o: unknown, ...keys: string[]) => {
  for (const k of keys) {
    const v = (o as Record<string, unknown> | null)?.[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
};

/** OpenCode's multi-file edit (apply_patch) lists its files as `files: [{ filePath, relativePath }]`; name one, or count them. */
function patchFiles(o: unknown): string | null {
  const files = (o as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return null;
  const names = files.map((f) => text(f, "relativePath", "filePath")).filter((n): n is string => !!n);
  return names.length === 1 ? names[0]! : names.length > 1 ? `${names.length} files: ${list(names)}` : null;
}

/** The whole card: plain title, effect line, and the agent's own reason if it gave one. */
export function explainPermission(info: PermissionInfo, agent: string): PermissionExplanation {
  const command = commandOf(info.rawInput) ?? (info.kind === "execute" ? info.title : null);
  const reason = text(info.rawInput, "description")?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
  if (command) {
    const x = explainCommand(command);
    return { title: `${agent} wants to run a command`, ...x, command, reason, ...(x.effect === "reads" ? {} : { alwaysNote: "Boss Man doesn't offer 'always' for commands that change, delete, push or use the network." }) };
  }
  const t = TOOL[info.kind ?? ""];
  // OpenCode's external_directory request (a folder outside the checkout): its title is the folder path, its input {filepath, parentDir}. Only that shape matches: a path title, and any parentDir agrees with it. A tool-server tool carries the model's own arguments, so its card keeps the tool name. Effect stays "unknown" so no rule is loosened by the wording.
  const parentDir = text(info.rawInput, "parentDir");
  const outside = !t && info.title?.startsWith("/") && (!parentDir || info.title === parentDir || info.title.startsWith(`${parentDir.replace(/\/+$/, "")}/`)) ? info.title : null;
  if (outside) return { title: `${agent} wants to access a folder outside its checkout`, summary: `Access folder outside checkout: ${outside}.`, effect: "unknown", reason };
  const target = text(info.rawInput, "file_path", "filePath", "filepath", "path", "url") ?? patchFiles(info.rawInput) ?? (info.kind === "search" ? text(info.rawInput, "pattern", "query") : null);
  if (!t) {
    const lookalike = looksLikeBossmanTool(info.title) ? ` Warning: this name looks like one of Boss Man's own tools (mcp__bossman__…) but is not one. Read it carefully: it may be a copy made to get past the checks.` : "";
    return { title: `${agent} wants to use a tool`, summary: `Uses the tool "${info.title ?? "unnamed"}", which Boss Man doesn't recognise.${lookalike}`, effect: "unknown", reason };
  }
  const noun = t.verb === "Fetch" || /^\d+ files: /.test(target ?? "") ? "" : t.verb === "Search" ? " for" : " the file";
  return { title: `${agent} wants to ${t.what}`, summary: `${t.verb}${target ? `${noun} ${target}` : ` (no name given)`}.`, effect: t.effect, reason };
}

/** Paths and words that point at secrets; a command naming one never gets an Always choice. */
const SECRET_HINT = /(?:^|[\/\s=~])(?:\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pgpass|\.docker\/config|\.env(?:\.\S*)?|id_(?:rsa|ed25519|ecdsa|dsa))(?:\W|$)|secret|passw(?:or)?d|credential|token|api[_-]?key|private[_-]?key|\.pem\b|\.p12\b|\.key\b|environ\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// File reads and edits get no Always choice: a kind-wide rule can't name a safe path, so it would cover secrets and files outside the checkout (BOS-294 security review).

/**
 * The standing rules offered for a request, narrowest first. Shell commands only when they
 * just read; Boss Man's own tools never. Every rule is safeOnly, so none can lift the
 * built-in gate on destructive commands and pushes.
 */
export function alwaysChoices(info: PermissionInfo, e: PermissionExplanation): AlwaysChoice[] {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(info.title ?? "");
  if (mcp) {
    const [, server, tool] = mcp as unknown as [string, string, string];
    if (server === "bossman") return [];
    // One exact tool only: a server-wide rule would cover destructive tools and ones added later (safeOnly checks shell commands only).
    return [{ label: `Always allow ${server}'s ${tool} tool`, name: `Allow ${server}'s ${tool} tool`, what: `use ${server}'s ${tool} tool`, match: { titlePattern: `^${escapeRe(info.title!)}$`, safeOnly: true } }];
  }
  if (e.command) {
    return e.effect === "reads" && !e.summary.includes("secrets") && !SECRET_HINT.test(e.command) && e.command.length < 250
      ? [{ label: "Always allow this exact command", name: `Allow the command ${e.command.slice(0, 60)}`, what: `run exactly this command: ${e.command.slice(0, 120)}`, match: { kinds: ["execute"], commandPattern: `^${escapeRe(e.command)}$`, safeOnly: true } }]
      : [];
  }
  // No kind-wide choices: a fetch rule has no address limit, so it would be a standing way to send data out in a URL.
  return [];
}
