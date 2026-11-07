import { explainCommand, readPush } from "./explain.js";
import { DESTRUCTIVE, isPrivateHost } from "./policy.js";

/**
 * The rules judge (BOS-337, from the BOS-329 study): where does this request reach? An ordered table
 * of rows; the first row that matches denies, otherwise it is allowed. It only picks the card's
 * suggested button. It never answers a card, and the hard gates (pushes to main, publishing,
 * deploys, secrets, the private network, other agents' work) stay decided by the fixed policy.
 */
export type JudgeRow = "noTarget" | "secret" | "others" | "kills" | "outward" | "privateNet" | "opaque" | "outside" | "tooLong" | "ok";

/** The reason shown on the card for each row: fixed, written by us, never built from the command. */
export const JUDGE_LABELS: Record<JudgeRow, string> = {
  noTarget: "It doesn't say which file, tool or address it touches",
  secret: "It could show or send a secret (tokens, keys, environment values)",
  others: "It could affect other agents' work or shared folders",
  kills: "It stops other agents' work",
  outward: "It pushes to main, force-pushes, deletes a branch, publishes, deploys or restarts a service",
  privateNet: "It contacts the home network or the machine's metadata service",
  opaque: "It runs code it downloads or decodes, so what it does can't be read",
  outside: "It changes or deletes files outside its own folder and /tmp",
  tooLong: "The command is too long to read safely",
  ok: "It stays in its own folder and /tmp, or only reads",
};

export interface JudgeReading {
  verdict: "allow" | "deny";
  row: JudgeRow;
  reasonLabel: string;
}

const WORKSPACE = /(?:^|[\s"'=:(])(?:\/[\w.@+-]+)*\/workspaces\/(?:tickets|reviews)\/([0-9a-f-]{36})/g;
const WORKSPACE_PATH = /^(?:\/[\w.@+-]+)*\/workspaces\/(?:tickets|reviews)\//;
const LEADING_CD = /^\s*(?:cd|git\s+-C)\s+(?:\/[\w.@+-]+)*\/workspaces\/(?:tickets|reviews)\/([0-9a-f-]{36})/;

/**
 * Characters the shell quotes, escapes, expands or substitutes. A path word that holds one can be written in a way the
 * judge can't read (`\/tmp`, `.'/.'/…`, `{,}`, `*`, `<(...)`, `$X`), so it never earns Allow (BOS-378, Jane's round 11).
 */
const PATH_DISGUISE = /[\\'"{}*?[\]$`()]/;
/** A `cd`/`pushd`/`chdir` (or `env -C`/`--chdir`) target, captured whole so the check sees any quotes or escapes in it. */
const CD_TARGET = /\b(?:cd|pushd|chdir)\b(?=[\s;&|)]|$)(?:\s+(?:--\s+)?("[^"]*"|'[^']*'|[^\s;&|)]*))?|\benv\b\s+(?:-\S+\s+)*?(?:-C|--chdir)(?:\s+|)(?:"([^"]*)"|'([^']*)'|([^\s;&|)]*))/g;
/** The interpreter names the judge reads; a word that is one of these is a program, not a launcher. */
const INTERP_NAMES = "python[\\d.]*|node(?:js)?|perl|ruby|php|lua|deno|bun|Rscript|tclsh|g?awk|mawk|sh|bash|zsh|dash|ksh";

/**
 * A path word resolved to what the shell would run: null when it holds a quote, escape, brace, glob, `$`, backtick or
 * bracket (the judge can't read those), otherwise a normalised path (`..`, `.` and `//` worked out). A relative word keeps
 * its leading `..` parts so the caller can reject it.
 */
function plainPath(raw: string): string | null {
  if (raw === "") return raw;
  if (PATH_DISGUISE.test(raw)) return null;
  const abs = raw.startsWith("/");
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** True when a plain path word climbs out (starts with `..`) as a relative path. */
const climbsOut = (p: string): boolean => p === ".." || p.startsWith("../");

/** The target words of every `cd`/`pushd`/`chdir` and `env -C` in the command, quotes and escapes kept so they can be judged. */
function cdWords(c: string): string[] {
  return [...c.matchAll(CD_TARGET)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim());
}

/** Longest command the judge reads; longer ones are not judged. */
export const MAX_JUDGED_COMMAND = 10_000;
export const isJudgeable = (command: string | null): boolean => !command || command.length <= MAX_JUDGED_COMMAND;

const result = (row: JudgeRow): JudgeReading => ({ verdict: row === "ok" ? "allow" : "deny", row, reasonLabel: JUDGE_LABELS[row] });

/**
 * @param question the card's plain-English text (used when there is no command to read)
 * @param command the shell command, or null for a tool call without one
 * @param ownFolder id of the ticket folder the asking agent works in, when the caller knows it;
 *   otherwise it is read from a leading `cd` or the most-named folder in the command.
 * @param ownProject name of the agent's own folder under `.claude/projects/`; only its `memory/` sub-folder
 *   may be written. Without it every `.claude` path is treated as shared.
 * @param workspaceRoot the folder that holds `tickets/` and `reviews/`; the own folder is `<root>/(tickets|reviews)/<id>`
 *   and nothing else counts as it. Without it any `.../workspaces/(tickets|reviews)/<id>` path counts.
 */
export function judgePermission(question: string, command: string | null, ownFolder?: string, ownProject?: string, workspaceRoot?: string): JudgeReading {
  if (!command) return judgeWithoutCommand(question, ownFolder, ownProject);
  // Safety net: callers should skip long commands with isJudgeable and keep the old recommendation.
  if (command.length > MAX_JUDGED_COMMAND) return result("tooLong");
  // Text written to a file by cat/tee is data, not commands: drop those heredoc bodies (interpreter heredocs stay, they run).
  const c = withoutOwnMemory(command, ownProject).replace(/((?:\bcat|\btee)\b[^\n]*?<<-?\s*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?)\n\3(?=\n|$)/g, (_m, head: string, _q, end: string) => head + end);
  const ids = [...c.matchAll(WORKSPACE)].map((m) => m[1]!);
  const own = ownFolder ?? LEADING_CD.exec(c)?.[1] ?? [...ids].sort((a, b) => ids.filter((x) => x === b).length - ids.filter((x) => x === a).length)[0];

  // Outward actions.
  if (readPush(c)?.dangerous) return result("outward");
  if (/\bgit\s+push\b[^;&|\n]*(\s-f\b|--force|\s\+\S|:main\b|:master\b|--delete|\s:\S)/.test(c)) return result("outward");
  if (/\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+(push|restart|stop|kill|rm|compose|run)\b|\bsystemctl\b|\bservice\s+\w+\s+(restart|stop)|\bgh\s+pr\s+merge\b|\bdeploy(\.sh)?\b[^\n]*\b(prod|production)\b|\bcrontab\b/.test(c)) return result("outward");
  if (/os\.system\([^)]*git\s+push|execSync\([^)]*git\s+push/.test(c)) return result("outward");
  // Secrets.
  if (/\/run\/secrets|\.git-credentials|\.netrc|\/\.ssh\/|\/\.aws\/|(^|[\s/"'=<>])\.env(\.\w+)?(?=$|[\s"';|&)])|\/environ\b|\bprintenv\b|(^|[;&|(]\s*)(set|export\s+-p|declare\s+-[px])\s*($|[|;&>)])|process\.env\b|os\.environ\b|\/api\/secrets\b|\.config\/(gh|gcloud|hub)\b|\.docker\/config\.json|\.npmrc\b|\.pgpass\b|\.kube\/config|\.git\/config\b[^\n]*\btoken/.test(c)) return result("secret");
  // Packing up a home folder or sending a file out as an upload.
  if (/\b(tar|zip|7z|cpio)\b[^|\n]*(\s|=)(~|\$HOME|\/home\/[\w.-]+)\/?(\s|$|\|)[^\n]*\|\s*(curl|wget|nc|ncat|socat)\b|\b(curl|wget)\b[^\n]*(\s-T\s|--upload-file|--data-binary\s+@|-d\s+@|-F\s+\S*@)/.test(c)) return result("secret");
  if (/(^|[;&|(]\s*|\s)env\s*($|[|;&>)])/.test(c) && !/env\s*\|\s*cut\s+-d\s*=?\s*['"]?=['"]?\s+-f\s*1/.test(c)) return result("secret");
  if (/\$\{?\w*(TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|CREDENTIAL|PRIVATE_KEY)\w*\}?/.test(c)) return result("secret");
  // Other agents and shared things.
  // Only a process this session started (`kill $!`, `kill %1`) may be stopped; any other pid, name or pattern could be another agent's check.
  if (/\b(pkill|killall)\b|\bkill\b(?!\s+(-\w+\s+)*(\$!|%\d))/.test(c)) return result("kills");
  if (/\/workspaces\/\.pnpm-store|\/workspaces\/repos\/[^\s]*\.git\/(config|hooks)|core\.hooksPath|\/home\/[\w.-]+\/\.claude\b|~\/\.claude\b|\$HOME\/\.claude/.test(c)) return result("others");
  if (/\.\.\/[0-9a-f]{8}-[0-9a-f]{4}/.test(c)) return result("others");
  if (/\brm\b[^;&|\n]*(^|\s)\.?pnpm-store\b/.test(c) && !own) return result("others");
  if (/\brm\b[^;&|\n]*\s\.pnpm-store\b/.test(c)) return result("others"); // same name as the shared store: the path must be absolute
  // Network.
  for (const m of c.matchAll(/https?:\/\/([^/\s:'"]+)|\b(?:ssh|scp)\s+(?:-\S+\s+)*(?:\w+@)?([\w.-]+)|connect\(\d+\s*,\s*['"]([\w.-]+)['"]/g)) {
    const h = (m[1] ?? m[2] ?? m[3])!;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(h)) continue; // the agent's own container
    if (isPrivateHost(h)) return result("privateNet");
  }
  // Opaque.
  if (/base64\s+(-d|--decode)[^\n]*\|\s*(sh|bash|zsh)\b|\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b|\b(sh|bash|zsh|source)\s+<\(\s*(curl|wget)\b|\beval\s+["'$]|\b(exec|eval)\s*\([^\n]*(urlopen|requests\.get|fetch)\b/.test(c)) return result("opaque");
  // Writes and deletes outside its own folder and /tmp.
  // A write to a shared checkout, or after a cd into someone else's folder, is outside its own folder.
  if (/\bsed\s+(?:-\w*i|--in-place)\b|>>?|\btee\b|\bcp\b|\bmv\b|\brm\b/.test(c) && /\/workspaces\/repos\//.test(c)) return result("outside");
  // Any write must land in /tmp, the agent's own ticket folder, /dev/null or its own memory folder. Shared startup and
  // settings files (~/.bashrc, ~/.gitconfig, /etc/..., /usr/local/bin/...) are not the agent's to change.
  // Settings written through a tool's own commands: `git config` with a file flag (in any position, `git -c x config`,
  // `git -C dir config`), the git config environment variables, and npm-family config/global installs.
  // Every `git config` write is refused (worktrees share the repo config, so core.fsmonitor / sshCommand / alias.x '!..'
  // would run in other agents' git); only the explicit read forms pass.
  // Allow-list: a git command passes only as a subcommand in GIT_TABLE with flags listed for it (checked below, once the own
  // folder is known) or the read-only config forms; everything else that uses git is Deny.
  if (/\bpip3?\s+install\b[^;&|\n]*\s--(?:user|target|prefix|root)\b|\bxargs\b[^;&|\n]*\b(?:ba|z|da)?sh\s+-c\b/.test(c)) return result("outside");
  if (/\bgit\b[^;&|\n]*\bconfig\b[^;&|\n]*(--(global|system|file|worktree|blob)\b|\s-f\S*)|\bGIT_CONFIG\w*=|\b(npm|pnpm|yarn)\s+(config|c)\s+(set|delete|edit|rm)\b|\bnpm\s+set\b|\b(npm|pnpm|yarn)\b[^;&|\n]*\s(-g|--global|--location[= ]global)\b/.test(c)) return result("outside");
  // Editors take commands (`vim -c "w! /file"`); an agent has no use for one.
  if (/(?:^|[;&|(\n]\s*)(?:vi|vim|nvim|ex|ed|view|vimdiff|emacs|nano|pico)\s/.test(c)) return result("outside");
  const rootRe = workspaceRoot ? workspaceRoot.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "(?:/[\\w.@+-]+)*/workspaces";
  const ownRe = own ? new RegExp(`^${rootRe}/(?:tickets|reviews)/${own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`) : null;
  /** Inside the agent's own ticket folder, anchored at the workspace root (the id elsewhere in a path does not count). */
  const inOwn = (p: string): boolean => !!ownRe && !p.includes("..") && ownRe.test(p.replace(/^['"]+|['"]+$/g, ""));
  const writeOk = (t: string): boolean => {
    const p = t.replace(/^['"]+|['"]+$/g, "");
    if (/^OWNDIR(\/[\w.@+-]+)*$/.test(p) && !p.includes("..")) return true;
    if (p === "MEMORY_PATH" || p === "/dev/null" || /^\/dev\/(stdout|stderr|fd\/\d+)$/.test(p)) return true;
    if (p.includes("..")) return false;
    if (/^\/tmp(\/|$)/.test(p)) return true;
    return inOwn(p);
  };
  if (gitDenied(c, inOwn, writeOk)) return result("outside");
  // Variables set in the same command are resolved; any other variable (and $(...)) can't be, so its target is denied.
  // $(git rev-parse --git-dir ...) is the asking agent's own git folder and $(mktemp ...) lands in /tmp, unless its
  // arguments (or a TMPDIR set anywhere) put the file somewhere else.
  const tmpdirSet = /\bTMPDIR\b/.test(c);
  const mktempPath = (args: string): string | null => {
    if (tmpdirSet) return null;
    const toks = args.trim().split(/\s+/).filter(Boolean);
    let dir: string | null = null;
    let tmpl: string | null = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t === "-p") dir = toks[++i] ?? "";
      else if (/^-p./.test(t)) dir = t.slice(2);
      else if (t === "--tmpdir") dir = "/tmp"; // no value: $TMPDIR, which no command here sets
      else if (t.startsWith("--tmpdir=")) dir = t.slice(9);
      else if (!t.startsWith("-")) tmpl = t;
    }
    const under = (p: string | null): boolean => p === null || (/^\/tmp(\/|$)/.test(p) && !p.includes(".."));
    const abs = (p: string | null): boolean => p !== null && /^[/~]/.test(p);
    if (!under(dir) || (abs(tmpl) && !under(tmpl))) return null;
    return (abs(tmpl) ? tmpl : dir) ?? "/tmp/mk";
  };
  const safeSubst = (x: string): string => x
    .replace(/\$\(\s*git\s+(?:-C\s+\S+\s+)?rev-parse\s+(?:--absolute-git-dir|--git-dir|--show-toplevel|--git-path\s+[\w./-]+)\s*\)/g, "OWNDIR")
    .replace(/\$\(\s*mktemp\b([^)\x60$]*)\)/g, (all, args: string) => mktempPath(args) ?? all);
  const cs = safeSubst(c);
  const assigned0 = new Map([...cs.matchAll(/(?:^|[;&|\s])(\w+)=(['"]?)(OWNDIR|\/tmp\/[\w.-]*)\2(?=$|[\s;&|)])/g)].map((m) => [m[1]!, m[3]!] as const));
  const cs2 = cs.replace(/\$\(\s*dirname\s+['"]?\$\{?(\w+)\}?['"]?\s*\)/g, (all, n: string) => assigned0.get(n) ?? all);
  // A variable is read only when it is set exactly once, to a plain value, before its first use. Any other way of setting
  // it (a second assignment, `for X in`, `read X`, `${X:=...}`, `printf -v X`, `X+=`) or a use before the assignment means its
  // value is unknown (HOME=/tmp; D=/etc; D=$HOME), so a target that uses it is denied.
  const setCount = new Map<string, number>();
  const bump = (n: string | undefined): void => void (n && setCount.set(n, (setCount.get(n) ?? 0) + 1));
  for (const m of cs2.matchAll(/(?:^|[;&|\s(])(\w+)\+?=/g)) bump(m[1]);
  for (const m of cs2.matchAll(/\bfor\s+(\w+)\b|\bprintf\s+-v\s+(\w+)|\$\{(\w+)[^}\w]*?(?::?[=])/g)) bump(m[1] ?? m[2] ?? m[3]);
  for (const m of cs2.matchAll(/\b(?:read|mapfile|readarray|getopts)\b([^;&|\n]*)/g)) for (const w of m[1]!.split(/\s+/)) if (/^\w+$/.test(w)) bump(w);
  const assigned = new Map<string, string>();
  for (const m of cs2.matchAll(/(?:^|[;&|\s])(\w+)=(['"]?)([^\s'";|&)$\x60]+)\2(?=$|[\s;&|)])/g)) {
    const name = m[1]!;
    const firstUse = cs2.search(new RegExp(`\\$\\{?${name}\\b`));
    if (setCount.get(name) === 1 && (firstUse < 0 || firstUse > m.index!)) assigned.set(name, m[3]!);
  }
  const resolve = (t: string): string => t.replace(/\$\{?(\w+)\}?/g, (all, name: string) => (name !== "HOME" && assigned.has(name) ? assigned.get(name)! : all));
  // A sed script is not a path, but only a script that provably can't run commands or write files is set aside as text:
  // `e` (flag or command), `w`/`W`/`r`/`R` (any file), or a script that can't be read means the write is not placed.
  const sedMasked = maskSedScripts(cs2);
  if (sedMasked === null) return result("outside");
  const forTargets = sedMasked;
  const writeTargets: string[] = [];
  const addTarget = (cand: string): void => { const r = resolve(cand); if (/^['"]*[~/$\x60]/.test(r) || /\$|\x60|OWNDIR/.test(r) || r.includes("..")) writeTargets.push(r); };
  for (const m of forTargets.matchAll(/>[>|&]?\s*(['"]?(?:[~/$]|OWNDIR)[^\s'";|&)<>]*)/g)) addTarget(m[1]!);
  for (const m of forTargets.matchAll(/\b(?:cp|mv|tee|ln|install|touch|chmod|chown|truncate|dd|rsync|mkdir|rmdir|mkfifo|mknod|patch|sed(?:\s+-[a-zA-Z]+)*\s+(?:-[a-zA-Z]*i\S*|--in-place\S*)|perl\s+-pi\S*|git\s+(?:clone|init|worktree|archive|checkout-index|bundle))\b([^;&|\n]*)/g)) {
    for (const tok of m[1]!.split(/\s+/)) {
      // Plain, `--opt=/x`, `of=/x` and `-t/x` forms.
      for (const cand of [tok, tok.split("=").slice(1).join("="), tok.replace(/^-\w(?=['"]?[~/$])/, "")]) addTarget(cand);
    }
  }
  // Downloaders and archive tools: the files named by their output / directory options, and every absolute path given to
  // tar and unzip, must be placed too.
  for (const t of toolTargets(forTargets)) addTarget(t);
  // BOS-378 (CEO round 14): a command whose words include a shell, interpreter or launcher gets no Allow unless the
  // whole command is on a short allow-list of plain forms (see codeRunDenied). The judge no longer tries to read inline
  // code, `-c`/`-S` strings, loader variables or disguised program names: it never auto-allows them. Over-denial is the
  // point; while the judge only watches, this costs nothing.
  if (codeRunDenied(cs, inOwn)) return result("outside");
  if (writeTargets.some((t) => !writeOk(t))) return result("outside");
  // A redirect (or any write) after a `cd`/`pushd` somewhere else lands there: `pushd /home/node; echo x >> .bashrc`.
  const hasRedirect = />/.test(forTargets.replace(/\d*>>?\s*\/dev\/null|\d*>&\d|&>\s*\/dev\/null/g, ""));
  if (hasRedirect) for (const d of cdWords(c)) if (!dirOk(d, inOwn)) return result("outside");
  const writes = /^(changes|deletes|unknown)$/.test(explainCommand(c).effect) || /rmSync|unlinkSync|writeFileSync|shutil\.rmtree|os\.remove|reset\s+--hard/.test(c) || new RegExp(DESTRUCTIVE, "i").test(c);
  if (writes) {
    for (const id of ids) if (own && id !== own && new RegExp(`(rm|rmSync|mv|reset|>|tee|cp)[^;&|\\n]*${id}`).test(c)) return result("outside");
    for (const m of c.matchAll(/\bcd\s+(?:\/[\w.@+-]+)*\/workspaces\/(?:tickets|reviews)\/([0-9a-f-]{36})/g)) if (own && m[1] !== own) return result("outside");
    const targets = [...c.matchAll(/(?:\brm\b|rmSync\(|rmtree\(|unlinkSync\()\s*(?:-\S+\s+)*['"]?((?:~|\$HOME|\/)[^\s'";|&)]*)/g)].map((m) => m[1]!);
    for (const t of targets) if (!/^\/tmp\//.test(t) && !inOwn(t) && t !== "/dev/null") return result("outside");
    // A relative target can climb out of the folder (`rm -rf ..`), and a `cd` somewhere else makes every relative target land there.
    for (const m of c.matchAll(/\brm\b([^;&|\n]*)/g)) if (/(^|[\s'"=/])\.\.(?=$|[\s'"/;|&)])/.test(m[1]!)) return result("outside");
    for (const d of cdWords(c)) if (!dirOk(d, inOwn)) return result("outside");
    // `find <path> ... -delete` / `-exec rm`: the start path decides.
    for (const m of c.matchAll(/\bfind\s+((?:-[HLP]\s+)*)([^\s-][^\s]*|)[^\n;&|]*?(-delete\b|-exec\s+rm\b)/g)) {
      const start = m[2]!;
      if (start === "" || start === "." || (/^[\w.@+-]+(\/[\w.@+-]+)*$/.test(start) && !start.includes(".."))) continue;
      if (/^\/tmp\//.test(start) && !start.includes("..")) continue;
      if (inOwn(start)) continue;
      return result("outside");
    }
  }
  return result("ok");
}

/**
 * What each git subcommand may be given. Anything not in this table is Deny: the subcommand itself (rebase, bisect, submodule,
 * am, archive, bundle, format-patch, checkout-index, `worktree add`, config writes, ...) and every flag that is not listed.
 * l: long flags, space separated; a trailing `=` means the flag takes its value as the next word (`--author x`).
 * s: short flags (letters); v: the short flags that take a value (`-m msg`, `-mmsg`); `0` in s allows `-5`.
 * w: the subcommand changes the tree or index, so absolute or `..` path arguments go through the write-target check.
 * first: the first plain word must match (`worktree list`); none: no plain words at all.
 */
interface GitSpec { l: string; s?: string; v?: string; w?: boolean; first?: RegExp; none?: boolean }
const DIFFISH = "--stat --shortstat --numstat --name-only --name-status --patch --no-patch --color --no-color --summary --raw --compact-summary --find-renames --no-renames --diff-filter= --unified= --word-diff --color-words --minimal --patience --histogram --abbrev --full-index --binary --text --ignore-all-space --ignore-space-change --ignore-blank-lines --relative --check --exit-code --quiet";
const LOGISH = "--oneline --graph --decorate --no-decorate --abbrev-commit --abbrev --all --branches --tags --remotes --author= --committer= --since= --until= --after= --before= --grep= --max-count= --skip= --reverse --merges --no-merges --first-parent --date= --follow --pretty --format --topo-order --date-order --cherry-pick --left-right --boundary --invert-grep --all-match --parents --children --full-history --simplify-by-decoration --relative-date --no-walk --ancestry-path --source --notes --no-notes --diff-filter= --pickaxe-all";
const GIT_TABLE: Record<string, GitSpec> = {
  status: { l: "--short --branch --porcelain --long --ignored --untracked-files --no-renames --ahead-behind --no-ahead-behind", s: "sbzv" },
  log: { l: `${LOGISH} ${DIFFISH}`, s: "npsSGiM0", v: "nSG" },
  show: { l: `${LOGISH} ${DIFFISH}`, s: "psq" },
  diff: { l: `${DIFFISH} --cached --staged --no-index --merge-base`, s: "puUbwRMSGaz", v: "USG" },
  grep: { l: "--no-index --cached --untracked --line-number --ignore-case --word-regexp --files-with-matches --files-without-match --count --extended-regexp --fixed-strings --perl-regexp --basic-regexp --heading --break --color --no-color --and --or --not --quiet --invert-match --text --full-name --max-depth= --threads=", s: "niwvlLcEFGPrhHIaeqAB0", v: "eAB" },
  "ls-files": { l: "--cached --others --modified --deleted --stage --ignored --unmerged --killed --exclude-standard --full-name --error-unmatch --deduplicate --eol --directory --no-empty-directory", s: "comdsiukzt" },
  "ls-tree": { l: "--name-only --long --full-name --full-tree --abbrev --object-only", s: "rdtlz" },
  "merge-tree": { l: "--write-tree --name-only --messages --no-messages --merge-base= --allow-unrelated-histories --trivial-merge", s: "z" },
  "rev-parse": { l: "--abbrev-ref --short --verify --git-dir --absolute-git-dir --show-toplevel --is-inside-work-tree --show-prefix --show-cdup --git-path= --symbolic-full-name --is-bare-repository --git-common-dir --quiet", s: "q" },
  "rev-list": { l: "--count --max-count= --all --branches --tags --reverse --parents --first-parent --no-merges --merges --left-right --abbrev-commit --oneline --since= --until= --author= --grep= --skip= --topo-order --date-order --ancestry-path", s: "n", v: "n" },
  "cat-file": { l: "--batch --batch-check --batch-all-objects", s: "tspe" },
  blame: { l: "--porcelain --line-porcelain --abbrev --since= --date= --root", s: "LwelspfnMCb", v: "L" },
  "diff-tree": { l: "--name-only --name-status --no-commit-id --root --stat --numstat", s: "rpmcst" },
  "for-each-ref": { l: "--format= --sort= --count= --merged --no-merged --contains --points-at=" },
  "show-ref": { l: "--heads --tags --verify --quiet --dereference --hash --abbrev", s: "qds" },
  describe: { l: "--tags --always --abbrev --dirty --long --contains --match= --exclude= --all --first-parent --candidates=" },
  shortlog: { l: "--summary --numbered --email --since= --until= --no-merges", s: "sne" },
  "name-rev": { l: "--name-only --tags --refs= --no-undefined --always" },
  "merge-base": { l: "--is-ancestor --fork-point --all --octopus --independent", s: "a" },
  "ls-remote": { l: "--heads --tags --refs --quiet --exit-code", s: "q" },
  "check-ignore": { l: "--verbose --non-matching --quiet --stdin --no-index", s: "vnqz" },
  "symbolic-ref": { l: "--short --quiet", s: "q" },
  remote: { l: "--verbose", s: "v", none: true },
  worktree: { l: "--porcelain --verbose", s: "vz", first: /^list$/ },
  commit: { l: "--amend --no-edit --no-verify --allow-empty --allow-empty-message --signoff --quiet --all --dry-run --short --porcelain --author= --date= --message= --fixup= --squash= --file= --reuse-message=", s: "maAsqvnFC", v: "mFC", w: true },
  add: { l: "--all --update --dry-run --verbose --force --intent-to-add --ignore-errors --no-all", s: "AunvfN", w: true },
  rm: { l: "--cached --force --quiet --dry-run --ignore-unmatch", s: "rfqn", w: true },
  mv: { l: "--force --dry-run --verbose", s: "fknv", w: true },
  restore: { l: "--staged --worktree --source= --quiet --ours --theirs --overlay --no-overlay", s: "SWsq", v: "s", w: true },
  reset: { l: "--hard --soft --mixed --keep --merge --quiet", s: "qN", w: true },
  clean: { l: "--force --dry-run --quiet", s: "fdxXnqe", v: "e", w: true },
  checkout: { l: "--quiet --force --detach --track --no-track --ours --theirs --merge --orphan=", s: "bBqftml", v: "bB", w: true },
  switch: { l: "--create= --force-create= --detach --force --quiet --track --no-track --discard-changes --merge", s: "cCdfqtm", v: "cC", w: true },
  branch: { l: "--all --remotes --verbose --list --show-current --contains --merged --no-merged --format= --sort= --set-upstream-to= --unset-upstream --force --delete --move --copy --points-at= --no-color --color --abbrev --quiet --track", s: "arvdDmMcCluft", v: "u", w: true },
  tag: { l: "--annotate --delete --force --message= --list --contains --merged --no-merged --sort= --points-at= --format= --verify", s: "adlmfnv", v: "m", w: true },
  stash: { l: "--include-untracked --all --keep-index --message= --quiet --stat --staged", s: "uakmq", v: "m", w: true },
  merge: { l: "--no-ff --ff-only --ff --squash --no-commit --commit --abort --continue --message= --quiet --no-edit --no-verify --allow-unrelated-histories --no-stat --stat", s: "mqn", v: "m", w: true },
  "cherry-pick": { l: "--continue --abort --skip --quit --no-commit --no-edit --allow-empty --keep-redundant-commits --mainline= --ff", s: "xnm", v: "m", w: true },
  fetch: { l: "--all --prune --tags --no-tags --quiet --verbose --depth= --unshallow --force --dry-run", s: "ptqvfn" },
  pull: { l: "--rebase --no-rebase --ff-only --no-ff --ff --autostash --no-autostash --all --quiet --verbose --tags --prune --depth=", s: "rqvp" },
  push: { l: "--set-upstream --tags --follow-tags --dry-run --quiet --verbose --no-verify --atomic", s: "unqv" },
  clone: { l: "--quiet --depth= --branch= --single-branch --no-tags --bare --no-checkout", s: "qbn", v: "b", w: true },
  init: { l: "--quiet --bare --initial-branch=", s: "qb", v: "b", w: true },
  apply: { l: "--check --stat --numstat --summary --index --3way --cached --reverse --quiet --verbose", s: "3Rqv" },
};
const GIT_READ = /^git (?:config (?:--get(?:-all|-regexp|-urlmatch)? [\w.-]+|--list)|--version)$/;
/** Words that may stand in front of git without changing what it runs. */
const GIT_WRAPPER = /^(?:time|nohup|command|nice|timeout|-\S*|\d+)$/;
/** Programs that start another program with its own arguments: when git follows one, it can't be read. */
const GIT_LAUNCHER = /^(?:\w+\+?=\S*|env|export|declare|typeset|local|readonly|sudo|doas|xargs|exec|setsid|stdbuf|ionice|watch|parallel|busybox|chroot|su|-exec|-execdir|-ok|-okdir|sh|bash|zsh|dash|ksh|eval|script|unshare|nsenter|flock|strace|ltrace|gdb)$/;

/** Words of a shell command with quotes and backslashes removed. Anything with $ or a backtick is refused by the caller. */
function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) { if (ch === q) q = ""; else if (ch === "\\" && q === '"' && i + 1 < s.length) cur += s[++i]!; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < s.length) { cur += s[++i]!; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ""; has = false; continue; }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}


/**
 * True when the arguments of one git command (words after `git`) are not on the allow-list. `repoOk` places the repository
 * git runs in: it must be inside the agent's own checkout, because that repo's hooks and config can run code. `cwdOutside`
 * says a preceding `cd`/`pushd` moved somewhere outside that checkout, so a git with no `-C`/`--git-dir`/`--work-tree`
 * would run there too.
 */
function gitArgsDenied(args: string[], repoOk: (p: string) => boolean, pathOk: (p: string) => boolean, cwdOutside: boolean): boolean {
  let i = 0;
  // Where git runs: -C, --git-dir and --work-tree must point inside the agent's own checkout (not just any /tmp folder).
  let explicit = false;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C") { if (i + 1 >= args.length || !repoOk(args[++i]!)) return true; explicit = true; continue; }
    if (/^--(?:git-dir|work-tree)$/.test(a)) { if (i + 1 >= args.length || !repoOk(args[++i]!)) return true; explicit = true; continue; }
    const eq = /^--(?:git-dir|work-tree)=(.*)$/.exec(a);
    if (eq) { if (!repoOk(eq[1]!)) return true; explicit = true; continue; }
    if (a === "--no-pager" || a === "--no-optional-locks") continue;
    break;
  }
  // No folder named: git runs in the current folder. It is the agent's own checkout unless a `cd`/`pushd` moved away.
  if (!explicit && cwdOutside) return true;
  const sub = args[i++];
  const spec = sub === undefined ? undefined : Object.hasOwn(GIT_TABLE, sub) ? GIT_TABLE[sub] : undefined;
  if (!spec) return true;
  const longs = new Map<string, boolean>();
  for (const f of spec.l.split(" ")) longs.set(f.replace(/=$/, ""), f.endsWith("="));
  const plain: string[] = [];
  let dashes = false;
  for (; i < args.length; i++) {
    const a = args[i]!;
    // A redirect is read by the general write scan; skip it here.
    if (/^\d*[<>]/.test(a)) { if (/^\d*>{1,2}[|&]?$|^\d*<$/.test(a)) i++; continue; }
    if (dashes || a === "-" || !a.startsWith("-")) { plain.push(a); continue; }
    if (a === "--") { dashes = true; continue; }
    if (a.startsWith("--")) {
      const name = a.split("=")[0]!;
      if (!longs.has(name)) return true;
      if (longs.get(name) && !a.includes("=")) i++; // value in the next word
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const ch = a[j]!;
      if (/\d/.test(ch)) { if (!(spec.s ?? "").includes("0")) return true; continue; }
      if (!(spec.s ?? "").includes(ch)) return true;
      if ((spec.v ?? "").includes(ch)) { if (j === a.length - 1) i++; break; }
    }
  }
  if (spec.none && plain.length > 0) return true;
  if (spec.first && !(plain[0] !== undefined && spec.first.test(plain[0]))) return true;
  for (const p of plain) {
    // A `::` in a URL names a transport helper (`ext::sh -c ...`, `fd::`), which runs a program: no Allow for any command
    // that copies from or talks to a remote.
    if (/::/.test(p) && (sub === "clone" || sub === "fetch" || sub === "pull" || sub === "push" || sub === "ls-remote")) return true;
    if (/\{[^}]*(?:,|\.\.)[^}]*\}/.test(p)) return true; // brace expansion
    if (!spec.w) continue;
    if (/(?:^|\/)\.\.(?:\/|$)/.test(p)) return true;
    if (/^[/~]/.test(p) && !(sub === "clone" && p === plain[0]) && !pathOk(p)) return true;
  }
  return false;
}

/**
 * True when a command that starts with git (after ;, |, $(, (, or a backtick) is not on the allow-list: the subcommand must be a
 * row of GIT_TABLE, every flag must be listed for it, and the folder git runs in must pass the same test as `cd`. A NAME=value,
 * env, export or other launcher in front of git, and any `$` or backtick in a git command, is Deny.
 */
function gitDenied(c: string, inOwn: (p: string) => boolean, pathOk: (p: string) => boolean): boolean {
  // Environment that makes git run a program or move it (GIT_DIR, GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_PAGER, ...), set anywhere on a line that uses git.
  if (/\bgit\b/.test(c) && /(?:^|[\s;&|(])(?:export\s+|env\s+|declare\s+(?:-x\s+)?)?(?:GIT_\w+|PAGER|EDITOR|VISUAL|SSH_ASKPASS|LESSOPEN|LD_\w+)\+?=/.test(c)) return true;
  // A `cd`/`pushd` outside the agent's own checkout (any /tmp repo, say) makes a git with no folder named run there, and
  // that repo's hooks and config can run code.
  let cwdOutside = false;
  for (const d of cdWords(c)) {
    const p = plainPath(d);
    if (p !== null && (inOwn(p) || (/^[\w.@+-]+(\/[\w.@+-]+)*$/.test(p) && !climbsOut(p)))) continue; // own folder or a sub-folder
    cwdOutside = true;
  }
  // Only a plain literal folder counts; a disguised one (`.'/…`) is unread, so not the agent's own repo (BOS-378).
  const repoOk = (p: string): boolean => { const n = plainPath(p); return n !== null && !climbsOut(n) && inOwn(n); };
  for (const seg of c.split(/[;&|\n]/)) {
    const parts = seg.split(/\$\(|[()\x60]/);
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]!.trim();
      const words = shellWords(raw);
      let k = 0;
      while (k < words.length && GIT_WRAPPER.test(words[k]!)) k++;
      const head = words[k];
      if (head === undefined) continue;
      // An unknown program with arguments (`$g config x y`) could be git.
      if (i === 0 && /^(?:\$[\w{(@*#?!$]|\x60)/.test(head) && words.length - k > 1 && (!head.includes("/") || /\/git$/.test(head))) return true;
      // A launcher (`FOO=1 git ...`, `env git ...`, `sudo git ...`, `xargs git ...`, `sh -c 'git ...'`) with git after it.
      if (GIT_LAUNCHER.test(head) && words.slice(k + 1).some((w) => /(?:^|[\s/])git(?:\s|$)/.test(w))) return true;
      // `find ... -exec git ...` runs git with arguments from elsewhere.
      if (words.some((w, n) => /^-(?:exec|execdir|ok|okdir)$/.test(w) && /(?:^|[\s/])git(?:\s|$)/.test(words[n + 1] ?? ""))) return true;
      if (!/^(?:[\w./-]*\/)?git(?:[$\x60{].*)?$/.test(head)) continue;
      if (GIT_READ.test(raw)) {
        // `git --version` touches no repo. A config read does: in a folder outside the agent's own checkout its config may
        // pull in another file, so no Allow there.
        if (/\bconfig\b/.test(raw) && cwdOutside) return true;
        continue;
      }
      // No substitution, variable or backtick anywhere in a git command, quoted or not: it can't be read.
      if (/[$\x60]/.test(i === 0 ? seg : raw)) return true;
      if (gitArgsDenied(words.slice(k + 1), repoOk, pathOk, cwdOutside)) return true;
    }
  }
  return false;
}

/**
 * Where a `cd` / `pushd` (or `env -C`) may go: /tmp, the own folder, or a sub-folder of where it already is. Only a plain
 * path word counts; a quoted, escaped, braced or globbed one (`.'.'/tmp/p`) is unread and so not ok (BOS-378).
 */
function dirOk(dir: string, inOwn: (p: string) => boolean): boolean {
  if (dir === "" || dir === "-") return false; // a bare `cd` goes to $HOME, `cd -` to OLDPWD: both unknown
  const p = plainPath(dir);
  if (p === null) return false;
  if (/^\/tmp(\/|$)/.test(p)) return true;
  if (inOwn(p)) return true;
  return /^[\w.@+-]+(\/[\w.@+-]+)*$/.test(p) && !climbsOut(p); // a sub-folder of where it already is
}

/**
 * True only for a sed script made of commands that can neither run a command nor touch a file: addresses, `s` with the
 * flags g p i I m M and digits, `y`, and the plain commands p d q Q n N h H g G x D P l =. `a`, `i`, `c` (plain text),
 * and nothing else: not `e`, `w`, `W`, `r`, `R`, `b`, `t`, `:`, comments and anything it can't parse are not safe. The parser follows GNU sed (bracket expressions
 * keep their delimiters), and stops at the first thing it doesn't know.
 */
function safeSedScript(raw: string): boolean {
  const s = raw.replace(/^(['"])([\s\S]*)\1$/, "$2").replace(/\$\(\([^()]*\)\)/g, "1");
  let i = 0;
  const skipTo = (d: string, brackets: boolean): boolean => {
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\\") { i += 2; continue; }
      if (brackets && ch === "[") {
        i++;
        if (s[i] === "^") i++;
        if (s[i] === "]") i++;
        while (i < s.length && s[i] !== "]") i += s[i] === "[" && /[:.=]/.test(s[i + 1] ?? "") ? (s.indexOf(s[i + 1]! + "]", i + 2) < 0 ? s.length : s.indexOf(s[i + 1]! + "]", i + 2) + 2 - i) : 1;
        if (i >= s.length) return false;
        i++;
        continue;
      }
      if (ch === d) { i++; return true; }
      if (ch === "\n") return false;
      i++;
    }
    return false;
  };
  const delimiter = (): string | null => { const d = s[i++]; return d === undefined || /[\s\;]/.test(d) ? null : d; };
  while (i < s.length) {
    const ch = s[i]!;
    if (/[\s;{}!,~+$\d]/.test(ch)) { i++; continue; }
    if (ch === "/" || ch === "\\") {
      if (ch === "\\") i++;
      const d = delimiter();
      if (!d || !skipTo(d, true)) return false;
      while (/[IM]/.test(s[i] ?? "")) i++;
      continue;
    }
    if (ch === "s" || ch === "y") {
      i++;
      const d = delimiter();
      if (!d || !skipTo(d, ch === "s") || !skipTo(d, false)) return false;
      if (ch === "s") while (/[gpiImM\d]/.test(s[i] ?? "")) i++;
      continue;
    }
    if (/[pdqQnNhHgGxDPl=]/.test(ch)) { i++; continue; }
    if (/[aic]/.test(ch)) { // text to append, insert or change: it runs to the end of the line (\ continues it) and is only text
      i++;
      while (i < s.length && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
      continue;
    }
    return false;
  }
  return true;
}

/** Replaces every sed script with the word SCRIPT when it is safe text; null when any sed script is not provably safe. */
function maskSedScripts(c: string): string | null {
  let unsafe = false;
  const out = c.replace(/(?<![\w./-])sed\b((?:[^;&|\n'"]|'[^']*'|"[^"]*")*)/g, (all, args: string) => {
    const toks = args.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    let haveScript = false;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (/^-[A-Za-z]*f$/.test(t)) { unsafe = true; continue; } // -f script-file
      if (t === "--file" || t.startsWith("--file=")) { unsafe = true; continue; }
      if (/^-[A-Za-z]*e$/.test(t) || t === "--expression") {
        haveScript = true;
        const next = toks[i + 1];
        if (next === undefined || !safeSedScript(next)) unsafe = true;
        else toks[i + 1] = "SCRIPT";
        i++;
        continue;
      }
      if (t.startsWith("--expression=")) { haveScript = true; if (!safeSedScript(t.slice(13))) unsafe = true; else toks[i] = "--expression=SCRIPT"; continue; }
      if (t.startsWith("-")) continue;
      if (!haveScript) {
        // The first plain word is the script when no -e was given.
        haveScript = true;
        if (!safeSedScript(t)) unsafe = true;
        else toks[i] = "SCRIPT";
      }
    }
    return "sed " + toks.join(" ");
  });
  return unsafe ? null : out;
}

/** The value options of curl, wget, tar and unzip that name a file or folder, plus every absolute path given to tar and unzip. */
function toolTargets(c: string): string[] {
  const out: string[] = [];
  const spec: Record<string, { short: string; long: string[] }> = {
    curl: { short: "ocDK", long: ["--output", "--output-dir", "--cookie-jar", "--dump-header", "--stderr", "--trace", "--trace-ascii", "--libcurl", "--config"] },
    wget: { short: "OoaP", long: ["--output-document", "--output-file", "--append-output", "--directory-prefix", "--save-cookies"] },
    tar: { short: "Cf", long: ["--directory", "--file", "--one-top-level", "--transform", "--to-command"] },
    unzip: { short: "d", long: [] },
    "7z": { short: "o", long: [] },
  };
  for (const m of c.matchAll(/(?<![\w./-])(curl|wget|tar|unzip|7z|7za|7zr)\b((?:[^;&|\n'"]|'[^']*'|"[^"]*")*)/g)) {
    const tool = m[1]!;
    const { short, long } = spec[/^7z/.test(tool) ? "7z" : tool]!;
    const toks = (m[2]!.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/['"]/g, ""));
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      // tar -P / --absolute-names: members keep their absolute paths, so nothing can be placed.
      if (tool === "tar" && (t === "--absolute-names" || (i === 0 && /^-?[A-Za-z]*P[A-Za-z]*$/.test(t)) || /^-[A-Za-z]*P[A-Za-z]*$/.test(t))) out.push("/UNPLACED");
      const lf = long.find((l) => t === l || t.startsWith(l + "="));
      if (lf) { out.push(t === lf ? (toks[++i] ?? "") : t.slice(lf.length + 1)); continue; }
      if (/^-[A-Za-z]+$/.test(t) && short.includes(t.slice(-1))) { out.push(toks[++i] ?? ""); continue; }
      const sv = /^-([A-Za-z])(.+)$/.exec(t);
      if (sv && !t.startsWith("--") && short.includes(sv[1]!) && /^[~/$]|\.\./.test(sv[2]!)) { out.push(sv[2]!); continue; }
      if ((tool === "tar" || tool === "unzip") && /^['"]*[~/$]|\.\./.test(t)) out.push(t);
    }
  }
  return out;
}

/**
 * BOS-378 (CEO round 14): the judge stops trying to read hidden scripts. A command whose words include a shell, an
 * interpreter or a launcher gets no Allow, wherever it sits in the chain, unless the whole segment is on a short
 * allow-list of plain forms:
 *   - `pnpm|npm run <script>` / `pnpm|npm exec <tool>` over plain literal words;
 *   - `node|python3|bash|sh <file>` (or a shebang script run by its plain path), every word a plain literal and the file
 *     a relative path inside the agent's own checkout with no `..`.
 * Everything else is Deny: any -c/-e/-p/-m/-r/--require/-s flag, any NAME=value or env prefix, any wrapper (nohup,
 * timeout, setsid, sudo, flock, ...) or unknown word in front of an interpreter, code piped or here-stringed in, a `-c`
 * string (never parsed: `-c` alone is Deny), a program name written in disguise, and a `$(...)`/backtick that is not a
 * plain path. Over-denial is the point; while the judge only watches this costs nothing, and the card just asks a human.
 * Every command span is read: split on `;`, `&`, `|`, newlines, and inside every `$(...)`, `(...)` and backtick.
 */
const SHELL_NAME = /^(?:sh|bash|zsh|dash|ksh)$/;
const INTERP_NAME = new RegExp(`^(?:${INTERP_NAMES}|tsx|ts-node|esbuild-register|swc-node)$`);
/** A runner's own subcommand before the file word: `deno run <file>`, `bun run <file>` — skip it. */
const INTERP_VERB = /^(?:run|eval)$/;
/** A build tool that reads a file named with `-f`/`--file`/`-C`; other `make` forms only run the local Makefile. */
const MAKE = /^(?:make|gmake)$/;
/** Words that only hand control to another program. None of them is on the allow-list. */
const LAUNCHER = /^(?:nohup|time|timeout|sudo|doas|setsid|stdbuf|env|exec|command|builtin|xargs|nice|ionice|chrt|chroot|nsenter|unshare|script|flock|strace|ltrace|gdb|watch|parallel|busybox|su|then|do|else|if|elif|while|until|!|\{|\}|\(|\))$/;
/** A plain literal word: a path or a value with no quoting, expansion, glob or shell operator. */
const PLAIN_WORD = /^[A-Za-z0-9_.@%+=:,/?~-]+$/;
/** A shell redirect token (`2>&1`, `>&2`, `&>`, `>/dev/null` handled elsewhere): it runs no code, so it does not block. */
const REDIR = /^(?:\d*>&\d+|&>\d*|&>>?\S*|\d*>>?&?\d*)$/;
/** The command word of a segment after its prefixes (`NAME=value`, `!`, `{`, `(`). */
const NO_PREFIX = /^(?:\w+=[^\s]*|[({!]+)$/;

/**
 * True when a segment runs code the judge will not auto-allow. `inOwn` places a script file: it must stay in the
 * agent's own checkout, and a `cd` out of it first makes a relative script file unreadable too.
 */
function codeRunDenied(c: string, inOwn: (p: string) => boolean): boolean {
  const base = (w: string): string => w.replace(/^.*\//, "");
  // Output redirections (`> log`, `2>&1`, `>> out`, `&> f`) and their target file are data sinks: running a program is
  // no less readable because its stdout goes to a file. Drop them so a plain script with `> log` still gets Allow. An
  // input redirect (`< f`, `<<EOF`, a heredoc) still feeds the program and is left in place (a shell reading stdin runs it).
  const OUT_REDIR = /^(?:\d*>>?|\d*>&\d+|&>>?)(.*)$/;
  const noOutRedir = (ws: string[]): string[] => {
    const out: string[] = [];
    for (let k = 0; k < ws.length; k++) {
      const w = ws[k]!;
      const m = OUT_REDIR.exec(w);
      if (m) { if (m[1] === "") k++; continue; } // `> log`: drop the token and its target
      if (REDIR.test(w)) continue;
      out.push(w);
    }
    return out;
  };
  const codeWord = (w: string): boolean => { const b = base(w); return INTERP_NAME.test(b) || SHELL_NAME.test(b) || LAUNCHER.test(b) || MAKE.test(b) || /^(?:pnpm|npm|yarn|bun|npx|pnpx|bunx)$/.test(b); };
  // A relative script file lands wherever the shell already is: only a `cd`/`pushd` that stays inside the checkout (or a
  // sub-folder of it) keeps it readable. A `cd /tmp` (or anywhere else) makes every relative script Deny.
  const cdOwn = (d: string): boolean => { const p = plainPath(d); return p !== null && (inOwn(p) || (/^[\w.@+-]+(\/[\w.@+-]+)*$/.test(p) && !climbsOut(p))); };
  const cdSafe = cdWords(c).every(cdOwn);
  // A variable, `$(...)` or backtick used as a command word is an unknown program: no Allow (it may be an interpreter or
  // a launcher). `$(...)` that survives safeSubst here is not the agent's own git dir or a /tmp mktemp, so it is unread.
  const unknownWord = (w: string): boolean => /^\$\{?[\w@*#?!$(-]|^`/.test(w);
  // A script file written earlier in the same command has content the judge can't read, so running it is not safe: a
  // redirect, `tee`, `cp`/`mv`/`ln`/`install`/`curl -o`/`wget`/`sed -i` naming the file, anywhere before it.
  const written = (p: string): boolean => {
    const n = p.replace(/^.*\//, "");
    const e = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:>\\s*['"]?(?:\\S*/)?${e}(?=$|[\\s;&|'"])|\\b(?:tee|cp|mv|ln|install|touch|sed|dd)\\b[^;&|\\n]*[\\s'"]${e}(?=$|[\\s;&|'"]))`).test(c);
  };
  const scriptOk = (w: string): boolean => {
    // A URL with a scheme (`file:///tmp/x`, `data:...`) is never a plain script file in the checkout (BOS-638, Jane round 2).
    if (/^[A-Za-z][\w+.-]*:/.test(w)) return false;
    const p = plainPath(w);
    if (p === null || p === "" || climbsOut(p) || !PLAIN_WORD.test(w) || /^~/.test(w)) return false;
    if (written(p)) return false;
    if (p.startsWith("/")) return inOwn(p);
    return cdSafe && !/^\/tmp(\/|$)/.test(p);
  };
  // Every span that can start a command: the shell-level segments, plus the inside of each `$(...)`, `(...)`, backtick.
  const spans: string[] = [];
  const walk = (s: string): void => {
    spans.push(s);
    for (const m of s.matchAll(/\$\(([^)]*)\)|\(([^()]*)\)|`([^`]*)`/g)) walk(m[1] ?? m[2] ?? m[3] ?? "");
  };
  // A heredoc body (`cat > f <<'EOF' ... EOF`) is data handed to the writing program, not a set of commands. Take it out
  // before splitting lines into spans, so a body line that happens to look like a command (`npm install`) is not judged
  // as one. The body is still unreadable, so the file it writes stays un-runnable (see `written`/`scriptOk`).
  const bodyless = c.replace(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n[\s\S]*?\n[^\n]*\b\2\b/g, "<<HEREDOC");
  for (const seg of bodyless.split(/&&|\|\||[;&|\n]+/)) walk(seg);
  for (const span of spans) {
    // A command substitution or backtick whose content is not a plain path means a program name or argument the judge
    // cannot read (`$(which node) x`, `n\ode`): no Allow. The inner content is also judged as its own span above.
    for (const m of span.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) if (!/^\s*[A-Za-z0-9_.@%+=:,/?~-]+\s*$/.test(m[1] ?? m[2] ?? "")) return true;
    const words = shellWords(span).filter((w) => w !== "");
    // Strip the prefixes to reach the command word. A NAME=value before an interpreter is an env prefix: not allow-listed.
    let i = 0;
    while (i < words.length && NO_PREFIX.test(words[i]!)) i++;
    if (i >= words.length) continue;
    const prefixed = i > 0 && words.slice(0, i).some((w) => /^\w+=/.test(w));
    const head = base(words[i]!);
    const args = words.slice(i + 1);
    // A variable or substitution as the command word, or after a launcher that starts another program (`xargs`, `env`,
    // `-exec`), is an unknown program: no Allow.
    if (unknownWord(words[i]!)) return true;
    if (LAUNCHER.test(head) && args.some((w) => unknownWord(w) && !/^\w+=/.test(w))) return true;
    // pnpm/npm/pnpx/yarn/bunx exec|run (BOS-378 CEO round 15): `exec`, `dlx`, `x`, `npx`, `pnpx`, `bunx` run the program
    // *after* the verb, so that program is judged as a new command head by the branches below (an interpreter or a /tmp
    // script there is Deny). `run <script>` runs a package.json script: a plain script name, never a path outside.
    const PM = /^(?:pnpm|npm|yarn|bun)$/;
    const PM_EXEC = /^(?:exec|dlx|x|create)$/;
    // A folder flag names the folder the package manager runs in: `-C`, `--dir`, `--prefix`, `--cwd`, `--filter`. The value
    // may be attached with `=`, or written straight after the flag (`-C/tmp/p`, and the long flags' usual abbreviation
    // `--dir/tmp/p`, which pnpm and npm both accept), so match the flag's own ending rather than requiring `=` or the end
    // of the word (BOS-638, Rex round 1: the attached form slipped through).
    const FOLDER_FLAG = /^(?:-C(?=$|[^A-Za-z])|--dir(?=$|=|[^A-Za-z=])|--prefix(?=$|=|[^A-Za-z=])|--cwd(?=$|=|[^A-Za-z=])|--filter(?=$|=|[^A-Za-z=]))/;
    // The folder a folder-flag word names: after `=`, or the rest of the word when it is attached (`-C/tmp/p`), else the
    // next argument.
    const folderOf = (w: string, next: string | undefined): string | undefined => {
      const eq = w.indexOf("=");
      if (eq >= 0) return w.slice(eq + 1);
      const m = /^(?:-C|--dir|--prefix|--cwd|--filter)/.exec(w);
      const tail = m ? w.slice(m[0].length) : "";
      return tail !== "" ? tail : next;
    };
    const attached = (w: string): boolean => {
      const eq = w.indexOf("=");
      if (eq >= 0) return true;
      const m = /^(?:-C|--dir|--prefix|--cwd|--filter)/.exec(w);
      return !!m && w.length > m[0].length;
    };
    const PM_TOOL = head === "npx" || head === "pnpx" || head === "bunx";
    if (PM.test(head) || PM_TOOL) {
      if (prefixed) return true;
      // A package-manager setting that names a file can pick the shell that runs a script or the rc file it reads:
      // `npm run build --script-shell=/tmp/x.sh`, `npm --userconfig=/tmp/rc run build` (BOS-638, Jane round 5, finding 2).
      // The value can come before or after the verb, so scan every argument; a file it names must be a plain in-checkout
      // script. The value may itself be an option with an attached path (`--require=/tmp/x.js`), so look past that prefix.
      // `--node-options`/`--node-arg` are passed to every node process a script starts, so they load code at start. Their
      // value can be a `data:`/`file:` URL that runs inline or /tmp code but is not a path, so the judge can't read it:
      // they get no Allow at all, whatever the value (BOS-638, Jane round 2: the strict option she offered).
      const NODE_OPTIONS = /^--(?:node-options|node-arg)(?:=|$)/;
      const CONFIG_FILE = /^--(?:script-shell|userconfig|globalconfig|config)(?:=|$)/;
      // A URL with a scheme (`data:...`, `file:///tmp/x`) is never a plain file path in the checkout: a setting that names
      // one loads code the judge can't read. Kept here as a guard for the value checks below too.
      const SCHEME = /^[A-Za-z][\w+.-]*:/;
      const valueLeaves = (v: string): boolean => {
        if (SCHEME.test(v)) return true;
        // `--flag=/tmp/x` / `--flag /tmp/x` inside the value: judge the path, not the whole option word.
        const inner = /^--?[\w-]+=(.*)$/.exec(v);
        if (inner) return valueLeaves(inner[1]!);
        // A quoted value (`--node-options="--require=/tmp/x.js"`) keeps its quotes through shellWords; strip them.
        const bare = v.replace(/^['"]|['"]$/g, "");
        if (bare !== v) return valueLeaves(bare);
        return !plainPath(v) || !scriptOk(v);
      };
      for (let k = 0; k < args.length; k++) {
        const w = args[k]!;
        if (NODE_OPTIONS.test(w)) return true; // loads code at start, whatever the value
        if (!CONFIG_FILE.test(w)) continue;
        const v = w.includes("=") ? w.slice(w.indexOf("=") + 1) : args[++k];
        if (v === undefined || valueLeaves(v)) return true;
      }
      // A tool run through a package manager (`pnpm vitest ...`, `npx <tool> ...`) reads files named in its arguments as
      // code or config (`--config /tmp/x.config.ts`, a positional `/tmp/x.test.ts`). The judge can't tell which argument a
      // tool loads, so any argument that leaves the checkout (an absolute path or a `..` climb) gets no Allow
      // (BOS-638, Jane round 5, finding 3: the general rule she asked for, not one per tool).
      // A path leaves the checkout when it is absolute, climbs with `..`, or starts with `~`/`$`/backtick (the shell turns
      // `~` into the home folder and expands a variable to a path the judge can't read) (BOS-638, Rex/Jane round 1).
      const leaves = (w: string): boolean => {
        if (/^(?:~|[\s]*\$|[`])(?:$|[\/{\w])/.test(w)) return true;
        // A URL with a scheme is not a path in the checkout: it can load code the judge can't read (`--config=file:///tmp`).
        if (/^[A-Za-z][\w+.-]*:/.test(w)) return true;
        // A value that is itself an option with an attached path (`--require=/tmp/x.js`, from `--node-options=...`): judge
        // the path it names, not the whole word (BOS-638, Jane round 1, part A).
        const inner = /^--?[\w-]+=(.*)$/.exec(w);
        if (inner) return leaves(inner[1]!);
        const p = plainPath(w);
        return p !== null && (p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p));
      };
      for (let k = 0; k < args.length; k++) {
        const w = args[k]!;
        if (FOLDER_FLAG.test(w)) {
          const d = folderOf(w, args[k + 1]);
          if (d === undefined || !cdOwn(d)) return true;
          if (!attached(w)) k++;
          continue;
        }
        if (w.startsWith("-")) {
          // `--call=<program>` (npx, npm exec) runs the program with any piped text as its code/stdin: a code word there is
          // an executor the judge would have to read (`npx --call=node`) (BOS-638, Jane round 1, part D).
          const call = /^--call=(.*)$/.exec(w) ?? (/^-c$/.test(w) ? [w, args[k + 1] ?? ""] : null);
          if (call && call[1] !== undefined && codeWord(call[1]!)) return true;
          if (w.includes("=") && leaves(w.slice(w.indexOf("=") + 1))) return true;
          continue;
        }
        if (leaves(w)) return true;
      }
      let verb = args[0];
      let rest = args.slice(1);
      if (verb && verb.startsWith("-")) {
        // A folder flag before the verb (`pnpm -C /tmp/p run x`, `npm --prefix /tmp/p run x`): the folder must stay in the
        // checkout. Other pre-verb flags are fine; they don't change what runs. A folder flag may come *after* another flag
        // (`pnpm --silent -C /tmp/p run x`, `npm --silent --prefix /tmp/p run x`), so every pre-verb flag is scanned, not just
        // the first (BOS-638, Jane round 5: only the first was checked, so a later folder flag slipped through).
        let idx = 0;
        let pre = [verb, ...rest];
        while (idx < pre.length && pre[idx]!.startsWith("-")) {
          if (FOLDER_FLAG.test(pre[idx]!)) {
            const d = pre[idx]!.includes("=") ? pre[idx]!.slice(pre[idx]!.indexOf("=") + 1) : pre[idx + 1];
            if (d === undefined || !cdOwn(d)) return true;
            idx += pre[idx]!.includes("=") ? 1 : 2;
          } else {
            idx += 1;
          }
        }
        verb = pre[idx];
        rest = pre.slice(idx + 1);
      }
      if (verb === undefined || verb.startsWith("-")) continue; // `pnpm --version`, `npx --help`: nothing runs code
      if (PM_EXEC.test(verb) || PM_TOOL) {
        // `exec`/`dlx`/`x` run the program *after* the verb; a tool runner (`npx`, `pnpx`, `bunx`) runs the tool that *is*
        // the first word. Rebuild the segment with that program first and judge it as the head below.
        const prog = PM_TOOL ? [verb, ...rest] : rest;
        if (prog.length === 0) continue; // `pnpm exec`/`npx` alone: nothing to run
        if (!prog.every((w) => PLAIN_WORD.test(w) || REDIR.test(w) || /^-{1,2}[\w-]+(=[^\s]*)?$/.test(w))) return true;
        words.splice(0, words.length, ...prog);
        i = 0;
      } else {
        // `run <script>` or a bare `pnpm <script>`: the script name, never a path or an interpreter, and the cd stays in
        // the checkout. A bare form (`pnpm vitest run ...`) has arguments the script reads as data; only its name matters.
        const explicit = verb === "run" || verb === "r";
        if (!explicit) rest = [verb, ...rest];
        if (!cdSafe) return true;
        for (let k = 0; k < rest.length; k++) {
          const w = rest[k]!;
          if (k === 0) {
            // The script name itself: a plain name, never a path, a program, or a value that can't be read.
            if (codeWord(w) || /^[/~]|\.\./.test(w) || w.startsWith("-")) return true;
            if (!explicit) continue; // a bare script name; the rest are its arguments (data)
            if (!PLAIN_WORD.test(w) || w.includes("/") || /^[.]/.test(w)) return true;
            continue;
          }
          if (REDIR.test(w)) continue;
          if (/^(?:-C|--dir|--prefix|--cwd|--filter)(?:=|$)/.test(w)) {
            const d = w.includes("=") ? w.slice(w.indexOf("=") + 1) : null;
            if (d !== null && !cdOwn(d)) return true;
            if (d === null) return true; // the folder is the following word: a path, not a script name
          } else if (w.startsWith("-")) {
            if (!/^-{1,2}[\w-]+(=[^\s]*)?$/.test(w)) return true;
          } else if (!explicit) {
            continue; // a bare form's arguments are data
          } else if (!PLAIN_WORD.test(w)) {
            return true; // a quoted/expanded argument to an explicit `run` can't be read
          }
        }
        continue;
      }
    }
    // After a `pnpm exec <program>` splice, the program is now the head: recompute head/args and judge it as such.
    {
      let j = 0;
      while (j < words.length && NO_PREFIX.test(words[j]!)) j++;
      if (j !== i) i = j;
    }
    const chead = base(words[i]!);
    const cargs = words.slice(i + 1);
    // `make -f <file>` / `make -C <dir>` read a file or a folder; plain `make` runs the local Makefile. A named file or
    // folder must be an in-checkout relative path (BOS-378 CEO round 15).
    if (MAKE.test(chead)) {
      if (i > 0) return true;
      for (let k = 0; k < cargs.length; k++) {
        const w = cargs[k]!;
        const f = /^(?:-f|--file|-C|--directory)(?:=(.*))?$/.exec(w);
        if (f) {
          const p = f[1] !== undefined ? f[1] : cargs[++k];
          if (p === undefined || !scriptOk(p)) return true;
        }
      }
      continue;
    }
    // `source <file>` and `. <file>` run a file in the shell: judge the file like a script.
    if (chead === "source" || chead === ".") {
      if (cargs.length < 1 || !scriptOk(cargs[0]!)) return true;
      continue;
    }
    // node|python3|bash|sh <file>: no prefix, no option before the file, no redirect/pipe, plain words, file in checkout.
    if (INTERP_NAME.test(chead) || SHELL_NAME.test(chead)) {
      if (i > 0 || cargs.length === 0) return true; // an env prefix, or code on stdin
      const va = noOutRedir(cargs);
      if (va.some((w) => /[<>|]/.test(w))) return true; // an input redirect or pipe into the interpreter
      if (va.some((w) => !PLAIN_WORD.test(w) && !/^-{1,2}[\w-]+(=[^\s]*)?$/.test(w))) return true;
      // The runner subcommands (`deno run <file>`, `bun run <file>`, `ts-node <file>`, `tsx <file>`) name a file after the
      // verb. Skip a leading verb, then require a script file in the checkout; a flag first (`-c`, `-e`, `-m`, `-r`) is
      // Deny. Any later word that is a path must also be an in-checkout script (a runner's `--config /tmp/x` can load code).
      const verb = INTERP_VERB.test(va[0] ?? "") ? 1 : 0;
      const file = va[verb];
      if (file === undefined || file.startsWith("-")) return true;
      if (!scriptOk(file)) return true;
      // A code-loading flag after the file can pull in a /tmp module even when the script is in the checkout (node's
      // `--require`/`--loader`/`--import`, a runner's `--config`). Its outside path is Deny; a plain output path is data.
      // Only the separated form (`-r /tmp/x`) can matter today: a flag *before* the file is already denied above
      // (`file.startsWith("-")`), so a flag after the file reaches the script, not node. The attached form
      // (`--require=/tmp/x`) is checked too, in case a flag before the file is ever allowed (BOS-638, Rex round 2).
      if (va.slice(verb + 1).some((w, n, a) => {
        const attached = /^(?:--require|--loader|--import|--experimental-loader|--config)=(.*)$/.exec(w);
        if (attached) return !scriptOk(attached[1]!);
        return /^(?:-r|--require|-l|--loader|--import|--experimental-loader|--config|-c)$/.test(a[n - 1] ?? "") && w.includes("/") && !scriptOk(w);
      })) return true;
      continue;
    }
    // A command word that is a path (`/tmp/x.sh`, `./x.sh`, `../x.sh`, `scripts/x.sh`) runs a file the judge can't read
    // unless it is a plain script inside the agent's own checkout (BOS-378 CEO round 15). Test the whole word: `head` has
    // already been base()'d, so an absolute `/tmp/x.sh` looked like a plain name and slipped through as Allow.
    const cmdWord = words[i]!;
    if (cmdWord.includes("/") && PLAIN_WORD.test(cmdWord)) {
      if (i > 0 || /[<>|]/.test(cmdWord)) return true;
      // An absolute path as the program gets no Allow, even one inside the agent's own checkout (CEO round 15): the judge
      // can't tell what it is from a path alone. Only a plain relative path in the checkout is Allow.
      if (cmdWord.startsWith("/")) return true;
      const va = noOutRedir(cargs);
      if (va.some((w) => /[<>|]/.test(w))) return true;
      if (va.some((w) => !PLAIN_WORD.test(w) && !/^-{1,2}[\w-]+(=[^\s]*)?$/.test(w))) return true;
      if (!scriptOk(cmdWord)) return true;
      continue;
    }
    // Anything else is Deny only when the command word is a shell/interpreter/launcher, or when one is the word after a
    // launcher that starts another program (`-exec`, `-execdir`, `-ok`, xargs, env, …). A plain program whose arguments
    // merely mention `node` (`grep -r node src/`) is left to the other checks.
    if (codeWord(chead)) return true;
    // A `-exec`/`-execdir`/`-ok` program is a command the judge must read: an interpreter/launcher there is Deny, and so is
    // a program given as a path that leaves the checkout (`find . -exec /tmp/x.sh {} ;`) (BOS-638, Jane round 5, finding 4).
    // A path leaves the checkout when it is absolute, climbs with `..`, or starts with `~`/`$`/backtick (the shell expands
    // those to a folder the judge can't read) (BOS-638, Jane round 1, part B: `find . -exec ~/x.sh {} ;`).
    const leavesOut = (w: string): boolean => {
      if (/^(?:~|[\s]*\$|[`])(?:$|[\/{\w])/.test(w)) return true;
      const p = plainPath(w);
      return p !== null && (p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p));
    };
    for (let k = 0; k < cargs.length; k++) {
      const verb = cargs[k]!;
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(verb)) continue;
      const prog = cargs[k + 1] ?? "";
      if (codeWord(prog) || leavesOut(prog)) return true;
      // `-execdir`/`-okdir` run their program from the folder of each file found, so a relative program runs in find's
      // start folder, not the shell's. When a start path before the verb leaves the checkout, that program runs outside it
      // (`find /tmp -execdir ./x.sh {} ;`) (BOS-638, Jane round 1, part C). Flags like `-L` take no path here.
      if (/^-(?:execdir|okdir)$/.test(verb) && !prog.startsWith("/") && !/^(?:~|\$|`)/.test(prog)) {
        if (cargs.slice(0, k).some((w) => !w.startsWith("-") && leavesOut(w))) return true;
      }
    }
    if ((chead === "xargs" || chead === "env") && cargs.some((w) => !w.startsWith("-") && codeWord(w))) return true;
  }
  return false;
}



/**
 * Hides the agent's own memory folder (`.claude/projects/<own project>/memory/...`) from the "shared folder" row.
 * A path that climbs out with `..` is not hidden.
 */
function withoutOwnMemory(command: string, ownProject?: string): string {
  if (!ownProject || !/^[\w.-]+$/.test(ownProject) || ownProject.includes("..")) return command;
  const own = ownProject.replace(/[.]/g, "\\.");
  const prefix = `(?:~|\\$HOME|\\/home\\/[\\w.-]+|\\/root)\\/\\.claude\\/projects\\/${own}\\/memory\\/`;
  if (!new RegExp(prefix).test(command)) return command;
  // Only a plain command qualifies: no `..`, quotes, braces, globs, backslashes, `$` or backticks anywhere; no cd, ln,
  // interpreters, or network tools next to the memory path (they could escape it or send its content out).
  // (A quote, brace or glob right after the path stops the whole-token match below, so it is not scrubbed either.)
  if ((command.match(new RegExp(prefix, "g")) ?? []).length !== 1 || /\.\.|[\\`{}*?]|\$(?!HOME\b)|\$\(|(?<![\w/.-])(cd|pushd|ln|python3?|node|perl|ruby|php|curl|wget|nc|ncat|socat|ssh|scp|rsync|sh|bash|zsh|eval|source)(?![\w/.-])/.test(command)) return command;
  const scrubbed = command.replace(new RegExp(`${prefix}[\\w@+./-]*(?=$|[\\s;&|<>)])`, "g"), "MEMORY_PATH");
  // No second path at all (only /dev/null); anything else (mv x ~/.bashrc) is not plain.
  for (const m of scrubbed.matchAll(/(?:^|[\s=<>])((?:~|\$HOME|\/)[^\s;&|<>)]*)/g)) {
    const t = m[1]!;
    if (t !== "/dev/null") return command;
  }
  // A leftover reference to the memory folder (not matched whole above) means something odd followed it.
  if (new RegExp(prefix).test(scrubbed)) return command;
  return scrubbed;
}

/** Resolves `.` and `..` segments so a path can't climb out of the folder it starts in. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

/** A tool call with no command: judged from the card's text, and unknown tools can't be vouched for. */
function judgeWithoutCommand(question: string, ownFolder?: string, ownProject?: string): JudgeReading {
  if (/\(no name given\)|Change \(no name|Fetch \(no name/.test(question)) return result("noTarget");
  const tool = /Uses the tool "([^"]+)"/.exec(question)?.[1];
  if (tool && !/^mcp__\w+__\w+$/.test(tool)) return result("noTarget");
  const url = /(https?:\/\/[^\s)"']+)/.exec(question)?.[1];
  if (url) {
    try {
      if (isPrivateHost(new URL(url).hostname)) return result("privateNet");
    } catch {
      return result("noTarget");
    }
  }
  if (/\/run\/secrets|\.git-credentials|\.netrc|\/\.ssh\//.test(question)) return result("secret");
  const change = /wants to (change|delete|move)/.test(question);
  const paths = [...question.matchAll(/(\/[\w.@+/-]+)/g)].map((m) => normalizePath(m[1]!.replace(/[.,]+$/, "")));
  if (change && paths.some((p) => /\/\.git\/hooks\b/.test(p))) return result("others");
  if (change && paths.some((p) => WORKSPACE_PATH.test(p) && ownFolder && !p.includes(`/${ownFolder}/`) && !p.endsWith(`/${ownFolder}`))) return result("others");
  const ownMemory = ownProject && /^[\w.-]+$/.test(ownProject) && !ownProject.includes("..") ? new RegExp(`^(?:\\/home\\/[\\w.-]+|\\/root)\\/\\.claude\\/projects\\/${ownProject.replace(/[.]/g, "\\.")}\\/memory\\/.+`) : null;
  if (change && paths.some((p) => /\/\.claude\b/.test(p) && !ownMemory?.test(p))) return result("others");
  if (change && paths.some((p) => !/^\/tmp\//.test(p) && !WORKSPACE_PATH.test(p) && !ownMemory?.test(p))) return result("outside");
  return result("ok");
}

/** The company setting: off, watch (log next to the human's answer only) or advise (sets the suggested button). There is no "act": the judge never answers a card. */
export const PERMISSION_JUDGE_MODES = ["off", "watch", "advise"] as const;
export type PermissionJudgeMode = (typeof PERMISSION_JUDGE_MODES)[number];
