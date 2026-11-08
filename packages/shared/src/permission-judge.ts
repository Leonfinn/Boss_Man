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

/** Longest command the judge reads; longer ones are not judged. */
export const MAX_JUDGED_COMMAND = 10_000;
export const isJudgeable = (command: string | null): boolean => !command || command.length <= MAX_JUDGED_COMMAND;

/**
 * The shells whose `-c` runs a command string and whose script file runs as code (BOS-715). One list, used by the `-c` scan,
 * the interpreter checks and the `xargs <shell> -c` check, so a shell is never caught in one place and missed in another.
 * `busybox sh` reaches the same list through the `busybox` launcher (`busybox sh -c ...`).
 */
export const SHELL_NAMES = "sh bash rbash zsh dash ksh ash mksh fish tcsh csh";
/** A regex alternation of the shell names, longest-first so `ash`/`mksh` are not partly read as `sh`/`ksh`. */
const SHELL_ALT = SHELL_NAMES.split(" ").sort((a, b) => b.length - a.length).join("|");

/**
 * Tools that create, move or delete a file named by their arguments (BOS-715). Given a target the judge can't place, or
 * reading their targets from `xargs` input, they are unread code. `shred` overwrites in place, so it counts as a delete.
 */
const FILE_TOOLS = new Set("rm rmdir shred unlink cp mv ln install touch truncate tee mkdir mkfifo mknod".split(" "));

/**
 * One work budget for the whole `-c` scan of a command, shared by every nesting level (BOS-715, Dougal's timing finding): each
 * shell word found costs the characters from it to the end of the string, so nested or repeated `sh -c` can't multiply the
 * work per level. When it runs out the line can't be placed and gets no Allow (opaque).
 */
type ScanBudget = { left: number };
const SCAN_BUDGET = 250_000;
function chargeScan(budget: ScanBudget, cost: number): boolean {
  budget.left -= cost;
  return budget.left >= 0;
}

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
export function judgePermission(question: string, command: string | null, ownFolder?: string, ownProject?: string, workspaceRoot?: string, depth = 0, budget: ScanBudget = { left: SCAN_BUDGET }): JudgeReading {
  if (!command) return judgeWithoutCommand(question, ownFolder, ownProject);
  // Safety net: callers should skip long commands with isJudgeable and keep the old recommendation.
  if (command.length > MAX_JUDGED_COMMAND) return result("tooLong");
  // Text written to a file by cat/tee is data, not commands: drop those heredoc bodies (interpreter heredocs stay, they run).
  // A quoted word reads as the word it is: quote removal (`"..."`, `'...'`, `$'...'`, `$"..."`, `\-`, backslash-newline)
  // is applied to every plain word before every check below, not only to flags (BOS-715).
  const own0 = withoutOwnMemory(command, ownProject);
  const base = dropCatHeredocBodies(dequoteWords(own0), own0);
  // The command string of each shell `-c` runs too, so `bash -c 'r''m -rf /'`, `bash -c $'\x72m -rf /'` and
  // `sh -c 'echo '$'\x24(cat /tmp/x)'` are all read (BOS-715). It is judged as its own command rather than glued onto the
  // outer line, so its redirects do not change how the outer line is read. A shell nested inside a shell is bounded by
  // `depth`; an unresolved inner string is already caught as opaque, so it is skipped here.
  if (depth < 8) {
    for (const innerCmd of shellDashCInner(base, budget)) {
      // A command string that ends inside a quote (`bash -c 'rm -rf /tmp/a'\'' /etc'` is `rm -rf /tmp/a' /etc`) is read
      // differently by the judge and by bash, so it gets no Allow (BOS-725).
      if (endsInsideQuote(innerCmd)) return result("opaque");
      const r = judgePermission(question, innerCmd, ownFolder, ownProject, workspaceRoot, depth + 1, budget);
      if (r.verdict === "deny") return r;
    }
  }
  const c = base;
  // Opaque: the command string a shell runs for `-c` (in any combined flag, with all of its joined quoted pieces) is
  // unknown when it holds a substitution or a variable the judge can't resolve.
  if (shellDashCOpaque(c, budget)) return result("opaque");
  const ids = [...c.matchAll(WORKSPACE)].map((m) => m[1]!);
  const own = ownFolder ?? LEADING_CD.exec(c)?.[1] ?? [...ids].sort((a, b) => ids.filter((x) => x === b).length - ids.filter((x) => x === a).length)[0];

  // Outward actions.
  if (readPush(c)?.dangerous) return result("outward");
  if (/\bgit\s+push\b[^;&|\n]*(\s-f\b|--force|\s\+\S|:main\b|:master\b|--delete|\s:\S)/.test(c)) return result("outward");
  if (/\b(npm|pnpm|yarn|yarnpkg)\s+publish\b|\bdocker\s+(push|restart|stop|kill|rm|compose|run)\b|\bsystemctl\b|\bservice\s+\w+\s+(restart|stop)|\bgh\s+pr\s+merge\b|\bdeploy(\.sh)?\b[^\n]*\b(prod|production)\b|\bcrontab\b/.test(c)) return result("outward");
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
  if (/\bgit\b[^;&|\n]*\bconfig\b[^;&|\n]*(--(global|system|file|worktree|blob)\b|\s-f\S*)|\bGIT_CONFIG\w*=|\b(npm|pnpm|yarn|yarnpkg)\s+(config|c)\s+(set|delete|edit|rm)\b|\bnpm\s+set\b|\b(npm|pnpm|yarn|yarnpkg)\b[^;&|\n]*\s(-g|--global|--location[= ]global)\b|\byarn(?:pkg)?(?:\.\w+)?\b[^;&|\n]*\sglobal(?=\s|$)/.test(c)) return result("outside");
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
  if (gitDenied(c, (d) => dirOk(d, inOwn), writeOk)) return result("outside");
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
  // Inline code in an interpreter can write anywhere; it is read only when it provably touches no outside path.
  if (!inlineCodeOk(c, writeOk) || runsUnreadFile(c, inOwn) || runsByPathOutside(cs2, inOwn) || usesScratchUnsafely(c)) return result("outside");
  // A tool run through pnpm/npm/yarn/npx, or a find -exec program, that names a path leaving the checkout runs code or reads
  // config the judge can't see (BOS-638, Jane's round-5 findings for BOS-378): the program word and any folder flag are
  // judged wherever they appear among the flags.
  if (toolingOrExecLeaves(c, inOwn)) return result("outside");
  if (writeTargets.some((t) => !writeOk(t))) return result("outside");
  // A redirect (or any write) after a `cd`/`pushd` somewhere else lands there: `pushd /home/node; echo x >> .bashrc`.
  const hasRedirect = />/.test(forTargets.replace(/\d*>>?\s*\/dev\/null|\d*>&\d|&>\s*\/dev\/null/g, ""));
  if (hasRedirect) for (const m of c.matchAll(/\b(?:cd|pushd|chdir)(?=[\s;&|)]|$)(?:\s+(?:--\s+)?['"]?([^\s;&|'")]*))?/g)) if (!dirOk(m[1] ?? "", inOwn)) return result("outside");
  const writes = /^(changes|deletes|unknown)$/.test(explainCommand(c).effect) || /rmSync|unlinkSync|writeFileSync|shutil\.rmtree|os\.remove|reset\s+--hard/.test(c) || new RegExp(DESTRUCTIVE, "i").test(c);
  if (writes) {
    for (const id of ids) if (own && id !== own && new RegExp(`(rm|rmSync|shred|unlink|mv|reset|>|tee|cp)[^;&|\\n]*${id}`).test(c)) return result("outside");
    for (const m of c.matchAll(/\bcd\s+(?:\/[\w.@+-]+)*\/workspaces\/(?:tickets|reviews)\/([0-9a-f-]{36})/g)) if (own && m[1] !== own) return result("outside");
    // Every target a delete tool names must be in /tmp or the checkout, not only the first: `rm -rf /tmp/a /etc` is as bad
    // as `rm -rf /etc` (BOS-715). The text is already dequoted, so `$'/etc'`, `\/etc` and `/e"tc"` read as `/etc`.
    for (const m of c.matchAll(/(?:\b(?:rm|rmdir|shred|unlink)\b|rmSync\(|rmtree\(|unlinkSync\()([^;&|\n]*)/g)) {
      for (const tok of shellWords(m[1]!)) {
        if (tok === "" || tok.startsWith("-")) continue;
        const p = tok.replace(/^['"]|['"]$/g, "");
        if (p.startsWith("~") || p.startsWith("$HOME") || p.startsWith("/")) {
          if (!/^\/tmp\//.test(p) && !inOwn(p) && p !== "/dev/null") return result("outside");
        }
      }
    }
    // A relative target can climb out of the folder (`rm -rf ..`), and a `cd` somewhere else makes every relative target land there.
    for (const m of c.matchAll(/\b(?:rm|rmdir|shred|unlink)\b([^;&|\n]*)/g)) if (/(^|[\s'"=/])\.\.(?=$|[\s'"/;|&)])/.test(m[1]!)) return result("outside");
    // An unresolved substitution or variable given to a file tool (`rm -rf $(curl ...)`, `cp $(cat /tmp/l) d`) is a target
    // the judge can't place, so it gets no Allow. `shred` and any file tool under `xargs` read their targets the same way, and a
    // substitution glued to a dash (`rm -$(cat /tmp/x)`) is unseen unless the dash word is tested too (BOS-715).
    // A heredoc piped into `xargs <file tool>` makes the heredoc body the target list (`cat <<EOF | xargs rm -rf`, BOS-727).
    for (const m of c.matchAll(/<<-?[ \t]*['"]?\w+['"]?[^\n]*?\|[ \t]*xargs\b([^;&|\n]*)/g)) if (shellWords(m[1]!).some((w) => FILE_TOOLS.has(w))) return result("outside");
    // One greedy, non-overlapping capture per tool keeps the scan linear (BOS-729: re-slicing the rest of the line for every
    // match was O(n²)). `xargs` appends its input to the command, so a file tool under it deletes or overwrites names the judge
    // never sees (`echo /etc | xargs rm -rf`, `find / | xargs shred`): no Allow.
    for (const m of c.matchAll(/\b(?:rm|rmdir|cp|mv|install|ln|shred|unlink|xargs)\b([^;&|\n]*)/g)) {
      const rest = m[1]!;
      if (/<\(/.test(rest)) return result("outside"); // a process substitution is a path the judge can't place
      if (hasBraceExpansion(rest)) return result("outside"); // `rm -rf /tmp/a {/etc,/tmp/b}` is several paths (BOS-725)
      const words = shellWords(rest);
      if (m[0].startsWith("xargs") && words.some((w) => FILE_TOOLS.has(w.replace(/^.*\//, "")))) return result("outside");
      for (const tok of words) if (tok !== "" && hasUnresolvedExpansion(tok)) return result("outside");
    }
    for (const m of c.matchAll(/\b(?:cd|pushd|chdir)(?=[\s;&|)]|$)(?:\s+(?:--\s+)?['"]?([^\s;&|'")]*))?/g)) if (!dirOk(m[1] ?? "", inOwn)) return result("outside");
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

/** True when a quote opened in `s` is never closed (a linear scan; a backslash escapes outside `'...'`). */
function endsInsideQuote(s: string): boolean {
  let q = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q === "'") { if (ch === "'") q = ""; continue; }
    if (ch === "\\") { i++; continue; }
    if (q === '"') { if (ch === '"') q = ""; continue; }
    if (ch === "'" || ch === '"') q = ch;
  }
  return q !== "";
}

/**
 * True when a word holds an unquoted brace expansion (`{a,b}`, `{1..3}`): bash turns it into several words, so a target that
 * uses one is a set of paths the judge can't place (BOS-725). Quoted braces are literal.
 */
function hasBraceExpansion(s: string): boolean {
  let q = "";
  let open = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q === "'") { if (ch === "'") q = ""; continue; }
    if (ch === "\\") { i++; continue; }
    if (q === '"') { if (ch === '"') q = ""; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === "{") open = i;
    else if (ch === "}" && open >= 0) { if (/,|\.\./.test(s.slice(open + 1, i))) return true; open = -1; }
  }
  return false;
}

/**
 * The escapes bash decodes inside `$'...'` (ANSI-C quoting): `\xHH`, `\NNN`, `\uHHHH`, `\UHHHHHHHH`, the single-letter
 * escapes (`\n`, `\t`, ...) and a backslash before anything else, which bash leaves in place. `\cX` follows bash in stopping
 * the rest of the string; here the two characters are kept so a caller that only wants the word's shape still sees them.
 */
function decodeAnsiC(s: string): string {
  const simple: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== "\\" || i + 1 >= s.length) { out += ch; continue; }
    const n = s[i + 1]!;
    if (n in simple) { out += simple[n]!; i++; continue; }
    if (/[0-7]/.test(n)) { let m = s.slice(i + 1, i + 4); m = m.slice(0, m.match(/^[0-7]+/)![0].length); out += String.fromCharCode(parseInt(m, 8) & 0xff); i += m.length; continue; }
    if (n === "x") { const m = (s.slice(i + 2).match(/^[0-9a-fA-F]{1,2}/) ?? [""])[0]; out += m ? String.fromCharCode(parseInt(m, 16)) : "\\x"; i += 1 + m.length; continue; }
    if (n === "u" || n === "U") { const len = n === "u" ? 4 : 8; const m = (s.slice(i + 2).match(new RegExp(`^[0-9a-fA-F]{1,${len}}`)) ?? [""])[0]; if (m) { out += String.fromCodePoint(parseInt(m, 16)); i += 1 + m.length; } else { out += "\\" + n; i++; } continue; }
    if (n === "c") { out += s.slice(i + 2); break; }
    out += "\\" + n; i++;
  }
  return out;
}

/**
 * Bash's quote removal for one word: `"..."`, `'...'`, `$'...'` and backslash escapes all go. Returns null when the word
 * holds a substitution (`$(`, a backtick) or a variable the judge can't resolve, so its value is not a plain literal.
 */
function dequoteWord(w: string): string | null {
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const ch = w[i]!;
    // A backslash before a newline is a line continuation: bash drops both, joining the text either side (BOS-715).
    if (ch === "\\" && w[i + 1] === "\n") { i++; continue; }
    if (ch === "\\" && i + 1 < w.length) { out += w[++i]!; continue; }
    if (ch === "$" && w[i + 1] === "'") {
      const e = w.indexOf("'", i + 2);
      if (e < 0) return null;
      out += decodeAnsiC(w.slice(i + 2, e));
      i = e;
      continue;
    }
    if (ch === "'") { const e = w.indexOf("'", i + 1); if (e < 0) return null; out += w.slice(i + 1, e); i = e; continue; }
    // `$"..."` is bash's locale quoting: after quote removal it is the same as `"..."` (BOS-715, Jane). Read it as a
    // double-quoted piece from its opening quote, so the closing quote pairs with it.
    if (ch === "$" && w[i + 1] === '"') {
      let j = i + 2;
      for (; j < w.length && w[j] !== '"'; j++) { if (w[j] === "\\" && j + 1 < w.length) out += w[++j]!; else out += w[j]!; }
      if (j >= w.length) return null;
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < w.length && w[j] !== '"'; j++) { if (w[j] === "\\" && j + 1 < w.length) out += w[++j]!; else out += w[j]!; }
      if (j >= w.length) return null;
      i = j;
      continue;
    }
    if (ch === "$" || ch === "\x60") return null; // a substitution or a variable: not a plain literal
    out += ch;
  }
  return out;
}

/**
 * Drops the quoting from every word the shell reads as a plain literal, so an option or a target reads as it really is
 * (`rm "-rf" /`, `rm $'-rf' /`, `rm \-rf /` are all `rm -rf /`; `rm /e"tc"`, `rm \/etc` and `rm $'/'` are `rm /etc` and
 * `rm /`). A word is rewritten only when quote removal leaves a plain literal with no space or shell metacharacter, so data
 * such as `echo 'a b'` is left alone. Each word keeps its place among the others.
 *
 * A word starts at the beginning of the string or after a space, `;`, `&`, `|` or `(`, and ends at the end of the string or
 * before a space, `;`, `&`, `|` or `)`. The scan is linear (BOS-697): an overlapping regex here backtracked exponentially on
 * a run of backslash-escaped or `$'...'` atoms that never closes, and the server runs the judge synchronously.
 */
function dequoteWords(s: string): string {
  // A word character is anything but whitespace, a shell word separator (`;`, `&`, `|`, `(`, `)`) or a quote; a quote
  // opens a quoted piece of the current word, so it is read together with the word.
  const separator = (ch: string): boolean => /[\s;&|()]/.test(ch);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    // Copy a separator or whitespace as it is; a quote begins a word.
    if (ch !== "'" && ch !== '"' && separator(ch)) { out += ch; i++; continue; }
    // Read one word: a run of plain characters and quoted/escaped pieces, stopping at a separator.
    const start = i;
    while (i < s.length) {
      const c = s[i]!;
      if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue; }
      if (c === '"') { let j = i + 1; while (j < s.length && s[j] !== '"') { if (s[j] === "\\" && j + 1 < s.length) j++; j++; } i = j < s.length ? j + 1 : s.length; continue; }
      if (c === "\\" && i + 1 < s.length) { i += 2; continue; }
      if (separator(c)) break;
      i++;
    }
    const w = s.slice(start, i);
    const d = /["'\\]/.test(w) ? dequoteWord(w) : null; // no quoting to remove: keep the word as it is
    // A word that quote removal turns into a plain literal (no space, no shell metacharacter, no variable) is rewritten to
    // what the shell reads: an option is the same option, and a target (`\/etc`, `/e"tc"`, `$'/'`) is the same path
    // (BOS-715). A word with a space or a metacharacter stays quoted, so data is not split or joined, and a `#` stays
    // quoted so `echo '#!...'` does not turn into a mid-line shell comment that hides the commands after it.
    // A backslash left in the result also keeps the word quoted: bare, `\` plus the next space reads as an escaped space and
    // the word swallows the next argument (`/tmp/a'\' /etc` -> `/tmp/a\ /etc`, BOS-725).
    out += d !== null && !/[\s;&|()<>"'\x60$*?[{#\\]/.test(d) ? d : w;
  }
  return out;
}

/**
 * True when a word holds a shell expansion that can carry text the judge can't read: a substitution (`$(`, a backtick), a
 * named variable (any `$name` or `${...}`), a positional parameter (`$0`-`$9`), or `$@` / `$*`. Plain data and status
 * expansions are not counted: `$'...'` is a literal after quote removal, and `$?`, `$#`, `$$`, `$!`, `$-` are numbers or
 * flags that can never hold a command string (BOS-697 round 2).
 */
function hasUnresolvedExpansion(w: string): boolean {
  return w.includes("\x60") || /\$(?!['?#$!-])/.test(w);
}

/** True when the arguments of one git command (words after `git`) are not on the allow-list. `dirOk` places a folder git is pointed at. */
function gitArgsDenied(args: string[], dirOk: (p: string) => boolean, pathOk: (p: string) => boolean): boolean {
  let i = 0;
  // Where git runs: -C, --git-dir and --work-tree get the same own-folder test as `cd`.
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C") { if (i + 1 >= args.length || !dirOk(args[++i]!)) return true; continue; }
    if (/^--(?:git-dir|work-tree)$/.test(a)) { if (i + 1 >= args.length || !dirOk(args[++i]!)) return true; continue; }
    const eq = /^--(?:git-dir|work-tree)=(.*)$/.exec(a);
    if (eq) { if (!dirOk(eq[1]!)) return true; continue; }
    if (a === "--no-pager" || a === "--no-optional-locks") continue;
    break;
  }
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
  // A `::` transport (`ext::sh -c ...`, `fd::3`) runs an arbitrary program whatever the subcommand: BOS-701 restored this for
  // every remote-taking subcommand, not just `clone` (BOS-378 checked only `clone`, so `fetch`/`ls-remote`/`pull` slipped).
  const REMOTE_SUB = /^(?:clone|fetch|pull|push|ls-remote|remote|submodule|archive|bundle|ls-tree|cat-file|show|diff)$/;
  for (const p of plain) {
    if (/::/.test(p) && sub !== undefined && REMOTE_SUB.test(sub)) return true;
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
function gitDenied(c: string, dirOk: (p: string) => boolean, pathOk: (p: string) => boolean): boolean {
  // Environment that makes git run a program or move it (GIT_DIR, GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_PAGER, ...), set anywhere on a line that uses git.
  if (/\bgit\b/.test(c) && /(?:^|[\s;&|(])(?:export\s+|env\s+|declare\s+(?:-x\s+)?)?(?:GIT_\w+|PAGER|EDITOR|VISUAL|SSH_ASKPASS|LESSOPEN|LD_\w+)\+?=/.test(c)) return true;
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
      if (GIT_READ.test(raw)) continue;
      // No substitution, variable or backtick anywhere in a git command, quoted or not: it can't be read.
      if (/[$\x60]/.test(i === 0 ? seg : raw)) return true;
      if (gitArgsDenied(words.slice(k + 1), dirOk, pathOk)) return true;
    }
  }
  return false;
}

/** Where a `cd` / `pushd` may go: /tmp, the own folder, or a sub-folder of where it already is. */
function dirOk(dir: string, inOwn: (p: string) => boolean): boolean {
  if (dir === "" || dir === "-") return false; // a bare `cd` goes to $HOME, `cd -` to OLDPWD: both unknown
  if (/^\/tmp(\/|$)/.test(dir) && !dir.includes("..")) return true;
  if (inOwn(dir)) return true;
  return /^[\w.@+-]+(\/[\w.@+-]+)*$/.test(dir) && !dir.includes(".."); // a sub-folder of where it already is
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
 * True when a command word is a variable, `$(...)` or backtick (an unknown program) and it is given code: a -c/-e/-r/-E/-p
 * option, `-` or a heredoc anywhere in its segment, or it receives a pipe. The command word is found after assignment
 * prefixes and wrappers (exec, command, env, timeout, nice, xargs, then, do, `{`, `(`...). Linear: one pass over the words.
 */
function variableCommandWord(c: string, inner = false): boolean {
  // Second pass: the text inside every `$(...)`, `(...)` and backtick is read as its own segment, whatever the outer command is.
  if (!inner && variableCommandWord(c.replace(/\$\(|[()\x60]/g, ";"), true)) return true;
  const parts = c.split(/(\|&|&&|\|\||[;&|\n])/);
  const safeHead = /^(?:echo|printf|ls|cat|cd|test|\[|rm|cp|mv|mkdir|touch|for|read|export|local|unset|git|pnpm|npm)$/;
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i]!;
    const words = (seg.match(/(?:'[^']*'|"[^"]*"|\\.|[^\s'"\\])+/g) ?? []).map((w) => w.replace(/['"\\]/g, "").replace(/^[({]+(?=.)/, ""));
    let k = 0;
    while (k < words.length && /^\w+=/.test(words[k]!)) k++;
    const head = words[k];
    // A variable word anywhere in the segment is an unknown program unless the segment starts with a known command
    // that merely takes it as an argument.
    if (head === undefined || safeHead.test(head)) continue;
    const at = words.findIndex((w, j) => j >= k && /^\$\{?[A-Za-z_]\w*\}?$|^\$[\d@*#?!$({]|^\x60/.test(w));
    if (at < 0) continue;
    const piped = i >= 2 && (parts[i - 1] === "|" || parts[i - 1] === "|&");
    // Any option, a redirect or heredoc into it, or a pipe: deny. Over-denial is fine.
    if (piped || /</.test(seg) || words.slice(at + 1).some((t) => t.startsWith("-"))) return true;
  }
  return false;
}

/**
 * True when an interpreter or shell runs code the judge can't read: a script file that is in /tmp, outside the agent's own
 * folder, named by a variable, `~` or `..`, or written earlier in the same command; or code that arrives on stdin from a file,
 * a process substitution or a pipe other than echo/printf. Checked-in scripts in the agent's own folder (`node scripts/x.js`)
 * are fine. Allow-list: anything not recognised as such a script is true (Deny).
 */
function runsUnreadFile(c: string, inOwn: (p: string) => boolean): boolean {
  const interp = "python[\\d.]*|node(?:js)?|perl|ruby|php|lua|deno|bun|Rscript|tclsh|g?awk|mawk|sh|bash|zsh|dash|ksh";
  // Only where a command word stands: at the start, after a separator, `then`/`do`, or a wrapper (env, nohup, timeout N, ...).
  const wrap = "(?:\\b(?:then|do|else|exec|env|nohup|time|sudo|xargs|command|nice|setsid|stdbuf)\\s+|\\btimeout\\s+)";
  const re = new RegExp(`(?:^|[;&|(\\n{]\\s*|${wrap})(?:(?:-\\S+|\\d+\\w*|\\w+=\\S*)\\s+)*(?:[\\w./-]*/)?(${interp})(?![\\w./-])((?:[^;&|\\n'"]|'[^']*'|"[^"]*")*)`, "g");
  const unq = (t: string): string => t.replace(/^['"]+|['"]+$/g, "");
  const risky = (p: string, relOk: boolean): boolean => {
    p = unq(p);
    if (p === "" || p === "-") return false;
    if (/\$|\x60|^~|\.\./.test(p) || /^\/tmp(\/|$)/.test(p)) return true;
    if (p.startsWith("/")) return !inOwn(p);
    return !relOk;
  };
  const writeOp = />|\btee\b|\bcp\b|\bmv\b|\bln\b|\binstall\b|\bdd\b|\bcurl\b|\bwget\b|\btouch\b|\bsed\b|\bpatch\b|\bgit\b[^;&|\n]*?\s(?:apply|checkout|restore|am)\b|\bunzip\b|\btar\b/;
  // A relative path lands wherever the last `cd` went.
  let relOk = true;
  for (const m of c.matchAll(/\b(?:cd|pushd|chdir)(?=[\s;&|)]|$)(?:\s+(?:--\s+)?['"]?([^\s;&|'")]*))?/g)) {
    const d = m[1] ?? "";
    if (!dirOk(d, inOwn) || (/^[/~$]/.test(d) && !inOwn(d))) relOk = false;
  }
  const writtenElsewhere = (p: string, at: number, len: number): boolean => {
    const rest = c.slice(0, at) + " " + c.slice(at + len);
    const base = unq(p).replace(/^.*\//, "");
    return writeOp.test(rest) && (rest.includes(unq(p)) || (base !== "" && rest.includes(base)));
  };
  // `source x` / `. x` runs a file in the shell.
  for (const m of c.matchAll(/(?:^|[;&|(\n]\s*)(?:source|\.)\s+(\S+)/g)) if (risky(m[1]!, relOk) || writtenElsewhere(m[1]!, m.index!, m[0]!.length)) return true;
  for (const m of c.matchAll(re)) {
    const name = m[1]!;
    const args = m[2]!;
    const toks: string[] = args.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    const awk =/awk$/.test(name);
    // Inline code (-c / -e ...) is read by inlineCodeOk; an awk program is inline unless it has -f.
    let inline = awk && !toks.includes("-f");
    for (const t of toks) {
      if (!t.startsWith("-") || t === "-") break;
      // `-r` is a module to preload for node and ruby, not code.
      if (/^-[A-Za-z]*[ceEp]$/.test(t) || (/^-[A-Za-z]*r$/.test(t) && /^(?:php|Rscript|lua)$/.test(name)) || /^--(?:eval|command|print)\b/.test(t)) { inline = true; break; }
    }
    if (inline) continue;
    // Words that name the script: everything up to the first one that looks like a script file, else all of them.
    // Redirect targets (`> file`, `2> file`) are not the script.
    const words = toks.filter((t, i) => !/^<|^>|^\d*>/.test(t) && !/^\d*>>?$|^&>$/.test(toks[i - 1] ?? ""));
    const extAt = words.findIndex((t) => /\.(?:[cm]?js|ts|py|pl|rb|php|lua|a?sh|bash|R|awk)['"]?$/i.test(t));
    const named = (extAt >= 0 ? words.slice(0, extAt + 1) : words).filter((t) => t !== "-");
    const candidates = named.flatMap((t) => (t.startsWith("-") ? (t.includes("=") ? [t.slice(t.indexOf("=") + 1)] : []) : [t]));
    const hasScript = named.some((t) => !t.startsWith("-"));
    if (/<\(/.test(args)) return true;
    for (const p of candidates) if (risky(p, relOk) || writtenElsewhere(p, m.index!, m[0]!.length)) return true;
    if (hasScript) continue;
    // No script file: the code comes from stdin.
    for (const r of args.matchAll(/(?<![<\d])<(?![<(])\s*(\S+)/g)) if (risky(r[1]!, relOk) || writtenElsewhere(r[1]!, m.index!, m[0]!.length)) return true;
    const before = c.slice(0, m.index!).replace(/(?:\b(?:env|exec|command|nohup|time|sudo|xargs|timeout\s+\d+\w*)\s+|\w+=\S*\s+)*$/, "");
    if (/^\|/.test(m[0]!) || /\|&?\s*$/.test(before)) {
      const prev = before.replace(/\|&?\s*$/, "").split(/&&|\|\||[;&|\n]/).pop() ?? "";
      if (!/^\s*(?:echo|printf)\s/.test(prev) || /\$\(|\x60|</.test(prev)) return true;
    }
  }
  return false;
}

/**
 * BOS-721 (CEO decision on BOS-720 item 4): a program run by its own path (`./foo.js`, `.yarn/releases/yarn-1.22.22.cjs`,
 * `/tmp/x/run.sh`, `cd /tmp/p && ./foo`) is code the judge hasn't read. When the file resolves outside the agent's own checkout
 * the command gets no Allow, whatever the file is called. Inside the checkout nothing changes (`scripts/check-quick.sh`,
 * `./node_modules/.bin/vitest`). Allow-list: the path counts as inside only when it is absolute under the own folder, or relative
 * with every `cd` staying inside it; `$`, `~` and `..` are unknown, so they are outside. The only outside paths let through are
 * system binaries one level under /bin, /usr/bin, /usr/local/bin, /sbin, /usr/sbin (the image's own tools, not agent-writable).
 * Linear: one pass over the shell words of each segment.
 */
function runsByPathOutside(c: string, inOwn: (p: string) => boolean, startRelOk = true): boolean {
  let relOk = startRelOk;
  let relCd = false;
  for (const m of c.matchAll(/\b(?:cd|pushd|chdir)(?=[\s;&|)]|$)(?:\s+(?:--\s+)?['"]?([^\s;&|'")]*))?/g)) {
    const d = m[1] ?? "";
    if (!dirOk(d, inOwn) || (/^[/~$]/.test(d) && !inOwn(d))) relOk = false;
    if (d !== "" && !/^[/~$]/.test(d)) relCd = true;
  }
  // BOS-722: a relative `cd` may follow a symlink the same command made (`ln -s /tmp/p l && cd l`), so it is outside.
  if (relCd && /(?:^|[;&|(\n{]\s*|\b(?:then|do|else)\s+)(?:\S*\/)?ln(?=\s)/.test(c)) relOk = false;
  const wrapper = /^(?:then|do|else|elif|if|while|until|coproc|eval|builtin|\{|!|exec|env|nohup|time|sudo|command|nice|setsid|stdbuf|timeout|xargs|ionice|flock|watch|strace|ltrace|taskset|chrt|script|unshare|setpriv|nsenter|chroot|doas)$/;
  // Wrappers whose first plain words are not the command (`flock l ./foo`, `taskset 1 ./foo`, `chroot dir ./foo`).
  const positional: Record<string, number> = { flock: 1, taskset: 1, chrt: 1, chroot: 1 };
  // Wrappers that run the string after `-c` / `--command` (`flock -c ./foo l`, `script -qc ./foo`) as a shell command.
  const cmdOpt = /^(?:flock|script)$/;
  const sysBin = /^\/(?:usr\/(?:local\/)?)?s?bin\/[\w.+-]+$/;
  // Short options of each wrapper that take a value in the next word (`env -P /bin`, `timeout -s KILL`, `nice -n 5`). Any other
  // option is value-less, so the word after it is still the command.
  const takesValue: Record<string, RegExp> = {
    env: /^-[A-Za-z]*[CPSua]$|^--(?:chdir|split-string|unset|argv0)$/,
    timeout: /^-[A-Za-z]*[sk]$|^--(?:signal|kill-after)$/,
    nice: /^-[A-Za-z]*n$|^--adjustment$/,
    stdbuf: /^-[A-Za-z]*[ioe]$|^--(?:input|output|error)$/,
    sudo: /^-[A-Za-z]*[ugCDhprRTU]$/,
    xargs: /^-[A-Za-z]*[nIdPLEsa]$/,
    exec: /^-[A-Za-z]*a$/,
    ionice: /^-[A-Za-z]*[cnp]$|^--(?:class|classdata|pid)$/,
    flock: /^-[A-Za-z]*[wE]$|^--(?:timeout|conflict-exit-code)$/,
    watch: /^-[A-Za-z]*n$|^--interval$/,
    strace: /^-[A-Za-z]*[oeEpsuabIOPSXyYZ]$/,
    ltrace: /^-[A-Za-z]*[oeEpsuabnlLxAF]$/,
    chrt: /^-[A-Za-z]*[p]$/,
    script: /^-[A-Za-z]*[TIOBEt]$|^--(?:timing|log-in|log-out|log-io|logging-format|echo|output-limit)$/,
    unshare: /^-[A-Za-z]*[R]$|^--(?:root|wd|map-user|map-group|setgroups|propagation)$/,
    setpriv: /^--(?:reuid|regid|ruid|rgid|euid|egid|groups|inh-caps|bounding-set|ambient-caps|securebits|selinux-label|apparmor-profile)$/,
    nsenter: /^-[A-Za-z]*[tSGrw]$/,
    doas: /^-[A-Za-z]*[uC]$/,
  };
  // The first real command word of each segment, plus the program after `find -exec`, is checked.
  const bad = (w: string): boolean => {
    if (!w.includes("/") || sysBin.test(w)) return false;
    if (/\$|\x60|^~|\.\./.test(w) || /^\/tmp(\/|$)/.test(w)) return true;
    return w.startsWith("/") ? !inOwn(w) : !relOk;
  };
  // The first real command word of a word list, after wrappers, their options and assignments, is checked.
  const firstWordBad = (words: string[]): boolean => {
    let skipNext = false;
    let cmdNext = false;
    let lead = "";
    let pos = 0;
    for (const w of words) {
      if (cmdNext) { if (runsByPathOutside(w, inOwn, relOk)) return true; break; }
      if (skipNext) { skipNext = false; continue; }
      // A system binary that runs its argument counts as that wrapper (`/usr/bin/env ./foo`).
      const base = sysBin.test(w) ? w.replace(/^.*\//, "") : w;
      // Skip assignment prefixes, wrapper words, their options and numeric arguments (`timeout 5`, `nice -n 5`).
      if (wrapper.test(base)) { lead = base; pos = positional[base] ?? 0; continue; }
      if (/^-/.test(w)) {
        if (cmdOpt.test(lead) && /^-[A-Za-z]*c$|^--command$/.test(w)) cmdNext = true;
        else if (cmdOpt.test(lead) && /^--command=/.test(w)) { if (runsByPathOutside(w.slice(10), inOwn, relOk)) return true; }
        else if (takesValue[lead]?.test(w)) skipNext = true;
        continue;
      }
      if (pos > 0) { pos--; continue; }
      if (/^\w+=/.test(w) || /^\d+[smhd]?$/.test(w)) continue;
      if (bad(w)) return true;
      break; // the first real command word of the segment
    }
    return false;
  };
  for (const seg of shellSegments(c)) {
    // BOS-723: the program after `find -exec` may sit behind a wrapper (`-exec env ./foo`, `-exec timeout 5 ./foo`): scan the words
    // up to the `;` / `+` that ends the -exec with the same wrapper-aware scan. Each word is visited once per scan.
    for (let i = 0; i < seg.words.length; i++) {
      const w = seg.words[i]!;
      if (w !== "-exec" && w !== "-execdir" && w !== "-ok" && w !== "-okdir") continue;
      let end = i + 1;
      // A following -exec starts its own slice, so the slices never overlap and the total work stays linear.
      // BOS-724: find ends -exec at `+` only when the word right before it is `{}`; any other `+` is a plain argument (`env -u +`).
      while (
        end < seg.words.length &&
        !/^(?:;|-exec|-execdir|-ok|-okdir)$/.test(seg.words[end]!) &&
        !(seg.words[end] === "+" && seg.words[end - 1] === "{}" && end - 1 > i)
      ) end++;
      if (firstWordBad(seg.words.slice(i + 1, end))) return true;
    }
    if (firstWordBad(seg.words)) return true;
  }
  return false;
}

/**
 * Splits a command into segments of words the way a shell would (quotes, backslashes, `$(`, backticks, `(`, `;&|`, newlines,
 * heredoc bodies and comments), so a quoted or escaped command word (`"node"`, `n\ode`) reads as the word it runs.
 * Redirects are lifted out: `out` holds output targets, and input targets stay as plain words. Over-splitting is fine.
 */
function shellSegments(c: string, bad?: { v: boolean }): { words: string[]; out: string[] }[] {
  const segs: { words: string[]; out: string[] }[] = [];
  let words: string[] = [];
  let out: string[] = [];
  let cur = "";
  let has = false;
  let redir: "out" | "in" | null = null;
  const modes: ("dq" | "sub")[] = [];
  const pendingTags: string[] = [];
  const endWord = (): void => {
    if (!has) return;
    if (redir === "out") out.push(cur);
    else words.push(cur);
    redir = null;
    cur = "";
    has = false;
  };
  const endSeg = (): void => {
    endWord();
    redir = null;
    if (words.length || out.length) segs.push({ words, out });
    words = [];
    out = [];
  };
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    const dq = modes[modes.length - 1] === "dq";
    if (ch === "\\") { cur += c[++i] ?? ""; has = true; continue; }
    if (!dq && ch === "'") {
      const e = c.indexOf("'", i + 1);
      cur += c.slice(i + 1, e < 0 ? c.length : e);
      has = true;
      i = e < 0 ? c.length : e;
      continue;
    }
    if (ch === '"') { if (dq) modes.pop(); else modes.push("dq"); has = true; continue; }
    if (ch === "`") { endSeg(); continue; }
    // Arithmetic `$((1<<2))` / `((x<<2))` is not a command or a heredoc: skip to the matching `))` when it holds no substitution.
    if ((ch === "$" && c[i + 1] === "(" && c[i + 2] === "(") || (ch === "(" && c[i + 1] === "(" && !has && !words.length)) {
      const start = ch === "$" ? i + 3 : i + 2;
      let depth = 2;
      let j = start;
      for (; j < c.length && depth > 0; j++) { if (c[j] === "(") depth++; else if (c[j] === ")") depth--; }
      const body = c.slice(start, j);
      if (depth === 0 && !/\$\(|\x60/.test(body)) { cur += "ARITH"; has = true; i = j - 1; continue; }
      if (depth !== 0 && bad) bad.v = true;
    }
    if (ch === "$" && c[i + 1] === "(") { endSeg(); modes.push("sub"); i++; continue; }
    // Inside double quotes a space or newline belongs to the word (`bash -c "python3 c.py"` is one inner command, not two words).
    if (dq) { cur += ch; has = true; continue; }
    if (ch === "#" && !has) { while (i < c.length && c[i] !== "\n") i++; i--; continue; }
    if (ch === ")") { endSeg(); if (modes[modes.length - 1] === "sub") modes.pop(); continue; }
    if (ch === "(" || ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && c[i + 1] !== ">")) {
      endSeg();
      if (ch === "\n") {
        for (const tag of pendingTags.splice(0)) {
          let j = i + 1;
          for (;;) {
            let e = c.indexOf("\n", j);
            if (e < 0) e = c.length;
            const found = c.slice(j, e).trim() === tag;
            j = e + 1;
            if (found) break;
            if (e >= c.length) break; // no terminator line: the shell reads to the end of the command as the body too
          }
          i = j - 2;
        }
      }
      continue;
    }
    if (ch === ">" || ch === "<" || ch === "&") {
      if (/^\d+$/.test(cur) && ch !== "&") { cur = ""; has = false; }
      endWord();
      let op = ch;
      while (/[>&|<]/.test(c[i + 1] ?? "") && op.length < 3) op += c[++i];
      if (op === "<<" || op === "<<-") {
        let j = i + 1;
        while (c[j] === " " || c[j] === "\t") j++;
        // Allow-list: only a plain word (`EOF`) or a fully quoted plain word (`'EOF'`, `"EOF"`) is a tag this reader knows how to
        // match. Anything else (`$'EOF'`, `E"OF"`, `\EOF`, a tag with punctuation) fails closed.
        const m = /^(?:(\w+)|'(\w+)'|"(\w+)")(?=[\s;&|<>()]|$)/.exec(c.slice(j));
        if (m) pendingTags.push((m[1] ?? m[2] ?? m[3])!);
        else if (bad) bad.v = true;
        redir = null;
      } else if (op[0] === ">" || op[0] === "&") redir = op.endsWith("&") && /^\s*\d/.test(c.slice(i + 1)) ? null : "out";
      else redir = null;
      continue;
    }
    if (/\s/.test(ch)) { endWord(); continue; }
    cur += ch;
    has = true;
  }
  endSeg();
  return segs;
}

/** A command that unpacks an archive or copies a folder tree in. */
function extractsFiles(name: string, args: string[], scratchInPlay: boolean): boolean {
  if (name === "tar") return args.some((a, i) => /^-[A-Za-z]*x|^--(?:extract|get)$/.test(a) || (i === 0 && /^[A-Za-z]*x/.test(a)));
  if (name === "unzip") return !args.some((a) => /^-[A-Za-z]*[lvtpZ]/.test(a));
  if (/^(?:7z|7za|7zr|cpio|rsync)$/.test(name)) return true;
  if (name === "cp") return args.some((a) => /^-[A-Za-z]*[rRa]|^--(?:recursive|archive)$/.test(a));
  if (name === "git") {
    // git verbs that write files they never name (a patch, a stash, a ref's tree).
    // Global options before the verb (`--git-dir .git`, `-C dir`, `-c k=v`, `--work-tree dir`) must not hide it.
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (rest.length === 0 && /^(?:-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|--exec-path|--attr-source)$/.test(a)) i++;
      else if (!a.startsWith("-")) rest.push(a);
    }
    const verb = rest[0];
    if (verb === "apply" || verb === "am") return true;
    // Restoring paths from a ref or stash is the agent's own committed work, unless the command also touches scratch or
    // written files (a ref fetched from /tmp): then it counts as unpacking.
    if (!scratchInPlay) return false;
    if (verb === "stash") return rest[1] === "pop" || rest[1] === "apply";
    if (verb === "restore") return args.some((a) => abbreviates(a, ["source"]) || /^-s/.test(a));
    if (verb === "checkout" || verb === "cherry-pick" || verb === "merge" || verb === "pull") return true;
  }
  return false;
}

/** GNU long options accept any unambiguous prefix (`--to-comm` is `--to-command`): true when `arg` abbreviates one of `names`. */
function abbreviates(arg: string, names: string[]): boolean {
  if (!arg.startsWith("--")) return false;
  const o = arg.slice(2).split("=")[0]!;
  return o.length >= 2 && names.some((n) => n.startsWith(o));
}

/**
 * Allow-list of options for tools that can run a program through some option (BOS-377 round 5). Only the options named here
 * are known safe; any other option, any abbreviation of a long option and any unknown flag is unsafe (fail closed).
 * `flags` are short options without a value, `valued` are short options that take a value (the rest of a cluster is the value),
 * `long` are exact long option names (value after `=` is fine). `oldStyle` allows tar's `xf` first word.
 */
interface OptionList { flags: string; valued: string; long: string[]; oldStyle?: boolean }
const SAFE_OPTIONS: Record<string, OptionList> = {
  tar: { flags: "cxtrufvzjJapkOhPmSwl", valued: "fCTX", oldStyle: true,
    long: ["create", "extract", "get", "list", "file", "directory", "gzip", "bzip2", "xz", "verbose", "preserve-permissions", "keep-old-files",
      "strip-components", "exclude", "to-stdout", "files-from", "absolute-names", "no-same-owner", "same-owner", "overwrite", "one-top-level", "auto-compress"] },
  sort: { flags: "bcdfghiMnRrsuVzm", valued: "oktSTy",
    long: ["reverse", "unique", "numeric-sort", "ignore-case", "key", "field-separator", "output", "stable", "version-sort", "human-numeric-sort", "check",
      "merge", "buffer-size", "temporary-directory", "zero-terminated", "ignore-leading-blanks", "dictionary-order", "general-numeric-sort", "month-sort", "parallel"] },
  unzip: { flags: "oqnjlvtpufaLCXKMs", valued: "dx", long: [] },
  zip: { flags: "rqjymgDXkuSv0123456789", valued: "bix", long: ["recurse-paths", "quiet", "junk-paths", "exclude", "include", "move", "update", "freshen", "delete"] },
  rg: { flags: "iIsSwxvcnNHhlLoqrujUaz", valued: "efgtTABCmMjdE",
    long: ["ignore-case", "smart-case", "case-sensitive", "word-regexp", "line-regexp", "invert-match", "count", "files-with-matches", "files-without-match",
      "line-number", "no-line-number", "with-filename", "no-filename", "only-matching", "quiet", "glob", "type", "type-not", "hidden", "no-ignore", "max-count",
      "context", "after-context", "before-context", "fixed-strings", "regexp", "files", "color", "json", "heading", "no-heading", "follow", "max-depth", "sort", "stats"] },
  wget: { flags: "qvcNrkSxpEKbnd", valued: "OPoiTtwlUQARDIXBa",
    long: ["output-document", "directory-prefix", "output-file", "quiet", "no-verbose", "verbose", "continue", "timeout", "tries", "no-check-certificate",
      "content-disposition", "max-redirect", "header", "user-agent", "no-clobber", "timestamping", "recursive", "level", "no-parent", "post-data", "post-file", "method"] },
};

/** True when an option in `args` is not on the tool's allow-list. */
function hasUnlistedOption(list: OptionList, args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return false;
    if (a.startsWith("--")) {
      if (!list.long.includes(a.slice(2).split("=")[0]!)) return true;
      continue;
    }
    let cluster: string | null = null;
    let old = false;
    if (a.startsWith("-") && a.length > 1) cluster = a.slice(1);
    else if (list.oldStyle && i === 0) { cluster = a; old = true; }
    if (cluster === null) continue;
    for (const ch of cluster) {
      // Dash cluster: the rest of the word is the value of a valued letter. Old-style first word (`tar xfI a.tar x.sh`): every
      // letter is an option and the values come from the following words, so every letter must be on the list.
      if (list.valued.includes(ch)) { if (old) continue; break; }
      if (!list.flags.includes(ch)) return true;
    }
  }
  return false;
}

/** Options on commands from the reader list that run a program of the caller's choosing. */
function runsProgramOption(name: string, args: string[]): boolean {
  const list = SAFE_OPTIONS[name];
  if (list) return hasUnlistedOption(list, args);
  if (name === "less" || name === "more") return args.some((a) => /^--lesskey|^-k$/.test(a));
  return false;
}

/** pnpm/npm/yarn/git run scripts and config from places named on their command line: not from a scratch or written path. */
function toolingRunsScratch(name: string, args: string[], isScratch: (w: string) => boolean, isWritten: (w: string) => boolean): boolean {
  const hit = (w: string | undefined): boolean => w !== undefined && (isScratch(w) || isWritten(w));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const val = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : args[i + 1];
    const opt = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (/^(?:-C|--dir|--prefix|--cwd|--config|--git-dir|--work-tree|--workspace-dir|--userconfig|--globalconfig|--use-yarnrc|--require|-r|--loglevel-file|--root)$/.test(opt) && hit(val)) return true;
    if (/^-[CD]./.test(a) && hit(a.slice(2))) return true;
  }
  if (name === "git") return false;
  // pnpm/npm/yarn: a package-manager verb may take a scratch output path; any other word is a package bin (`pnpm tsx /tmp/x.ts`).
  const verbs = /^(?:install|i|ci|add|remove|rm|update|up|run|run-script|test|t|build|typecheck|lint|dev|start|store|prune|audit|list|ls|outdated|pack|why|licenses|dedupe|rebuild|fetch|prefetch)$/;
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub !== undefined && !verbs.test(sub) && args.some(hit)) return true;
  return false;
}

/**
 * Environment variables an agent may set in front of a command, or export. Allow-list (BOS-630): a variable the judge does not
 * know to be harmless can make a listed tool run a program or load code (TAR_OPTIONS=--to-command=..., GREP_OPTIONS, ZIPOPT,
 * WGETRC, RIPGREP_CONFIG_PATH, BASH_ENV, ENV, PERL5OPT, NODE_OPTIONS, NODE_PATH, PYTHONSTARTUP, PYTHONPATH, LD_PRELOAD, PATH,
 * GIT_*, PAGER ...). None of those is listed; a name not listed here is never Allow, whatever its value.
 */
const SAFE_ENVIRONMENT = /^(?:CI|NODE_ENV|FORCE_COLOR|NO_COLOR|CLICOLOR|CLICOLOR_FORCE|TZ|TERM|COLUMNS|LINES|LANG|LANGUAGE|LC_[A-Z]+|DEBUG|CHECK_ALL_FORCE|CHECK_ALL_LOCK_WAIT|BOSSMAN_TEST_MAX_WORKERS|CHECK_QUICK_FORCE_RELATED|BOSSMAN_VITEST_NO_SLOT|BOSSMAN_CHECK_STORE)$/;

/**
 * True when a command puts a variable that is not on SAFE_ENVIRONMENT into a program's environment: as a prefix (`X=1 cmd`,
 * `env X=1 cmd`; `assigns` holds those), after a launcher that is not peeled (`sudo X=1 cmd`), by `export` / `declare -x` /
 * `typeset -x`, or by switching on allexport (`set -a`) or `env -S`. A plain `X=1` on its own is a shell variable, not environment.
 */
function setsUnknownEnvironment(assigns: string[], sh: string, args: string[]): boolean {
  const unknown = (word: string): boolean => {
    const m = /^(\w+)\+?=?/.exec(word);
    return !m || !SAFE_ENVIRONMENT.test(m[1]!);
  };
  if (assigns.some(unknown)) return true;
  if (/^(?:sudo|doas|xargs|stdbuf|ionice|chroot|su|unshare|nsenter|strace|ltrace|watch|parallel)$/.test(sh) && args.some((a) => /^\w+=/.test(a) && unknown(a))) return true;
  if (/^(?:export|declare|typeset)$/.test(sh)) {
    const exports = sh === "export" || args.some((a) => /^-[A-Za-z]*x/.test(a));
    if (exports && args.some((a) => !a.startsWith("-") && unknown(a))) return true;
  }
  if (sh === "set" && args.some((a, i) => /^-[A-Za-z]*[ak]/.test(a) || ((a === "allexport" || a === "keyword") && args[i - 1] === "-o") || /^-o?(?:allexport|keyword)$/.test(a))) return true;
  return false;
}

/**
 * True when a shell's `-c` command string is unknown: a substitution (`$(...)`, a backtick) or a variable the judge
 * can't resolve. The string is assembled the way bash joins adjacent quoted pieces (`bash -c 'echo '"$(cat /tmp/x)"`),
 * and only the word the shell actually runs (after any option words, BOS-695) is read.
 */
function shellDashCOpaque(c: string, budget: ScanBudget): boolean {
  for (const m of c.matchAll(new RegExp(`\\b(?:${SHELL_ALT})\\b`, "g"))) {
    if (!chargeScan(budget, c.length - m.index!)) return true; // out of work: can't place it, so no Allow
    const words = shellWords(c.slice(m.index! + m[0].length).split(/\n/)[0]!);
    const at = words.findIndex((w) => /^[-+][A-Za-z]*c/.test(w));
    if (at < 0) continue;
    const { word, ok } = shellDashCString(words.slice(at + 1));
    if (ok === false || (word !== "" && hasUnresolvedExpansion(word))) return true;
  }
  return false;
}

/**
 * The command strings every shell `-c` runs, with quote removal applied so `bash -c 'r''m -rf /'` and
 * `bash -c $'\x72m -rf /'` both read as `rm -rf /` (BOS-715). A string the judge can't resolve is left out; it is already
 * caught as opaque. The inner command genuinely runs, so the judge reads each one as an extra command in the same line.
 */
function shellDashCInner(c: string, budget: ScanBudget): string[] {
  const out: string[] = [];
  for (const m of c.matchAll(new RegExp(`\\b(?:${SHELL_ALT})\\b`, "g"))) {
    if (!chargeScan(budget, c.length - m.index!)) break; // shellDashCOpaque then reports the line as opaque
    const words = shellWords(c.slice(m.index! + m[0].length).split(/\n/)[0]!);
    const at = words.findIndex((w) => /^[-+][A-Za-z]*c/.test(w));
    if (at < 0) continue;
    const { word, ok } = shellDashCString(words.slice(at + 1));
    if (ok === false || word === "" || hasUnresolvedExpansion(word)) continue;
    // shellWords already dropped `'...'` / `"..."`; decode a `$'...'` string and any backslash by the same quote removal.
    const d = dequoteWord(word);
    // A string that dequoting can't finish (a quote never closed, `/tmp/a' /etc`) is kept as it is; judgePermission refuses it.
    if (d === null) out.push(word);
    else if (d.trim() !== "") out.push(d);
  }
  return out;
}

/**
 * The command string a shell runs for `sh|bash|zsh|dash|ksh -c`, given the words after `-c` (BOS-695). The shell still reads
 * options after `-c`, so skip `--`, option words (`-x`, `+x`, `-eu`, `-e`, `-o pipefail`, `+o errexit`, `-O extglob`) and the
 * argument an `-o`/`+o`/`-O`/`+O` word takes, then take the first plain word. `ok: false` means an option word we can't place,
 * or no command string at all: the caller must give no Allow.
 */
function shellDashCString(words: string[]): { word: string; ok: boolean } {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") continue;
    if (!/^[-+]/.test(w)) return { word: w, ok: true };
    // `-o pipefail` / `+o errexit` / bash's `-O extglob` / `+O nullglob`, and a cluster ending in o/O (`-eo pipefail`,
    // `-euo pipefail`, `-eO extglob`): the option name is the next word.
    if (/^[-+][A-Za-z]*[oO]$/.test(w)) { i++; continue; }
    // A second `-c` word: bash runs the first command string and never reads this one as the shell's own option, so the
    // words after it are not where the judge places them (BOS-707).
    if (/^[-+][A-Za-z]*c/.test(w)) return { word: "", ok: false };
    // A bare `-` is a word, not an option.
    if (w === "-") return { word: w, ok: true };
    // Only plain short-option words (`-e`, `-ex`, `+e`, `-x`) are recognised, along with an `-o<name>`/`-O<name>` without a
    // separate name (`-opipefail`); anything else (an option form the judge can't place) gives no Allow.
    if (/^[-+][A-Za-z]+$/.test(w)) continue;
    return { word: "", ok: false };
  }
  return { word: "", ok: false }; // `-c` with no command string: nothing to read, so no Allow
}

/**
 * Deny-by-default for scratch paths. In a command that names a /tmp path or a path the command itself writes (redirect, tee,
 * cp, mv, curl -o ...), the only commands allowed to mention that path are readers and file tools (cat, grep, ls, cp, rm,
 * tee ...). Any other command word (an interpreter however it is spelled or wrapped, `./w.js`, flock, strace, npx, `FOO=/tmp/x
 * cmd`) is code the judge can't read. pnpm/npm/yarn/git may name a /tmp path but not a path the command wrote, and not with an
 * exec-style word. Over-denial (generate a file, then feed it to a checked-in script) is accepted.
 */
const TOOL_RUNNER = /^(?:pnpm|npm|yarn|yarnpkg|npx|pnpx|bunx)$/;
// Options whose value names a file or folder a package manager runs from or reads config from. Judged wherever they stand
// (`--silent -C /tmp/p`, `--script-shell=/tmp/x.sh`), with the value attached (`-C/tmp`, `--prefix=/tmp`) or in the next word.
const TOOL_PATH_OPT = /^(?:-C|--dir|--prefix|--cwd|--config|--git-dir|--work-tree|--workspace-dir|--userconfig|--globalconfig|--use-yarnrc|--require|-r|--loglevel-file|--root|--script-shell)$/;
// BOS-701 (allow-list, not a deny-list): the package-manager options whose value only names where output is written, so an
// absolute /tmp path there is fine (`pnpm run build --outDir /tmp/out`). Any other `--key=/abs/path` value gets no Allow.
const OUTPUT_OPT = /^--(?:outDir|out-dir|output-dir|outputDir|dist-dir|distDir|report-dir|reportDir|coverage-dir|coverageDir)$/;
/** True when `w` is a relative path that climbs out of the checkout with `..` (`../x.ts`, `../../x.test.ts`). */
function climbsOut(w: string): boolean {
  const p = w.replace(/^['"]+|['"]+$/g, "");
  if (p.startsWith("/") || /\$|\x60|^~/.test(p)) return false; // absolute or unknown: judged elsewhere
  return /(?:^|\/)\.\.(?:\/|$)/.test(p);
}
/** True when `w` names a file or folder outside the checkout: an absolute path (a /tmp shell or config included) or a climb. */
function pathLeaves(w: string, inOwn: (p: string) => boolean): boolean {
  const p = w.replace(/^['"]+|['"]+$/g, "");
  if (p === "" || p === "-" || /\$|\x60|^~/.test(p)) return false; // unknown value: left to the other checks
  if (p.startsWith("/")) return !inOwn(p); // /tmp is outside: a shell, config or script there is code the judge can't read
  return climbsOut(p);
}
/**
 * BOS-638 (split from BOS-378 by the CEO): a package-manager run or a `find -exec` that names a path leaving the checkout gets
 * no Allow. Jane's round-5 review found a folder flag after another flag, an npm setting that names a file, a tool argument
 * from outside the checkout, and a `find -exec` script there. The judge is only in "watch"; this closes the four before any
 * company switches it to "advise". Over-denial of a tool argument that climbs out is accepted.
 */
function toolingOrExecLeaves(c: string, inOwn: (p: string) => boolean): boolean {
  const bad = { v: false };
  const segs = shellSegments(c, bad);
  if (bad.v) return true; // the parser can't tell where a heredoc or arithmetic ends: fail closed
  const wrappers = /^(?:env|nohup|time|sudo|command|nice|setsid|stdbuf|exec|timeout|-exec|-execdir|-ok|-okdir|then|do|else|if|while|until|!|\{)$/;
  // BOS-701 (lost BOS-378 check): a folder a `cd`/`pushd`/`chdir` or a wrapper's folder flag (`env -C`) moves to that is
  // outside the checkout. `/tmp` is outside here even though `cd /tmp` itself is fine: running repo code there is code the
  // judge can't read. A relative sub-folder and the own folder keep it inside.
  const repoDirOk = (dir: string): boolean => dir !== "" && dir !== "-" && (inOwn(dir) || /^[\w.@+-]+(\/[\w.@+-]+)*$/.test(dir)) && !dir.includes("..");
  // A program that runs repo code from the checkout once the working folder is outside it gets no Allow. git always counts (it
  // runs hooks and aliases). A package manager counts when it runs a script (`run`, `test`, a bare script name); a plain
  // `npm init`/`install` in a fresh /tmp folder only sets up or installs packages there, which the CEO allowed (BOS-329 eval).
  const RUNS_REPO_CODE = /^(?:git|make|gmake|cmake|gradle|mvn|ant|cargo|dotnet|rake|bundle|mix|stack)$/;
  const PM = /^(?:pnpm|npm|yarn|npx|pnpx|bunx|bun)$/;
  const PM_SCRIPT = /^(?:run|run-script|test|t|start|dev|restart|rebuild|pack|publish|exec|dlx|create)$/;
  // BOS-710: which options take no value differs per package manager (npm `-w` is `--workspace <name>`, pnpm `-w` is the workspace
  // root; bun `-r` is `--preload <file>` and `-d` is `--define <k:v>`), so the allow-list is per program. An option missing from
  // a program's list gets "runs a script" (over-deny, never Allow).
  const PM_FLAGS_COMMON = "-s|--silent|-q|--quiet|--no-color|--ignore-scripts|-D|-g|--global|--save-dev|--offline|--prefer-offline|--no-progress|--force|-f|--verbose";
  // BOS-712: yarn 1 declares `--prod, --production [prod]` (an optional value), so `yarn --production install` reads production=install;
  // the flag is value-less only for the others, and so is not in the common list. Every other yarn entry was run against yarn 1.22.22.
  const PM_FLAGS: Record<string, RegExp> = {
    npm: new RegExp(`^(?:${PM_FLAGS_COMMON}|--production|--if-present|-ws|--workspaces|-y|--yes|--prod|--legacy-peer-deps|--no-audit|--no-fund|-d)$`),
    pnpm: new RegExp(`^(?:${PM_FLAGS_COMMON}|--production|--if-present|-w|--workspace-root|-r|--recursive|--frozen-lockfile|--no-frozen-lockfile|--prod|--no-audit)$`),
    yarn: new RegExp(`^(?:${PM_FLAGS_COMMON}|--frozen-lockfile|--no-audit|-W|--ignore-workspace-root-check)$`),
    bun: new RegExp(`^(?:${PM_FLAGS_COMMON}|--production|--frozen-lockfile|--no-frozen-lockfile|--prod|--dry-run)$`),
    npx: /^(?:-y|--yes|-q|--quiet|-s|--silent|--no)$/,
  };
  const pmRunsScript = (head: string, args: string[]): boolean => {
    // BOS-706 (allow-list): an option the judge does not know may take the next word as its value (`npm --cache install run evil`),
    // so the verb cannot be told. Only known value-less options may stand before the verb; any other gets "runs a script".
    const known = PM_FLAGS[head] ?? PM_FLAGS[head === "pnpx" || head === "bunx" ? "npx" : head] ?? /^$/;
    const verbAt = args.findIndex((a) => !a.startsWith("-") && a !== "");
    for (const a of verbAt < 0 ? args : args.slice(0, verbAt)) {
      if (a !== "--" && !a.includes("=") && !known.test(a)) return true;
    }
    const first = verbAt < 0 ? undefined : args[verbAt];
    // No verb (`pnpm` alone) or a script-run verb, or a word that is not a known non-script verb (a bare script name).
    if (first === undefined) return true;
    if (PM_SCRIPT.test(first)) return true;
    // BOS-716: `npm init <name>` is `npm exec create-<name>` (downloads and runs a package), like `npm exec`; a bare `init`
    // (or one with only flags) writes a package.json and stays readable. Any word after init is a name, so no Allow.
    if (first === "init" && args.slice(verbAt + 1).some((a) => !a.startsWith("-") || a === "--")) return true;
    return !/^(?:install|i|ci|add|remove|rm|update|up|init|prune|audit|list|ls|outdated|why|licenses|dedupe|fetch|prefetch|store|config|c|set|link|unlink|patch|version)$/.test(first);
  };
  let away = false;
  for (const s of segs) {
    let words = s.words;
    let k = 0;
    let unreadable = false;
    // Peel launchers and their own flags: `env -C /tmp/p cmd`, `timeout -s KILL 60 cmd`, `nice -n 5 cmd`, `sudo cmd`, `A=b cmd`.
    // BOS-706: the wrappers in WRAPPER_OPTS are peeled by peelWrapper, which knows each one's value-taking flags (short, attached,
    // long and GNU-abbreviated); one it cannot read leaves the program unknown, which is no Allow once the folder is outside.
    while (k < words.length) {
      const w = words[k]!;
      if (/^\w+\+?=/.test(w)) { k++; continue; }
      const base = w.replace(/^.*\//, "");
      if (base === "env" || base === "chdir") {
        // A wrapper that can change the working folder: `-C /tmp/p`, `-C/tmp/p`, `--chdir /tmp/p`, `--ch=/tmp/p` (any GNU prefix).
        for (let j = k + 1; j < words.length; j++) {
          const f = words[j]!;
          if (/^\w+\+?=/.test(f)) continue;
          if (!f.startsWith("-") || f === "-") break;
          if (f === "--") break;
          const long = f.startsWith("--") ? f.replace(/=.*$/s, "") : "";
          if (long.length > 2 && "--chdir".startsWith(long)) {
            const v = f.includes("=") ? f.slice(f.indexOf("=") + 1) : (words[j + 1] ?? "");
            if (!repoDirOk(v)) away = true;
          } else if (long.length > 2 && !f.includes("=") && ("--unset".startsWith(long) || "--argv0".startsWith(long))) {
            j++; // takes the next word as its value: `env --unset X -C /tmp/p cmd`
          } else if (!long && f.length > 1) {
            // BOS-710: a group of short options (`-0u X`, `-iP /bin`, `-uC`): the first value letter (u, C, P) ends the group, and its
            // value is the rest of the word or the next word, the same rule as peelWrapper.
            const at = [...f.slice(1)].findIndex((ch) => "uCP".includes(ch)) + 1;
            if (at > 0) {
              const attached = at < f.length - 1;
              const v = attached ? f.slice(at + 1) : (words[j + 1] ?? "");
              if (f[at] === "C" && !repoDirOk(v)) away = true;
              if (!attached) j++;
            }
          }
        }
      }
      if (Object.hasOwn(WRAPPER_OPTS, base)) {
        const peeled = peelWrapper(w, words.slice(k + 1));
        if (peeled === null || peeled === "split") { unreadable = true; break; }
        words = [peeled.head, ...peeled.args];
        k = 0;
        if (peeled.head === "") break;
        continue;
      }
      if (base === "chdir") { k++; continue; }
      // BOS-711: `corepack pnpm install` runs the package manager; judge it as that program.
      if (base === "corepack" && /^(?:pnpm|npm|yarn|yarnpkg|npx|pnpx)$/.test(words[k + 1] ?? "")) { k++; continue; }
      if (wrappers.test(w)) { k++; continue; }
      break;
    }
    // BOS-717: `yarnpkg` is yarn 1 under another name (same yarn-path rule), so it is judged as `yarn`.
    const head0 = (words[k] ?? "").replace(/^.*\//, "");
    // BOS-718: so is yarn 1 under its file names (`yarn.js`, `yarn.cmd`, `yarnpkg.cmd`, ...), run by path or from PATH.
    const head = /^(?:yarn|yarnpkg)(?:\.(?:c?js|mjs|cmd|ps1|exe))?$/.test(head0) ? "yarn" : head0;
    const args = words.slice(k + 1);
    // A launcher that could not be read, or a flag standing where the program should be (`sudo -u x git`), hides the program.
    if (away && (unreadable || head === "corepack" || (head.startsWith("-") && head.length > 1) || /^(?:sh|bash|dash|zsh|ksh|ash)$/.test(head))) return true;
    // A `cd`/`pushd`/`chdir` moves the working folder for the segments that follow; a bare `popd`/`cd -` can't be read.
    if (/^(?:cd|pushd|chdir)$/.test(head)) {
      // cd's own flags (`-P`, `-L`, `-e`, `-@`, `-n`) are skipped: the first word that is not a flag is the target.
      const target = args.find((a) => a !== "--" && !(a.startsWith("-") && a.length > 1))?.replace(/^['"]+|['"]+$/g, "") ?? "";
      if (target === "" || target === "-" || /^\/tmp(\/|$)/.test(target) || target.includes("..") || !repoDirOk(target)) away = true;
      continue;
    }
    if (head === "popd") { away = true; continue; }
    if (away && (RUNS_REPO_CODE.test(head) || (PM.test(head) && pmRunsScript(head, args)))) return true;
    // BOS-716: `npm init <name>` downloads and runs a package wherever it is run, so it is no Allow inside the checkout too.
    // BOS-717: an unknown option before the verb may take the next word as its value (`npm --loglevel info init x`), so the verb
    // is the first word that is not an option or an option's value; `init` anywhere there counts.
    // BOS-720: only options (and their values) stand before word `at`, so it is the verb. Same reading as the init check.
    const onlyOptsBefore = (at: number): boolean => {
      const before = args.slice(0, at);
      return before.every((a, i) => a.startsWith("-") || (a !== "" && (before[i - 1] ?? "").startsWith("-") && (before[i - 1] ?? "") !== "--" && !(before[i - 1] ?? "").includes("=")));
    };
    // BOS-720: npm expands any unique prefix of a command name, so `crea`, `ini` and `inn` are init (`in` is ambiguous). A prefix
    // that is too short to be unique is an error in npm, so over-matching here only denies, never allows. pnpm and bun need the word.
    const isInitWord = (a: string): boolean => head === "npm"
      ? (a.length >= 2 && "create".startsWith(a)) || (a.length >= 3 && ("init".startsWith(a) || "innit".startsWith(a)))
      : a === "init" || a === "create" || a === "innit";
    if (/^(?:pnpm|npm|bun)$/.test(head)) {
      // BOS-718: `create` and `innit` are npm's aliases of `init` (pnpm and bun have `create` too), same verdict.
      const initAt = args.findIndex(isInitWord);
      if (initAt >= 0 && onlyOptsBefore(initAt) && args.slice(initAt + 1).some((a) => !a.startsWith("-") || a === "--")) return true;
    }
    // BOS-720: yarn 1 `global` works on the unquoted word (the shell strips quotes), and `yarn create x` installs create-x globally
    // then runs it: both put packages and bins outside the checkout, like `yarn global add`.
    if (head === "yarn") {
      const gAt = args.findIndex((a) => a === "global" || a === "create");
      if (gAt >= 0 && onlyOptsBefore(gAt)) return true;
    }
    // BOS-717: npm reads `init-module=<file>` from the folder's `.npmrc` and runs that file on `npm init`, so outside the checkout
    // any `npm init` gets no Allow (pnpm and bun do not read init-module). Inside the checkout the .npmrc is ours.
    if (away && head === "npm" && args.some((a) => a === "init" || isInitWord(a))) return true;
    // BOS-706 (CEO decision): outside the checkout an install runs that folder's own preinstall/install/postinstall/prepare
    // scripts, which the judge can't read. It gets no Allow unless `--ignore-scripts` (or `=true`) is given. Inside the checkout
    // and its workspaces installs stay Allow (BOS-329).
    // BOS-711 (allow-list): only a verb known to run no folder or dependency script stays Allow without the flag; every other verb
    // (update, dedupe, remove, link, version, prune, ...) reifies the tree or runs lifecycle scripts, so it needs the flag too. The
    // flags are read in order up to `--`; the flag counts only when nothing undoes it (`--no-ignore-scripts`, `=false`, a following
    // `false`) and any other spelling of the setting is unreadable, which is no Allow.
    // BOS-711 group 4 (CEO decision): code the judge can't read also loads from config files even with --ignore-scripts.
    // pnpm loads the folder's `.pnpmfile.cjs` on install/add/update, so outside the checkout pnpm also needs `--ignore-pnpmfile`
    // (read in order like the first flag). yarn 1 runs the file named by `yarn-path` in the folder's `.yarnrc` and no flag turns
    // that off, so outside the checkout a yarn install/add/upgrade (or bare `yarn`) gets no Allow: a person decides. Inside the
    // checkout nothing changes: that is our own repo's reviewed config.
    // BOS-716 (extends group 4): yarn reads `yarn-path` from the folder's `.yarnrc` at start-up for every command, not just
    // installs, so outside the checkout no yarn command gets an Allow. `npm audit fix` rebuilds the tree like `npm update` and runs
    // dependency install scripts, so an `audit` with a `fix` word needs `--ignore-scripts` too (`pnpm audit --fix` only edits
    // overrides in package.json, so a flag spelling stays Allow).
    if (away && head === "yarn") return true;
    if (away && /^(?:pnpm|npm|bun)$/.test(head)) {
      const verb = args.find((a) => !a.startsWith("-") && a !== "");
      const auditFix = verb === "audit" && args.slice(args.indexOf(verb) + 1).some((a) => a === "fix");
      if (auditFix || (verb !== undefined && !/^(?:init|audit|list|ls|outdated|why|licenses|fetch|prefetch|store|config|c|set)$/.test(verb))) {
        const end = args.indexOf("--");
        const flags = end < 0 ? args : args.slice(0, end);
        // True when the setting `name` ends up on: read in order, undone or oddly spelled means off.
        const flagOn = (name: string): boolean => {
          let on = false;
          let bad = false;
          const loose = new RegExp(name.replace(/-/g, "-?"), "i");
          for (let i = 0; i < flags.length; i++) {
            const a = flags[i]!;
            if (!loose.test(a)) continue;
            if (a === `--${name}` || a === `--${name}=true`) {
              on = true;
              const nextWord = flags[i + 1];
              if (a === `--${name}` && (nextWord === "true" || nextWord === "false")) { if (nextWord === "false") bad = true; i++; }
            } else {
              bad = true; // --no-<name>, =false, =0, odd case or spelling
            }
          }
          return on && !bad;
        };
        if (!flagOn("ignore-scripts")) return true;
        if (head === "pnpm" && !flagOn("ignore-pnpmfile")) return true;
      }
    }
    // find's `-exec`/`-execdir`/`-ok`/`-okdir` program: a path that leaves the checkout is code from elsewhere.
    if (head === "find") {
      for (let i = 0; i < args.length; i++) {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i]!)) continue;
        // The -exec program may sit behind a wrapper (`env ../x.sh`): peel env/nohup/nice/... and its assigns to reach it.
        let j = i + 1;
        while (j < args.length && (wrappers.test(args[j]!) || /^\w+\+?=/.test(args[j]!))) j++;
        const prog = args[j] ?? "";
        // A bare name (`grep`, `rm`) runs from PATH; only a word naming a path (`../x.sh`, `/tmp/x.sh`, `./x.sh`) is judged.
        if (prog.includes("/") && (climbsOut(prog) || pathLeaves(prog, inOwn))) return true;
      }
      continue;
    }
    if (!TOOL_RUNNER.test(head)) continue;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      const eq = a.indexOf("=");
      // A folder/config/shell option: its value (`--opt=v`, `-C/v`, or the next word) must stay inside the checkout or /tmp,
      // wherever the option stands among the flags.
      const opt = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
      if (TOOL_PATH_OPT.test(opt)) {
        const val = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : /^-[A-Za-z]./.test(a) ? a.slice(2) : args[i + 1];
        if (val !== undefined && pathLeaves(val, inOwn)) return true;
        continue;
      }
      // A tool argument that is a relative path climbing out of the checkout (`npx vitest run ../../x.test.ts`,
      // `pnpm dlx tsx ../x.ts`). An absolute /tmp output (`--outDir /tmp/out`) is allowed as before; a /tmp input to run is
      // already denied by usesScratchUnsafely. A package name (`@scope/pkg`) has no `..`, so it is not caught.
      const val = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : a;
      if (!val.startsWith("-") && climbsOut(val)) return true;
      // BOS-701 (lost BOS-378 check, part B): npm and pnpm read any `--key=value` as a config setting, so BOS-638's fixed list of
      // option names misses some (`--node-options=--require=/tmp/x.js`, `--config.script-shell=/tmp/x.sh`). Allow-list, not one
      // more name on the deny-list: any option value naming an absolute path outside the checkout gets no Allow, unless the option
      // is a known output option that only writes there (`--outDir`).
      if (a.startsWith("--")) {
        const name = eq > 0 ? a.slice(0, eq) : a;
        const v = eq > 0 ? a.slice(eq + 1) : args[i + 1];
        // BOS-706 (allow-list): node-options is NODE_OPTIONS by flag, so a `--require`, `--import` or `--loader` in it runs code the
        // judge can't read, however the path is spelled (`-r/tmp/x.js`, `../x.js`, `$HOME/x.js`, `data:` URL). npm accepts any
        // unambiguous prefix of a config name and `_` for `-`. Only known harmless node flags may stand in the value.
        const cfg = name.replace(/^--(?:config\.)?/, "").replace(/_/g, "-");
        if (cfg.length >= 3 && "node-options".startsWith(cfg)) {
          const toks = (v ?? "").replace(/['"]/g, "").split(/\s+/).filter((t) => t !== "");
          if (toks.length === 0 || !toks.every((t) => /^--(?:max[-_]old[-_]space[-_]size|stack[-_]trace[-_]limit)=\d+$|^--(?:no-warnings|trace-warnings|enable-source-maps|no-deprecation)$/.test(t))) return true;
        }
        // Any absolute path token inside the value that leaves the checkout (`--require=/tmp/x.js`, `--node-options` value).
        if (!OUTPUT_OPT.test(name) && v !== undefined) {
          for (const tok of v.split(/[\s=,'"]+/)) if (/^\//.test(tok) && pathLeaves(tok, inOwn)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Wrappers that only start the real command, with the options that take a value (BOS-703): `short` lists the letters (`-k 2`,
 * `-oL`), `long` the options whose value is the next word (`--signal KILL`; `--signal=KILL` is one word and needs no entry).
 * One table for the main command path and the pipe-segment parser, so they cannot drift apart.
 */
const WRAPPER_OPTS: Record<string, { short: string; long: string[]; bare: string[] }> = {
  setsid: { short: "", long: [], bare: ["--ctty", "--fork", "--wait", "--help", "--version"] },
  nohup: { short: "", long: [], bare: ["--help", "--version"] },
  command: { short: "", long: [], bare: [] },
  exec: { short: "a", long: [], bare: [] },
  time: { short: "fo", long: ["--format", "--output"], bare: ["--append", "--verbose", "--portability", "--quiet", "--help", "--version"] },
  nice: { short: "n", long: ["--adjustment"], bare: ["--help", "--version"] },
  timeout: { short: "sk", long: ["--signal", "--kill-after"], bare: ["--foreground", "--preserve-status", "--verbose", "--help", "--version"] },
  env: { short: "uCP", long: ["--unset", "--chdir", "--argv0"], bare: ["--ignore-environment", "--null", "--debug", "--list-signal-handling", "--block-signal", "--default-signal", "--ignore-signal", "--help", "--version"] },
  flock: { short: "wE", long: ["--timeout", "--wait", "--conflict-exit-code"], bare: ["--shared", "--exclusive", "--unlock", "--nonblock", "--nb", "--no-fork", "--close", "--verbose", "--fcntl", "--help", "--version"] },
  stdbuf: { short: "ioe", long: ["--input", "--output", "--error"], bare: ["--help", "--version"] },
};

/**
 * Peel one wrapper (`head` may carry a path: `/usr/bin/time`). Returns null when `head` is no wrapper or cannot be peeled
 * (`flock -c 'cmd'`), "split" for `env -S` (a command string the judge can't read), else the command behind it.
 */
function peelWrapper(head: string, args: string[]): { head: string; args: string[]; assigns: string[] } | "split" | null {
  const name = head.replace(/^.*\//, "");
  const spec = Object.hasOwn(WRAPPER_OPTS, name) ? WRAPPER_OPTS[name]! : null;
  if (!spec) return null;
  const assigns: string[] = [];
  let durationLeft = name === "timeout"; // timeout DURATION command
  let lockLeft = name === "flock"; // flock LOCKFILE command
  let optionsDone = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (!optionsDone && a === "--") { optionsDone = true; i++; continue; }
    if (!optionsDone && a.startsWith("--")) {
      // GNU getopt_long takes any unambiguous prefix (`nice --adj 5`, `env --sp 'cmd'`): match by prefix, fail closed when it is ambiguous.
      const opt = a.replace(/=.*$/s, "");
      const hasEq = opt !== a;
      const hit = (n: string) => n === opt || (opt.length > 2 && n.startsWith(opt));
      const unreadable = name === "env" ? "--split-string" : name === "flock" ? "--command" : "";
      const all = [...spec.long, ...spec.bare, ...(unreadable ? [unreadable] : [])];
      const exact = all.includes(opt);
      const matches = exact ? [opt] : all.filter(hit);
      if (unreadable && matches.includes(unreadable)) return name === "env" ? "split" : null;
      if (matches.length > 1 && matches.some((m) => spec.long.includes(m))) return "split"; // ambiguous prefix with a value option: unreadable
      i += !hasEq && matches.length === 1 && spec.long.includes(matches[0]!) ? 2 : 1;
      continue;
    }
    if (!optionsDone && a.startsWith("-") && a.length > 1) {
      if (name === "env" && /^-[A-Za-z]*S/.test(a)) return "split";
      if (name === "flock" && /^-[A-Za-z]*c$/.test(a)) return null;
      // The first letter that takes a value: the rest of the word is the value (`-oL`), or the next word when it ends the word.
      let takesNext = false;
      for (let k = 1; k < a.length; k++) if (spec.short.includes(a[k]!)) { takesNext = k === a.length - 1; break; }
      i += takesNext ? 2 : 1;
      continue;
    }
    // timeout reads its duration with strtod (`inf`, `+1`, `1e3`, `infinity`): the first operand is always the duration, never the command.
    if (durationLeft) { durationLeft = false; i++; continue; }
    if (/^\w+=/.test(a)) { assigns.push(a); i++; continue; }
    if (lockLeft) { lockLeft = false; i++; continue; }
    break;
  }
  return { head: args[i] ?? "", args: args.slice(i + 1), assigns };
}

/** Flags of an interpreter that take the next word as their value (`python3 -W ignore::x.Warning`, `perl -I lib.d`), by interpreter. */
const INTERP_VALUE_FLAGS: [RegExp, string][] = [
  [/^python[\d.]*$|^pypy[\d.]*$|^ipython[\d.]*$/, "WXQ"],
  [/^perl$/, "I"],
  [/^ruby$/, "IC"],
  [/^php$/, "d"],
];

function usesScratchUnsafely(c: string): boolean {
  const bad = { v: false };
  const segs = shellSegments(c, bad);
  if (bad.v) return true; // the parser can't tell where a heredoc or arithmetic ends: fail closed
  const safe = new Set(("cat grep egrep fgrep rg ls ll head tail wc diff cmp stat file echo printf rm rmdir shred mkdir cp mv ln tee touch cd pushd popd " +
    "test [ [[ realpath dirname basename readlink du df sort uniq cut tr jq md5sum sha256sum sha1sum mktemp export local unset set read for " +
    "true false sleep chmod date tar unzip gzip gunzip zip curl wget sed less more tree nl od xxd hexdump column").split(" "));
  const tooling = new Set(["pnpm", "npm", "yarn", "yarnpkg", "git"]);
  const keywords = new Set(["if", "then", "do", "else", "elif", "while", "until", "!", "time", "{", "}", "fi", "done", "esac", "in"]);
  const clean = (w: string): string => w.replace(/^\.\//, "").replace(/\/+$/, "");
  const written = new Set<string>();
  let unknownWrite = false; // a write whose file name the judge can't be sure of: plain static imports are not harmless then
  const scratchVars = new Set<string>();
  const scratchWord = /\/tmp(?:\/|$|:)|\$\{?TMPDIR|mktemp/;
  const parsed = segs.map((s) => {
    let k = 0;
    const assigns: string[] = [];
    while (k < s.words.length && (/^\w+\+?=/.test(s.words[k]!) || keywords.has(s.words[k]!))) { if (!keywords.has(s.words[k]!)) assigns.push(s.words[k]!); k++; }
    const head = s.words[k] ?? "";
    const args = s.words.slice(k + 1);
    for (const o of s.out) if (o !== "/dev/null" && !/^\d+$|^-$/.test(o)) written.add(clean(o));
    const flagless = args.filter((a) => !a.startsWith("-"));
    if (/^(?:cp|mv|install|ln)$/.test(head) && flagless.length) {
      written.add(clean(flagless[flagless.length - 1]!));
      // Into a folder (`cp /tmp/c.py .`, `-t DIR`) the new file keeps the source's name: count that name as written too.
      for (const a of flagless) written.add(clean(a.replace(/^.*\//, "")));
    }
    // A download that names its own file (`curl -O URL`, `-J`, `wget URL` without -O) writes a name the URL decides.
    if (head === "curl" || head === "wget") {
      const saves = head === "wget" ? !args.some((a) => /^(?:-O|--output-document)/.test(a)) : args.some((a) => /^-[A-Za-z]*[OJ]|^--remote-name|^--remote-header-name/.test(a));
      if (saves) {
        unknownWrite = true;
        for (const a of args) if (/^[a-z][\w+.-]*:\/\//i.test(a)) written.add(clean(a.replace(/[?#].*$/, "").replace(/^.*\//, "")));
      }
    }
    if (head === "tee") for (const a of flagless) written.add(clean(a));
    // Readers on the safe list that still write a file: `sort -o OUT`, `uniq IN OUT`, `xxd -r IN OUT`.
    // Output options of the other readers on the list (`sort -o`, `tree -o`), also at the end of a flag cluster (`sort -uo OUT`).
    if (head === "sort" || head === "tree") for (let i = 0; i < args.length; i++) {
      if (/^-[A-Za-z]*o$|^--output$/.test(args[i]!)) written.add(clean(args[i + 1] ?? ""));
      else if (/^--output=/.test(args[i]!)) written.add(clean(args[i]!.slice(9)));
      else if (/^-[A-Za-z]*o./.test(args[i]!) && !args[i]!.startsWith("--")) written.add(clean(args[i]!.replace(/^-[A-Za-z]*?o/, "")));
    }
    if ((head === "uniq" || head === "xxd") && flagless.length >= 2) written.add(clean(flagless[flagless.length - 1]!));
    // zip OUT.zip files; tar -c/-r/-u -f OUT; sed -i FILE and sed's `w FILE`: archive or file output the command names.
    if (head === "zip" && flagless.length) written.add(clean(flagless[0]!));
    if (head === "tar") {
      const mode = (args[0] ?? "").replace(/^-/, "");
      const makes = /^[A-Za-z]*[cru]/.test(mode) || args.some((a) => /^--(?:create|append|update)$/.test(a));
      for (let i = 0; i < args.length; i++) {
        if (makes && /^-?[A-Za-z]*f$/.test(args[i]!) && !args[i]!.startsWith("--")) written.add(clean(args[i + 1] ?? ""));
        else if (makes && /^--file=/.test(args[i]!)) written.add(clean(args[i]!.slice(7)));
        else if (makes && args[i] === "--file") written.add(clean(args[i + 1] ?? ""));
      }
    }
    if (head === "sed") {
      // `sed -n 'w OUT'`, `sed 's/a/b/w OUT'`. (`sed -i` edits a file that already exists, so it is not counted here.)
      for (const a of args) {
        const m = /(?:^|[;{}\n])\s*[wW]\s+(\S+)\s*$/.exec(a) ?? /^s(.).*\1.*\1[gpiImMe0-9]*[wW]\s+(\S+)\s*$/s.exec(a);
        if (m) written.add(clean(m[m.length - 1]!));
      }
    }
    for (let i = 0; i < args.length; i++) {
      if ((head === "curl" && /^(?:-o|--output)$/.test(args[i]!)) || (head === "wget" && /^(?:-O|--output-document)$/.test(args[i]!))) written.add(clean(args[i + 1] ?? ""));
      const of = /^of=(.+)$/.exec(args[i]!);
      if (head === "dd" && of) written.add(clean(of[1]!));
    }
    return { head, args, assigns };
  });
  for (const p of parsed) for (const a of p.assigns) {
    const m = /^(\w+)\+?=(.*)$/.exec(a)!;
    if (scratchWord.test(m[2]!)) scratchVars.add(m[1]!);
  }
  written.delete("");
  // A command substitution in command position (`$(echo ./c)`, `` `echo ./c` ``, `"$(...)"`) builds the command word from
  // output the judge can't read; the parser splits it into its own segment, so check the raw text. Over-denial is accepted.
  if ((written.size > 0 || scratchVars.size > 0 || scratchWord.test(c)) &&
    /(?:^|[;&|(\n{]|\b(?:then|do|else|elif|exec|env|nohup|time|command)\s)\s*["']?(?:\.?\/)?(?:\$\(|\x60)/.test(c)) return true;
  const isWritten = (w: string): boolean => {
    const t = clean(w);
    const base = t.replace(/^.*\//, "");
    for (const p of written) if (t === p || t.startsWith(p + "/") || (base !== "" && base === p.replace(/^.*\//, "")) || (p.includes("$") && t.includes(p))) return true;
    return false;
  };
  const isScratch = (w: string): boolean => scratchWord.test(w) || [...scratchVars].some((v) => new RegExp(`\\$\\{?${v}\\b`).test(w));
  // Names the command wrote, as path parts without their extension (`d/c.py` gives `d`, `c`, `c.py`): an interpreter that
  // mentions one anywhere (`python3 -c 'import c'`, `node -e "require('./c.js')"`, `python3 -m c`) may load the written code.
  const writtenNames = new Set<string>();
  for (const p of written) for (const part of p.split("/")) {
    if (part === "" || part === "." || part === "..") continue;
    writtenNames.add(part);
    writtenNames.add(part.replace(/\.[^.]*$/, ""));
  }
  writtenNames.delete("");
  const named = (text: string): boolean => [...writtenNames].some((n) => new RegExp(`(?<![\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text));
  // Only code that loads a module or script by name counts (`import c`, `from c import`, `require('./c.js')`, `source c`,
  // `-m c`); reading a written file as data (`readFileSync("/tmp/out.json")`) is left to inlineCodeOk.
  const mentionsWritten = (text: string): boolean => {
    const loaders = /(?:^|[^\w.])(?:import|from|require\w*|include\w*|dofile|loadfile|source|use|run_path|import_module)\b[\s(]*['"]?([^\s'");,]*)/g;
    for (const m of text.matchAll(loaders)) if (named(m[1]!)) return true;
    for (const m of text.matchAll(/(?:^|[^\w.])import\s+([\w., ]+)/g)) if (named(m[1]!)) return true; // `import os, c`
    return false;
  };
  // A write by the shell, or a /tmp path somewhere other than in the inline code itself: self-contained inline code that names
  // its own /tmp file is placed by inlineCodeOk, as before.
  const playOutside = (code: string): boolean => written.size > 0 || scratchVars.size > 0 || scratchWord.test(code === "" ? c : c.split(code).join(""));
  const inScratchPlay = written.size > 0 || scratchVars.size > 0 || scratchWord.test(c);
  const interpWords = "python[\\d.]*|pypy[\\d.]*|ipython[\\d.]*|node(?:js)?|tsx|ts-node|perl|ruby|php|lua|deno|bun|Rscript|sh|bash|zsh|dash|ksh|tclsh";
  const interpreters = new RegExp(`^(?:${interpWords})$`);
  // Any word by which inline code can bring in or run other code, a dotted one too (`runpy.run_path`, `os.system`), or the
  // shell's `source` / `.`. Reading a file as data (`readFileSync`) is not a loader; feeding it to exec / eval / Function is.
  // A static import of a plain module name (`import json`, `from os import path`, `require('fs')`) can only load a module
  // that `named` checks against the files the command wrote, so it is taken out first; a path or built name is not.
  const loadsCode = (text: string): boolean => {
    if (unknownWrite) return /\b(?:import|from|require\w*|include\w*|source|load\w*|use|do|exec\w*|eval\w*)\b|__import__|\w*Context\b|(?:^|[;&|(\s])\.\s+\S/.test(text) || loadsCodeStripped(text);
    return loadsCodeStripped(text);
  };
  const loadsCodeStripped = (text: string): boolean => {
    const rest = text
      .replace(/\bfrom\s+[\w.]+\s+import\s+[\w*, ]+/g, " ")
      .replace(/\bimport\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*/g, " ")
      .replace(/\brequire\(\s*['"][^'"./][^'"]*['"]\s*\)/g, " ");
    return /\b(?:\w*exec\w*|\w*eval\w*|require\w*|import\w*|__import__|source|load\w*|dofile|include\w*|use|do|run_path|runpy|system|spawn\w*|popen|fork|Function|compile|subprocess|child_process|\w*Context)\b|(?:^|[;&|(\s])\.\s+\S/.test(rest);
  };
  // A heredoc fed to an interpreter is inline code too (the parser skips its body).
  if (inScratchPlay) {
    const heredoc = new RegExp(`\\b(?:${interpWords})\\b[^\\n;|&]*<<-?\\s*['"]?\\w+['"]?[^\\n]*\\n([\\s\\S]*)`, "g");
    for (const m of c.matchAll(heredoc)) if (playOutside(m[1]!) && (loadsCode(m[1]!) || mentionsWritten(m[1]!))) return true;
    // Code piped to an interpreter that has no script argument (`echo "import c" | python3 -`, `cat c.py | node`) is read from stdin:
    // the text before the pipe is checked like a heredoc body, and a pipe from `cat` of a written or scratch file is code too.
    // A here-string is code on stdin too: the rest of the line is checked like a heredoc body.
    const hereStr = new RegExp(`\\b(?:${interpWords})\\b[^\\n;|&]*<<<[ \\t]*([^\\n]*)`, "g");
    for (const m of c.matchAll(hereStr)) if (playOutside(m[1]!) && (loadsCode(m[1]!) || mentionsWritten(m[1]!))) return true;
    // The segment after each pipe is parsed: redirects dropped, runners looked through, then an interpreter with no script
    // operand (no word with a dot or slash) and no -c/-e code reads its program from stdin; a lone `-` is stdin too.
    const pipeSeg = /(?<!\|)\|(?!\|)((?:(?!&&)[^;\n|)])*)/g;
    const piped: { index: number }[] = [];
    // Whether one command after a pipe (its text up to the next separator) is an interpreter that reads its program from stdin.
    const readsStdin = (text: string): boolean => {
      let words = text
        .replace(/\d*>&\d+|&>>?\s*\S+|\d*>>?\s*\S+|\d*<\s*\S+/g, " ")
        .split(/\s+/)
        .filter((w) => w !== "" && w !== "&");
      // A subshell's opening bracket and the wrappers the main command path peels, with their options and values (BOS-698, BOS-703).
      for (let guard = 0; guard < 8 && words.length; guard++) {
        if (/^[({]/.test(words[0]!)) { words[0] = words[0]!.replace(/^[({]+/, ""); if (words[0] === "") words.shift(); continue; }
        const peeled = peelWrapper(words[0]!, words.slice(1));
        if (peeled === null) break;
        if (peeled === "split") return true; // `env -S 'cmd'`: unreadable, fail closed
        words = [peeled.head, ...peeled.args].filter((w) => w !== "");
      }
      let ai = 0;
      if (words.length && /^(?:pnpm|npx|bunx|uvx|yarn|yarnpkg|npm|uv|poetry|pipx)$/.test(words[0]!)) {
        ai = words.findIndex((w) => interpreters.test(w.replace(/^.*\//, "")));
        if (ai < 0) return false;
      }
      const interpName = (words[ai] ?? "").replace(/^.*\//, "");
      if (!interpreters.test(interpName)) return false;
      // Flags that take a value (`-W ignore::x.Warning`, `-Wignore::x.Warning`, `-X utf8`) are dropped with that value: it is
      // neither inline code nor a script operand.
      const valueLetters = INTERP_VALUE_FLAGS.find(([re]) => re.test(interpName))?.[1] ?? "";
      const rest: string[] = [];
      const afterInterp = words.slice(ai + 1);
      for (let k = 0; k < afterInterp.length; k++) {
        const a = afterInterp[k]!;
        const at = /^-[A-Za-z]/.test(a) && valueLetters !== "" ? [...a.slice(1)].findIndex((ch) => valueLetters.includes(ch)) : -1;
        if (at < 0) { rest.push(a); continue; }
        if (at === a.length - 2) k++; // the value letter ends the word: the next word is its value
      }
      // Only a flag that carries inline code (one with an operand after it) means the program is not on stdin; for shells
      // only a cluster ending in `c` does (`bash -e` is errexit, `python3 -E` ignores the environment, `node -p` has no code).
      const shellInterp = /^(?:sh|bash|zsh|dash|ksh)$/.test((words[ai] ?? "").replace(/^.*\//, ""));
      const codeFlag = shellInterp ? /^-[A-Za-z]*c$/ : /^-[A-Za-z]*[cermEpM]|^--(?:eval|print|require|import|exec)\b/;
      // The word after the flag must be code: a following `-` (stdin) or another flag means the flag carried none (`python3 -E -`).
      if (rest.some((a, k) => codeFlag.test(a) && k + 1 < rest.length && !rest[k + 1]!.startsWith("-"))) return false;
      // A script operand comes before the stdin marker: words after `-`, or after `-s` for a shell, are arguments to the stdin program.
      const marker = rest.findIndex((a) => a === "-" || (shellInterp && /^-[A-Za-z]*s[A-Za-z]*$/.test(a)));
      return !(marker < 0 ? rest : rest.slice(0, marker)).some((a) => /[./]/.test(a));
    };
    for (const m of c.matchAll(pipeSeg)) if (readsStdin(m[1]!)) piped.push({ index: m.index! });
    // `| (cd x && python3)`, `| { cd x; python3; }`: every command in the group inherits the pipe.
    const pipeGroup = /(?<!\|)\|(?!\|)\s*[({]([^)}\n]*)/g;
    for (const m of c.matchAll(pipeGroup)) if (m[1]!.split(/&&|\|\||;/).some(readsStdin)) piped.push({ index: m.index! });
    for (const m of piped) {
      const before = c.slice(0, m.index);
      if (loadsCode(before) || mentionsWritten(before)) return true;
      const last = before.split(/[;&|\n]/).pop() ?? "";
      if (/^\s*cat\b/.test(last) && last.split(/\s+/).some((w) => w !== "cat" && !w.startsWith("-") && w !== "" && (isWritten(w) || isScratch(w)))) return true;
    }
  }
  let extracted = false;
  for (const p of parsed) {
    let { head, args } = p;
    const assigns = [...p.assigns];
    // Peel plain wrappers that only start the real command: `setsid nohup`, `env A=b`, `timeout 120`, `nice -n 5`, `time`.
    // The same helper peels them in the pipe-segment parser above (WRAPPER_OPTS); `env -S 'A=b cmd'` and `flock -c` are not readable.
    for (let guard = 0; guard < 8; guard++) {
      const peeled = peelWrapper(head, args);
      if (peeled === null) break;
      if (peeled === "split") return true;
      assigns.push(...peeled.assigns);
      head = peeled.head;
      args = peeled.args;
    }
    if (head === "") continue; // a plain `X=1` is a shell variable, not environment
    if (setsUnknownEnvironment(assigns, head.replace(/^.*\//, ""), args)) return true;
    // A command word that is a variable or backtick may expand to a file the command wrote (`X=c; $X`): unread code.
    // Any `$` or backtick anywhere in the word counts (`./$X`, `./"$X"`, `$(echo ./c)`), not just at its start.
    // Globs and brace lists (`./c*`, `./[c]`, `./{c,d}`) are not plain literals either; `[` and `[[` are the test builtin.
    if ((/[$\x60]/.test(head) || (head !== "[" && head !== "[[" && /[*?[{]/.test(head))) && (written.size > 0 || scratchVars.size > 0 || scratchWord.test(c))) return true;
    const sh = head.replace(/^.*\//, "");
    // F4: once a command has unpacked an archive or copied a folder in, files it never wrote by name may exist. Only readers
    // and file tools may follow in the same command.
    if (extracted && !(safe.has(sh) && !head.includes("/"))) return true;
    if (extractsFiles(sh, args, written.size > 0 || scratchVars.size > 0 || scratchWord.test(c))) extracted = true;
    // F2: options that make an otherwise harmless tool run a program.
    if (runsProgramOption(sh, args)) return true;
    // F3: xargs builds a command from its input; with a scratch or written path anywhere it is unread code. A file tool under
    // xargs (`cat /tmp/x | xargs rm -rf`, `... | xargs shred`) acts on names the judge never sees, so it is not exempt
    // (BOS-715).
    if (sh === "xargs") {
      const cmdWord = args.find((a, i) => !a.startsWith("-") && !/^-[IiLnPsdE]$/.test(args[i - 1] ?? ""));
      if ((written.size || scratchWord.test(c) || scratchVars.size) && !(cmdWord !== undefined && safe.has(cmdWord) && cmdWord !== "tar" && !FILE_TOOLS.has(cmdWord))) return true;
    }
    // git's own config, hooks and -C are BOS-378 (Kit); only pnpm/npm/yarn are handled here.
    if (tooling.has(sh) && sh !== "git" && toolingRunsScratch(sh, args, isScratch, isWritten)) return true;
    if (tooling.has(sh) && sh !== "git" && [...written].some((p) => /(?:^|\/)(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|package\.json)$/.test(p))) return true;
    // Only the inline code or module name (the words after -c/-e/-r/-m) is checked here; a written file given as plain data
    // to a checked-in script (`node scripts/use.js out.json`) is judged below as before.
    // Any single-dash flag cluster holding c/e/E/r/m/M/p (`-c`, `-pe`, `-mc`, `-MC`, `-ec`), or --eval / --print / --require.
    // An interpreter behind a runner (`pnpm exec node -e`, `pnpm tsx -e`, `npx tsx -e`, `uv run python -c`, `poetry run python -c`).
    let ish = sh;
    let iargs = args;
    if (/^(?:pnpm|npx|bunx|uvx|yarn|yarnpkg|npm|uv|poetry|pipx)$/.test(sh)) {
      // The first interpreter word anywhere in the arguments (`pnpm --filter x exec node`, `uv run --with y python`).
      const j = iargs.findIndex((a) => interpreters.test(a.replace(/^.*\//, "")));
      if (j >= 0) { ish = iargs[j]!.replace(/^.*\//, ""); iargs = iargs.slice(j + 1); }
    }
    const codeAt = iargs.findIndex((a) => /^-[A-Za-z]*[cermEpM]/.test(a) || /^--(?:eval|print|require|import|exec)\b/.test(a));
    if (codeAt >= 0 && interpreters.test(ish) && playOutside(iargs.slice(codeAt + 1).join(" "))) {
      const args = iargs;
      const flag = args[codeAt]!;
      const code = args.slice(codeAt + 1).join(" ");
      // After a write or with a /tmp path anywhere, inline code that loads, requires, sources, imports or executes anything gets
      // no Allow, whatever it names: it can build the file name at run time. A module named by a joined flag (`-mc`, `-MC`) counts.
      if (loadsCode(code) || loadsCode(flag.replace(/^-[A-Za-z]*?[mMr]/, "import "))) return true;
      if (mentionsWritten(code) || named(flag.replace(/^-[A-Za-z]*?[mMr]/, ""))) return true;
      if (/^-[A-Za-z]*[mMr]$|^--(?:require|import)$/.test(flag) && named(args[codeAt + 1] ?? "")) return true; // `-m c`, `-r ./c.js`
    }
    const dashC = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (/^(?:sh|bash|zsh|dash|ksh)$/.test(sh) && dashC >= 0 && !assigns.some(isScratch)) {
      // `bash -c -ex -- 'cmd'`: the shell still reads options after -c, so the command string is the first word after -c
      // that is not `--` and not an option (BOS-695). An option word we can't place gives no Allow.
      // `bash -ce 'cmd'` / `bash -co pipefail 'cmd'` (BOS-700): `c` may sit inside a cluster, so the letters after it are
      // still options to place (`-ce` -> `-e`, `-co` -> `-o pipefail`) before the command string.
      // `bash -oc pipefail 'cmd'` (BOS-707): an `o`/`O` anywhere in the same option word as the `c`, before or after it,
      // takes the next word as its option name (`-oc`, `-Oc`, `-eoc`, `-oeOc`; `-oec` reads the command string itself as an
      // "invalid option name" and aborts). Because the command string then sits one or more words on and the count is easy to
      // misplace, the judge does not try to place it: a cluster with `c` and any `o`/`O` gives no Allow. Over-denial is
      // accepted (write `-o pipefail -c 'cmd'` or `-c -o pipefail 'cmd'` instead). A `-c`-only cluster with other letters is
      // still placed by `shellDashCString` as before.
      const word = args[dashC]!;
      if (/[oO]/.test(word.slice(1))) return true;
      const rest = args.slice(dashC + 1);
      const at = shellDashCString(rest);
      if (at.ok === false) return true;
      const inner = at.word;
      // `bash -c -e`: no command string to read, but with a written or scratch path anywhere in the command, give no Allow.
      if (inner === "" && (written.size > 0 || scratchVars.size > 0 || scratchWord.test(c))) return true;
      if (inner === "") continue;
      if (written.size > 0 && named(inner)) return true; // the inner command may run what the outer one wrote
      if (usesScratchUnsafely(inner)) return true;
      continue;
    }
    const all = [...assigns.map((a) => a.slice(a.indexOf("=") + 1)), head, ...args];
    const hitsWritten = all.some(isWritten);
    const hitsScratch = hitsWritten || all.some(isScratch);
    if (!hitsScratch) continue;
    const name = head.replace(/^.*\//, "");
    if (head.includes("/") && !safe.has(name) && !tooling.has(name)) return true; // `/tmp/w.js`, `./w.js`, `/usr/bin/node /tmp/x`
    if (safe.has(name) && !head.includes("/")) {
      if (name === "find" || (name === "sed" && args.some((a) => /^-[a-zA-Z]*f|^--file/.test(a)))) return true;
      continue;
    }
    if (name === "find" && !args.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a))) continue;
    if (tooling.has(name)) {
      if (hitsWritten && name !== "git") return true; // git reads or stages a written file; its `-c` and exec forms are denied below
      if (args.some((a) => /^(?:exec|dlx|x|node|nodejs|python[\d.]*|sh|bash|zsh|env|eval|-c|--eval|--exec)$/.test(a)) || (name === "git" && args.includes("-c"))) return true;
      continue;
    }
    // `node scripts/build.js --out /tmp/out`: a plain interpreter whose script is a checked-in relative file. Nothing before
    // the script (flags, -I/tmp, an assignment) may be scratch or written; later words are the script's data.
    if (head === name && /^(?:python[\d.]*|node(?:js)?|perl|ruby|php|lua|deno|bun|Rscript|sh|bash|zsh|dash|ksh)$/.test(name) && !assigns.some((a) => isScratch(a) || isWritten(a.slice(a.indexOf("=") + 1)))) {
      // Inline code (-c / -e) is read by inlineCodeOk, which places the paths it names.
      const inl = args.findIndex((a) => !a.startsWith("-") || /^-[A-Za-z]*[ceE]$/.test(a));
      if (inl >= 0 && args[inl]!.startsWith("-") && !args.slice(0, inl).some((a) => isScratch(a) && /^-[A-Za-z]/.test(a) && !/^-[A-Za-z]$/.test(a))) continue;
      const at = args.findIndex((a) => !a.startsWith("-"));
      const before = at < 0 ? args : args.slice(0, at + 1);
      const script = at < 0 ? "" : args[at]!;
      if (at >= 0 && !/^[/~$]|\.\./.test(script) && !before.some((a) => isScratch(a) || isWritten(a))) continue;
    }
    return true;
  }
  return false;
}

/**
 * Inline code run by an interpreter (`python3 -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `lua -e`, an awk program, a
 * heredoc or pipe into one) is unknown and so denied, unless it provably does nothing that reaches a file: no file, process
 * or environment API at all, or only file APIs on literal paths that `writeOk` places, with no shell-out and no way to
 * build a path out of pieces. Interpreters that run a script file are not read here.
 */
function inlineCodeOk(c: string, writeOk: (t: string) => boolean): boolean {
  const interp = "python[\\d.]*|node(?:js)?|perl|ruby|php|lua|deno|bun|Rscript|tclsh|g?awk|mawk";
  // The interpreter is found wherever it stands (after env, timeout, xargs, a full path, `then` ...), not only first.
  const re = new RegExp(`(?<![\\w.-])(?:[\\w./-]*/)?(${interp})(?![\\w./-])((?:[^;&|\\n'"]|'[^']*'|"[^"]*")*)`, "g");
  const piped = new RegExp(`\\|\\s*(?:${interp})\\b`);
  // A command word that is a variable, `$(...)` or backtick is an unknown program: with -c/-e/-r it may be an interpreter.
  if (variableCommandWord(c)) return false;
  for (const m of c.matchAll(re)) {
    const name = m[1]!;
    const seg = m[0]!;
    const isAwk = /awk$/.test(name);
    const fed = /<<|\s-(?:\s|$)/.test(seg) || piped.test(c); // code arrives by heredoc or pipe
    // Inline when an option like -c / -e / -r comes before the first plain argument (which would be a script file).
    let inline = isAwk;
    for (const t of m[2]!.match(/'[^']*'|"[^"]*"|\S+/g) ?? []) {
      if (!t.startsWith("-") || t === "-") break;
      if (/^-[A-Za-z]*[ceErp]$/.test(t) || /^--(?:eval|command|print)\b/.test(t)) { inline = true; break; }
      if (isAwk && t === "-f") { inline = false; break; }
    }
    if (!inline && !fed) continue;
    const code = (fed ? c : seg).replace(/\\(["'`$])/g, "$1");
    const nodeOrPy = /^(?:python[\d.]*|node(?:js)?)$/.test(name);
    // Code this long is not read (and the matching below stays cheap on adversarial input).
    if (code.length > 3000) return false;
    // `chdir`, home lookups and dynamic imports make a path (or a call) depend on something we can't see.
    if (/\b(?:chdir|homedir|expanduser|userInfo|__import__|importlib|getattr|globals|pty)\b|\.home\s*\(/.test(code)) return false;
    // A Path method that writes must be called right on a literal Path('...').
    if ((code.match(/\.(?:write_text|write_bytes)\s*\(/g) ?? []).length !== (code.match(/\bPath\(\s*(['"])[^'"]*\1\s*\)\.(?:write_text|write_bytes)\s*\(/g) ?? []).length) return false;
    if (/child_process|subprocess|\b(?:system|popen|exec|execl\w*|execv\w*|spawn\w*|shell_exec|passthru|proc_open|qx|Open3|Kernel|eval|getline)\b|\b(?:execSync|execFileSync|spawnSync)\b/.test(code) || (!nodeOrPy && /\x60/.test(code))) return false;
    // A path is placed when it is a literal that writeOk accepts; a relative literal stays where the shell already is.
    const literalOk = (p: string): boolean => !p.includes("..") && (!/^[~/]/.test(p) || writeOk(p));
    const pathy = [...code.matchAll(/(?:^|[\s'"`=])((?:~|\/(?=[\w.@+-]))[\w.@+\/~-]*)(?=$|[\s'"`),;:])/g)].map((p) => p[1]!);
    if (pathy.some((p) => !literalOk(p))) return false;
    if (nodeOrPy) {
      // Every file call must name its path as a literal, or as a variable set once to a literal.
      const call = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|rename|unlinkSync|unlink|rmSync|rmdirSync|mkdirSync|mkdir|symlinkSync|symlink|linkSync|chmodSync|chownSync|truncateSync|open|Path|write_text|write_bytes|shutil\.\w+|os\.(?:remove|rename|unlink|mkdir|makedirs|rmdir|chmod|symlink|link|truncate|replace))\s*\(([^,)]*)(?:,([^,)]*))?[,)]/g; // disjoint groups: linear on unclosed input
      for (const k0 of code.matchAll(call)) {
        const k = [k0[0], k0[1], k0[2]?.trim(), k0[3]?.trim()] as (string | undefined)[];
        for (const arg of /^(?:copyFile|cpSync|copyFileSync|rename|renameSync|symlink|symlinkSync|linkSync|shutil|os\.(?:rename|replace|symlink|link))/.test(k[1]!) ? [k[2], k[3]] : [k[2]]) {
          if (arg === undefined || arg === "") continue;
          if (/^(?:['"][^'"$\\{}]*['"]|`[^`$\\]*`)$/.test(arg)) { if (!literalOk(arg.slice(1, -1))) return false; continue; }
          if (/^[\w.]+$/.test(arg) && /^[A-Za-z_]/.test(arg)) {
            const sets = [...code.matchAll(new RegExp(`(?:^|[\\s;,(])${arg.replace(/\./g, "\\.")}\\s*=\\s*(\\S[^;\\n]*?)\\s*(?:;|\\n|$)`, "g"))];
            const lit = sets.length === 1 ? /^['"]([^'"$\\{}]*)['"]$/.exec(sets[0]![1]!) : null;
            if (lit && literalOk(lit[1]!)) continue;
          }
          // Not a flag like 'r'/'w': those are second arguments to open and are short literals handled above.
          return false;
        }
      }
      continue;
    }
    // Other interpreters: no file or process API at all, or no way to build a path out of pieces.
    const touchesFiles = /\b(?:open|write\w*|append\w*|File|IO|FileUtils|unlink|remove|rename|copy\w*|move|mkdir\w*|symlink|chmod|chown|truncate|touch|file_put_contents|fopen|fwrite|require|import|Deno|Bun)\b|>\s*["'$\w/~]/.test(code);
    if (touchesFiles && /\+|\bjoin\b|%[sdr(]|\bformat\b|\bchr\b|fromCharCode|base64|b64|decode|\\x[0-9a-fA-F]|\\u|environ|\benv\b|HOME|argv|getenv|\$\{/.test(code)) return false;
  }
  return true;
}

/** Commands a cat/tee heredoc may be piped into without its body becoming code (BOS-727); any other stage keeps the body. */
const HEREDOC_SINK_SAFE = new Set("cat tee head tail wc sort uniq tr cut grep".split(" "));

/**
 * True when a `<<` in the original command may not be a real heredoc operator (or may be hidden from the operator
 * count): inside quotes, after a comment `#`, backslash-escaped, in `((...))` arithmetic, or on a command line that
 * leaves a quote open. Only command lines are scanned: heredoc bodies are skipped using the real operators found, so an
 * apostrophe in a file's text does not matter. One pass over the lines, so it is linear. (BOS-727)
 */
function hasUnreliableHeredocOps(original: string): boolean {
  const lines = original.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++]!;
    let quote = "";
    const ends: { dash: boolean; end: string }[] = [];
    let ops = 0;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k]!;
      if (quote === "'") { if (ch === "'") quote = ""; else if (ch === "<" && line[k + 1] === "<") return true; continue; }
      if (ch === "\\") {
        if (line[k + 1] === "<" && line[k + 2] === "<") return true;
        k++;
        continue;
      }
      if (quote === '"') { if (ch === '"') quote = ""; else if (ch === "<" && line[k + 1] === "<") return true; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "#" && (k === 0 || /[\s;&|(]/.test(line[k - 1]!))) return /<</.test(line.slice(k));
      if (ch === "<" && line[k + 1] === "<") {
        if (line[k + 2] === "<") { k += 2; continue; } // a here-string, no body
        ops++;
        const m = /^(-?)[ \t]*(['"]?)(\w+)\2/.exec(line.slice(k + 2, k + 202));
        if (m) ends.push({ dash: m[1] === "-", end: m[3]! });
        k++;
      }
    }
    if (quote) return true;
    if (ops > 0 && /\(\(/.test(line)) return true;
    for (const e of ends) {
      while (i < lines.length && (e.dash ? lines[i]!.replace(/^\t+/, "") : lines[i]!) !== e.end) i++;
      if (i >= lines.length) return false;
      i++;
    }
  }
  return false;
}

/**
 * Drops the bodies of heredocs that belong to cat/tee (text written to a file is data), and nothing else (BOS-727).
 * Every `<<` on a line is read in order, and the bodies that follow the line are taken in that order, so an earlier
 * interpreter heredoc keeps its body even when a cat heredoc comes later on the same line. A body is also kept when
 * the cat/tee output is run: sent to a process substitution (`> >(bash)`) or piped to anything but a plain text tool
 * (`| xargs rm`, `| python3`). A body whose end is not found, or one with `$(…)`/backticks under an unquoted delimiter
 * (bash expands those, BOS-725), is kept. One pass over the lines, so linear in the command.
 */
function dropCatHeredocBodies(text: string, original: string): string {
  if (!text.includes("<<")) return text;
  // `text` has had its quotes removed, so a `<<` that sat inside quotes or a comment looks like a real heredoc there.
  // Such a fake would pair with the wrong body and swallow a real interpreter's body, so the original is checked first.
  if (hasUnreliableHeredocOps(original)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    out.push(line);
    i++;
    const ops = [...line.matchAll(/(?<!<)<<(?!<)(-?)[ \t]*(['"]?)(\w+)\2/g)];
    if (ops.length === 0) continue;
    // Read the bodies in order; if any end is missing, keep everything from here on as it is.
    const bodies: { body: string[]; term: string; drop: boolean }[] = [];
    let j = i;
    let ok = true;
    for (const op of ops) {
      const [, dash, q, end] = op as unknown as [string, string, string, string];
      const body: string[] = [];
      while (j < lines.length && (dash ? lines[j]!.replace(/^\t+/, "") : lines[j]!) !== end) body.push(lines[j++]!);
      if (j >= lines.length) { ok = false; break; }
      const k = op.index!;
      const segStart = Math.max(line.lastIndexOf(";", k), line.lastIndexOf("&", k), line.lastIndexOf("|", k), line.lastIndexOf("(", k)) + 1;
      let drop = /^[ \t]*(?:cat|tee)\b/.test(line.slice(segStart, k)) && !/[;&|()]/.test(line.slice(segStart, k));
      if (drop && q === "" && /\$\(|\x60/.test(body.join("\n"))) drop = false;
      if (drop) {
        const rest = line.slice(segStart);
        // A process substitution is found from the `<<` on, not only as `>(`/`<(` after a space: `tee <<'EOF' >(bash)` and
        // `> >(bash)` put a separate `>` before the `(`, and `>>(bash)` glues it on, so neither matched (BOS-744).
        if (/[<>]\(/.test(rest.slice(k - segStart))) drop = false;
        else {
          const stages = rest.split(/(?<!\|)\|(?!\|)&?/).slice(1);
          if (stages.some((s) => !HEREDOC_SINK_SAFE.has(/^[ \t]*([\w.-]+)/.exec(s)?.[1] ?? ""))) drop = false;
        }
      }
      bodies.push({ body, term: lines[j]!, drop });
      j++;
    }
    if (!ok) { while (i < lines.length) out.push(lines[i++]!); break; }
    for (const b of bodies) {
      if (!b.drop) out.push(...b.body);
      out.push(b.term);
    }
    i = j;
  }
  return out.join("\n");
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
