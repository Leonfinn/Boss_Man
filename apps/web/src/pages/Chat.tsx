// The owner chat (v1.1, R70), laid out like a messenger: the team on the left, the
// conversation on the right. Most messages go to the CEO, but any agent can be messaged
// directly. On a phone the list and the conversation take turns.
import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, type Company } from "../api";
import { NoCompany } from "../components/NoCompany";
import { NEWLINE_KEY_HINT, useCoarsePointer, usePoll } from "../hooks";
import { useDraft } from "../drafts";
import { when } from "./Runs";
import { atTime } from "./settings/updates";
import { StarButton } from "./Agents";
import { Avatar } from "../components/Avatar";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { ImagePreviews, useImageAttach, withAttachments } from "../components/ImageAttach";
import { OwnerMessageBox, tooLongToSend } from "../components/OwnerMessageBox";
import { ThinkingTrace } from "../components/ThinkingTrace";
import { linkPieces, type LinkContext } from "../links";
import type { TraceBody } from "@boss-man/shared";

type Message = { id: string; role: "owner" | "assistant" | "system"; text: string; createdAt: string; trace?: TraceBody };
type Chat = { agentId: string; items: Message[]; state: string; live?: TraceBody | null };
/** The runner-update hold, from App's /api/maintenance poll (BOS-349). */
type Maintenance = { on: false } | { on: true; kind?: "update" | "settings" | "wrapup" | "building"; runs: number; chatOpen: boolean; /** BOS-1951 */ merges?: number; checks?: number; unknownWait?: boolean; /** BOS-1877 */ phase?: "waiting" | "swapping"; expectedFinishAt?: string | null; overdue?: boolean };
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
  if (m.kind === "building")
    return (
      <p className="banner" role="status">
        A runner update is being built. Chat stays open; new agent runs start once the update has gone in.
      </p>
    );
  if (m.kind === "settings")
    return (
      <p className="banner" role="status">
        {m.chatOpen
          ? `Applying a runner setting change (not an update): waiting for ${m.runs} agent${m.runs === 1 ? "" : "s"} to finish. Chat stays open until then.`
          : "Applying a runner setting change (not an update), back in a moment. New messages are saved and answered when it is done."}
      </p>
    );
  return (
    <p className="banner" role="status">
      {m.chatOpen
        ? m.runs === 0 && m.unknownWait
          ? "Update running late: Boss Man cannot say what it is waiting for. Chat stays open; see Settings → Server and runner → Updates to stop waiting or cancel."
          : m.runs === 0 && (m.merges ?? 0) > 0 && !(m.checks ?? 0)
            ? `Update waiting for ${m.merges === 1 ? "a merge" : `${m.merges} merges`} being pushed to main${m.expectedFinishAt ? `, expected about ${atTime(m.expectedFinishAt)}` : m.overdue ? " (taking longer than expected)" : ""}: chat stays open until then.`
          : m.runs === 0
          ? `Update waiting for running checks to finish${m.expectedFinishAt ? `, expected about ${atTime(m.expectedFinishAt)}` : m.overdue ? " (taking longer than expected)" : ""}: chat stays open until then.`
          : `Update waiting for ${m.runs} agent${m.runs === 1 ? "" : "s"} to finish: chat stays open until then.`
        : m.phase === "swapping"
          ? "Swapping the runners now, back in a moment. New messages are saved and answered when it is done."
          : `Update pending${m.expectedFinishAt ? `: expected to finish about ${atTime(m.expectedFinishAt)}` : m.overdue ? ": taking longer than expected" : ""}. New messages are saved and answered when it is done.`}
    </p>
  );
}

export function ChatPage({ companies, companyId, agentId, messageId, maintenance = null, go, onChanged }: { companies: Company[]; companyId: string | undefined; agentId: string | undefined; /** BOS-2192: a search result's message, scrolled to once loaded. */ messageId?: string; maintenance?: Maintenance | null; go: (to: string) => void; onChanged: () => void }) {
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
  const live = chat.data?.live ?? null;
  // Which traces and steps the owner has opened, kept by message (or the live run) so the 2 s poll
  // doesn't close them; not kept after a reload (BOS-1367). Keyed by message id, or `live:<agentId>`.
  const [traceOpen, setTraceOpen] = useState<Record<string, boolean>>({});
  const [stepOpen, setStepOpen] = useState<Record<string, Record<number, boolean>>>({});
  const liveKey = `live:${current?.id ?? ""}`;
  const latest = items.at(-1)?.createdAt;
  useEffect(() => setBusy(state !== "idle"), [state]);
  // Braces: scrollIntoView returns a Promise in Chromium 150+, and React would call it as the clean-up.
  // A search result names one message (BOS-2192): scroll to it once it has loaded. If the conversation
  // loaded without it (older than the newest 200 shown), say so and open at the end as usual.
  const target = useRef(messageId);
  const [olderThanShown, setOlderThanShown] = useState(false);
  const loaded = !!chat.data;
  useEffect(() => {
    const want = target.current;
    if (want) {
      const el = document.getElementById(`chat-msg-${want}`);
      if (el) {
        target.current = undefined;
        el.scrollIntoView({ block: "center" });
        return;
      }
      if (!loaded) return;
      target.current = undefined;
      setOlderThanShown(true);
    }
    end.current?.scrollIntoView({ block: "end" });
  }, [items.length, current?.id, loaded]);
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
        <NoCompany />
      ) : (
        <section className="card messenger" data-picked={agentId ? "yes" : "no"} aria-label="Chat">
          <nav className="messenger-list" aria-label="Team">
            {!threads.data && threads.error && <LoadError what="the team" message={threads.error.message} onRetry={threads.reload} />}
            {!threads.data && !threads.error && <Loader label="Loading the team" size={16} />}
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
                {!chat.data && chat.error && <LoadError what="this conversation" message={chat.error.message} onRetry={chat.reload} />}
                {!chat.data && !chat.error && <Loader label="Loading the conversation" size={16} />}
                {olderThanShown && <p className="muted">The message you searched for is older than the messages shown here, so the chat opens at its newest.</p>}
                {items.length === 0 && chat.data && (
                  <p className="muted">
                    {current.role === "ceo" || current.duty === "assistant" ? 'Try: "Add rate limiting to the login API before the beta, after the auth refactor."' : `Ask ${current.name} about their work, or for something to go on the board.`}
                  </p>
                )}
                {items.map((m, i) => {
                  const trace = m.trace;
                  return (
                    <div key={m.id} id={`chat-msg-${m.id}`} className={`chat-msg ${m.role}${trace ? " has-trace" : ""}${m.id === messageId ? " found" : ""}`}>
                      {trace && m.role === "assistant" && (
                        <ThinkingTrace
                          trace={trace}
                          open={traceOpen[m.id]}
                          onToggle={(v) => setTraceOpen((s) => ({ ...s, [m.id]: v }))}
                          stepOpen={stepOpen[m.id]}
                          onStepToggle={(idx, v) => setStepOpen((s) => ({ ...s, [m.id]: { ...s[m.id], [idx]: v } }))}
                        />
                      )}
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
                  );
                })}
                {live && (
                  <div className="chat-msg assistant live has-trace" key={liveKey}>
                    <ThinkingTrace
                      trace={live}
                      live
                      open={traceOpen[liveKey]}
                      onToggle={(v) => setTraceOpen((s) => ({ ...s, [liveKey]: v }))}
                      stepOpen={stepOpen[liveKey]}
                      onStepToggle={(idx, v) => setStepOpen((s) => ({ ...s, [liveKey]: { ...s[liveKey], [idx]: v } }))}
                    />
                    <p>
                      <span className="muted">{current.name} is working…</span>
                    </p>
                  </div>
                )}
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
