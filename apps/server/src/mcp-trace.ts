// The run trace (BOS-758): what a chat run changed and which tickets it touched, for the "Done in this
// reply" line under CEO chat replies. Moved out of mcp.ts unchanged.
import { and, eq } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db } from "./db/client.js";
import { tickets } from "./db/schema.js";
import { refsOf } from "./mcp-common.js";
import { markReportInChat } from "./services/chat-report-back.js";

// shortcut: one run's record is held in memory and dropped when the run ends; lost on restart, harmless because a chat run dies with the restart (BOS-758).
type RunTrace = { changes: string[]; tickets: string[] };
const traces = new Map<string, RunTrace>();
/** What a chat run changed and the tickets it touched (created or read), read by chat.ts under its reply. */
export const runTrace = (runId: string): RunTrace => traces.get(runId) ?? { changes: [], tickets: [] };
export function forgetRunTrace(runId: string) {
  traces.delete(runId);
}

/**
 * The chat tools that never change anything: reads and lookups only (BOS-806). Every other tool in the
 * chat's list must have a case in changeTrace, so the "Done in this reply" line names what it changed.
 * chat.test.ts walks the live chat tool list against these two sets, so a new tool cannot be added
 * silently: it is either a read (add it here) or a change (add a case in changeTrace).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "agent_instructions", "board", "devices", "features", "list_my_work", "model_options", "open_attachment", "owner_answers",
  "server_status", "sizing_guide", "tickets", "whats_new",
]);

/**
 * Every tool with a case in changeTrace, which may return null for its read actions (notes list,
 * roadmap list, review diff). Kept in step with the switch below by a guard there and by chat.test.ts.
 */
export const TRACED_TOOLS: ReadonlySet<string> = new Set([
  "notes", "create_ticket", "create_feature", "log_feedback", "set_ticket_state", "update_ticket", "set_ticket_risk",
  "assign_ticket", "link_tickets", "set_milestone", "raise_decision", "withdraw_decision", "decisions", "nudge", "wiki",
  "update_instructions", "rename_agent", "set_agent_picture", "standing_rules", "propose_hire", "propose_team",
  "propose_model_change", "propose_rule", "attach_image", "ticket_reply", "notify_owner", "roadmap", "report_key_result",
  "schedule_check", "clear_check", "request_check", "request_engagement", "engagement", "handoff", "deploy", "submit_plan",
  "review", "request_note", "feedback", "skills", "pa_verdict", "runs",
]);

/**
 * A changing tool call, as one item for the "Done in this reply" line; null for a call that is not one
 * (a read action of a tool that also writes, such as notes list or roadmap list). `ref` names a ticket
 * by its BOS-style reference (BOS-806), so "created a ticket" also says which one; a created ticket's id
 * comes from the tool's own result (returnId), since create_ticket takes none.
 */
async function changeTrace(name: string, input: Record<string, unknown>, ref: (id: string) => Promise<string | null>, returnId?: string): Promise<string | null> {
  const s = (v: unknown, n = 60) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const action = String(input.action ?? "");
  const ticket = async (id: unknown) => {
    const r = typeof id === "string" ? await ref(id) : null;
    return r ? ` ${r}` : "";
  };
  // A name with no case below has no business being in TRACED_TOOLS; the test guard keeps them in step,
  // and this stops an untraced tool from ever being silently counted as a change.
  if (!TRACED_TOOLS.has(name)) return null;
  switch (name) {
    case "notes":
      return action === "save" || action === "update" || action === "accept" ? `saved note "${s(input.title)}"` : action === "remove" || action === "decline" ? "removed a note" : null;
    case "create_ticket":
      return `created a ticket${await ticket(returnId)}`;
    case "create_feature":
      return `created a feature request "${s(input.title)}"`;
    case "log_feedback":
      return "filed feedback";
    case "set_ticket_state":
      return `moved a ticket${await ticket(input.ticketId)}`;
    case "update_ticket":
      return `updated a ticket${await ticket(input.ticketId)}`;
    case "set_ticket_risk":
      return "set a ticket's risk";
    case "assign_ticket":
      return `handed a ticket to ${s(input.agent)}`;
    case "link_tickets":
      return "made a ticket wait on another";
    case "set_milestone":
      return "put a ticket in a milestone";
    case "raise_decision":
      return "raised a decision for the owner";
    case "withdraw_decision":
      return "withdrew a decision";
    case "decisions":
      return ["answer", "withdraw", "escalate", "advise"].includes(action) ? "settled a decision" : null;
    case "nudge":
      return `nudged ${s(input.agent)}`;
    case "wiki":
      return action === "write" || action === "append"
        ? `wrote the wiki page "${s(input.title || input.slug)}"`
        : action === "restore"
          ? `restored the wiki page "${s(input.slug)}"`
          : action === "attach"
            ? "attached something to a ticket"
            : null;
    case "update_instructions":
      return `changed ${s(input.agent)}'s instructions`;
    case "rename_agent":
      return `renamed an agent to ${s(input.newName)}`;
    case "set_agent_picture":
      return "set an agent's picture";
    case "standing_rules":
      return action === "write" ? "changed the standing rules" : null;
    case "propose_hire":
      return `proposed hiring ${s(input.name)}`;
    case "propose_team":
      return "proposed a team";
    case "propose_model_change":
      return `proposed a model change for ${s(input.agent)}`;
    case "propose_rule":
      return "proposed a permission rule";
    case "attach_image":
      return "attached an image to a ticket";
    // BOS-806: the tools a CEO chat run can call that change something and were left out of the line.
    case "ticket_reply":
      return "replied on a ticket";
    case "notify_owner":
      return `sent the owner a ${s(input.level) === "page" ? "page" : s(input.level) === "flag" ? "flag" : "note"}`;
    case "roadmap":
      return action === "add_objective" ? `added the objective "${s(input.title)}"` : action === "add_milestone" ? `added the milestone "${s(input.title)}"` : action === "set" ? "put a ticket in a milestone" : null;
    case "report_key_result":
      return "reported a key result";
    case "schedule_check":
      return "scheduled a check";
    case "clear_check":
      return "cleared a check";
    case "request_check":
      return "asked the runner for a check";
    case "request_engagement":
      return `asked ${s(input.providerCompany)} to do work`;
    case "engagement":
      return ["accept", "reject", "counter", "accept_counter", "withdraw", "sign_off", "request_revision", "deliver"].includes(action) ? "moved an engagement on" : null;
    case "handoff":
      return "wrote the handoff";
    case "deploy":
      return action === "request" ? `asked to deploy ${s(input.ref)}` : action === "report" ? "reported a deploy" : action === "release_hold" ? "released a held update" : null;
    case "submit_plan":
      return "submitted the plan";
    case "review":
      return action === "submit"
        ? `reviewed a ticket (${input.verdict === "approved" ? "approved" : "asked for changes"})`
        : action === "sequence" || action === "overrule" || action === "retry_merge" || action === "prioritise_merge"
          ? "arranged a ticket's reviews"
          : null;
    case "request_note":
      return "asked for a lasting note";
    case "feedback":
      return ["log", "link", "create_feature", "mark", "size", "update_feature"].includes(action) ? "updated the feature requests" : null;
    case "skills":
      return ["give", "take", "propose", "review_verdict"].includes(action) ? "changed the skill library" : null;
    case "pa_verdict":
      return "marked a PA answer";
    case "runs":
      return action === "message" ? "messaged another run" : action === "stop" ? "stopped a run" : null;
    default:
      return null;
  }
}

/** The chat tools whose ticket is marked "report back in chat" (R52): the ones that create or change one ticket. */
const REPORT_TOOLS: ReadonlySet<string> = new Set(["create_ticket", "update_ticket", "set_ticket_state", "assign_ticket", "set_ticket_risk"]);

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Records a chat run's changing calls, and every ticket id any of its tools returned (BOS-758), so the
 * reply can be checked against what the run actually did. Wraps the server's registerTool: only the
 * chat's server gets here, and a failed call (isError) records nothing.
 */
export function traceCalls(server: McpServer, db: Db, runId: string, companyId: string): McpServer {
  const register = server.registerTool.bind(server);
  // Names a ticket by its BOS-style reference (BOS-806), looked up once per id. The lookup runs after the
  // tool already succeeded: if it fails, the change is still made and still named, just without the number
  // (BOS-820), so a failed lookup can never turn a good call into an error the agent would retry.
  const refOf = async (id: string) => {
    try {
      const [t] = await db.select({ number: tickets.number }).from(tickets).where(and(eq(tickets.id, id), eq(tickets.companyId, companyId)));
      if (!t) return null;
      return (await refsOf(db, companyId))(t).ref;
    } catch {
      return null;
    }
  };
  server.registerTool = ((name: string, config: never, cb: (input: Record<string, unknown>, extra: never) => Promise<unknown>) =>
    register(name, config, (async (input: Record<string, unknown>, extra: never) => {
      const out = (await cb(input, extra)) as { isError?: boolean };
      if (!out?.isError) {
        const trace = traces.get(runId) ?? { changes: [], tickets: [] };
        const returned = JSON.stringify(out).match(UUID_ANYWHERE) ?? [];
        for (const id of returned) if (!trace.tickets.includes(id)) trace.tickets.push(id);
        // A created ticket has no id in its input, so take the one the tool returned.
        const change = await changeTrace(name, input, refOf, name === "create_ticket" ? returned[0] : undefined);
        if (change && !trace.changes.includes(change)) trace.changes.push(change);
        // R52: a ticket a chat run creates or changes is reported back in that chat when it closes. Never turns a good call into an error.
        // A call that sets or clears the mark by hand is the CEO's own word, and is not marked over.
        if (REPORT_TOOLS.has(name) && input.reportInChat === undefined) {
          const id = name === "create_ticket" ? returned[0] : typeof input.ticketId === "string" ? input.ticketId : null;
          if (id) await markReportInChat(db, runId, id).catch(() => undefined);
        }
        if (trace.changes.length || trace.tickets.length) traces.set(runId, trace);
      }
      return out;
    }) as never)) as never;
  return server;
}
