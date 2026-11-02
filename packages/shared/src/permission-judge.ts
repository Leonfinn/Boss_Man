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

/** Longest command the judge reads; longer ones are denied unread. */
export const MAX_JUDGED_COMMAND = 10_000;

const result = (row: JudgeRow): JudgeReading => ({ verdict: row === "ok" ? "allow" : "deny", row, reasonLabel: JUDGE_LABELS[row] });

/**
 * @param question the card's plain-English text (used when there is no command to read)
 * @param command the shell command, or null for a tool call without one
 * @param ownFolder id of the ticket folder the asking agent works in, when the caller knows it;
 *   otherwise it is read from a leading `cd` or the most-named folder in the command.
 * @param ownProject name of the agent's own folder under `.claude/projects/`; only its `memory/` sub-folder
 *   may be written. Without it every `.claude` path is treated as shared.
 */
export function judgePermission(question: string, command: string | null, ownFolder?: string, ownProject?: string): JudgeReading {
  if (!command) return judgeWithoutCommand(question, ownFolder, ownProject);
  // The patterns below are not built for huge input (and run on the server loop): refuse to read it.
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
  if (/\bsed\s+-i\b|>>?|\btee\b|\bcp\b|\bmv\b|\brm\b/.test(c) && /\/workspaces\/repos\//.test(c)) return result("outside");
  // Any write must land in /tmp, the agent's own ticket folder, /dev/null or its own memory folder. Shared startup and
  // settings files (~/.bashrc, ~/.gitconfig, /etc/..., /usr/local/bin/...) are not the agent's to change.
  if (/\bgit\s+config\s+(?:-\S+\s+)*--(global|system|file|worktree)\b/.test(c)) return result("outside");
  const writeOk = (t: string): boolean => {
    const p = t.replace(/^['"]+|['"]+$/g, "");
    if (/^OWNDIR(\/[\w.@+-]+)*$/.test(p) && !p.includes("..")) return true;
    if (p === "MEMORY_PATH" || p === "/dev/null" || /^\/dev\/(stdout|stderr|fd\/\d+)$/.test(p)) return true;
    if (p.includes("..")) return false;
    if (/^\/tmp(\/|$)/.test(p)) return true;
    return !!own && new RegExp(`^/[\\w./@+-]*/${own}(/|$)`).test(p);
  };
  // Variables set in the same command are resolved; any other variable (and $(...)) can't be, so its target is denied.
  // $(git rev-parse --git-dir ...) is the asking agent's own git folder and $(mktemp ...) lands in /tmp.
  const safeSubst = (x: string): string => x
    .replace(/\$\(\s*git\s+(?:-C\s+\S+\s+)?rev-parse\s+(?:--absolute-git-dir|--git-dir|--show-toplevel|--git-path\s+[\w./-]+)\s*\)/g, "OWNDIR")
    .replace(/\$\(\s*mktemp\b([^)\x60$]*)\)/g, (_a, args: string) => /\/tmp\/[\w.-]*/.exec(args)?.[0] ?? "/tmp/mk");
  const cs = safeSubst(c);
  const assigned0 = new Map([...cs.matchAll(/(?:^|[;&|\s])(\w+)=(['"]?)(OWNDIR|\/tmp\/[\w.-]*)\2(?=$|[\s;&|)])/g)].map((m) => [m[1]!, m[3]!] as const));
  const cs2 = cs.replace(/\$\(\s*dirname\s+['"]?\$\{?(\w+)\}?['"]?\s*\)/g, (all, n: string) => assigned0.get(n) ?? all);
  const assigned = new Map([...cs2.matchAll(/(?:^|[;&|\s])(\w+)=(['"]?)([^\s'";|&)$\x60]+)\2(?=$|[\s;&|)])/g)].map((m) => [m[1]!, m[3]!] as const));
  const resolve = (t: string): string => t.replace(/\$\{?(\w+)\}?/g, (all, name: string) => (name !== "HOME" && assigned.has(name) ? assigned.get(name)! : all));
  // A sed script is not a path (unless it can write one: `w /file`).
  const forTargets = cs2.replace(/(\bsed\s+(?:-\S+\s+)*)('[^']*'|"[^"]*")/g, (all, head: string, script: string) => (/[wWe]\s*(\/|~|\$)/.test(script) ? all : head + "SCRIPT"));
  const writeTargets: string[] = [];
  for (const m of forTargets.matchAll(/>>?\s*(['"]?(?:[~/$]|OWNDIR)[^\s'";|&)<>]*)/g)) { const r = resolve(m[1]!); if (/^['"]*[~/$\x60]/.test(r) || /\$|\x60|OWNDIR/.test(r)) writeTargets.push(r); }
  for (const m of forTargets.matchAll(/\b(?:cp|mv|tee|ln|install|touch|chmod|chown|truncate|dd|rsync|sed\s+-i\S*|perl\s+-pi\S*)\b([^;&|\n]*)/g)) {
    for (const tok of m[1]!.split(/\s+/)) {
      // Plain, `--opt=/x`, `of=/x` and `-t/x` forms.
      for (const cand of [tok, tok.split("=").slice(1).join("="), tok.replace(/^-\w(?=['"]?[~/$])/, "")]) {
        const r = resolve(cand);
        if (/^['"]*[~/$\x60]/.test(r) || /\$|\x60|OWNDIR/.test(r)) writeTargets.push(r);
      }
    }
  }
  if (writeTargets.some((t) => !writeOk(t))) return result("outside");
  const writes = /^(changes|deletes|unknown)$/.test(explainCommand(c).effect) || /rmSync|unlinkSync|writeFileSync|shutil\.rmtree|os\.remove|reset\s+--hard/.test(c) || new RegExp(DESTRUCTIVE, "i").test(c);
  if (writes) {
    for (const id of ids) if (own && id !== own && new RegExp(`(rm|rmSync|mv|reset|>|tee|cp)[^;&|\\n]*${id}`).test(c)) return result("outside");
    for (const m of c.matchAll(/\bcd\s+(?:\/[\w.@+-]+)*\/workspaces\/(?:tickets|reviews)\/([0-9a-f-]{36})/g)) if (own && m[1] !== own) return result("outside");
    const targets = [...c.matchAll(/(?:\brm\b|rmSync\(|rmtree\(|unlinkSync\()\s*(?:-\S+\s+)*['"]?((?:~|\$HOME|\/)[^\s'";|&)]*)/g)].map((m) => m[1]!);
    for (const t of targets) if (!/^\/tmp\//.test(t) && !(own && t.includes(own)) && t !== "/dev/null") return result("outside");
    // A relative target can climb out of the folder (`rm -rf ..`), and a `cd` somewhere else makes every relative target land there.
    for (const m of c.matchAll(/\brm\b([^;&|\n]*)/g)) if (/(^|[\s'"=/])\.\.(?=$|[\s'"/;|&)])/.test(m[1]!)) return result("outside");
    for (const m of c.matchAll(/\bcd\s+(?:--\s+)?['"]?([^\s;&|'")]*)/g)) {
      const dir = m[1]!;
      if (dir === "" || dir === "-") continue;
      if (/^\/tmp(\/|$)/.test(dir) && !dir.includes("..")) continue;
      if (own && dir.includes(own) && !dir.includes("..")) continue;
      if (/^[\w.@+-]+(\/[\w.@+-]+)*$/.test(dir) && !dir.includes("..")) continue; // a sub-folder of where it already is
      return result("outside");
    }
    // `find <path> ... -delete` / `-exec rm`: the start path decides.
    for (const m of c.matchAll(/\bfind\s+((?:-[HLP]\s+)*)([^\s-][^\s]*|)[^\n;&|]*?(-delete\b|-exec\s+rm\b)/g)) {
      const start = m[2]!;
      if (start === "" || start === "." || (/^[\w.@+-]+(\/[\w.@+-]+)*$/.test(start) && !start.includes(".."))) continue;
      if (/^\/tmp\//.test(start) && !start.includes("..")) continue;
      if (own && start.includes(own) && !start.includes("..")) continue;
      return result("outside");
    }
  }
  return result("ok");
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
