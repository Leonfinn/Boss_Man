// Secret check on what agents write into Boss Man (BOS-2731). The built-in rule "never write a token, key or password into a
// ticket, wiki page or message" was only enforced for the repo (the merge gate's added-lines scan). A slip in a wiki page or a
// ticket is permanent (history keeps it), so these tools refuse text that holds a secret, using the same rule list as the
// scan (packages/shared/src/secret-rules.mjs). The refusal names the rule's kind only: never the value, where it sits, how
// long it is, or a fingerprint. The owner's private-details list is not applied here; that stays a merge-gate check.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findSecretKind } from "@boss-man/shared";
import { fail } from "./mcp-common.js";

/**
 * Deny by default (BOS-2760): every tool's text is checked, and only reads are exempt, so a tool or action added later is
 * covered without anyone remembering to list it. Every string anywhere in the input is read, not a list of field names.
 * A tool listed here whole never writes; for the others the listed actions only read, and any other action is checked.
 * Keep these lists to what cannot store or send text: when unsure, leave it out (a wrongly checked read costs nothing).
 */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "agent_instructions", "board", "devices", "features", "list_my_work", "model_options", "open_attachment", "owner_answers",
  "server_status", "sizing_guide", "tickets", "whats_new", "permission_report", "merge_line_records", "workflow_scorecard",
]);
const READ_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["wiki", new Set(["list", "read", "history"])],
  ["decisions", new Set(["list", "read", "explain"])],
  ["review", new Set(["diff"])],
  ["notes", new Set(["list", "requests"])],
  ["roadmap", new Set(["list"])],
  ["skills", new Set(["list", "proposals", "proposal", "proposal_file"])],
  ["engagement", new Set(["list", "view"])],
  ["deploy", new Set(["targets", "history"])],
  ["runs", new Set(["list", "history"])],
  ["standing_rules", new Set(["read"])],
  ["feedback", new Set(["inbox", "features"])],
  ["security_alert", new Set(["read"])],
  ["watchdog", new Set(["list", "alerts"])],
]);

function* strings(v: unknown, depth = 0): Generator<string> {
  if (typeof v === "string") yield v;
  else if (depth < 8 && Array.isArray(v)) for (const x of v) yield* strings(x, depth + 1);
  else if (depth < 8 && v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x, depth + 1);
}

/** The refusal text for a call that holds a secret, or null when it is clean (or a read). */
export function secretRefusal(tool: string, input: unknown): string | null {
  if (READ_TOOLS.has(tool)) return null;
  const reads = READ_ACTIONS.get(tool);
  const action = (input as { action?: unknown } | null)?.action;
  if (reads && typeof action === "string" && reads.has(action)) return null;
  for (const s of strings(input)) {
    const kind = findSecretKind(s);
    if (kind) return `Refused: the text holds what looks like a ${kind}. Never write a token, key or password into Boss Man; use the environment variable instead, and send the call again without it. (The value is not shown.)`;
  }
  return null;
}

/** Wraps registerTool so the guarded tools are checked before they run. Call it before any tool registers. */
export function guardSecrets(server: McpServer): McpServer {
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: never, cb: (input: unknown, extra: never) => Promise<unknown>) =>
    register(name, config, (async (input: unknown, extra: never) => {
      const refusal = secretRefusal(name, input);
      return refusal ? fail(refusal) : cb(input, extra);
    }) as never)) as never;
  return server;
}
