// Permission rules (R19, R22). An agent's request to run a tool is matched against the
// company's rules, then global rules, then these defaults; the first match decides.
// "ceo" and "owner" outcomes become decision-queue rows; the agent waits for the answer.

import { cleanupScope, explainCommand, readPush, tempCleanup } from "./explain.js";

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
  /** Only matches a call to one of Boss Man's own tools that isn't a command (isBossmanCall). Built-in rule only. */
  bossmanCall?: boolean;
};

export type PolicyRuleSpec = { name: string; match: PolicyMatch; outcome: PolicyOutcome };

/** The owner's opt-in standing rule for scratch work (Rules page switch). */
export const SCRATCH_RULE: PolicyRuleSpec = { name: "Always allow commands that only work in /tmp", match: { kinds: ["execute"], scratchOnly: true }, outcome: "allow" };

// rm's -r/-f may come after other flags or the paths (GNU rm reads `rm x -rf`), or be spelled long; find deletes with -delete or -exec.
export const DESTRUCTIVE = String.raw`\brm\s+(?:[^\s;&|]+\s+)*?(?:-[a-zA-Z]*[rf][a-zA-Z]*|--(?:recursive|force))\b|\bfind\b[^;&|\n]*\s-(?:delete|exec(?:dir)?\s+(?:rm|rmdir|unlink|shred|truncate))\b|\bmkfs\b|\bdd\s+if=|\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b|\bgit\s+push\s+.*--force\b|\bzfs\s+destroy\b|\bshred\b`;

export const PUSHING = String.raw`\b(git\s+push|npm\s+publish|docker\s+push)\b`;

export const TEMP_CLEANUP_RULE = "Temp-file cleanup goes to the CEO first";
export const WORKING_COPY_RULE = "Deletes in the agent's own working copy go to the CEO first";

// Boss Man's own tool server is named "bossman"; each harness spells the tool title its own way: Claude Code mcp__bossman__wiki,
// Codex mcp.bossman.wiki or "Tool: bossman/wiki", OpenCode bossman_wiki, other adapters "bossman: wiki". Matched case-insensitively.
export const BOSSMAN_TOOL_PATTERN = String.raw`^\s*(?:tool:\s*)?(?:mcp[_.:/ -]{1,2})?bossman(?:__|_|\.|:\s*|/|\s+-\s+)\S`;
const BOSSMAN_TOOL = new RegExp(BOSSMAN_TOOL_PATTERN, "i");

/** True when a tool title names a tool of Boss Man's own server, in any harness's spelling. */
export function isBossmanTool(title: string | null | undefined): boolean {
  return BOSSMAN_TOOL.test(title ?? "");
}

// Kinds a Boss Man tool call never has. Some harnesses title a shell request with the command itself or an
// agent-written description, so a title alone could pass "bossman_x; rm -rf …" off as a board tool (BOS-292 security review).
const NOT_A_BOSSMAN_CALL = ["execute", "edit", "delete", "move", "fetch"];

/** True for a call to Boss Man's own server: its title names one, and it carries no command and no file, shell or fetch kind. */
export function isBossmanCall(info: PermissionInfo): boolean {
  if (commandOf(info.rawInput) != null) return false;
  if (info.kind && NOT_A_BOSSMAN_CALL.includes(info.kind)) return false;
  return isBossmanTool(info.title);
}

export const DEFAULT_POLICY: PolicyRuleSpec[] = [
  { name: "Boss Man's own tools", match: { bossmanCall: true }, outcome: "allow" },
  // Before the owner rule: cleaning up /tmp is the CEO's call, and reaches the owner only if the CEO escalates it (BOS-111).
  { name: TEMP_CLEANUP_RULE, match: { kinds: ["execute"], commandPattern: DESTRUCTIVE, tempCleanupOnly: true }, outcome: "ceo" },
  // The same for plain relative paths in the agent's checkout; the server sends it to the owner when the run has no checkout (BOS-120).
  { name: WORKING_COPY_RULE, match: { kinds: ["execute"], commandPattern: DESTRUCTIVE, workingCopyOnly: true }, outcome: "ceo" },
  { name: "Destructive commands go to the owner", match: { commandPattern: DESTRUCTIVE }, outcome: "owner" },
  { name: "Pushing and publishing go to the owner", match: { commandPattern: PUSHING }, outcome: "owner" },
  { name: "Reading, searching and editing the workspace", match: { kinds: ["read", "search", "edit", "think", "fetch"] }, outcome: "allow" },
  { name: "Other shell commands", match: { kinds: ["execute"] }, outcome: "allow" },
  // Anything else (delete, move, unknown tools) falls through to the owner.
];

/** ACP tool kinds a rule can match on. */
export const TOOL_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"] as const;

/** What's wrong with a rule's match, if anything: it needs a condition, and its patterns must compile. */
export function ruleProblems(match: PolicyMatch): string[] {
  const problems: string[] = [];
  if (!match.kinds?.length && !match.commandPattern && !match.titlePattern && !match.scratchOnly) problems.push("Give the rule at least one condition: tool kinds, a command pattern or a title pattern.");
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
  if (rule.safeOnly) {
    const cmd = commandOf(info.rawInput) ?? "";
    if (new RegExp(`${DESTRUCTIVE}|${PUSHING}`, "i").test(cmd)) return false;
  }
  if (rule.scratchOnly) {
    // shortcut: paths are checked as written, so a symlink inside /tmp pointing elsewhere isn't caught; resolving them needs the runner's filesystem.
    const scratch = explainCommand(commandOf(info.rawInput) ?? "").scratch;
    if (!scratch || scratch.unchecked.length) return false;
  }
  if (rule.tempCleanupOnly && !tempCleanup(commandOf(info.rawInput) ?? "")) return false;
  if (rule.workingCopyOnly) {
    // A string only: an argv array runs without a shell, so cleanupScope's reading of ; and && wouldn't hold.
    const cmd = (info.rawInput as Record<string, unknown> | null)?.["command"];
    if (typeof cmd !== "string" || !cleanupScope(cmd)?.workingCopy.length) return false;
  }
  if (rule.titlePattern) {
    const re = safeRegex(rule.titlePattern);
    if (!info.title || !re || !re.test(info.title)) return false;
  }
  if (rule.bossmanCall && !isBossmanCall(info)) return false;
  return Boolean(rule.kinds || rule.commandPattern || rule.titlePattern || rule.scratchOnly || rule.bossmanCall);
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
  const outside = (/^mcp__/.test(info.title ?? "") && !isBossmanCall(info)) || info.kind === "fetch";
  if (!outside) return false;
  return urlsIn(info.rawInput).some((u) => {
    try {
      return isPrivateHost(new URL(u).hostname);
    } catch {
      return true;
    }
  });
}

export function evaluatePermission(info: PermissionInfo, rules: PolicyRuleSpec[]): { outcome: PolicyOutcome; rule: string; position: number } {
  // Checked before any rule, so an "Allow always" can't lift it. shortcut: checks the address asked for, not where DNS or a redirect lands; a network-level block on the tool containers is the full fix.
  if (reachesPrivateNetwork(info)) return { outcome: "deny", rule: LAN_GUARD, position: 0 };
  // Boss Man's own tools are checked per call by the server (role and company), so a broad company
  // rule that routes requests to the CEO or the owner must not catch them (BOS-292): that sent every
  // board-tool call to a card. A company rule can still deny one.
  const ownTool = isBossmanCall(info);
  const all = [...rules, ...DEFAULT_POLICY];
  for (const [i, rule] of all.entries()) {
    if (ownTool && rule.outcome !== "deny" && rule.outcome !== "allow" && i < rules.length) continue;
    if (matches(rule.match, info)) return { outcome: rule.outcome, rule: rule.name, position: i + 1 };
  }
  return { outcome: "owner", rule: "No rule matched", position: 0 };
}

/** Build output directly in the agent's working folder (node_modules, dist…): one component only, no trailing slash. rm -rf NAME/ follows a symlink as if NAME were its target (BOS-150), and a deeper path such as dist/x still follows a symlinked dist, so `rm -rf dist` is the only shape vouched for. */
const WORKSPACE_DELETE = /^rm(?:\s+(?:--?[A-Za-z][A-Za-z-]*|--))*(?:\s+(?:node_modules|dist|build|coverage|out|target))+(?:\s+(?:(?:[12]|&)?>>?\s*\/dev\/null|2>&1))*$/;

/**
 * What the decision queue recommends for an escalated request (BOS-111). Deleting or changing
 * files isn't a reason to refuse on its own: temp-file cleanup and deletes of build output in the
 * working folder are recommended Allow. Deny is for deletes Boss Man can't vouch for (absolute
 * paths outside /tmp, ~, variables, globs, a cd out of /tmp) and for the other destructive commands
 * (mkfs, dd, docker rm, force push, zfs destroy, shred). It only picks the suggested button.
 */
export function recommendedVerdict(info: PermissionInfo): "allow" | "deny" {
  const cmd = commandOf(info.rawInput) ?? info.title ?? "";
  // Temp cleanup is Allow whatever else is in it: cleanupScope already refuses shred, pushes and other destructive words, and a later cd can't move a /tmp/NAME delete.
  if (tempCleanup(cmd)) return "allow";
  // A push is judged by where it goes (BOS-208): a plain ticket-branch push is Allow; main, force,
  // deletes, every-branch and anything the parser can't read are Deny.
  const push = readPush(cmd);
  if (push) return push.dangerous ? "deny" : "allow";
  // Quoted text is data (a sed script, a commit message) unless a shell runs it.
  const run = /\b(sh|bash|zsh)\s+-c\b|\beval\b/.test(cmd) ? cmd : cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  const hits = run.match(new RegExp(DESTRUCTIVE, "gi")) ?? [];
  // Destructive commands that aren't file deletes are Deny even in /tmp (shred /tmp/a); find -delete counts as a delete.
  if (hits.some((h) => !/^(rm|find)\b/i.test(h))) return "deny";
  // A command that only works in /tmp, with nothing in it Boss Man can't check, is safe too.
  const scratch = explainCommand(cmd).scratch;
  if (scratch && !scratch.unchecked.length) return "allow";
  if (!hits.length) return "allow";
  if (hits.some((h) => !/^rm\b/i.test(h)) || /(^|[\s;&|(])cd\s/.test(run)) return "deny";
  const destructive = new RegExp(DESTRUCTIVE, "i");
  const pieces = run.split(/&&|\|\||[;|\n]|(?<!>)&(?!>)/).map((s) => s.trim());
  return pieces.every((s) => !destructive.test(s) || WORKSPACE_DELETE.test(s)) ? "allow" : "deny";
}
