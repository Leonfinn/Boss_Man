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
  // Allow-list: a command that starts with git passes only as one of a short list of literal subcommands (no `$`, backtick,
  // `-c` or `--output` in its arguments) or the read-only config forms; everything else that starts with git is Deny.
  if (gitDenied(c)) return result("outside");
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
  if (!inlineCodeOk(c, writeOk)) return result("outside");
  if (writeTargets.some((t) => !writeOk(t))) return result("outside");
  // A redirect (or any write) after a `cd`/`pushd` somewhere else lands there: `pushd /home/node; echo x >> .bashrc`.
  const hasRedirect = />/.test(forTargets.replace(/\d*>>?\s*\/dev\/null|\d*>&\d|&>\s*\/dev\/null/g, ""));
  if (hasRedirect) for (const m of c.matchAll(/\b(?:cd|pushd|chdir)(?=[\s;&|)]|$)(?:\s+(?:--\s+)?['"]?([^\s;&|'")]*))?/g)) if (!dirOk(m[1] ?? "", inOwn)) return result("outside");
  const writes = /^(changes|deletes|unknown)$/.test(explainCommand(c).effect) || /rmSync|unlinkSync|writeFileSync|shutil\.rmtree|os\.remove|reset\s+--hard/.test(c) || new RegExp(DESTRUCTIVE, "i").test(c);
  if (writes) {
    for (const id of ids) if (own && id !== own && new RegExp(`(rm|rmSync|mv|reset|>|tee|cp)[^;&|\\n]*${id}`).test(c)) return result("outside");
    for (const m of c.matchAll(/\bcd\s+(?:\/[\w.@+-]+)*\/workspaces\/(?:tickets|reviews)\/([0-9a-f-]{36})/g)) if (own && m[1] !== own) return result("outside");
    const targets = [...c.matchAll(/(?:\brm\b|rmSync\(|rmtree\(|unlinkSync\()\s*(?:-\S+\s+)*['"]?((?:~|\$HOME|\/)[^\s'";|&)]*)/g)].map((m) => m[1]!);
    for (const t of targets) if (!/^\/tmp\//.test(t) && !inOwn(t) && t !== "/dev/null") return result("outside");
    // A relative target can climb out of the folder (`rm -rf ..`), and a `cd` somewhere else makes every relative target land there.
    for (const m of c.matchAll(/\brm\b([^;&|\n]*)/g)) if (/(^|[\s'"=/])\.\.(?=$|[\s'"/;|&)])/.test(m[1]!)) return result("outside");
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

/** Literal git subcommands that cannot write config or run a program of the agent's choosing. */
const GIT_SAFE = /^git (?:-C \S+ |--no-pager )*(?:commit|log|add|status|diff|show|checkout|switch|branch|tag|stash|merge|merge-base|merge-tree|rebase|rev-parse|rev-list|grep|push|pull|fetch|ls-tree|ls-files|ls-remote|check-ignore|worktree|archive|clone|rm|mv|reset|restore|cherry-pick|blame|describe|shortlog|cat-file|for-each-ref|show-ref|symbolic-ref|diff-tree|name-rev|reflog|clean|init|apply|am|remote -v)(?:\s|$)/;
const GIT_READ = /^git (?:config (?:--get(?:-all|-regexp|-urlmatch)? [\w.-]+|--list)|--version)$/;
const GIT_WRAPPER = /^(?:\w+=\S*|sudo|env|xargs|time|nohup|exec|command|nice|timeout|-\S*|\d+)$/;

/** True when a command that starts with git (after ;, |, $(, (, or a backtick) is not on the allow-list. */
function gitDenied(c: string): boolean {
  // Environment that makes git run a program (GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_PAGER, ...), set anywhere on a line that uses git.
  if (/\bgit\b/.test(c) && /(?:^|[\s;&|(])(?:export\s+|env\s+|declare\s+(?:-x\s+)?)?(?:GIT_\w+|PAGER|EDITOR|VISUAL|SSH_ASKPASS|LESSOPEN|LD_\w+)\+?=/.test(c)) return true;
  // A variable set exactly once to a plain path-like value (not an option) is read as that value.
  const plain = new Map<string, string>();
  for (const m of c.matchAll(/(?:^|[;&|\s])(\w+)=([\w./@+][\w./@+-]*)(?=$|[\s;&|)])/g)) plain.set(m[1]!, plain.has(m[1]!) ? "$" : m[2]!);
  for (const m of c.matchAll(/(?:^|[;&|\s])(\w+)\+?=/g)) if (plain.has(m[1]!) && (c.match(new RegExp(`(?:^|[;&|\\s])${m[1]!}\\+?=`, "g")) ?? []).length > 1) plain.set(m[1]!, "$");
  const known = (x: string): string => x.replace(/\$\{?(\w+)\}?/g, (all, n: string) => { const v = plain.get(n); return v !== undefined && v !== "$" ? v : all; });
  c = known(c);
  for (const seg of c.split(/[;&|\n]/)) {
    const parts = seg.split(/\$\(|[()\x60]/);
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]!.trim();
      // Quotes and backslashes removed, so `g''it` reads as `git`; the allow-list below still needs the raw text.
      const words = raw.replace(/['"\\]/g, "").split(/\s+/).filter(Boolean);
      let k = 0;
      while (k < words.length && GIT_WRAPPER.test(words[k]!)) k++;
      const head = words[k];
      if (head === undefined) continue;
      // An unknown program with arguments (`$g config x y`) could be git.
      if (i === 0 && /^(?:\$[\w{(@*#?!$]|\x60)/.test(head) && words.length - k > 1 && (!head.includes("/") || /\/git$/.test(head))) return true;
      if (!/^(?:[\w./-]*\/)?git(?:[$\x60{].*)?$/.test(head)) continue;
      if (GIT_READ.test(raw)) continue;
      // A substitution after the git word (`git log $(...)`) counts against it, except a plain `$(git <subcommand> ...)`, which is
      // read as its own command; single-quoted text and escaped \$ or backticks are literal.
      const text = (i === 0 ? seg : raw).replace(/'[^']*'/g, "''").replace(/\\[$`]/g, "").replace(/\$\(\s*git [^$`()]*\)/g, "");
      if (!GIT_SAFE.test(raw) || /[$\x60]/.test(text) || /(?:^|\s)-c|--output|--config-env|--ext-diff|--open-files-in-pager|--textconv|(?:^|\s)-[A-Za-z]*O|--exec-path|--upload-pack|--receive-pack|\s--exec\b/.test(text)) return true;
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
