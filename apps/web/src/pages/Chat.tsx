// The owner chat (v1.1, R70), laid out like a messenger: the team on the left, the
// conversation on the right. Most messages go to the CEO, but any agent can be messaged
// directly. On a phone the list and the conversation take turns.
import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, type Company } from "../api";
import { NEWLINE_KEY_HINT, useCoarsePointer, usePoll } from "../hooks";
import { useDraft } from "../drafts";
import { when } from "./Runs";
import { StarButton } from "./Agents";
import { Avatar } from "../components/Avatar";
import { ImagePreviews, useImageAttach, withAttachments } from "../components/ImageAttach";
import { OwnerMessageBox, tooLongToSend } from "../components/OwnerMessageBox";
import { linkPieces, type LinkContext } from "../links";

type Message = { id: string; role: "owner" | "assistant" | "system"; text: string; createdAt: string };
type Chat = { agentId: string; items: Message[]; state: string };
/** The runner-update hold, from App's /api/maintenance poll (BOS-349). */
type Maintenance = { on: false } | { on: true; runs: number; chatOpen: boolean };
type Thread = { id: string; name: string; role: "ceo" | "manager" | "worker"; duty: string | null; state: string; last: { role: Message["role"]; text: string; createdAt: string } | null };

/** Plain text with in-app links made clickable (BOS-358): one shared builder, see links.ts. */
export function linked(text: string, wikiCompanyId?: string, ctx: LinkContext = {}): ReactNode {
  return linkPieces(text, { ...ctx, companyId: wikiCompanyId ?? ctx.companyId }).map((p, i) =>
    p.kind === "text" ? (
      <Fragment key={i}>{p.text}</Fragment>
    ) : p.kind === "image" ? (
      <a key={i} href={p.src} target="_blank" rel="noreferrer" className="msg-img">
        <img src={p.src} alt={p.alt} loading="lazy" />
      </a>
    ) : p.kind === "file" ? (
      <a key={i} href={p.href} download className="file-chip">
        {p.text}
      </a>
    ) : (
      <a key={i} href={p.href}>
        {p.text}
      </a>
    ),
  );
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

/** One plain line while a runner update waits (BOS-349): chat stays open while agents work, then holds briefly for the swap. */
export function UpdateNote({ m }: { m: Maintenance | null }) {
  if (!m?.on) return null;
  return (
    <p className="banner" role="status">
      {m.chatOpen
        ? `Update waiting for ${m.runs} agent${m.runs === 1 ? "" : "s"} to finish: chat stays open until then.`
        : "Updating, back in a moment. New messages are saved and answered when it is done."}
    </p>
  );
}

export function ChatPage({ companies, companyId, agentId, maintenance = null, go, onChanged }: { companies: Company[]; companyId: string | undefined; agentId: string | undefined; maintenance?: Maintenance | null; go: (to: string) => void; onChanged: () => void }) {
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
  // What is being typed survives a freeze, a reload or a return to this conversation (BOS-637): one draft per agent.
  const draftKey = company && current ? `chat/${company.id}/${current.id}` : null;
  const [text, setText, clearText] = useDraft(draftKey);
  const img = useImageAttach(company?.id);
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
    // From the box, the attachment links go on when sending; a message passed in whole (Ask the CEO) is sent as it is.
    const fromBox = body === text && to === current;
    const outgoing = fromBox ? withAttachments(body, img.attached) : body;
    if (!company || !to || !outgoing.trim()) return;
    void api(`/api/companies/${company.id}/chat`, { method: "POST", body: { text: outgoing.trim(), agentId: to.id } }).then(
      () => {
        // Sent: the draft goes. A failed send keeps it, so Send can be pressed again (BOS-637).
        if (fromBox) clearText();
        if (fromBox) img.clear();
        setError(null);
        setBusy(true);
        threads.reload();
        if (to.id === current?.id) chat.reload();
        else go(`chat/${company.id}/${to.id}`);
      },
      (err: Error) => setError(err.message),
    );
  };
  // Too long for a message: send it as a .txt file, which the agent opens whole.
  const sendAsFile = async (long: string) => {
    if (!company || !current) return;
    try {
      const markdown = await img.uploadText(long, "message.txt");
      await api(`/api/companies/${company.id}/chat`, { method: "POST", body: { text: withAttachments("I've sent the text as a file (below); please read it before answering.", [markdown]).trim(), agentId: current.id } });
      clearText();
      img.clear();
      setError(null);
      setBusy(true);
      threads.reload();
      chat.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  // A phone keyboard has no Shift, so there Return adds a line and Send sends.
  const coarse = useCoarsePointer();
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (coarse) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const unread = (t: Thread) => !!t.last && t.last.role !== "owner" && t.id !== current?.id && (!seen[t.id] || seen[t.id]! < t.last.createdAt);

  return (
    <div className="chat-page">
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
              <UpdateNote m={maintenance} />
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
                <OwnerMessageBox
                  id="chat-text"
                  label={`Message to ${current.name}`}
                  className="chat-text"
                  rows={2}
                  enterKeyHint={NEWLINE_KEY_HINT}
                  placeholder={coarse ? `Message ${current.name}` : `Message ${current.name}. Enter sends, Shift+Enter adds a line.`}
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
                {img.button}
                {current.duty === "assistant" && ceo && (
                  <button className="btn" type="button" disabled={!text.trim()} onClick={() => send(undefined, ceo)}>
                    Ask the CEO
                  </button>
                )}
                <button className="btn primary" type="submit" disabled={(!text.trim() && !img.attached.length) || img.busy || tooLongToSend(text, img.attached)}>
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
    </div>
  );
}
