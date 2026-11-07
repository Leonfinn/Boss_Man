import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Transcript, type TranscriptItem } from "./api";

/** At most this many events are kept in the page; older ones are dropped from the top (R43). */
export const MAX_ITEMS = 5_000;

/**
 * Follows a run's transcript: pages through what's there, then checks for new events every
 * couple of seconds until the run ends. Each fetch lands as one batch, never per event.
 */
export function useTranscript(runId: string, pollMs = 2_000) {
  const [state, setState] = useState<{ run: Transcript["run"] | null; items: TranscriptItem[]; dropped: number; error: ApiError | null }>({ run: null, items: [], dropped: 0, error: null });
  const cursor = useRef(0);

  useEffect(() => {
    cursor.current = 0;
    setState({ run: null, items: [], dropped: 0, error: null });
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = async () => {
      try {
        const page = await api<Transcript>(`/api/runs/${runId}/transcript?after=${cursor.current}&limit=500`, { signal: ctrl.signal });
        cursor.current = page.next;
        setState((s) => {
          const all = s.items.concat(page.items);
          const over = Math.max(0, all.length - MAX_ITEMS);
          return { run: page.run, items: over ? all.slice(over) : all, dropped: s.dropped + over, error: null };
        });
        if (page.more) timer = setTimeout(step, 0);
        else if (!page.run.endedAt) timer = setTimeout(step, pollMs);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState((s) => ({ ...s, error: err instanceof ApiError ? err : new ApiError(0, String(err)) }));
        timer = setTimeout(step, pollMs * 5);
      }
    };
    void step();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [runId, pollMs]);

  return state;
}

/** One line of the transcript in words. */
export function describe(item: TranscriptItem): { tone: "text" | "tool" | "note" | "bad"; label: string; body?: string } {
  const e = item.event;
  const u = (e.update ?? {}) as Record<string, string | null | undefined>;
  switch (item.type) {
    case "run.started":
      return { tone: "note", label: `Session started${e.model ? ` on ${String(e.model)}` : ""}` };
    case "run.workspace":
      return { tone: "note", label: `${e.created ? "New workspace" : "Workspace"} on ${String(e.branch)} from ${String(e.baseCommit).slice(0, 7)}${e.restoredPatch ? ", with saved work put back" : ""}` };
    case "run.permission_request":
      return { tone: "note", label: `Asked permission: ${String(e.title ?? "a tool")}` };
    case "run.ended":
      return e.error ? { tone: "bad", label: e.interrupted ? "Interrupted" : "Failed", body: String(e.error) } : { tone: "note", label: `Ended (${String(e.stopReason ?? "done").replace(/_/g, " ")})` };
    case "run.update":
      switch (u.kind) {
        case "agent_message":
          return { tone: "text", label: "Agent", body: u.text ?? "" };
        case "tool_call":
        case "tool_call_update":
          return { tone: "tool", label: u.title ?? "Tool", body: u.status ?? undefined };
        case "resumed":
          return { tone: "note", label: u.mode === "load" ? "Resumed the saved session after a restart" : "Started a fresh session after a restart" };
        case "checkpoint":
          return { tone: "note", label: `Checkpoint ${String(u.turn ?? "")}: ${Number(u.files ?? 0)} file${Number(u.files) === 1 ? "" : "s"} changed this turn` };
        case "message_delivered": {
          // The run carries only the start of a long message; say how much there was so it isn't read as the whole thing.
          const shown = String(u.text ?? "");
          const full = Number(u.fullLength ?? 0);
          return { tone: "note", label: "Message delivered", body: full > shown.length ? `${shown}… (${full.toLocaleString()} characters in all; the rest is on the ticket)` : shown };
        }
        default:
          return { tone: "note", label: String(u.kind ?? "update").replace(/_/g, " ") };
      }
    default:
      return { tone: "note", label: item.type };
  }
}
