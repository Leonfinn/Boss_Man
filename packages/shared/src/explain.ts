// Plain-English explanations of permission requests, worked out from the command itself
// (no model): what the owner is being asked to allow, and the worst thing it could do.

import { commandOf, DESTRUCTIVE, PUSHING, type PermissionInfo, type PolicyMatch } from "./policy.js";

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
};

/** A standing rule the owner can pick instead of "Allow once". */
export type AlwaysChoice = { label: string; name: string; match: PolicyMatch };

/** Shell grammar, not programs: skipped to find the program that follows. */
const KEYWORDS = new Set("if then else elif fi for do done while until case esac function { } ! [[ ]] (( ))".split(" "));
const SHELLS = new Set("bash sh zsh dash python python3 node".split(" "));
const READS = new Set("set export local declare readonly unset shift return exit printf read trap break continue cat grep egrep rg ls head tail wc stat du df free ps which pwd echo cd date whoami uname sort uniq cut tr diff file test [ true sleep".split(" "));
const CHANGES = new Set("tee mv cp mkdir touch chmod chown ln".split(" "));
const DELETES = new Set("rm rmdir unlink shred".split(" "));
const NETWORK = new Set("curl wget ssh scp nc ncat rsync".split(" "));
const GIT_READS = new Set("status log diff show branch rev-parse ls-files blame remote grep describe merge-base show-ref cat-file shortlog rev-list for-each-ref ls-tree reflog name-rev symbolic-ref check-ignore count-objects merge-tree range-diff whatchanged version help fsck cherry".split(" "));
const GIT_CHANGES = new Set("add commit checkout switch merge reset rebase stash restore cherry-pick tag apply mv revert am notes init gc prune config sparse-checkout bisect format-patch update-ref".split(" "));
const GIT_NETWORK = new Set(["fetch", "pull", "clone", "ls-remote", "submodule"]);
/** git options that take the next word as their value, so it isn't the subcommand. */
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PKG = new Set(["npm", "pnpm", "yarn"]);
const PKG_INSTALL = new Set(["install", "i", "add", "ci", "remove", "uninstall"]);

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

type Part = { effect: Effect; text: string; targets: string[]; env?: boolean; program?: string; local?: boolean; /** Also writes the repository its folder belongs to. */ repo?: boolean };

function explainSegment(seg: string): Part {
  const all = (seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(unquote);
  const comment = all.findIndex((t) => t.startsWith("#"));
  const inline = all.some((t) => t.startsWith("<<") && !t.startsWith("<<<"));
  const tokens = all.slice(0, comment < 0 ? all.length : comment).filter((t) => !t.startsWith("<<") || t.startsWith("<<<"));
  const args: string[] = [];
  const writes: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(?:\d*|&)>>?(.*)$/.exec(tokens[i]!);
    if (!m) {
      args.push(tokens[i]!);
      continue;
    }
    const target = m[1] || tokens[++i] || "";
    if (target && target !== "/dev/null" && !target.startsWith("&")) writes.push(target);
  }
  const nested = /^\w+=\$\((.+)$/.exec(args[0] ?? "");
  if (nested) args[0] = nested[1]!.replace(/\)$/, "");
  while (args[0] && (/^\w+=/.test(args[0]) || KEYWORDS.has(args[0]) || /^[\w-]+\(\)$|^[\w-]*\)$/.test(args[0]))) args.shift();
  const program = (args[0] ?? "").split("/").pop() ?? "";
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
    p = flags.some((f) => /^-\w*i/.test(f)) ? part("changes", "Edits files in place", files) : part("reads", "", files.filter((a) => a.includes("/")));
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
  } else if (PKG.has(program) && PKG_INSTALL.has(rest[0] ?? "")) p = part("changes", `Installs or removes packages (${program})`);
  else if (program === "node" && flags.length && flags.every((f) => f === "--version" || f === "-v") && !operands.length) p = part("reads", "");
  else if (NETWORK.has(program)) p = part("network", `Uses the network (${program})`);
  else if (CHANGES.has(program)) p = part("changes", "Changes files", program === "cp" || program === "tee" ? operands.slice(program === "cp" ? -1 : 0) : program === "chmod" || program === "chown" ? operands.slice(1) : operands);
  else if (READS.has(program)) p = part("reads", "", paths);
  else if (inline && SHELLS.has(program)) p = part("unknown", `Runs a script written into the command (${program})`);
  else p = part("unknown", "Runs a program Boss Man doesn't recognise", [program]);

  if (/\$\(|`/.test(nested ? seg.slice(seg.indexOf("$(") + 2) : seg) && p.effect === "reads") p = part("unknown", "Runs a command nested inside another");
  p.program = program;
  if (writes.length) {
    const worse = WORST.indexOf(p.effect) < WORST.indexOf("changes") ? p : null;
    p = worse ?? { ...part("changes", "Changes files", writes), env: p.env, repo: p.repo };
  }
  return p;
}

const list = (xs: string[]) => {
  const all = [...new Set(xs.map(friendly))];
  return all.slice(0, 4).join(", ") + (all.length > 4 ? ` and ${all.length - 4} more` : "");
};

const SCRATCH = /^\/tmp(\/|$)/;
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
 * Whether everything the command changes or deletes is under /tmp, following its cd's. Null when
 * anything could reach further: a push, the network, a relative path from an unknown folder, or a
 * change with no named target outside a /tmp folder. Programs it can't see into are listed.
 */
function scratchOnly(segs: string[], parts: Part[]): { unchecked: string[] } | null {
  let cwd: string | null = null;
  const at = (p: string) => norm(p.startsWith("/") ? p : cwd ? `${cwd}/${p}` : "");
  const unchecked: string[] = [];
  let wrote = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.program === "cd") {
      const to = (segs[i]!.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(unquote)[1] ?? "";
      cwd = to ? at(to) : null;
      continue;
    }
    if (p.effect === "pushes" || p.effect === "network" || p.repo) return null;
    if (p.effect === "unknown") {
      if (!cwd || !SCRATCH.test(cwd)) return null;
      unchecked.push(p.program || "a program");
      continue;
    }
    if (p.effect !== "changes" && p.effect !== "deletes") continue;
    wrote = true;
    const where = p.targets.length ? p.targets.map(at) : [cwd];
    if (where.some((w) => !w || !SCRATCH.test(w))) return null;
    // Deleting /tmp itself wipes every agent's temp files: not scratch work.
    if (p.effect === "deletes" && where.includes("/tmp")) return null;
  }
  return wrote ? { unchecked: [...new Set(unchecked)] } : null;
}

/** One plain entry directly in /tmp: not /tmp itself, no deeper path, nothing the shell would expand or resolve. */
const TEMP_PATH = String.raw`/tmp/(?!\.+(?:\s|$))[A-Za-z0-9._+@-]+`;
/** A plain rm/rmdir/unlink: options first, then its paths (group 1); output may only go to /dev/null. */
/** A delete that touches only TEMP_PATHs, as written: only these clear a /tmp entry for later writes. */
const TEMP_DELETE = new RegExp(String.raw`^(?:rm|rmdir|unlink)(?:\s+(?:--?[A-Za-z][A-Za-z-]*|--))*(?:\s+${TEMP_PATH})+(?:\s+(?:(?:[12]|&)?>>?\s*/dev/null|2>&1))*$`);
const DELETE = /^(?:rm|rmdir|unlink)(?:\s+(?:--?[A-Za-z][A-Za-z-]*|--))*((?:\s+[^\s>&]+)+)(?:\s+(?:(?:[12]|&)?>>?\s*\/dev\/null|2>&1))*$/;
/**
 * A plain relative path in the agent's working copy (BOS-120): no leading / - or ~, and no . .. or
 * .git part at any depth (so not a submodule's .git either). Other dot folders (.turbo, .cache) are fine.
 */
const WORKING_PATH = /^[A-Za-z0-9_+@.][A-Za-z0-9._+@-]*(?:\/[A-Za-z0-9._+@-]+)*\/?$/;
const inWorkingCopy = (p: string) => WORKING_PATH.test(p) && p.replace(/\/$/, "").split("/").every((part) => part !== "." && part !== ".." && part.toLowerCase() !== ".git");

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
      if (action === "list" || action === "prune") return args.every((w) => w.startsWith("-") && !w.startsWith("--expire"));
      // Only add. remove follows a symlink at /tmp/NAME and deletes its target (BOS-111 security review);
      // rm -rf /tmp/NAME then git worktree prune does the same cleanup. No -B: it resets an existing branch.
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
  if (/\(\)\s*\{|\bfunction\s|\balias\b|\bPATH=/.test(command)) return null;
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
      if (!(to === "/dev/null" || to === "&1" || to === "&2" || cleared.has(to))) ok = false;
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

/** What a shell command would do, in one sentence led by the worst thing in it. */
export function explainCommand(command: string): { summary: string; effect: Effect; scratch?: PermissionExplanation["scratch"] } {
  const segs = segments(command);
  const parts = segs.map(explainSegment);
  const effect = WORST.find((e) => parts.some((p) => p.effect === e)) ?? "reads";
  const sentences: string[] = [];
  for (const e of WORST) {
    const group = parts.filter((p) => p.effect === e && (p.text || e === "reads"));
    if (!group.length) continue;
    const targets = list(group.flatMap((p) => p.targets));
    if (e === "reads") {
      if (group.every((p) => p.env && !p.targets.length)) continue;
      sentences.push(`${effect === "reads" ? "Only reads" : "Reads"} information${targets ? ` (${targets})` : ""}${effect === "reads" ? "; it doesn't change anything" : ""}.`);
    } else {
      const many = new Set(group.flatMap((p) => p.targets)).size > 1;
      sentences.push([...new Set(group.map((p) => (many ? p.text.replace("a program", "programs") : p.text)))].join("; ") + (targets ? ` (${targets})` : "") + ".");
    }
  }
  if (parts.some((p) => p.env)) sentences.push("Shows environment variables, which can include secrets.");
  const tmp = parts.some((p) => p.env) ? null : scratchOnly(segs, parts);
  const scratch = tmp && {
    unchecked: tmp.unchecked,
    note: `Works only in a temporary folder (/tmp): every file it changes or deletes is there, so your project, its branch and the repository aren't touched.${tmp.unchecked.length ? ` It also runs ${tmp.unchecked.join(", ")} in that folder; Boss Man can't see inside ${tmp.unchecked.length === 1 ? "that program" : "those programs"}.` : ""}`,
  };
  return { summary: sentences.join(" ") || "Does nothing visible.", effect, ...(scratch ? { scratch } : {}) };
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

/** The whole card: plain title, effect line, and the agent's own reason if it gave one. */
export function explainPermission(info: PermissionInfo, agent: string): PermissionExplanation {
  const command = commandOf(info.rawInput) ?? (info.kind === "execute" ? info.title : null);
  const reason = text(info.rawInput, "description")?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
  if (command) {
    const x = explainCommand(command);
    return { title: `${agent} wants to run a command`, ...x, command, reason, ...(x.effect === "reads" ? {} : { alwaysNote: "Boss Man doesn't offer 'always' for commands that change, delete, push or use the network." }) };
  }
  const t = TOOL[info.kind ?? ""];
  const target = text(info.rawInput, "file_path", "filePath", "path", "url") ?? (info.kind === "search" ? text(info.rawInput, "pattern", "query") : null);
  if (!t) return { title: `${agent} wants to use a tool`, summary: `Uses the tool "${info.title ?? "unnamed"}", which Boss Man doesn't recognise.`, effect: "unknown", reason };
  const noun = t.verb === "Fetch" ? "" : t.verb === "Search" ? " for" : " the file";
  return { title: `${agent} wants to ${t.what}`, summary: `${t.verb}${target ? `${noun} ${target}` : ` (no name given)`}.`, effect: t.effect, reason };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KIND_RULE: Record<string, string> = { read: "read files", edit: "change files", fetch: "fetch web pages" };

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
    return [
      { label: `Always allow ${server}'s ${tool} tool`, name: `Allow ${server}'s ${tool} tool`, match: { titlePattern: `^${escapeRe(info.title!)}$`, safeOnly: true } },
      { label: `Always allow every ${server} tool`, name: `Allow every ${server} tool`, match: { titlePattern: `^mcp__${escapeRe(server)}__`, safeOnly: true } },
    ];
  }
  if (e.command) {
    return e.effect === "reads" && !e.summary.includes("secrets") && e.command.length < 250
      ? [{ label: "Always allow this exact command", name: `Allow the command ${e.command.slice(0, 60)}`, match: { kinds: ["execute"], commandPattern: `^${escapeRe(e.command)}$`, safeOnly: true } }]
      : [];
  }
  const what = KIND_RULE[info.kind ?? ""];
  // shortcut: rules have no agent condition, so this is company-wide.
  return what ? [{ label: `Always allow every agent in this company to ${what}`, name: `Allow agents to ${what}`, match: { kinds: [info.kind!], safeOnly: true } }] : [];
}
