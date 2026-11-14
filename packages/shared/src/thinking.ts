// The "Thinking" trace (BOS-1368): what an agent did on its way to a reply, in order, so the
// owner can expand it above the reply. One shape for the runner, the server and the web app, so a
// step recorded for one harness is named and drawn the same way for all of them.
//
// A step is reasoning (the model's own thinking, where the harness gives it), a look (a search or
// a read of a ticket, page, file or the web), an action (a tool that changes something), a command
// (code or a shell command run) or other (a tool we can't place). Each has a short input and a
// short result. The kinds, the sentences, the clip sizes and the caps all live here.

import { z } from "zod";

/** How much of each field is kept. Reasoning is the longest; tool results are clipped hard. */
export const TRACE_CLIP = { reasoning: 2000, input: 300, output: 500 } as const;

/** Per message: at most this many steps, and the whole trace at most this many bytes of JSON. */
export const TRACE_CAP = { steps: 60, bytes: 16 * 1024 } as const;

/** The four ways a step can look; a failed or refused step keeps its kind and gains a flag. */
export const TraceKind = z.enum(["reasoning", "look", "action", "command", "other"]);
export type TraceKind = z.infer<typeof TraceKind>;

export const TraceFlag = z.enum(["failed", "refused"]);
export type TraceFlag = z.infer<typeof TraceFlag>;

/**
 * One step, as stored and shown. Short text only: every field is clipped before storage (see
 * TRACE_CLIP), and `cut` says a long field was cut so the detail can say so rather than lie.
 */
export const TraceStep = z.object({
  kind: TraceKind,
  /** One line the row shows, built from the tool and its input (see traceSentence), never a tool id. */
  summary: z.string().max(300),
  /** The step's detail: reasoning text, what was sent, the command. */
  input: z.string().max(TRACE_CLIP.input * 4).optional(),
  /** What came back: the tool result, the command output. */
  output: z.string().max(TRACE_CLIP.output * 4).optional(),
  /** Labels for the detail's two halves (Sent / Got back, Command / Output); reasoning has none. */
  labels: z.object({ input: z.string().max(40), output: z.string().max(40) }).optional(),
  flag: TraceFlag.optional(),
  /** How long the step took, in milliseconds, when known. */
  ms: z.number().int().nonnegative().optional(),
  /** The input or output was longer than was kept. */
  cut: z.boolean().optional(),
});
export type TraceStep = z.infer<typeof TraceStep>;

/**
 * A reply's whole trace: the steps in order and the header numbers. Set once when the reply is
 * saved, so a stored trace never grows afterwards. A live trace is the same shape, sent with the
 * chat while the run is still working.
 */
export const TraceBody = z.object({
  /** From when the run picked up the owner's message to when the reply was saved. */
  secs: z.number().int().nonnegative(),
  steps: z.array(TraceStep).max(TRACE_CAP.steps),
  /** Steps past the cap that were dropped; shown as "and N more steps". */
  dropped: z.number().int().nonnegative().optional(),
  /** The run stopped (error, interrupt, restart) rather than answering. */
  stopped: z.boolean().optional(),
});
export type TraceBody = z.infer<typeof TraceBody>;

/** The step time the row shows: "under 1 s", "42 s", "2 min 14 s". */
export function traceTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "under 1 s";
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/** Clip a field to `max` characters, saying whether it was cut. */
export function clipField(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
}

/** Boss Man's own tool names (an `mcp__bossman__` tool), by what they do. */
const LOOK_TOOLS = new Set(["tickets", "wiki", "whats_new", "board", "features", "decisions", "list_my_work", "sizing_guide", "server_status", "runs", "model_options", "agent_instructions", "devices", "engagement", "feedback"]);
const WRITE_TOOLS = new Set(["create_ticket", "update_ticket", "create_feature", "update_feature", "create_objective", "create_milestone", "link_tickets", "set_milestone", "nudge", "assign_ticket", "set_ticket_risk", "raise_decision", "withdraw_decision", "notify_owner", "ticket_reply", "log_feedback", "propose_hire", "propose_team", "propose_model_change", "rename_agent", "set_agent_picture", "update_instructions", "notes", "request_note", "request_engagement", "propose_rule", "attach_image", "handoff", "deploy", "review", "schedule_check", "clear_check", "report_key_result", "roadmap", "skills"]);

/**
 * The trace kind for one ACP tool call: from the protocol's `kind` when it says, else from the
 * tool's name (an `mcp__bossman__tickets` call looks; `create_ticket` acts). A `think` tool is the
 * model reasoning in a tool, which is reasoning, not a look.
 */
export function traceKindOf(kind: string | null | undefined, title: string | null | undefined): TraceKind {
  if (kind === "think") return "reasoning";
  if (kind === "read" || kind === "search" || kind === "fetch") return "look";
  if (kind === "execute") return "command";
  if (kind && (kind === "edit" || kind === "delete" || kind === "move" || kind === "switch_mode")) return "action";
  // No protocol kind (often an MCP tool): go by the name. Titles look like "mcp__bossman__tickets".
  const name = (title ?? "").trim();
  const mcp = /^mcp__[^_]+__(.+)$/.exec(name);
  if (mcp) {
    const tool = mcp[1]!;
    if (WRITE_TOOLS.has(tool)) return "action";
    if (LOOK_TOOLS.has(tool)) return "look";
    return "other";
  }
  // Native file tools Codex and OpenCode name plainly, when no kind comes with them.
  if (/^(read|read_file|view|cat|ls|glob|list_files|grep|search|find|web_search|webfetch|fetch)\b/i.test(name)) return "look";
  if (/^(write|edit|update|apply_patch|str_replace|multi_edit|create)\b/i.test(name)) return "action";
  if (/^(bash|shell|exec|exec_command|run|terminal)\b/i.test(name)) return "command";
  return "other";
}

/** A short, human label for a step's kind, for the row's hidden kind prefix. */
export const TRACE_KIND_WORD: Record<TraceKind, string> = {
  reasoning: "Thinking",
  look: "Looked up",
  action: "Action",
  command: "Command",
  other: "Used",
};

/** The first sentence of a block of text, cut at a word if it has to be, with an ellipsis if longer. */
function firstSentence(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const stop = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  const sent = stop ? stop[1]! : flat;
  if (sent.length <= max) return stop && stop[0].length < flat.length ? sent : sent;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The `#/tickets/<id>` in a tool result, which the row can show as a ticket the step touched. */
function ticketIn(text: string): string | null {
  const m = /BOS-\d+/.exec(text);
  return m ? m[0] : null;
}

/** A tool's input, dug out of the shapes Codex, OpenCode and Boss Man's tools use. */
function inputValue(input: string | undefined): unknown {
  if (!input) return undefined;
  const t = input.trim();
  if (!t.startsWith("{")) return t;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

const firstString = (o: unknown): string | null => {
  if (typeof o === "string") return o;
  if (!o || typeof o !== "object") return null;
  for (const v of Object.values(o as Record<string, unknown>)) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
};

/**
 * One line for a step's row, built from the tool and its input or result. It starts with a verb for
 * the kind, names the ticket or page when the tool's reply says one, and never shows a tool id or an
 * `mcp__` name. `title` is the tool call's title from the harness (often the command or the path).
 */
export function traceSentence(step: Pick<TraceStep, "kind" | "input" | "output">, title: string | null | undefined, toolName?: string | null): string {
  const name = (toolName ?? "").trim();
  const mcp = /^mcp__[^_]+__(.+)$/.exec(name);
  const tool = mcp?.[1] ?? name;
  const out = step.output ?? "";
  const input = inputValue(step.input);
  const t = (title ?? "").trim();
  if (step.kind === "reasoning") return firstSentence(step.input ?? t);
  if (tool === "tickets") {
    if (/^\s*(create|found|updated|moved|closed)/i.test(out)) {
      const ref = ticketIn(out);
      return ref ? firstSentence(out, 120) : firstSentence(out, 120) || "Used tickets";
    }
    const ref = ticketIn(out);
    if (ref) {
      const rest = /#[^\s]*\s+(.+?)(?:\s+·|\s*$)/.exec(out)?.[1] ?? "";
      return rest ? `Read ticket ${ref} · ${firstSentence(rest, 60)}` : `Read ticket ${ref}`;
    }
    const q = typeof input === "string" ? input : firstString(input);
    return q ? `Searched tickets for “${firstSentence(q, 60)}”` : "Searched tickets";
  }
  if (tool === "wiki") {
    if (/^\s*(wrote|updated|added|appended)/i.test(out)) return firstSentence(out, 120) || "Updated a wiki page";
    const page = /wiki page "?([^"\n]+)"?/i.exec(out)?.[1] ?? t.replace(/^wiki\s+/i, "");
    if (page) return `Read wiki page ${firstSentence(page, 60)}`;
    return "Read the wiki";
  }
  if (step.kind === "command") {
    const cmd = typeof input === "string" ? input : firstString(input);
    const code = cmd ? firstSentence(cmd, 80) : t;
    return code ? `Ran ${code}` : "Ran a command";
  }
  if (step.kind === "look") {
    if (t) return firstSentence(t.startsWith("Read") || t.startsWith("Searched") ? t : `Read ${t}`, 120);
    const path = typeof input === "string" ? input : firstString(input);
    return path ? `Read ${firstSentence(path, 80)}` : "Looked something up";
  }
  if (step.kind === "action") {
    if (t) return firstSentence(t, 120);
    const ref = ticketIn(out);
    return ref ? `Worked on ticket ${ref}` : "Changed something";
  }
  const label = t || tool.replace(/_/g, " ");
  return label ? `Used ${firstSentence(label, 120)}` : "Used a tool";
}

/**
 * The header words for a finished or live trace. Done: "Thought for 42 s · 6 steps" (reasoning only:
 * no step count); stopped: "Stopped after 42 s · 6 steps". A trace with no steps has no header at all,
 * so the caller shows none.
 */
export function traceHeadline(trace: Pick<TraceBody, "secs" | "steps" | "stopped" | "dropped">): string {
  const n = trace.steps.length + (trace.dropped ?? 0);
  const time = traceTime(trace.secs * 1000);
  if (trace.stopped) return `Stopped after ${time}${n ? ` · ${n} step${n === 1 ? "" : "s"}` : ""}`;
  // Reasoning on its own shows no step count (design BOS-1367: "Thought for 8 s"); any tool step counts.
  const toolSteps = trace.steps.filter((s) => s.kind !== "reasoning").length + (trace.dropped ?? 0);
  return toolSteps ? `Thought for ${time} · ${n} step${n === 1 ? "" : "s"}` : `Thought for ${time}`;
}
