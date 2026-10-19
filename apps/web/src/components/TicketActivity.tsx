// A ticket's activity (R65, R76): the conversation with its agents and each run's progress in
// one feed, oldest first, like a chat. A run that's going shows what the agent is doing as it
// happens; finished runs fold their steps away. The box at the bottom talks to the agent: into
// its live run (after the current turn, or interrupting it), or as a new run.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { linked } from "../pages/Chat";
import { outcomeTag, when } from "../pages/Runs";
import { describe, useTranscript } from "../transcript";

type Message = { id: string; author: "owner" | "agent" | "system"; agent: string | null; runId: string | null; text: string; delivery: string | null; createdAt: string };
type Conversation = { items: Message[]; live: { id: string; agent: string | null } | null };
type RunRow = { id: string; agent: string | null; startedAt: string; endedAt: string | null; outcome: string | null };

const DELIVERY: Record<string, string> = {
  live: "sent into the running agent",
  woken: "the agent picks it up in a new run",
  unassigned: "no one is assigned yet, so no agent has seen it",
};
const STEPS = 60;

/** An agent reply is a plain summary, then "Details:" and the technical report; older replies have no marker. */
export function splitDetails(text: string): { summary: string; details: string | null } {
  const m = /^[ \t]*Details:[ \t]*$/m.exec(text);
  if (!m) return { summary: text, details: null };
  const details = text.slice(m.index + m[0].length).trim();
  return { summary: text.slice(0, m.index).trim(), details: details || null };
}

function byline(m: Message) {
  if (m.author === "owner") return `You${m.delivery && DELIVERY[m.delivery] ? ` · ${DELIVERY[m.delivery]}` : ""}`;
  if (m.author === "agent") return `${m.agent ?? "An agent"}${m.delivery === "end_of_run" ? " · end of run" : ""}`;
  return "Boss Man";
}

/** A run's working: the agent's interim messages, tool calls, notes and errors. */
function Steps({ runId, live }: { runId: string; live: boolean }) {
  const { items, error } = useTranscript(runId, live ? 2000 : 60_000);
  const steps = items.map((i) => ({ i, d: describe(i) })).filter(({ d }) => d.tone !== "text" || d.body?.trim());
  const shown = steps.slice(-STEPS);
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (live && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [live, shown.length]);
  if (error && !items.length) return <p className="error">{error.message}</p>;
  if (!items.length) return <p className="muted">{live ? "Starting…" : "Loading…"}</p>;
  return (
    <>
      {steps.length > STEPS && (
        <p className="muted" style={{ fontSize: 12 }}>
          The last {STEPS} of {steps.length} steps. <a href={`#/runs/${runId}`}>See the whole run</a>.
        </p>
      )}
      <ol className="run-steps" ref={box} aria-live={live ? "polite" : undefined}>
        {shown.map(({ i, d }) => (
          <li key={i.seq} className={d.tone}>
            <time className="mono muted">{new Date(i.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
            <span>
              {d.label}
              {d.body && d.tone === "tool" && <span className="tag">{d.body.replace(/_/g, " ")}</span>}
              {d.body && d.tone === "text" && <span> {d.body.slice(0, 600)}</span>}
              {d.body && d.tone !== "tool" && d.tone !== "text" && <span className="muted"> {d.body.slice(0, 300)}</span>}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function RunBlock({ run }: { run: RunRow }) {
  const live = !run.endedAt;
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  return (
    <div className={`run-block${live ? " live" : ""}`}>
      <div className="run-head">
        <strong>{run.agent ?? "An agent"}</strong>
        <span className="muted">{live ? `is working · started ${when(run.startedAt)}` : `worked on it · ${when(run.startedAt)}`}</span>
        {outcomeTag(live ? null : (run.outcome ?? "end_turn"))}
      </div>
      <details className="run-body" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Show working</summary>
        {open && <Steps runId={run.id} live={live} />}
        <a href={`#/runs/${run.id}`} style={{ fontSize: 13 }}>
          See the whole run
        </a>
      </details>
    </div>
  );
}

export function TicketActivity({ ticketId, assignee }: { ticketId: string; assignee: string | null }) {
  const [busy, setBusy] = useState(false);
  const convo = usePoll((signal) => api<Conversation>(`/api/tickets/${ticketId}/messages`, { signal }), busy ? 3000 : 10_000, ticketId);
  const runs = usePoll((signal) => api<RunRow[]>(`/api/tickets/${ticketId}/runs`, { signal }), busy ? 3000 : 10_000, ticketId);
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const live = convo.data?.live ?? null;
  useEffect(() => setBusy(live !== null), [live]);

  const feed = [
    ...(convo.data?.items ?? []).map((m) => ({ at: m.createdAt, key: `m${m.id}`, m, r: null as RunRow | null })),
    ...(runs.data ?? []).map((r) => ({ at: r.startedAt, key: `r${r.id}`, m: null as Message | null, r })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [feed.length]);

  const send = async (interrupt = false) => {
    if (!text.trim()) return;
    try {
      await api(`/api/tickets/${ticketId}/messages`, { method: "POST", body: { text: text.trim(), interrupt } });
      setText("");
      setNote(null);
      convo.reload();
      runs.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const stop = async () => {
    if (!live) return;
    try {
      await api(`/api/runs/${live.id}/cancel`, { method: "POST" });
      setNote({ ok: true, text: "Stopping the run." });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <section className="card activity" aria-labelledby="activity-h">
      <h2 id="activity-h">Activity</h2>
      <div className="activity-feed" role="log" aria-live="polite">
        {feed.length === 0 && convo.data && <p className="muted">No activity yet. When an agent works on this ticket, you'll see what it's doing here, and you can talk to it below.</p>}
        {feed.map(({ key, m, r }) =>
          r ? (
            <RunBlock key={key} run={r} />
          ) : (
            <div key={key} className={`chat-msg ${m!.author === "agent" ? "assistant" : m!.author}`}>
              {(() => {
                const { summary, details } = m!.author === "agent" ? splitDetails(m!.text) : { summary: m!.text, details: null };
                return (
                  <>
                    <p>{linked(summary)}</p>
                    {details && (
                      <details>
                        <summary>Details</summary>
                        <p>{linked(details)}</p>
                      </details>
                    )}
                  </>
                );
              })()}
              <small>
                {byline(m!)} · {when(m!.createdAt)}
              </small>
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <form className="activity-compose" onSubmit={(e: FormEvent) => (e.preventDefault(), void send())}>
        <label htmlFor="activity-text" className="sr-only">
          Message to the agent
        </label>
        <textarea
          id="activity-text"
          rows={2}
          maxLength={4000}
          placeholder={live ? `Message ${live.agent ?? "the agent"} while it works. Enter sends after its current step.` : assignee ? `Message ${assignee}. Enter sends, Shift+Enter adds a line.` : "Write a note. Assign the ticket to have an agent pick it up."}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="compose-actions">
          <button className="btn primary" type="submit" disabled={!text.trim()}>
            Send
          </button>
          {live && (
            <>
              <button className="btn" type="button" disabled={!text.trim()} onClick={() => void send(true)} title="Stops the agent's current turn, then gives it your message">
                Interrupt and send
              </button>
              <button className="btn" type="button" onClick={() => void stop()} style={{ color: "var(--red-ink)" }}>
                Stop
              </button>
            </>
          )}
        </div>
      </form>
      {note && (
        <p className={note.ok ? "muted" : "error"} role={note.ok ? "status" : "alert"} style={{ padding: "0 18px 14px" }}>
          {note.text}
        </p>
      )}
    </section>
  );
}
