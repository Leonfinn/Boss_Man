// A ticket's conversation (R65): the owner writes to whoever is working the ticket, and
// agents answer on it. Each run's closing message shows here too.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { linked } from "../pages/Chat";
import { when } from "../pages/Runs";

type Message = { id: string; author: "owner" | "agent" | "system"; agent: string | null; runId: string | null; text: string; delivery: string | null; createdAt: string };
type Conversation = { items: Message[]; live: { id: string; agent: string | null } | null };

const DELIVERY: Record<string, string> = {
  live: "sent into the running agent",
  woken: "the agent will pick it up in a new run",
  unassigned: "no one is assigned yet, so no agent has seen it",
};

function byline(m: Message) {
  if (m.author === "owner") return `You${m.delivery && DELIVERY[m.delivery] ? ` · ${DELIVERY[m.delivery]}` : ""}`;
  if (m.author === "agent") return `${m.agent ?? "An agent"}${m.delivery === "end_of_run" ? " · end of run" : ""}`;
  return "Boss Man";
}

export function TicketConversation({ ticketId }: { ticketId: string }) {
  const [busy, setBusy] = useState(false);
  const convo = usePoll((signal) => api<Conversation>(`/api/tickets/${ticketId}/messages`, { signal }), busy ? 3000 : 10_000, ticketId);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const live = convo.data?.live ?? null;
  const count = convo.data?.items.length ?? 0;
  useEffect(() => setBusy(live !== null), [live]);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [count]);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    void api(`/api/tickets/${ticketId}/messages`, { method: "POST", body: { text: text.trim() } }).then(
      () => (setText(""), setError(null), convo.reload()),
      (err: Error) => setError(err.message),
    );
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <section className="card chat" aria-labelledby="convo-h">
      <h2 id="convo-h" style={{ fontSize: 17, fontWeight: 600, padding: "18px 20px 0" }}>
        Conversation
      </h2>
      <div className="chat-log" role="log" aria-live="polite" style={{ minHeight: 0, paddingTop: 0 }}>
        {count === 0 && convo.data && <p className="muted">Ask the agent on this ticket a question or give it more direction. If it's working now, your message goes straight in; otherwise it starts a new run.</p>}
        {convo.data?.items.map((m) => (
          <div key={m.id} className={`chat-msg ${m.author === "agent" ? "assistant" : m.author}`}>
            <p>{linked(m.text)}</p>
            <small>
              {byline(m)} · {when(m.createdAt)}
              {m.runId && (
                <>
                  {" · "}
                  <a href={`#/runs/${m.runId}`}>run</a>
                </>
              )}
            </small>
          </div>
        ))}
        {live && (
          <p className="muted chat-state" role="status">
            {live.agent ?? "An agent"} is working on this ticket now.
          </p>
        )}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="chat-form">
        <label htmlFor="convo-text" className="sr-only">
          Message to the agent
        </label>
        <textarea id="convo-text" rows={2} maxLength={4000} placeholder="Write to the agent. Enter sends, Shift+Enter adds a line." value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <button className="btn primary" type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
      {error && (
        <p className="error" role="alert" style={{ padding: "0 20px 18px" }}>
          {error}
        </p>
      )}
    </section>
  );
}
