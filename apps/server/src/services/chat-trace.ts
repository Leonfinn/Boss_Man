// The Thinking trace shown above an agent reply (BOS-1368): what the run did on its way to the
// reply, in order. The runner sends each tool call and thought chunk as a `run.update` (protocol.ts);
// this service turns them into steps, keeps them per run in memory while it works, and builds the
// capped, redacted body that is saved with the reply.
//
// Safety: every field passes through the same redact() the server's error lines use, before it is
// kept, so the stored trace is clean by construction; each field is clipped; the whole body is
// capped by step count and bytes. Nothing here reads env or tokens.
import { clipField, TRACE_CAP, TRACE_CLIP, traceSentence, type TraceBody, type TraceFlag, type TraceKind, type TraceStep } from "@boss-man/shared";
import { redact } from "./error-buffer.js";

/** One run's steps as they arrive, with where the run started for the header's time. */
type RunSteps = { startedAt: number; steps: TraceStep[]; dropped: number; openReasoning: boolean };
// shortcut: a run's steps are held in memory and dropped when the reply is saved or the run ends; lost on restart, harmless because a chat run dies with the restart (BOS-1368).
const traces = new Map<string, RunSteps>();

/** The update shape the runner sends for each step (see session-manager.ts onUpdate). */
export type TraceUpdate = {
  kind?: string;
  title?: string | null;
  toolKind?: string | null;
  status?: string | null;
  toolCallId?: string;
  traceKind?: TraceKind;
  text?: string;
  inputSummary?: string;
  resultSummary?: string;
  resultCut?: boolean;
  at?: string;
  refused?: boolean;
};

/** Clip and redact one field. Redaction runs first, so a clipped end can't hide a token before it. */
function clean(text: string | undefined, max: number): { text: string; cut: boolean } {
  if (!text) return { text: "", cut: false };
  return clipField(redact(text), max);
}

const KINDWORD: Record<TraceKind, string> = { reasoning: "Thought", look: "Looked up", action: "Did", command: "Ran", other: "Used" };

/** The row sentence for one step, redacted and clipped, from the tool and its short input/result. */
function sentenceOf(kind: TraceKind, title: string | null | undefined, input: string | undefined, output: string | undefined, toolName?: string | null): string {
  const built = traceSentence({ kind, input, output }, redact(title ?? ""), toolName ?? redact(title ?? ""));
  return clipField(redact(built || KINDWORD[kind]), 300).text;
}

export function chatTraceService() {
  return {
    /** The run started: its trace starts now. */
    begin(runId: string) {
      if (!traces.has(runId)) traces.set(runId, { startedAt: Date.now(), steps: [], dropped: 0, openReasoning: false });
    },

    /**
     * One `run.update` from the runner, turned into a step. Thought chunks in a row join into one
     * reasoning step (a tool call, or anything else, starts a new one). A tool call becomes a step
     * when its input or result first appears, and updates that step as the result arrives.
     */
    onUpdate(runId: string, u: TraceUpdate) {
      const run = traces.get(runId) ?? (traces.set(runId, { startedAt: Date.now(), steps: [], dropped: 0, openReasoning: false }), traces.get(runId)!);
      if (u.kind === "reasoning") {
        const text = clean(u.text, TRACE_CLIP.reasoning);
        if (!text.text) return;
        if (run.openReasoning) {
          const last = run.steps[run.steps.length - 1];
          if (last?.kind === "reasoning") {
            const joined = clean(`${last.input ?? ""}${last.cut ? "" : text.text}`, TRACE_CLIP.reasoning);
            last.input = joined.text;
            last.cut = joined.cut || text.cut;
            last.summary = sentenceOf("reasoning", null, joined.text, undefined);
            return;
          }
        }
        push(run, { kind: "reasoning", summary: sentenceOf("reasoning", null, text.text, undefined), input: text.text, ...(text.cut ? { cut: true } : {}), ms: 0 });
        run.openReasoning = true;
        return;
      }
      if (u.kind !== "tool_call" && u.kind !== "tool_call_update") return;
      run.openReasoning = false;
      const input = u.inputSummary ? clean(u.inputSummary, TRACE_CLIP.input) : { text: "", cut: false };
      const output = u.resultSummary ? clean(u.resultSummary, TRACE_CLIP.output) : { text: "", cut: false };
      const flag: TraceFlag | undefined = u.refused ? "refused" : u.status === "failed" ? "failed" : undefined;
      const kind: TraceKind = u.traceKind ?? (u.toolKind === "think" ? "reasoning" : "other");
      const title = u.title ?? null;
      // A repeat of a call we already have (the result update): fill in its output, flag and time.
      if (u.toolCallId) {
        const at = run.steps.findIndex((s) => (s as TraceStep & { id?: string }).id === u.toolCallId);
        if (at >= 0) {
          const step = run.steps[at] as TraceStep & { id?: string };
          if (output.text) {
            step.output = output.text;
            if (output.cut) step.cut = true;
          }
          if (flag) step.flag = flag;
          step.summary = sentenceOf(step.kind, title, step.input, step.output, title);
          return;
        }
      }
      // Boss Man's tools carry their name in the title ("mcp__bossman__tickets"); the sentence builder
      // takes it, so the row says "Read ticket BOS-1" not the raw name.
      const step: TraceStep & { id?: string } = {
        kind,
        summary: sentenceOf(kind, title, input.text, output.text, title),
        ...(input.text ? { input: input.text } : {}),
        ...(output.text ? { output: output.text } : {}),
        ...(kind === "command" ? { labels: { input: "Command", output: "Output" } } : kind !== "reasoning" ? { labels: { input: "Sent", output: "Got back" } } : {}),
        ...(flag ? { flag } : {}),
        ...(input.cut || output.cut ? { cut: true } : {}),
        ...(u.toolCallId ? { id: u.toolCallId } : {}),
        ms: 0,
      };
      push(run, step);
    },

    /**
     * The reply being saved: the body for it, or null when there are no steps (a short reply with no
     * trace). The steps since the previous reply belong to this one; the run's steps are then cleared
     * so a second reply lists only its own, and the header time runs from the previous reply.
     */
    take(runId: string, stopped = false): TraceBody | null {
      const run = traces.get(runId);
      if (!run) return null;
      const secs = Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
      const steps = run.steps;
      const { kept, dropped } = capSteps(steps, run.dropped);
      // Reset for the run's next reply: a fresh start time and no steps (a repeat of a permission prompt keeps none).
      traces.set(runId, { startedAt: Date.now(), steps: [], dropped: 0, openReasoning: false });
      if (!kept.length) return null;
      return { secs, steps: kept, ...(dropped ? { dropped } : {}), ...(stopped ? { stopped } : {}) };
    },

    /** The steps so far, for the live chat while the run is still working. */
    live(runId: string): TraceBody | null {
      const run = traces.get(runId);
      if (!run || !run.steps.length) return null;
      const secs = Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
      const { kept, dropped } = capSteps(run.steps, run.dropped);
      return kept.length ? { secs, steps: kept, ...(dropped ? { dropped } : {}) } : null;
    },

    forget(runId: string) {
      traces.delete(runId);
    },

    /** For a run the server saw end while the owner's chat was open: the steps so far, cleared after. */
    stopped(runId: string): TraceBody | null {
      const body = this.take(runId, true);
      return body;
    },
  };
}

export type ChatTraceService = ReturnType<typeof chatTraceService>;

/** Add a step, or count it as dropped once the cap is reached (so the header's count is honest). */
function push(run: RunSteps, step: TraceStep) {
  if (run.steps.length >= TRACE_CAP.steps) {
    run.dropped += 1;
    return;
  }
  run.steps.push(step);
}

/**
 * Keep the body within the caps: at most TRACE_CAP.steps steps, and the whole thing at most
 * TRACE_CAP.bytes of JSON. Steps past the count are dropped (and counted); if the bytes still
 * overflow, the oldest steps are dropped into the count too, so the newest work is what's shown.
 */
function capSteps(steps: TraceStep[], alreadyDropped: number): { kept: TraceStep[]; dropped: number } {
  const kept = steps.slice(0, TRACE_CAP.steps);
  let dropped = alreadyDropped + (steps.length - kept.length);
  // Trim by bytes, from the oldest, until the serialized trace fits.
  while (kept.length && Buffer.byteLength(JSON.stringify({ secs: 0, steps: kept, dropped })) > TRACE_CAP.bytes) {
    kept.shift();
    dropped += 1;
  }
  return { kept, dropped };
}
