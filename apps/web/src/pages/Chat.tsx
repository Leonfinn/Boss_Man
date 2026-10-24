// The owner chat (v1.1, R70), laid out like a messenger: the team on the left, the
// conversation on the right. Most messages go to the CEO, but any agent can be messaged
// directly. On a phone the list and the conversation take turns.
import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, type Company } from "../api";
import { usePoll } from "../hooks";
import { when } from "./Runs";
import { StarButton } from "./Agents";
import { Avatar } from "../components/Avatar";

type Message = { id: string; role: "owner" | "assistant" | "system"; text: string; createdAt: string };
type Chat = { agentId: string; items: Message[]; state: string };
type Thread = { id: string; name: string; role: "ceo" | "manager" | "worker"; duty: string | null; state: string; last: { role: Message["role"]; text: string; createdAt: string } | null };

/** Plain text with in-app links (#/tickets/<id> and the like, or [title](#/tickets/<id>)) made clickable. */
export function linked(text: string): ReactNode {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\[([^\]]+)\]\((#\/[a-z]+\/[0-9a-f-]{36})\)|`?(#\/[a-z]+(?:\/[0-9a-f-]{36})?)`?/g)) {
    const href = (m[2] ?? m[3])!;
    out.push(<Fragment key={`t${at}`}>{text.slice(at, m.index)}</Fragment>, <a key={`a${m.index}`} href={href}>{m[1] ?? (href.startsWith("#/tickets/") ? "task" : href.slice(2))}</a>);
    at = m.index + m[0].length;
  }
  out.push(<Fragment key="end">{text.slice(at)}</Fragment>);
  return out;
}

const ROLE: Record<Thread["role"], string> = { ceo: "CEO", manager: "Manager", worker: "Worker" };
const roleOf = (t: Thread) => (t.duty === "assistant" ? "PA" : ROLE[t.role]);
// The PA's posted answers end with this; it becomes a button that puts the question to the CEO (R87).
const ASK_CEO = "[Ask the CEO]";
// When the owner last looked at each conversation, so new replies show a dot. Only this browser
// needs it, so it lives in local storage, and the page works without it.
const SEEN = "bm-chat-seen";
function readSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function markSeen(agentId: string, at: string) {
  try {
    localStorage.setItem(SEEN, JSON.stringify({ ...readSeen(), [agentId]: at }));
  } catch {
    // Storage may be blocked; the dots just stay.
  }
}

function busyText(state: string, name: string) {
  if (state === "answering") return `${name} is replying…`;
  if (state === "queued") return "Waiting for the runner…";
  return state.replace(/^waiting: /, "Waiting: ");
}

export function ChatPage({ companies, companyId, agentId, go, onChanged }: { companies: Company[]; companyId: string | undefined; agentId: string | undefined; go: (to: string) => void; onChanged: () => void }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const threads = usePoll((signal) => (company ? api<Thread[]>(`/api/companies/${company.id}/chat/threads`, { signal }) : Promise.resolve([])), 5000, company?.id ?? "none");
  const team = threads.data ?? [];
  // The CEO is the default conversation; on a phone, the list shows until someone is picked.
  const current = team.find((t) => t.id === agentId) ?? team[0];
  const starred = company?.agents.find((a) => a.id === current?.id);
  const [busy, setBusy] = useState(false);
  const chat = usePoll(
    (signal) => (company && current ? api<Chat>(`/api/companies/${company.id}/chat?agentId=${current.id}`, { signal }) : Promise.resolve(null)),
    busy ? 2000 : 5000,
    `${company?.id ?? "none"}/${current?.id ?? "none"}`,
  );
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(readSeen);
  const end = useRef<HTMLDivElement>(null);
  const state = chat.data?.state ?? "idle";
  const items = chat.data?.items ?? [];
  const latest = items.at(-1)?.createdAt;
  useEffect(() => setBusy(state !== "idle"), [state]);
  // Braces: scrollIntoView returns a Promise in Chromium 150+, and React would call it as the clean-up.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items.length, current?.id]);
  useEffect(() => {
    if (!current || !latest) return;
    markSeen(current.id, latest);
    setSeen(readSeen());
  }, [current?.id, latest]);

  const ceo = team.find((t) => t.role === "ceo");
  const send = (e?: FormEvent, to = current, body = text) => {
    e?.preventDefault();
    if (!company || !to || !body.trim()) return;
    void api(`/api/companies/${company.id}/chat`, { method: "POST", body: { text: body.trim(), agentId: to.id } }).then(
      () => {
        setText("");
        setError(null);
        setBusy(true);
        threads.reload();
        if (to.id === current?.id) chat.reload();
        else go(`chat/${company.id}/${to.id}`);
      },
      (err: Error) => setError(err.message),
    );
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const unread = (t: Thread) => !!t.last && t.last.role !== "owner" && t.id !== current?.id && (!seen[t.id] || seen[t.id]! < t.last.createdAt);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Chat</h1>
          <p className="sub">Message your CEO, or any agent directly. In chat they can look up and change the board, tasks, the wiki and skills, but not code: work that needs code goes on a task.</p>
        </div>
      </header>
      {!company ? (
        <p>Create a company on the Kanban first.</p>
      ) : (
        <section className="card messenger" data-picked={agentId ? "yes" : "no"} aria-label="Chat">
          <nav className="messenger-list" aria-label="Team">
            <ul>
              {team.map((t) => (
                <li key={t.id}>
                  <a href={`#/chat/${company.id}/${t.id}`} aria-current={t.id === current?.id ? "page" : undefined} title={`${t.name}, ${roleOf(t)}`} data-unread={unread(t) ? "yes" : undefined}>
                    <Avatar agent={company.agents.find((x) => x.id === t.id) ?? t} className={t.role} />
                    <span className="who">
                      <span className="name">
                        {t.name} <small>{roleOf(t)}</small>
                        {unread(t) && <span className="dot" aria-label="new reply" />}
                      </span>
                      <span className="preview">{t.state !== "idle" ? busyText(t.state, t.name) : t.last ? `${t.last.role === "owner" ? "You: " : ""}${t.last.text}` : "No messages yet"}</span>
                    </span>
                    {t.last && <time className="when">{when(t.last.createdAt)}</time>}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {current && (
            <div className="messenger-chat">
              <header className="messenger-head">
                <a className="back" href={`#/chat/${company.id}`} aria-label="Back to the team">
                  ←
                </a>
                <Avatar agent={company.agents.find((x) => x.id === current.id) ?? current} className={current.role} />
                <div>
                  <h2>{current.name}</h2>
                  <small className="muted">{state !== "idle" ? busyText(state, current.name) : roleOf(current)}</small>
                </div>
                {starred && <StarButton agent={starred} onToggle={() => void api(`/api/agents/${current.id}`, { method: "PATCH", body: { starred: !starred.starred } }).then(onChanged, (err: Error) => setError(err.message))} />}
              </header>
              <div className="chat-log" role="log" aria-live="polite">
                {items.length === 0 && chat.data && (
                  <p className="muted">
                    {current.role === "ceo" || current.duty === "assistant" ? 'Try: "Add rate limiting to the login API before the beta, after the auth refactor."' : `Ask ${current.name} about their work, or for something to go on the board.`}
                  </p>
                )}
                {items.map((m, i) => (
                  <div key={m.id} className={`chat-msg ${m.role}`}>
                    <p>
                      {m.text.includes(ASK_CEO) && ceo ? (
                        <>
                          {linked(m.text.split(ASK_CEO)[0]!)}
                          <button type="button" className="linkish" onClick={() => send(undefined, ceo, items.slice(0, i).reverse().find((x) => x.role === "owner")?.text ?? "")}>
                            Ask the CEO
                          </button>
                        </>
                      ) : (
                        linked(m.text)
                      )}
                    </p>
                    <small>
                      {m.role === "owner" ? "You" : m.role === "assistant" ? current.name : "Boss Man"} · {when(m.createdAt)}
                    </small>
                  </div>
                ))}
                <div ref={end} />
              </div>
              <form onSubmit={send} className="chat-form">
                <label htmlFor="chat-text" className="sr-only">
                  Message to {current.name}
                </label>
                <textarea id="chat-text" rows={2} maxLength={4000} placeholder={`Message ${current.name}. Enter sends, Shift+Enter adds a line.`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
                {current.duty === "assistant" && ceo && (
                  <button className="btn" type="button" disabled={!text.trim()} onClick={() => send(undefined, ceo)}>
                    Ask the CEO
                  </button>
                )}
                <button className="btn primary" type="submit" disabled={!text.trim()}>
                  Send
                </button>
              </form>
              {error && (
                <p className="error" role="alert" style={{ padding: "0 20px 14px" }}>
                  {error}
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
