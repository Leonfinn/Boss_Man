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
const INTERP_WORD = new RegExp(`^(?:${INTERP_NAMES})$`);
/** An interpreter named anywhere inside a `-c`/`-e` string a launcher runs. */
const INTERP_ANYWHERE = new RegExp(`(?:^|\\s)(?:[\\w./-]*/)?(?:${INTERP_NAMES})(?=\\s|$)`);
/** Command words the judge already unwraps: the real program follows, so they are not "unknown launchers". */
const KNOWN_WRAPPER = /^(?:then|do|else|exec|env|nohup|time|sudo|doas|xargs|command|nice|setsid|stdbuf|timeout|if|elif|while|until|!|builtin)$/;
/** Common programs whose later words are data, not a hidden command: never treated as an unknown launcher. */
const SAFE_COMMAND = /^(?:echo|printf|ls|cat|grep|egrep|rg|head|tail|wc|sort|uniq|cut|tr|diff|file|test|\[|true|false|pwd|whoami|date|uname|stat|du|df|ps|free|which|type|export|local|declare|readonly|set|unset|shift|return|exit|read|trap|break|continue|sleep|mkdir|touch|cp|mv|rm|rmdir|unlink|ln|chmod|chown|tee|find|git|pnpm|npm|yarn|make|docker|cd|pushd|popd|basename|dirname|realpath|readlink|jq|sed|awk|curl|wget|tar|gzip|gunzip|unzip|mistake)$/;

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

/**
 * True when a word that starts a command is an unknown launcher (not an interpreter, a wrapper the judge unwraps, or a
 * common safe program) and an interpreter follows it in the same segment; the interpreter may run a file that the judge
 * never reads that way (`flock /tmp/l node /tmp/x.js`, `busybox sh x.sh`).
 */
function unknownLauncherBeforeInterpreter(c: string): boolean {
  for (const seg of c.split(/&&|\|\||[;&|\n]+/)) {
    const words = shellWords(seg).filter((w) => w !== "");
    let i = 0;
    while (i < words.length && (/^\w+=/.test(words[i]!) || /^[({!]+$/.test(words[i]!))) i++;
    if (i >= words.length) continue;
    const base = (w: string): string => w.replace(/^.*\//, "");
    if (INTERP_WORD.test(base(words[i]!)) || SAFE_COMMAND.test(base(words[i]!))) continue;
    // Unwrap the known launchers (`nice -n 5 node`, `timeout 5 node`, `sudo -u x node`) to reach the command word.
    while (i < words.length && KNOWN_WRAPPER.test(base(words[i]!))) {
      i++;
      while (i < words.length && /^-\S*$|^\d+[a-z]*$|^\w+=\S*$/.test(words[i]!)) i++;
    }
    if (i >= words.length) continue;
    const head = base(words[i]!);
    if (INTERP_WORD.test(head) || SAFE_COMMAND.test(head)) continue;
    // The interpreter may be a whole word, or inside a `-c`/`-e` string the launcher runs (`su -c 'node /tmp/x.js'`).
    if (words.slice(i + 1).some((w) => INTERP_WORD.test(base(w)) || INTERP_ANYWHERE.test(w))) return true;
  }
  return false;
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
  // Inline code in an interpreter can write anywhere; it is read only when it provably touches no outside path.
  // Code handed to a shell or interpreter as a string (`sh -c '…'`, `env -S '…'`) is judged as if written plainly
  // (BOS-378, Rex's round 12). A program name written in disguise (`"node"`, `n\ode`, `$(which node)`) is read the same
  // way (BOS-378, Jane's round 12). Loader variables (NODE_OPTIONS, PYTHONSTARTUP, BASH_ENV, ...) are BOS-630, not here.
  if (!inlineCodeOk(c, writeOk) || runsUnreadFile(c, inOwn) || unknownLauncherBeforeInterpreter(c)) return result("outside");
  if (nestedCodeUnread(c, inOwn, writeOk)) return result("outside");
  if (disguisedInterpreter(c)) return result("outside");
  if (stdinToInterpreter(c)) return result("outside");
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
 * True when one option word means the interpreter's code is written inline, so no script file follows. Only `-c` (sh, bash,
 * zsh, dash, ksh), `-c`/`-m` (python) and the eval flags of the other interpreters (perl/ruby `-e`, php `-r`, lua/deno/bun
 * `-e`) count as inline; every other option (`-e`/`-E` on a shell, `-x`, `-u`, `-O`, `--norc`, ...) is skipped and the next
 * plain word is the script file, which then gets the path check (BOS-378, Jane round 12). `--eval`/`--command`/`--print`
 * and a bare `-` (code on stdin) are inline too.
 */
function inlineOption(name: string, t: string): boolean {
  if (t === "-" || /^--(?:eval|command|print)\b/.test(t)) return true;
  const m = /^-([A-Za-z]*)([ceErmp])$/.exec(t);
  if (!m) return false;
  const flag = m[2]!;
  if (/^(?:sh|bash|zsh|dash|ksh)$/.test(name)) return flag === "c";
  if (/^python[\d.]*$/.test(name)) return flag === "c" || flag === "m";
  if (/^(?:perl|ruby|lua|deno|bun|Rscript|tclsh)$/.test(name)) return flag === "e";
  if (name === "php") return flag === "r";
  if (/^node(?:js)?$/.test(name)) return flag === "e" || flag === "p";
  return false;
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
  const wrap = "(?:\\b(?:then|do|else|exec|env|nohup|time|sudo|doas|xargs|command|nice|setsid|stdbuf)\\s+|\\btimeout\\s+)";
  const re = new RegExp(`(?:^|[;&|(\\n{]\\s*|${wrap})(?:(?:-\\S+|\\d+\\w*|\\w+=\\S*)\\s+)*(?:[\\w./-]*/)?(${interp})(?![\\w./-])((?:[^;&|\\n'"]|'[^']*'|"[^"]*")*)`, "g");
  const unq = (t: string): string => t.replace(/^['"]+|['"]+$/g, "");
  // A script word must be a plain literal path (BOS-378): any quote, escape, brace or glob is unread, so risky.
  const risky = (raw: string, relOk: boolean): boolean => {
    const p = plainPath(raw);
    if (p === null) return raw !== "-"; // a disguised path word is never read as safe
    if (p === "" || p === "-") return false;
    if (/^~/.test(raw) || climbsOut(p) || /^\/tmp(\/|$)/.test(p)) return true;
    if (p.startsWith("/")) return !inOwn(p);
    return !relOk;
  };
  const writeOp = />|\btee\b|\bcp\b|\bmv\b|\bln\b|\binstall\b|\bdd\b|\bcurl\b|\bwget\b|\btouch\b|\bsed\b|\bpatch\b|\bgit\s+(?:apply|checkout|restore|am)\b|\bunzip\b|\btar\b/;
  // A relative path lands wherever the last `cd`/`pushd`/`env -C` went.
  let relOk = true;
  for (const d of cdWords(c)) {
    const p = plainPath(d);
    if (p === null || !dirOk(d, inOwn) || (/^[/~$]/.test(p) && !inOwn(p))) relOk = false;
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
    const awk = /awk$/.test(name);
    // Inline code (-c / -e ...) is read by inlineCodeOk; an awk program is inline unless it has -f. Only the inline options
    // count (BOS-378, Jane round 12): a skipped option like -e/-E leaves the next plain word as the script file.
    let inline = awk && !toks.includes("-f");
    for (const t of toks) {
      if (!t.startsWith("-") || t === "-") break;
      if (inlineOption(name, t)) { inline = true; break; }
      if (awk && t === "-f") { inline = false; break; }
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
 * Code handed to a shell or interpreter as one string, which the judge would otherwise never open: `sh -c '…'` /
 * `bash -c`, `env -S '…'`, and `su -c`/`doas -c` style launchers. The inner text is judged with the same outside checks
 * as if it were typed plainly, so a script file inside it (`bash -c 'bash /tmp/x'`) is read the same way (BOS-378, Rex
 * round 12). Allow-list: only the recognised `-c`/`-S` string forms are unwrapped; everything else is left to the checks
 * above. Bounded so nested `sh -c 'sh -c …'` strings can't recurse forever.
 */
function nestedCodeUnread(c: string, inOwn: (p: string) => boolean, writeOk: (t: string) => boolean, depth = 0): boolean {
  if (depth > 4) return true; // too deeply nested to read: no Allow
  const SHELL = /^(?:sh|bash|zsh|dash|ksh)$/;
  const INTERP = /^(?:python[\d.]*|node(?:js)?|perl|ruby|php|lua|deno|bun|Rscript|tclsh)$/;
  // Words that only wrap another program: skipped to reach the real command word (allow-list — anything else before a
  // shell/interpreter with a command string is an unknown launcher and gets no Allow).
  const WRAP = /^(?:then|do|else|exec|env|nohup|time|sudo|doas|xargs|command|nice|setsid|stdbuf|timeout|sup|su|doas|busybox|localhost|flock|ionice|chrt|chroot|nsenter|unshare|script|\{|\}|\(|\)|!)$/;
  const base = (w: string): string => w.replace(/^.*\//, "").replace(/^['"]+|['"]+$/g, "");
  // The inner string to judge, from a `-c` (shell/python), `-m` (python), `-S`/`--split-string` (env) or `-e`-style flag.
  const inlineString = (words: string[], name: string): string | null => {
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      // env -S '…', env --split-string='…', env -S'…'
      if (base(name) === "env" && (w === "-S" || /^--split-string=/.test(w))) {
        if (w === "-S") return words[i + 1] ?? null;
        return w.slice("--split-string=".length);
      }
      if (base(name) === "env" && /^-S\S/.test(w)) return w.slice(2);
      if (!w.startsWith("-") || w === "-") break;
      const short = /^-([A-Za-z]+)$/.exec(w);
      if (short) {
        const flags = short[1]!;
        if (SHELL.test(base(name)) && flags.includes("c")) return words[i + 1] ?? null;
        if (/^python[\d.]*$/.test(base(name)) && /[cm]/.test(flags)) return words[i + 1] ?? null;
      }
    }
    return null;
  };
  for (const seg of c.split(/&&|\|\||[;&|\n]+/)) {
    const toks = (seg.trim().match(/(?:\$\([^)]*\)|`[^`]*`|'[^']*'|"[^"]*"|\S)+/g) ?? []).map((t) => t.replace(/^[({]+(?=.)/, (m) => m));
    // `find … -exec sh -c '…' \;` / `-execdir` / `-ok`: judge the word after -exec as its own segment.
    for (let i = 0; i < toks.length; i++) {
      if (/^-(?:exec|execdir|ok|okdir)$/.test(toks[i]!) && toks[i + 1] !== undefined) {
        const rest = toks.slice(i + 1).join(" ").replace(/\s*\\?;?\s*$/, "");
        if (runsUnreadFile(rest, inOwn) || disguisedInterpreter(rest) || nestedCodeUnread(rest, inOwn, writeOk, depth + 1)) return true;
      }
    }
    // `env … -S '…'` / `env --split-string='…'`: env is a wrapper, but its split-string is a command to read, even after
    // other wrapper words or env options.
    const envAt = toks.findIndex((t) => /(?:^|\/)env$/.test(base(t)));
    if (envAt >= 0) {
      const inner = inlineString(toks.slice(envAt + 1), "env");
      if (inner !== null) {
        const body = inner.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
        if (body !== "" && !body.startsWith("-") && (runsUnreadFile(body, inOwn) || !inlineCodeOk(body, writeOk) || unknownLauncherBeforeInterpreter(body) || disguisedInterpreter(body) || nestedCodeUnread(body, inOwn, writeOk, depth + 1))) return true;
      }
    }
    // `su -c '…'`, `doas -c '…'`, `sudo -c '…'`, `busybox sh -c '…'`: the -c string is a command the judge must read.
    for (let k = 0; k < toks.length; k++) {
      if (!/^(?:su|doas|sudo|busybox|chroot|chrt|flock|ionice|nsenter|unshare)$/.test(base(toks[k]!))) continue;
      const body = inlineString(toks.slice(k + 1), "sh");
      if (body === null) continue;
      const t = body.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
      if (t !== "" && !t.startsWith("-") && (runsUnreadFile(t, inOwn) || !inlineCodeOk(t, writeOk) || unknownLauncherBeforeInterpreter(t) || disguisedInterpreter(t) || nestedCodeUnread(t, inOwn, writeOk, depth + 1))) return true;
    }
    // Walk the command words, skipping wrappers, to any shell/interpreter and its command string.
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_]\w*=/.test(toks[i]!) || /^[({!]+$/.test(toks[i]!) || WRAP.test(base(toks[i]!)))) {
      // `env -i`, `timeout 5`, `xargs -0`: consume an option or number that belongs to the wrapper.
      i++;
      while (i < toks.length && (/^-\S*$/.test(toks[i]!) || /^\d+[a-z]*$/.test(toks[i]!) || /^\w+=\S*$/.test(toks[i]!))) i++;
    }
    const head = toks[i];
    if (head === undefined) continue;
    const name = base(head);
    if (!SHELL.test(name) && !INTERP.test(name) && !/^env$/.test(name)) continue;
    const raw = inlineString(toks.slice(i + 1), name);
    if (raw === null) continue;
    // Drop the one layer of quotes the shell used to group the string; the inner text is then read as if typed plainly.
    const inner = raw.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
    if (inner === "") continue;
    if (inner.startsWith("-")) continue; // the string is flags for the interpreter, not a command
    if (runsUnreadFile(inner, inOwn) || !inlineCodeOk(inner, writeOk) || unknownLauncherBeforeInterpreter(inner) || disguisedInterpreter(inner)) return true;
    if (nestedCodeUnread(inner, inOwn, writeOk, depth + 1)) return true;
  }
  return false;
}

/**
 * True when code arrives at a shell or interpreter on stdin, which the judge can't read: a pipe into `bash`/`sh`/`python3`/
 * `node` with no script argument (`echo … | bash`, `… | sh -s`, `… | python3 -`), or a here-string `<<<`. A pipe into one
 * that names a checked-in script is left to runsUnreadFile (BOS-378, Rex round 13).
 */
function stdinToInterpreter(c: string): boolean {
  const SHELL = /^(?:sh|bash|zsh|dash|ksh)$/;
  const INTERP = /^(?:python[\d.]*|node(?:js)?|perl|ruby|php|lua|deno|bun)$/;
  const WRAP = /^(?:then|do|else|exec|env|nohup|time|sudo|doas|xargs|command|nice|setsid|stdbuf|timeout|su|busybox|flock|ionice|chrt|chroot|nsenter|unshare|script|\{|\}|\(|\)|!)$/;
  const base = (w: string): string => w.replace(/^.*\//, "").replace(/^['"]+|['"]+$/g, "");
  if (/(?:^|[\s;|&])<<<(?!<)\s*\S/.test(c)) return true;
  // Split into pipeline stages; a stage that reads the previous stage's output into a bare shell/interpreter runs code the
  // judge can't see. Only the stage's own command word and arguments are read, never any earlier command.
  const stages = c.split(/\|&?/);
  for (let s = 1; s < stages.length; s++) {
    const toks = (stages[s]!.trim().match(/(?:\$\([^)]*\)|`[^`]*`|'[^']*'|"[^"]*"|\S)+/g) ?? []) as string[];
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_]\w*=/.test(toks[i]!) || WRAP.test(base(toks[i]!)))) {
      i++;
      while (i < toks.length && (/^-\S*$/.test(toks[i]!) || /^\d+[a-z]*$/.test(toks[i]!) || /^\w+=\S*$/.test(toks[i]!))) i++;
    }
    const head = toks[i];
    if (head === undefined) continue;
    const name = base(head);
    if (!SHELL.test(name) && !INTERP.test(name)) continue;
    // A plain word after the interpreter is a script file (read by runsUnreadFile); only flags mean code comes from stdin.
    const args = toks.slice(i + 1).filter((w) => !/^\d*[<>]|^\d*>>?$|^&>/.test(w) && !/^-?\d+$/.test(w));
    if (args.some((w) => !w.startsWith("-"))) continue;
    return true;
  }
  return false;
}

/**
 * True when the command word is a disguised interpreter: its name is written with quotes, escapes, an empty-quote splice,
 * a variable or a `$(...)`/backtick lookup and, decoded, is a program (BOS-378, Jane round 12). `"node" /tmp/x.js`,
 * `n\ode /tmp/x.js`, `b''ash /tmp/x.sh`, `$(which node) /tmp/x.js`: the plain-name regexes above can't read these, so the
 * script file after them would otherwise escape the check. Allow-list: a command word that is a plain literal name is left
 * to the checks above. Only command words are read (after a separator or `then`/`do`/a known wrapper).
 */
function disguisedInterpreter(c: string): boolean {
  const words = "python[\\d.]*|node(?:js)?|perl|ruby|php|lua|deno|bun|Rscript|tclsh|g?awk|mawk|sh|bash|zsh|dash|ksh";
  const plain = new RegExp(`^(?:[\\w./-]*/)?(?:${words})$`);
  const wrap = /^(?:then|do|else|exec|env|nohup|time|sudo|doas|xargs|command|nice|setsid|stdbuf|flock|ionice|chrt|busybox|chroot|su|-exec|-execdir|-ok|-okdir)$/;
  for (const seg of c.split(/&&|\|\||[;&|\n]+/)) {
    // Keep `$(...)` and backtick lookups as one token, so a lookup of the program name is read whole.
    const toks = seg.trim().match(/(?:\$\([^)]*\)|`[^`]*`|'[^']*'|"[^"]*"|\S)+/g) ?? [];
    let i = 0;
    // Skip assignment prefixes, `{`/`(`/`!` and the known wrappers, like the other launcher checks.
    while (i < toks.length && (/^[A-Za-z_]\w*=/.test(toks[i]!) || /^[({!]+$/.test(toks[i]!))) i++;
    while (i < toks.length && wrap.test(toks[i]!.replace(/^.*\//, ""))) {
      i++;
      while (i < toks.length && /^-\S*$|^\d+[a-z]*$|^\w+=\S*$/.test(toks[i]!)) i++;
    }
    const raw = toks[i];
    if (raw === undefined) continue;
    // A plain literal command word is judged elsewhere; only disguised forms are read here.
    if (plain.test(raw)) continue;
    if (!/['"\\`$]/.test(raw)) continue;
    // Decode: drop quotes entirely, unescape, and strip a `$(,)`/backtick wrapper; the leftover must look like a program.
    const decoded = raw
      .replace(/\$\(\s*(?:[\w./-]*\/)?(?:which|type|command)\s+([\w.-]+)\s*\)/g, "$1")
      .replace(/[`](\s*(?:[\w./-]*\/)?([\w.-]+)\s*)[`]/g, "$2")
      .replace(/\$\([^)]*\)/g, "\u0000")
      .replace(/\\(.)/g, "$1")
      .replace(/['"]/g, "");
    if (decoded.includes("\u0000")) return true; // an unresolved substitution in the command word
    if (plain.test(decoded)) return true;
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
    // Inline when an inline option (-c/-e/-r/-m) comes before the first plain argument (which would be a script file). A
    // skipped option like a shell's -e/-E does not make it inline (BOS-378, Jane round 12).
    let inline = isAwk;
    for (const t of m[2]!.match(/'[^']*'|"[^"]*"|\S+/g) ?? []) {
      if (!t.startsWith("-") || t === "-") break;
      if (inlineOption(name, t)) { inline = true; break; }
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
