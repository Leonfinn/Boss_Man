// A ticket's activity (R65, R76): the conversation with its agents and each run's progress in
// one feed, oldest first, like a chat. A run that's going shows what the agent is doing as it
// happens; finished runs fold their steps away. The box at the bottom talks to the agent: into
// its live run (after the current turn, or interrupting it), or as a new run.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { systemAuthor, ticketRef } from "@boss-man/shared";
import { api, type Agent } from "../api";
import { NEWLINE_KEY_HINT, useCoarsePointer, usePoll } from "../hooks";
import { linked } from "../pages/Chat";
import { ImagePreviews, useImageAttach, withAttachments } from "./ImageAttach";
import { OwnerMessageBox, tooLongToSend } from "./OwnerMessageBox";
import { outcomeTag, when } from "../pages/Runs";
import { STATUS, type TicketReview } from "./TicketReviews";
import { describe, useTranscript } from "../transcript";

type Message = {
  id: string;
  author: "owner" | "agent" | "system";
  agent: string | null;
  runId: string | null;
  text: string;
  delivery: string | null;
  createdAt: string;
  /** The waiting-for-an-answer state of an owner message (BOS-425); null for anything else. */
  replyState?: "delivered" | "queued" | null;
  replyReminders?: number | null;
  replyClearedAt?: string | null;
  replyClearedBy?: string | null;
};
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

/** Under an owner message: whether it reached the agent, is waiting its turn, or has gone unanswered (BOS-425). Nothing once it is answered. */
export function replyState(m: Message): string | null {
  if (m.author !== "owner" || m.delivery === "unassigned" || !m.replyState) return null;
  if (m.replyClearedAt) return null;
  if (m.replyState === "queued") return "waiting behind the agent's other work";
  if ((m.replyReminders ?? 0) >= 2) return "not answered after 10 minutes, and the CEO has been asked";
  if ((m.replyReminders ?? 0) >= 1) return "not answered yet; the agent has been asked again";
  return m.delivery === "live" ? "delivered to the running agent" : "waiting: the agent will see it when it next starts a run";
}

function byline(m: Message) {
  if (m.author === "owner") return `You${m.agent ? ` to ${m.agent}` : ""}${m.delivery && DELIVERY[m.delivery] ? ` · ${DELIVERY[m.delivery]}` : ""}`;
  if (m.author === "agent") return `${m.agent ?? "An agent"}${m.delivery === "end_of_run" ? " · end of run" : ""}`;
  return systemAuthor(m.delivery);
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

/** Where the reviews fell in the work: one line when a round was sent for review, one per verdict. The Reviews box keeps the detail. */
function reviewMarks(reviews: TicketReview[]) {
  const marks: Array<{ at: string; key: string; text: string; tone: string }> = [];
  const rounds = new Map<number, TicketReview[]>();
  for (const r of reviews) rounds.set(r.round, [...(rounds.get(r.round) ?? []), r]);
  for (const [round, rs] of rounds) {
    const sent = rs.map((r) => r.createdAt).filter(Boolean).sort()[0];
    if (sent) marks.push({ at: sent, key: `rs${round}`, text: `Sent for review, round ${round}: ${rs.map((r) => `${r.kind} review by ${r.reviewer ?? "a reviewer"}`).join(", ")}`, tone: "" });
    for (const r of rs) {
      if (!r.decidedAt || r.status === "pending" || r.status === "skipped") continue;
      const note = r.notes?.split("\n").find((l) => l.trim() && !/^Review from /.test(l))?.trim();
      marks.push({ at: r.decidedAt, key: `rd${r.id}`, text: `${r.reviewer ?? "A reviewer"}, ${r.kind} review round ${round}: ${STATUS[r.status] ?? r.status}${note ? `. ${note.length > 160 ? `${note.slice(0, 160)}…` : note}` : ""}`, tone: r.status === "approved" ? "green" : r.status === "changes_requested" ? "red" : "" });
    }
  }
  return marks;
}

export function TicketActivity({ ticketId, companyId, assignee, assigneeId = null, agents = [], reviews = null, ticketNumber = null, prefix = null }: { ticketId: string; companyId?: string; assignee: string | null; assigneeId?: string | null; agents?: Agent[]; reviews?: TicketReview[] | null; ticketNumber?: number | null; prefix?: string | null }) {
  // Ticket references in the feed link to their ticket; this ticket is BOS-n (BOS-358).
  const refCtx = { prefix, selfId: ticketId, tickets: ticketNumber ? [{ id: ticketId, number: ticketNumber, prefix }] : [] };
  const [busy, setBusy] = useState(false);
  const convo = usePoll((signal) => api<Conversation>(`/api/tickets/${ticketId}/messages`, { signal }), busy ? 3000 : 10_000, ticketId);
  const runs = usePoll((signal) => api<RunRow[]>(`/api/tickets/${ticketId}/runs`, { signal }), busy ? 3000 : 10_000, ticketId);
  const [text, setText] = useState("");
  const img = useImageAttach(companyId, ticketId);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // "" is whoever is working the ticket; another agent (e.g. the CEO) can be asked about it instead.
  const [to, setTo] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const live = convo.data?.live ?? null;
  const other = agents.find((a) => a.id === to) ?? null;
  const working = live?.agent ?? assignee;
  useEffect(() => setBusy(live !== null), [live]);

  const feed = [
    ...(convo.data?.items ?? []).map((m) => ({ at: m.createdAt, key: `m${m.id}`, m, r: null as RunRow | null, mark: null })),
    ...(runs.data ?? []).map((r) => ({ at: r.startedAt, key: `r${r.id}`, m: null as Message | null, r, mark: null })),
    ...reviewMarks(reviews ?? []).map((mark) => ({ at: mark.at, key: mark.key, m: null as Message | null, r: null as RunRow | null, mark })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  // Braces: scrollIntoView returns a Promise in Chromium 150+, and React would call it as the clean-up.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [feed.length]);

  const send = async (interrupt = false) => {
    const outgoing = withAttachments(text, img.attached);
    if (!outgoing.trim()) return;
    try {
      await api(`/api/tickets/${ticketId}/messages`, { method: "POST", body: { text: outgoing.trim(), interrupt, ...(other ? { agentId: other.id } : {}) } });
      setText("");
      img.clear();
      setNote(null);
      convo.reload();
      runs.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  // Too long for a message: send it as a .txt file on the ticket, which the agent opens whole.
  const sendAsFile = async (long: string) => {
    try {
      const markdown = await img.uploadText(long, "message.txt");
      const outgoing = withAttachments("I've sent the text as a file (below); please read it before answering.", [markdown]);
      await api(`/api/tickets/${ticketId}/messages`, { method: "POST", body: { text: outgoing, ...(other ? { agentId: other.id } : {}) } });
      setText("");
      img.clear();
      setNote({ ok: true, text: "Sent as a .txt file on the ticket." });
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
  // A phone keyboard has no Shift, so there Return adds a line and Send sends.
  const coarse = useCoarsePointer();
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (coarse) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const placeholder = coarse
    ? other
      ? `Ask ${other.name} about this task.`
      : live
        ? `Message ${live.agent ?? "the agent"} while it works.`
        : assignee
          ? `Message ${assignee}`
          : "Write a note. Assign the task to have an agent pick it up."
    : other
      ? `Ask ${other.name} about this task. ${working ? `${working} carries on undisturbed.` : ""}`.trim()
      : live
        ? `Message ${live.agent ?? "the agent"} while it works. Enter sends after its current step.`
        : assignee
          ? `Message ${assignee}. Enter sends, Shift+Enter adds a line.`
          : "Write a note. Assign the task to have an agent pick it up.";

  return (
    <section className="card activity" aria-labelledby="activity-h">
      <h2 id="activity-h">Activity</h2>
      <div className="activity-feed" role="log" aria-live="polite">
        {feed.length === 0 && convo.data && <p className="muted">No activity yet. When an agent works on this task, you'll see what it's doing here, and you can talk to it below.</p>}
        {feed.map(({ key, m, r, mark }) =>
          mark ? (
            <p key={key} className={`activity-mark ${mark.tone}`}>
              {mark.text} · {when(mark.at)}
            </p>
          ) : r ? (
            <RunBlock key={key} run={r} />
          ) : (
            <div key={key} className={`chat-msg ${m!.author === "agent" ? "assistant" : m!.author}`}>
              {(() => {
                const { summary, details } = m!.author === "agent" ? splitDetails(m!.text) : { summary: m!.text, details: null };
                return (
                  <>
                    <p>{linked(summary, companyId, refCtx)}</p>
                    {details && (
                      <details>
                        <summary>Details</summary>
                        <p>{linked(details, companyId, refCtx)}</p>
                      </details>
                    )}
                  </>
                );
              })()}
              <small>
                {byline(m!)} · {when(m!.createdAt)}
              </small>
              {replyState(m!) && (
                <p className="muted reply-state" style={{ fontSize: 12, margin: "2px 0 0" }}>
                  {replyState(m!)}
                </p>
              )}
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <form className="activity-compose" onSubmit={(e: FormEvent) => (e.preventDefault(), void send())}>
        {agents.length > 0 && (
          <div className="compose-to">
            <label htmlFor="activity-to">To</label>
            <select id="activity-to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">{working ? `${working} (working on it)` : "Nobody yet (a note only)"}</option>
              {agents
                .filter((a) => a.id !== assigneeId && a.name !== live?.agent)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </div>
        )}
        <OwnerMessageBox
          id="activity-text"
          label="Message to the agent"
          rows={2}
          enterKeyHint={NEWLINE_KEY_HINT}
          placeholder={placeholder}
          value={text}
          onChange={setText}
          onKeyDown={onKey}
          onPaste={img.onPaste}
          onSendAsFile={sendAsFile}
          attaching={img.busy}
          error={img.error}
        >
          {img.attached.length > 0 && <ImagePreviews attached={img.attached} onRemove={img.remove} />}
        </OwnerMessageBox>
        <div className="compose-actions">
          {img.button}
          <button className="btn primary" type="submit" disabled={(!text.trim() && !img.attached.length) || img.busy || tooLongToSend(text, img.attached)}>
            Send
          </button>
          {live && (
            <>
              <button className="btn" type="button" disabled={(!text.trim() && !img.attached.length) || !!other} onClick={() => void send(true)} title="Stops the agent's current turn, then gives it your message">
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
