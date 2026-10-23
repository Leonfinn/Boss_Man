// Plain-English explanations of permission requests, worked out from the command itself
// (no model): what the owner is being asked to allow, and the worst thing it could do.

import { commandOf, type PermissionInfo, type PolicyMatch } from "./policy.js";

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
};

/** A standing rule the owner can pick instead of "Allow once". */
export type AlwaysChoice = { label: string; name: string; match: PolicyMatch };

const READS = new Set("cat grep egrep rg ls head tail wc stat du df free ps which pwd echo cd date whoami uname sort uniq cut tr diff file test [ true sleep".split(" "));
const CHANGES = new Set("tee mv cp mkdir touch chmod chown ln".split(" "));
const DELETES = new Set("rm rmdir unlink shred".split(" "));
const NETWORK = new Set("curl wget ssh scp nc ncat rsync".split(" "));
const GIT_READS = new Set("status log diff show branch rev-parse ls-files blame remote grep describe merge-base show-ref cat-file shortlog".split(" "));
const GIT_CHANGES = new Set("add commit checkout switch merge reset rebase stash restore cherry-pick tag apply mv".split(" "));
const GIT_NETWORK = new Set(["fetch", "pull", "clone"]);
const PKG = new Set(["npm", "pnpm", "yarn"]);
const PKG_INSTALL = new Set(["install", "i", "add", "ci", "remove", "uninstall"]);

/** Paths the owner will recognise, in friendly words. */
const FRIENDLY: Array<[RegExp, string]> = [
  [/^\/proc\/meminfo$/, "the machine's memory"],
  [/^\/sys\/fs\/cgroup\/memory[./]/, "the container's memory limit"],
];
const friendly = (p: string) => FRIENDLY.find(([re]) => re.test(p))?.[1] ?? p;

/** Splits on ; && || | and newlines outside quotes. shortcut: no escapes, subshells or heredocs; commands that use $( ) or backticks are flagged unknown instead. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === ";" || c === "|" || c === "\n" || (c === "&" && command[i + 1] === "&")) {
      if (c === "&" || (c === "|" && command[i + 1] === "|")) i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  return [...out, cur].map((s) => s.trim()).filter(Boolean);
}

const unquote = (t: string) => t.replace(/^(['"])(.*)\1$/, "$2");

type Part = { effect: Effect; text: string; targets: string[]; env?: boolean };

function explainSegment(seg: string): Part {
  const tokens = (seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(unquote);
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
  while (args[0] && /^\w+=/.test(args[0])) args.shift();
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
  } else if (program === "sed") p = flags.some((f) => /^-\w*i/.test(f)) ? part("changes", "Edits files in place", paths) : part("reads", "", paths);
  else if (program === "git") {
    const sub = rest.find((a) => !a.startsWith("-")) ?? "";
    p =
      sub === "push" ? part("pushes", "Pushes code to the repository")
      : sub === "clean" || sub === "rm" ? part("deletes", "Deletes files from the project")
      : GIT_NETWORK.has(sub) ? part("network", "Uses the network (git)")
      : GIT_CHANGES.has(sub) ? part("changes", "Changes the project's files or history")
      : GIT_READS.has(sub) ? part("reads", "", paths)
      : part("unknown", `Runs a git command Boss Man doesn't recognise: ${sub || "git"}`);
  } else if (PKG.has(program) && PKG_INSTALL.has(rest[0] ?? "")) p = part("changes", `Installs or removes packages (${program})`);
  else if (program === "node" && flags.length && flags.every((f) => f === "--version" || f === "-v") && !operands.length) p = part("reads", "");
  else if (NETWORK.has(program)) p = part("network", `Uses the network (${program})`);
  else if (CHANGES.has(program)) p = part("changes", "Changes files", operands);
  else if (READS.has(program)) p = part("reads", "", paths);
  else p = part("unknown", `Runs a program Boss Man doesn't recognise: ${program}`);

  if (/\$\(|`/.test(seg) && p.effect === "reads") p = part("unknown", "Runs a command nested inside another");
  if (writes.length) {
    const worse = WORST.indexOf(p.effect) < WORST.indexOf("changes") ? p : null;
    p = worse ?? { ...part("changes", "Changes files", writes), env: p.env };
  }
  return p;
}

const list = (xs: string[]) => [...new Set(xs.map(friendly))].slice(0, 4).join(", ");

/** What a shell command would do, in one sentence led by the worst thing in it. */
export function explainCommand(command: string): { summary: string; effect: Effect } {
  const parts = segments(command).map(explainSegment);
  const effect = WORST.find((e) => parts.some((p) => p.effect === e)) ?? "reads";
  const sentences: string[] = [];
  for (const e of WORST) {
    const group = parts.filter((p) => p.effect === e && (p.text || e === "reads"));
    if (!group.length) continue;
    const targets = list(group.flatMap((p) => p.targets));
    if (e === "reads") {
      if (group.every((p) => p.env && !p.targets.length)) continue;
      sentences.push(`${effect === "reads" ? "Only reads" : "Reads"} information${targets ? ` (${targets})` : ""}${effect === "reads" ? "; it doesn't change anything" : ""}.`);
    } else sentences.push([...new Set(group.map((p) => p.text))].join("; ") + (targets ? ` (${targets})` : "") + ".");
  }
  if (parts.some((p) => p.env)) sentences.push("Shows environment variables, which can include secrets.");
  return { summary: sentences.join(" ") || "Does nothing visible.", effect };
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
