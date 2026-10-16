import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, type Company } from "../api";
import { usePoll } from "../hooks";
import { when } from "./Runs";

type Message = { id: string; role: "owner" | "assistant" | "system"; text: string; createdAt: string };
type Chat = { items: Message[]; state: string };

/** Plain text with in-app links (#/tickets/<id> and the like) made clickable. */
function linked(text: string): ReactNode {
  const parts = text.split(/`?(#\/[a-z]+(?:\/[0-9a-f-]{36})?)`?/g);
  return parts.map((p, i) => (p.startsWith("#/") ? <a key={i} href={p}>{p.startsWith("#/tickets/") ? "ticket" : p.slice(2)}</a> : <Fragment key={i}>{p}</Fragment>));
}

export function ChatPage({ companies, companyId, go }: { companies: Company[]; companyId: string | undefined; go: (to: string) => void }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const [busy, setBusy] = useState(false);
  const chat = usePoll((signal) => (company ? api<Chat>(`/api/companies/${company.id}/chat`, { signal }) : Promise.resolve(null)), busy ? 2000 : 5000, company?.id ?? "none");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const state = chat.data?.state ?? "idle";
  const count = chat.data?.items.length ?? 0;
  useEffect(() => setBusy(state !== "idle"), [state]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [count]);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!company || !text.trim()) return;
    void api(`/api/companies/${company.id}/chat`, { method: "POST", body: { text: text.trim() } }).then(
      () => (setText(""), setError(null), setBusy(true), chat.reload()),
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
    <>
      <header className="page-head">
        <div>
          <h1>Chat</h1>
          <p className="sub">Say what you want in plain words; the assistant turns it into tickets, milestones and links on the board. It can only use board tools: it can't read or change code.</p>
        </div>
        {companies.length > 1 && (
          <div className="field">
            <label htmlFor="chat-company">Company</label>
            <select id="chat-company" value={company?.id} onChange={(e) => go(`chat/${e.target.value}`)}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>
      {!company ? (
        <p>Create a company on the Board first.</p>
      ) : (
        <section className="card chat" aria-label="Conversation">
          <div className="chat-log" role="log" aria-live="polite">
            {count === 0 && chat.data && <p className="muted">Try: "Add rate limiting to the login API before the beta, after the auth refactor."</p>}
            {chat.data?.items.map((m) => (
              <div key={m.id} className={`chat-msg ${m.role}`}>
                <p>{linked(m.text)}</p>
                <small>
                  {m.role === "owner" ? "You" : m.role === "assistant" ? "Assistant" : "Boss Man"} · {when(m.createdAt)}
                </small>
              </div>
            ))}
            {state !== "idle" && (
              <p className="muted chat-state" role="status">
                {state === "answering" ? "The assistant is working on it…" : state === "queued" ? "Waiting for the runner…" : state.replace(/^waiting: /, "Waiting: ")}
              </p>
            )}
            <div ref={end} />
          </div>
          <form onSubmit={send} className="chat-form">
            <label htmlFor="chat-text" className="visually-hidden">
              Message
            </label>
            <textarea id="chat-text" rows={3} maxLength={4000} placeholder="What should happen? Enter sends, Shift+Enter adds a line." value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
            <button className="btn primary" type="submit" disabled={!text.trim()}>
              Send
            </button>
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </>
  );
}
