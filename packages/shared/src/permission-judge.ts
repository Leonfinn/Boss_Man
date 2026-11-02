import { explainCommand, readPush } from "./explain.js";
import { DESTRUCTIVE, isPrivateHost } from "./policy.js";

/**
 * The rules judge (BOS-337, from the BOS-329 study): where does this request reach? An ordered table
 * of rows; the first row that matches denies, otherwise it is allowed. It only picks the card's
 * suggested button. It never answers a card, and the hard gates (pushes to main, publishing,
 * deploys, secrets, the private network, other agents' work) stay decided by the fixed policy.
 */
export type JudgeRow = "noTarget" | "secret" | "others" | "outward" | "privateNet" | "opaque" | "outside" | "ok";

/** The reason shown on the card for each row: fixed, written by us, never built from the command. */
export const JUDGE_LABELS: Record<JudgeRow, string> = {
  noTarget: "It doesn't say which file, tool or address it touches",
  secret: "It could show or send a secret (tokens, keys, environment values)",
  others: "It could affect other agents' work or shared folders",
  outward: "It pushes to main, force-pushes, deletes a branch, publishes, deploys or restarts a service",
  privateNet: "It contacts the home network or the machine's metadata service",
  opaque: "It runs code it downloads or decodes, so what it does can't be read",
  outside: "It changes or deletes files outside its own folder and /tmp",
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

const result = (row: JudgeRow): JudgeReading => ({ verdict: row === "ok" ? "allow" : "deny", row, reasonLabel: JUDGE_LABELS[row] });

/**
 * @param question the card's plain-English text (used when there is no command to read)
 * @param command the shell command, or null for a tool call without one
 * @param ownFolder id of the ticket folder the asking agent works in, when the caller knows it;
 *   otherwise it is read from a leading `cd` or the most-named folder in the command.
 */
export function judgePermission(question: string, command: string | null, ownFolder?: string): JudgeReading {
  if (!command) return judgeWithoutCommand(question);
  // Text written to a file by cat/tee is data, not commands: drop those heredoc bodies (interpreter heredocs stay, they run).
  const c = command.replace(/((?:\bcat|\btee)\b[^\n]*?<<-?\s*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?)\n\3(?=\n|$)/g, (_m, head: string, _q, end: string) => head + end);
  const ids = [...c.matchAll(WORKSPACE)].map((m) => m[1]!);
  const own = ownFolder ?? LEADING_CD.exec(c)?.[1] ?? [...ids].sort((a, b) => ids.filter((x) => x === b).length - ids.filter((x) => x === a).length)[0];

  // Outward actions.
  if (readPush(c)?.dangerous) return result("outward");
  if (/\bgit\s+push\b[^;&|\n]*(\s-f\b|--force|\s\+\S|:main\b|:master\b|--delete|\s:\S)/.test(c)) return result("outward");
  if (/\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+(push|restart|stop|kill|rm|compose|run)\b|\bsystemctl\b|\bservice\s+\w+\s+(restart|stop)|\bgh\s+pr\s+merge\b|\bdeploy(\.sh)?\b[^\n]*\b(prod|production)\b|\bcrontab\b/.test(c)) return result("outward");
  if (/os\.system\([^)]*git\s+push|execSync\([^)]*git\s+push/.test(c)) return result("outward");
  // Secrets.
  if (/\/run\/secrets|\.git-credentials|\.netrc|\/\.ssh\/|\/environ\b|\bprintenv\b|process\.env\b|os\.environ\b/.test(c)) return result("secret");
  if (/(^|[;&|(]\s*|\s)env\s*($|[|;&>)])/.test(c) && !/env\s*\|\s*cut\s+-d\s*=?\s*['"]?=['"]?\s+-f\s*1/.test(c)) return result("secret");
  if (/\$\{?\w*(TOKEN|SECRET|PASSWORD|API_KEY)\w*\}?/.test(c)) return result("secret");
  // Other agents and shared things.
  if (/\b(pkill|killall)\b|\bkill\s+(-\w+\s+)*\$\(/.test(c)) return result("others");
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
  if (/base64\s+(-d|--decode)[^\n]*\|\s*(sh|bash|zsh)\b|\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b|\beval\s+["'$]/.test(c)) return result("opaque");
  // Writes and deletes outside its own folder and /tmp.
  const writes = /^(changes|deletes|unknown)$/.test(explainCommand(c).effect) || /rmSync|unlinkSync|writeFileSync|shutil\.rmtree|os\.remove|reset\s+--hard/.test(c) || new RegExp(DESTRUCTIVE, "i").test(c);
  if (writes) {
    for (const id of ids) if (own && id !== own && new RegExp(`(rm|rmSync|mv|reset|>|tee|cp)[^;&|\\n]*${id}`).test(c)) return result("outside");
    const targets = [...c.matchAll(/(?:\brm\b|rmSync\(|rmtree\(|unlinkSync\()\s*(?:-\S+\s+)*['"]?((?:~|\$HOME|\/)[^\s'";|&)]*)/g)].map((m) => m[1]!);
    for (const t of targets) if (!/^\/tmp\//.test(t) && !(own && t.includes(own)) && t !== "/dev/null") return result("outside");
  }
  return result("ok");
}

/** A tool call with no command: judged from the card's text, and unknown tools can't be vouched for. */
function judgeWithoutCommand(question: string): JudgeReading {
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
  const paths = [...question.matchAll(/(\/[\w.@+/-]+)/g)].map((m) => m[1]!);
  if (change && paths.some((p) => !/^\/tmp\//.test(p) && !WORKSPACE_PATH.test(p))) return result("outside");
  return result("ok");
}

/** The company setting: off, watch (log next to the human's answer only) or advise (sets the suggested button). There is no "act": the judge never answers a card. */
export const PERMISSION_JUDGE_MODES = ["off", "watch", "advise"] as const;
export type PermissionJudgeMode = (typeof PERMISSION_JUDGE_MODES)[number];
