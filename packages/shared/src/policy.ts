// Permission rules (R19, R22). An agent's request to run a tool is matched against the
// company's rules, then global rules, then these defaults; the first match decides.
// "ceo" and "owner" outcomes become decision-queue rows; the agent waits for the answer.

import { commandRisks, type Risk } from "./destructive.js";
import { cleanupScope, explainCommand, tempCleanup } from "./explain.js";

export type PolicyOutcome = "allow" | "deny" | "ceo" | "owner";

export type PermissionInfo = {
  title: string | null;
  /** ACP tool kind: read, edit, delete, move, search, execute, think, fetch, other. */
  kind: string | null;
  rawInput: unknown;
};

export type PolicyMatch = {
  kinds?: string[];
  /** Regular expression tested against the shell command, when there is one. */
  commandPattern?: string;
  /** Regular expression tested against the tool call's title. */
  titlePattern?: string;
  /** Never matches a command the built-in rules send to the owner (destructive, push). Set on rules made by "Allow always". */
  safeOnly?: boolean;
  /** Only matches a shell command whose every change or deletion is under /tmp, with no push, network or program Boss Man can't see into. Set by the owner's "/tmp only" switch. */
  scratchOnly?: boolean;
  /** Only matches a shell command whose every delete is of an entry directly in /tmp, with nothing else destructive or pushing (BOS-111, tempCleanup in explain.ts). */
  tempCleanupOnly?: boolean;
  /** Only matches a shell command written as one string whose deletes include plain relative paths in the working copy, the rest as tempCleanupOnly (BOS-120, cleanupScope in explain.ts). */
  workingCopyOnly?: boolean;
  /** Only matches a shell command that deletes or destroys data, judged by what each part runs (BOS-116, destructive.ts). */
  destructive?: boolean;
  /** Only matches a shell command that pushes or publishes, judged the same way. */
  pushing?: boolean;
};

export type PolicyRuleSpec = { name: string; match: PolicyMatch; outcome: PolicyOutcome };

/** The owner's opt-in standing rule for scratch work (Rules page switch). */
export const SCRATCH_RULE: PolicyRuleSpec = { name: "Always allow commands that only work in /tmp", match: { kinds: ["execute"], scratchOnly: true }, outcome: "allow" };

// The old text patterns, kept as a second net under commandRisks (BOS-116): anything they caught is still caught.
// rm's -r/-f may come after other flags or the paths (GNU rm reads `rm x -rf`), or be spelled long; find deletes with -delete or -exec.
export const DESTRUCTIVE = String.raw`\brm\s+(?:[^\s;&|]+\s+)*?(?:-[a-zA-Z]*[rf][a-zA-Z]*|--(?:recursive|force))\b|\bfind\b[^;&|\n]*\s-(?:delete|exec(?:dir)?\s+(?:rm|rmdir|unlink|shred|truncate))\b|\bmkfs\b|\bdd\s+if=|\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b|\bgit\s+push\s+.*--force\b|\bzfs\s+destroy\b|\bshred\b`;

export const PUSHING = String.raw`\b(git\s+push|npm\s+publish|docker\s+push)\b`;

export const TEMP_CLEANUP_RULE = "Temp-file cleanup goes to the CEO first";
export const WORKING_COPY_RULE = "Deletes in the agent's own working copy go to the CEO first";

export const DEFAULT_POLICY: PolicyRuleSpec[] = [
  { name: "Boss Man's own tools", match: { titlePattern: String.raw`^(mcp__bossman__|mcp\.bossman\.)` }, outcome: "allow" },
  // Before the owner rule: cleaning up /tmp is the CEO's call, and reaches the owner only if the CEO escalates it (BOS-111).
  { name: TEMP_CLEANUP_RULE, match: { kinds: ["execute"], destructive: true, tempCleanupOnly: true }, outcome: "ceo" },
  // The same for plain relative paths in the agent's checkout; the server sends it to the owner when the run has no checkout (BOS-120).
  { name: WORKING_COPY_RULE, match: { kinds: ["execute"], destructive: true, workingCopyOnly: true }, outcome: "ceo" },
  { name: "Destructive commands go to the owner", match: { destructive: true }, outcome: "owner" },
  { name: "Pushing and publishing go to the owner", match: { pushing: true }, outcome: "owner" },
  { name: "Reading, searching and editing the workspace", match: { kinds: ["read", "search", "edit", "think", "fetch"] }, outcome: "allow" },
  { name: "Other shell commands", match: { kinds: ["execute"] }, outcome: "allow" },
  // Anything else (delete, move, unknown tools) falls through to the owner.
];

/** ACP tool kinds a rule can match on. */
export const TOOL_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"] as const;

/** What's wrong with a rule's match, if anything: it needs a condition, and its patterns must compile. */
export function ruleProblems(match: PolicyMatch): string[] {
  const problems: string[] = [];
  if (!match.kinds?.length && !match.commandPattern && !match.titlePattern && !match.scratchOnly && !match.destructive && !match.pushing) problems.push("Give the rule at least one condition: tool kinds, a command pattern or a title pattern.");
  for (const k of match.kinds ?? []) if (!(TOOL_KINDS as readonly string[]).includes(k)) problems.push(`"${k}" isn't a tool kind. Use: ${TOOL_KINDS.join(", ")}.`);
  for (const [label, p] of [["command pattern", match.commandPattern], ["title pattern", match.titlePattern]] as const) {
    if (p == null) continue;
    if (p.length > 500) problems.push(`The ${label} is too long (500 characters at most).`);
    else if (!safeRegex(p)) problems.push(`The ${label} isn't a valid regular expression.`);
  }
  return problems;
}

export function commandOf(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const c = (rawInput as Record<string, unknown>)["command"] ?? (rawInput as Record<string, unknown>)["cmd"];
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) return c.join(" ");
  return null;
}

/** Programs that only ever use their quoted arguments as text (a message, a pattern), never run them. `printf -v` stores its text in a variable that can be run, so it's not one of them. */
const DATA_ONLY = /^(?:echo|printf(?!\s+(?:--\s+)?-v)|grep|egrep|fgrep|git\s+(?:commit|tag)|(?:gh|glab)\s+(?:pr|issue|release|mr))(?=\s|$)/;

/**
 * The command for the text patterns, with quoted text blanked only where it can't run: the
 * arguments of a DATA_ONLY program written alone (`git commit -m 'stop rm -rf'`). Anywhere else
 * quoted text may be run by a program the reader doesn't know (tmux new 'rm -rf x', at, docker
 * exec, sed '1e …'), so it stays (BOS-116 review). Only a lone command is exempt: chained after
 * anything, the text can reach a runner (git's COMMIT_EDITMSG, `git log > a.sh`, an earlier
 * `exec >file`), so with ; & && || | or a newline nothing is blanked. Nor with heredocs,
 * substitutions, definitions, a comment or $'…' quoting, which this scan would misread. A
 * redirect into a file keeps the text too (`echo 'rm -rf x' >> ~/.bashrc`).
 */
function dataText(cmd: string): string {
  if (/<<|[<>]\(|`|\$\(|\$['"]|\(\s*\)|\bfunction\s|\balias\b|\bPATH=|\bhash\s/.test(cmd)) return cmd;
  const segs: Array<{ start: number; quotes: Array<[number, number]>; writes?: boolean }> = [{ start: 0, quotes: [] }];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === "\\") i++;
    else if (c === "#") return cmd;
    else if (c === ">" && !/^>>?\|?\s*(?:\/dev\/null|&\d)(?=[\s;&|)]|$)/.test(cmd.slice(i))) segs.at(-1)!.writes = true;
    // &> and >& are redirects, not a background &: the segment (and its writes) goes on.
    else if (c === "&" && (cmd[i + 1] === ">" || cmd[i - 1] === ">")) continue;
    else if (c === "'" || c === '"') {
      let e = i + 1;
      for (; e < cmd.length && cmd[e] !== c; e++) if (c === '"' && cmd[e] === "\\") e++;
      if (e >= cmd.length) return cmd;
      segs.at(-1)!.quotes.push([i, e + 1]);
      i = e;
    } else if (c === "|" && cmd[i + 1] !== "|" && cmd[i - 1] !== "|") return cmd;
    else if (/[;&|\n]/.test(c)) segs.push({ start: i + 1, quotes: [] });
  }
  // A trailing ; or & leaves an empty segment, which chains nothing.
  const used = segs.filter((s, i) => i === 0 || cmd.slice(s.start, segs[i + 1]?.start ?? cmd.length).replace(/[;&|\n]/g, "").trim());
  const s = segs[0]!;
  if (used.length > 1 || s.writes || !DATA_ONLY.test(cmd.trimStart())) return cmd;
  let out = cmd;
  for (const [a, b] of s.quotes.reverse()) out = out.slice(0, a) + "''" + out.slice(b);
  return out;
}

/** What a request's shell command destroys or pushes. An argv array is read as its words, so ["bash", "-lc", "…"] keeps its script whole. */
function risksOf(info: PermissionInfo): Risk[] {
  const raw = info.rawInput && typeof info.rawInput === "object" ? (info.rawInput as Record<string, unknown>) : {};
  const argv = raw["command"] ?? raw["cmd"];
  if (Array.isArray(argv) && argv.every((x) => typeof x === "string")) return commandRisks(argv);
  const cmd = commandOf(info.rawInput) ?? (info.kind === "execute" ? info.title : null);
  return cmd ? commandRisks(cmd) : [];
}

const hits = (info: PermissionInfo, kind: Risk["kind"], legacy: string) => {
  const cmd = commandOf(info.rawInput) ?? (info.kind === "execute" ? info.title : null) ?? "";
  return risksOf(info).some((r) => r.kind === kind) || new RegExp(legacy, "i").test(dataText(cmd));
};
export const isDestructive = (info: PermissionInfo) => hits(info, "destroys", DESTRUCTIVE);
export const isPushing = (info: PermissionInfo) => hits(info, "pushes", PUSHING);

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function matches(rule: PolicyMatch, info: PermissionInfo): boolean {
  // OpenCode asks about some shell commands (e.g. outside its folder) with kind "other"; a command is still a command.
  const kind = (!info.kind || info.kind === "other") && commandOf(info.rawInput) ? "execute" : info.kind;
  if (rule.kinds && !(kind && rule.kinds.includes(kind))) return false;
  if (rule.commandPattern) {
    const cmd = commandOf(info.rawInput) ?? (info.kind === "execute" ? info.title : null);
    const re = safeRegex(rule.commandPattern);
    if (!cmd || !re || !re.test(cmd)) return false;
  }
  if (rule.safeOnly && (isDestructive(info) || isPushing(info))) return false;
  if (rule.destructive && !isDestructive(info)) return false;
  if (rule.pushing && !isPushing(info)) return false;
  if (rule.scratchOnly) {
    // shortcut: paths are checked as written, so a symlink inside /tmp pointing elsewhere isn't caught; resolving them needs the runner's filesystem.
    const scratch = explainCommand(commandOf(info.rawInput) ?? "").scratch;
    if (!scratch || scratch.unchecked.length) return false;
  }
  // A string only: an argv array runs without a shell, so tempCleanup's and cleanupScope's reading of ; and && wouldn't hold.
  const shellCmd = (info.rawInput as Record<string, unknown> | null)?.["command"];
  if (rule.tempCleanupOnly && !(typeof shellCmd === "string" && tempCleanup(shellCmd))) return false;
  if (rule.workingCopyOnly && !(typeof shellCmd === "string" && cleanupScope(shellCmd)?.workingCopy.length)) return false;
  if (rule.titlePattern) {
    const re = safeRegex(rule.titlePattern);
    if (!info.title || !re || !re.test(info.title)) return false;
  }
  return Boolean(rule.kinds || rule.commandPattern || rule.titlePattern || rule.scratchOnly || rule.destructive || rule.pushing);
}

/** Addresses a fetch must not reach: the home network and the machine itself (SSRF). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h.includes(".") && !h.includes(":")) return true; // a bare name like "truenas" or "localhost"
  if (/(^|\.)(localhost|local|lan|internal|localdomain|home\.arpa)$/.test(h)) return true;
  // IPv4-mapped IPv6 (the URL parser writes ::ffff:192.168.0.1 as ::ffff:c0a8:1).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  const v4 = mapped ? [parseInt(mapped[1]!, 16) >> 8, parseInt(mapped[1]!, 16) & 255, parseInt(mapped[2]!, 16) >> 8, parseInt(mapped[2]!, 16) & 255] : /^\d+\.\d+\.\d+\.\d+$/.test(h) ? h.split(".").map(Number) : null;
  if (v4) {
    const [a, b] = v4 as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}

/** Every web address in a tool call's input, to two levels deep (e.g. crawl4ai's url and urls). */
function urlsIn(rawInput: unknown, depth = 0): string[] {
  if (typeof rawInput === "string") return /^(https?|wss?):\/\//i.test(rawInput.trim()) ? [rawInput.trim()] : [];
  if (!rawInput || typeof rawInput !== "object" || depth > 2) return [];
  return Object.values(rawInput as Record<string, unknown>).flatMap((v) => urlsIn(v, depth + 1));
}

const LAN_GUARD = "Fetching from your home network or this machine is blocked";

/** True when a fetch, or a call to an outside tool server, aims at a private address. Unparseable addresses count as private. */
export function reachesPrivateNetwork(info: PermissionInfo): boolean {
  const outside = /^mcp__(?!bossman__)/.test(info.title ?? "") || info.kind === "fetch";
  if (!outside) return false;
  return urlsIn(info.rawInput).some((u) => {
    try {
      return isPrivateHost(new URL(u).hostname);
    } catch {
      return true;
    }
  });
}

export function evaluatePermission(info: PermissionInfo, rules: PolicyRuleSpec[]): { outcome: PolicyOutcome; rule: string } {
  // Checked before any rule, so an "Allow always" can't lift it. shortcut: checks the address asked for, not where DNS or a redirect lands; a network-level block on the tool containers is the full fix.
  if (reachesPrivateNetwork(info)) return { outcome: "deny", rule: LAN_GUARD };
  for (const rule of [...rules, ...DEFAULT_POLICY]) {
    if (matches(rule.match, info)) return { outcome: rule.outcome, rule: rule.name };
  }
  return { outcome: "owner", rule: "No rule matched" };
}

/** Build output in the agent's working folder (node_modules, dist…), by a plain relative path: no component starting with a dot (so no .., . or .git), no ~, $ or globs. Source folders such as src aren't vouched for. */
const WORKSPACE_DELETE = /^rm(?:\s+(?:--?[A-Za-z][A-Za-z-]*|--))*(?:\s+(?:[\w+@-][\w.+@-]*\/)*(?:node_modules|dist|build|coverage|out|target)\/?)+(?:\s+(?:(?:[12]|&)?>>?\s*\/dev\/null|2>&1))*$/;

/**
 * What the decision queue recommends for an escalated request (BOS-111). Deleting or changing
 * files isn't a reason to refuse on its own: temp-file cleanup and deletes of build output in the
 * working folder are recommended Allow. Deny is for deletes Boss Man can't vouch for (absolute
 * paths outside /tmp, ~, variables, globs, a cd out of /tmp) and for the other destructive commands
 * (mkfs, dd, docker rm, force push, zfs destroy, shred). It only picks the suggested button.
 */
export function recommendedVerdict(info: PermissionInfo): "allow" | "deny" {
  const cmd = commandOf(info.rawInput) ?? info.title ?? "";
  const run = dataText(cmd);
  const hits = run.match(new RegExp(DESTRUCTIVE, "gi")) ?? [];
  // What the reader finds (BOS-116), as well as the text patterns.
  const found = risksOf(info).filter((r) => r.kind === "destroys");
  // Destructive commands that aren't file deletes are Deny even in /tmp (shred /tmp/a); find -delete counts as a delete.
  if ([...hits, ...found.map((r) => r.text)].some((h) => !/^(rm|find)\b/i.test(h))) return "deny";
  // A command that only works in /tmp, with nothing in it Boss Man can't check, is safe too.
  const scratch = explainCommand(cmd).scratch;
  if (tempCleanup(cmd) || (scratch && !scratch.unchecked.length)) return "allow";
  // Of the reader's findings, only a plainly written rm of build output can be vouched for.
  if (found.some((r) => !r.plain || !WORKSPACE_DELETE.test(r.text))) return "deny";
  if (!hits.length && !found.length) return "allow";
  if (hits.some((h) => !/^rm\b/i.test(h)) || /(^|[\s;&|(])cd\s/.test(run)) return "deny";
  const destructive = new RegExp(DESTRUCTIVE, "i");
  const pieces = run.split(/&&|\|\||[;|\n]|(?<!>)&(?!>)/).map((s) => s.trim());
  return pieces.every((s) => !destructive.test(s) || WORKSPACE_DELETE.test(s)) ? "allow" : "deny";
}
