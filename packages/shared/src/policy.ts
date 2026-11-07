// Permission rules (R19, R22). An agent's request to run a tool is matched against the
// company's rules, then global rules, then these defaults; the first match decides.
// "ceo" and "owner" outcomes become decision-queue rows; the agent waits for the answer.

import { commandRisks, type Risk } from "./destructive.js";
import { cleanupScope, explainCommand, readPush, TEMP_DELETE, tempCleanup, writesBeyondTmp } from "./explain.js";

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
  /** Only matches a call to one of Boss Man's own tools that isn't a command (isBossmanCall). Built-in rule only. */
  bossmanCall?: boolean;
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

// Boss Man's own tool server is named "bossman"; each harness spells the tool title its own way: Claude Code mcp__bossman__wiki,
// Codex mcp.bossman.wiki or "Tool: bossman/wiki", OpenCode bossman_wiki, other adapters "bossman: wiki". Matched case-insensitively.
export const BOSSMAN_TOOL_PATTERN = String.raw`^\s*(?:tool:\s*)?(?:mcp[_.:/ -]{1,2}bossman(?:__|\.|:\s*|/|\s+-\s+)|bossman(?:__|_|\.|:\s*|/|\s+-\s+))\S`;
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

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** True when a tool title's server name is close to "bossman" (two edits or fewer) but isn't one of Boss Man's own tools: mcp__bossrnan__wiki, mcp__bossmann__wiki, a title with an invisible character in it. */
export function looksLikeBossmanTool(title: string | null | undefined): boolean {
  if (!title || isBossmanTool(title)) return false;
  const t = title.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase().replace(/^\s*tool:\s*/, "").replace(/^mcp[_\-.\s:]*/, "");
  // The server segment ends at "__", a space or a colon; separators inside it are ignored (boss_man, boss-man).
  const server = (t.split(/__|[\s:]/)[0] ?? "").replace(/[_\-.]/g, "");
  if (!server) return false;
  // Other alphabets (a Cyrillic "о" for "o") can't be told apart by eye, so any non-ASCII server name is flagged.
  return /[^\x00-\x7f]/.test(server) || editDistance(server, "bossman") <= 2;
}

// Input keys that name a file or folder. A request carrying one is about the filesystem, not an unknown tool (OpenCode's external_directory arrives as kind "other" with filepath and parentDir).
const PATH_KEYS = ["filepath", "parentdir", "path", "paths", "cwd", "workdir", "file", "directory", "dir"];

function carriesPath(rawInput: unknown): boolean {
  if (!rawInput || typeof rawInput !== "object") return false;
  return Object.keys(rawInput as Record<string, unknown>).some((k) => PATH_KEYS.includes(k.toLowerCase().replace(/[_-]/g, "")));
}

export const UNKNOWN_TOOL_RULE = "Unrecognised tools go to the CEO first";

/** True when a request is for a tool Boss Man doesn't recognise: no command, no path-like input key, and an unknown or "other" kind. These go to the CEO first (BOS-295), unless a rule above decides. */
export function isUnrecognisedTool(info: PermissionInfo): boolean {
  return commandOf(info.rawInput) == null && !carriesPath(info.rawInput) && (!info.kind || info.kind === "other" || !(TOOL_KINDS as readonly string[]).includes(info.kind));
}

/** Table row 3: the built-in guards. Checked before any company allow, so a broad allow cannot lift them (BOS-307, DR-001). */
export const BUILTIN_GUARDS: PolicyRuleSpec[] = [
  // Before the owner rule: cleaning up /tmp is the CEO's call, and reaches the owner only if the CEO escalates it (BOS-111).
  { name: TEMP_CLEANUP_RULE, match: { kinds: ["execute"], destructive: true, tempCleanupOnly: true }, outcome: "ceo" },
  // The same for plain relative paths in the agent's checkout; the server sends it to the owner when the run has no checkout (BOS-120).
  { name: WORKING_COPY_RULE, match: { kinds: ["execute"], destructive: true, workingCopyOnly: true }, outcome: "ceo" },
  { name: "Destructive commands go to the owner", match: { destructive: true }, outcome: "owner" },
  { name: "Pushing and publishing go to the owner", match: { pushing: true }, outcome: "owner" },
];

/** Table row 6: the built-in allows. Never reached by a request a guard caught, and company routing rules never apply to them. */
export const BUILTIN_ALLOWS: PolicyRuleSpec[] = [
  { name: "Boss Man's own tools", match: { bossmanCall: true }, outcome: "allow" },
  { name: "Reading, searching and editing the workspace", match: { kinds: ["read", "search", "edit", "think", "fetch"] }, outcome: "allow" },
  { name: "Other shell commands", match: { kinds: ["execute"] }, outcome: "allow" },
  // Anything else (delete, move, unknown tools) falls through to the owner.
];

/** Guards first, then allows: the old single list, shown on the Rules page. */
export const DEFAULT_POLICY: PolicyRuleSpec[] = [...BUILTIN_GUARDS, ...BUILTIN_ALLOWS];

/**
 * The one ordered permission table (BOS-307, DR-001). The first row that decides wins. decidePermission is the only
 * code that applies it, used by the live path and the Rules page's test screen.
 */
export const PERMISSION_TABLE: ReadonlyArray<{ row: number; name: string; why: string }> = [
  { row: 1, name: "Network guard", why: "Fetching from the home network is denied; nothing may lift it." },
  { row: 2, name: "Owner chat and plan approval", why: "Decided by the server before this table (chat: board tools only)." },
  { row: 3, name: "Built-in guards", why: "Destructive, push and cleanup requests ask the owner or CEO. A company allow cannot lift them, except the owner's /tmp-only switch." },
  { row: 4, name: "Company deny rules", why: "The owner's own denials beat every allow below the network guard." },
  { row: 5, name: "Company allow rules", why: "In the owner's order, shared with row 7: the first matching allow or routing rule decides. They cannot lift a guard." },
  { row: 6, name: "Built-in allows", why: "Boss Man's tools, reading, editing, plain shell." },
  { row: 7, name: "Company routing rules", why: "To the CEO or owner. Only for requests the rows above leave asking, plus guarded ones; never for what is allowed." },
  { row: 8, name: "Default", why: "Nothing matched: the owner is asked." },
  { row: 9, name: "Tier adjustments", why: "The CEO's own request goes to the owner (server, after this table)." },
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
    // Paths are checked as written, so the note (scratchOnly in explain.ts) vouches only for
    // programs that can't follow a symlink at their target: rm/rmdir/unlink/mkdir of one plain
    // /tmp entry, no redirects (BOS-165).
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
  if (rule.bossmanCall && !isBossmanCall(info)) return false;
  return Boolean(rule.kinds || rule.commandPattern || rule.titlePattern || rule.scratchOnly || rule.destructive || rule.pushing || rule.bossmanCall);
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
const NOT_A_TOOL = "The tool name is a folder path, not a tool (call read, list or bash)";

/**
 * BOS-495: a request whose "tool" is a folder path and that has no command. OpenCode names an
 * external_directory ask after its folder when it has no description or command, so this is an
 * agent reaching outside its checkout by a route Boss Man has no card for. Refused outright, never a card.
 * Only kinds "other" or none: for execute the title is the command, and read/edit titles are file paths.
 */
export function titleIsPath(info: PermissionInfo): boolean {
  const title = info.title?.trim();
  if (!title || (info.kind && info.kind !== "other") || commandOf(info.rawInput)) return false;
  return /^(\/|~(\/|$)|\.{1,2}\/|[A-Za-z]:[\\/])/.test(title);
}

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

export type PermissionDecision = { outcome: PolicyOutcome; rule: string; row: number };

/** Applies PERMISSION_TABLE (rows 1 and 3 to 8) to one request. `rules` are the company's rules, then global ones, each in the owner's order. */
export function decidePermission(info: PermissionInfo, rules: PolicyRuleSpec[]): PermissionDecision {
  // Row 1. Checked before any rule, so an "Allow always" can't lift it. shortcut: checks the address asked for, not where DNS or a redirect lands; a network-level block on the tool containers is the full fix.
  if (reachesPrivateNetwork(info)) return { outcome: "deny", rule: LAN_GUARD, row: 1 };
  // Not a tool at all (BOS-495): refused before any rule, so no allow rule can turn it into a card or an allow.
  if (titleIsPath(info)) return { outcome: "deny", rule: NOT_A_TOOL, row: 1 };
  // Row 3: the built-in guard that catches this request, if any.
  const guard = BUILTIN_GUARDS.find((r) => matches(r.match, info));
  // Row 4: company deny rules.
  const deny = rules.find((r) => r.outcome === "deny" && matches(r.match, info));
  if (deny) return { outcome: "deny", rule: deny.name, row: 4 };
  // Rows 5 and 7 share the owner's order: the first company allow or routing rule that matches decides, so "ask me for ^x__delete" above "allow ^x__" still asks. A guarded request is lifted only by the owner's /tmp-only switch, which checks every path itself.
  const isRoute = (r: PolicyRuleSpec) => r.outcome === "ceo" || r.outcome === "owner";
  const first = rules.find((r) => ((r.outcome === "allow" && (!guard || r.match.scratchOnly)) || isRoute(r)) && matches(r.match, info));
  if (first && first.outcome === "allow") return { outcome: "allow", rule: first.name, row: 5 };
  // Row 7 may change who is asked about a guarded request, never turn it into an allow.
  if (guard) return first ? { outcome: first.outcome, rule: first.name, row: 7 } : { outcome: guard.outcome, rule: guard.name, row: 3 };
  // Row 6: built-in allows. Company routing never reaches a request they allow (BOS-307; this replaces BOS-292's skip list).
  const builtin = BUILTIN_ALLOWS.find((r) => matches(r.match, info));
  if (builtin) return { outcome: builtin.outcome, rule: builtin.name, row: 6 };
  if (first) return { outcome: first.outcome, rule: first.name, row: 7 };
  // Row 8: a tool Boss Man doesn't recognise is the CEO's call first (BOS-295); anything else is the owner's.
  return isUnrecognisedTool(info) ? { outcome: "ceo", rule: UNKNOWN_TOOL_RULE, row: 8 } : { outcome: "owner", rule: "No rule matched", row: 8 };
}

/** Routing rules the built-in allows cover: they only fire for guarded requests now (BOS-307). Judged from the tool kinds alone: listed when it names no kinds, or when any kind it names is a built-in allow. */
export function shadowedRoutingRules<T extends PolicyRuleSpec>(rules: T[]): T[] {
  const covered = new Set(BUILTIN_ALLOWS.flatMap((r) => r.match.kinds ?? []));
  return rules.filter((r) => (r.outcome === "ceo" || r.outcome === "owner") && (!r.match.kinds?.length || r.match.kinds.some((k) => covered.has(k))));
}

/** The table applied for callers that log the position or only read the outcome. `position` is the deciding row (0 when nothing in the table matched); it replaces the old list index BOS-306 logged. */
export function evaluatePermission(info: PermissionInfo, rules: PolicyRuleSpec[]): { outcome: PolicyOutcome; rule: string; position: number } {
  const { outcome, rule, row } = decidePermission(info, rules);
  return { outcome, rule, position: outcome === "owner" && row === 8 ? 0 : row };
}

/** Build output directly in the agent's working folder (node_modules, dist…): one component only, no trailing slash. rm -rf NAME/ follows a symlink as if NAME were its target (BOS-150), and a deeper path such as dist/x still follows a symlinked dist, so `rm -rf dist` is the only shape vouched for. */
const WORKSPACE_DELETE = /^rm(?:\s+(?:--?[A-Za-z][A-Za-z-]*|--))*(?:\s+(?:node_modules|dist|build|coverage|out|target))+(?:\s+(?:(?:[12]|&)?>>?\s*\/dev\/null|2>&1))*$/;

/** find -delete rooted at one plain /tmp entry: kept Allow as BOS-111 pinned it. Root must be one level, quoted patterns kept simple. */
const FIND_TMP_DELETE = /^find\s+\/tmp\/(?!\.+(?:\s|$))[A-Za-z0-9._+@-]+(?:\s+-(?:name|iname|type|path|mindepth|maxdepth|mtime|mmin|newer|empty|print)(?:\s+(?:'[^']*'|[\w.*?-]+))?)*\s+-delete$/;

const vouched = (s: string) => WORKSPACE_DELETE.test(s) || TEMP_DELETE.test(s) || FIND_TMP_DELETE.test(s);

/**
 * What the decision queue recommends for an escalated request (BOS-111). Deleting or changing
 * files isn't a reason to refuse on its own: temp-file cleanup and deletes of build output in the
 * working folder are recommended Allow. Deny is for deletes Boss Man can't vouch for (absolute
 * paths outside /tmp, ~, variables, globs, a cd out of /tmp) and for the other destructive commands
 * (mkfs, dd, docker rm, force push, zfs destroy, shred). It only picks the suggested button.
 */
export function recommendedVerdict(info: PermissionInfo): "allow" | "deny" {
  const cmd = commandOf(info.rawInput) ?? info.title ?? "";
  const found = risksOf(info).filter((r) => r.kind === "destroys");
  // Temp cleanup is Allow whatever else is in it: cleanupScope already refuses shred, pushes and other destructive words,
  // and a later cd can't move a /tmp/NAME delete. The reader must agree that nothing but deletes destroys (BOS-116).
  if (tempCleanup(cmd) && found.every((r) => /^(rm|find)\b/i.test(r.text))) return "allow";
  // A push is judged by where it goes (BOS-208): a plain ticket-branch push is Allow; main, force,
  // deletes, every-branch and anything the parser can't read are Deny.
  const push = readPush(cmd);
  if (push) return push.dangerous ? "deny" : "allow";
  const run = dataText(cmd);
  const hits = run.match(new RegExp(DESTRUCTIVE, "gi")) ?? [];
  // Destructive commands that aren't file deletes are Deny even in /tmp (shred /tmp/a); find -delete counts as a delete.
  if ([...hits, ...found.map((r) => r.text)].some((h) => !/^(rm|find)\b/i.test(h))) return "deny";
  // A command that only works in /tmp, with nothing in it Boss Man can't check, is safe too.
  const scratch = explainCommand(cmd).scratch;
  if (scratch && !scratch.unchecked.length) return "allow";
  if (!hits.length && !found.length) return "allow";
  // A shell still runs $( ), backticks and <( ) inside double quotes, which `run` blanked out, so the pieces below can't be judged without seeing them (security round 2).
  if (/\$\(|`|[<>]\(/.test(cmd)) return "deny";
  const destructive = new RegExp(DESTRUCTIVE, "i");
  const pieces = run.split(/&&|\|\||[;|\n]|(?<!>)&(?!>)/).map((s) => s.trim());
  // Of the reader's findings, only a plainly written delete of build output or of one-level /tmp entries can be vouched for (BOS-116, BOS-165).
  // A find whose pattern is quoted (-name '*.log') isn't "plain", so it is vouched for only when the command itself has a top-level piece
  // FIND_TMP_DELETE accepts: a find inside bash -c, a wrapper or a subshell doesn't make one.
  const vouchedRisk = (r: Risk) => (r.plain ? vouched(r.text) : /^find\s/.test(r.text) && FIND_TMP_DELETE.test(r.text) && pieces.some((p) => FIND_TMP_DELETE.test(p)));
  if (!found.every(vouchedRisk)) return "deny";
  if (hits.some((h) => !/^(?:rm|find)\b/i.test(h)) || /(^|[\s;&|(])cd\s/.test(run)) return "deny";
  // A plain delete of one-level /tmp entries never makes the suggestion Deny, whatever else the
  // command does (BOS-165, from BOS-153 finding 2). TEMP_DELETE accepts no trailing slash, deeper
  // path, glob or redirect to a file, so /tmp/a/, /tmp/a/b and rm > /home/x stay Deny. A piece with
  // no vouched delete is accepted only when it can't reach beyond /tmp either (writesBeyondTmp),
  // so cp -t /home and a redirect into the home folder still pay Deny.
  // A piece counts as a delete when the reader finds one in it too (rm --rec dist), so the vouched check, not writesBeyondTmp, judges it.
  const deletes = (s: string) => destructive.test(s) || commandRisks(s).some((r) => r.kind === "destroys");
  return pieces.every((s) => (deletes(s) ? vouched(s) : !writesBeyondTmp(s))) ? "allow" : "deny";
}
