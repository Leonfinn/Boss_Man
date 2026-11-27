// Secret check on what agents write into Boss Man (BOS-2731). The built-in rule "never write a token, key or password into a
// ticket, wiki page or message" was only enforced for the repo (the merge gate's added-lines scan). A slip in a wiki page or a
// ticket is permanent (history keeps it), so these tools refuse text that holds a secret, using the same rule list as the
// scan (packages/shared/src/secret-rules.mjs). The refusal names the rule's kind only: never the value, where it sits, how
// long it is, or a fingerprint. The owner's private-details list is not applied here; that stays a merge-gate check.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findSecretKind } from "@boss-man/shared";
import { fail } from "./mcp-common.js";

/**
 * The tools whose text is checked, each with the actions that write (null = every call). Every string anywhere in the
 * input is read, not a list of field names, so a field added later is covered without anyone remembering to list it.
 */
const GUARDED: ReadonlyMap<string, ReadonlySet<string> | null> = new Map([
  ["wiki", new Set(["write", "append"])],
  ["create_ticket", null],
  ["update_ticket", null],
  ["ticket_reply", null],
  ["set_ticket_state", null],
  ["raise_decision", null],
  ["nudge", null],
]);

function* strings(v: unknown, depth = 0): Generator<string> {
  if (typeof v === "string") yield v;
  else if (depth < 8 && Array.isArray(v)) for (const x of v) yield* strings(x, depth + 1);
  else if (depth < 8 && v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x, depth + 1);
}

/** The refusal text for a call that holds a secret, or null when it is clean (or not a guarded call). */
export function secretRefusal(tool: string, input: unknown): string | null {
  if (!GUARDED.has(tool)) return null;
  const actions = GUARDED.get(tool);
  const action = (input as { action?: unknown } | null)?.action;
  if (actions && !(typeof action === "string" && actions.has(action))) return null;
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
