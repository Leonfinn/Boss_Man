// The owner chat (v1.1, R70), laid out like a messenger: the team on the left, the
// conversation on the right. Most messages go to the CEO, but any agent can be messaged
// directly. On a phone the list and the conversation take turns.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, type Company } from "../api";
import { download } from "../csv";
import { NoCompany } from "../components/NoCompany";
import { NEWLINE_KEY_HINT, useCoarsePointer, usePoll } from "../hooks";
import { useDraft } from "../drafts";
import { when } from "./Runs";
import { atTime } from "./settings/updates";
import { StarButton } from "./Agents";
import { Avatar } from "../components/Avatar";
import { DraftTextarea } from "../components/DraftTextarea";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { ImagePreviews, useImageAttach, withAttachments } from "../components/ImageAttach";
import { OwnerMessageBox, tooLongToSend } from "../components/OwnerMessageBox";
import { ThinkingTrace } from "../components/ThinkingTrace";
import { linkPieces, type LinkContext } from "../links";
import { countHits, dayStart, findQuery, findSpots, firstOnOrAfter, spotIndex, splitHits, stepSpot, type FindSpot, type Segment } from "../chat-find";
import type { TraceBody } from "@boss-man/shared";

type Message = { id: string; role: "owner" | "assistant" | "system"; text: string; createdAt: string; trace?: TraceBody };
type Chat = { agentId: string; items: Message[]; hasMore?: boolean; state: string; live?: TraceBody | null };
/** The runner-update hold, from App's /api/maintenance poll (BOS-349). */
type Maintenance = { on: false } | { on: true; kind?: "update" | "settings" | "wrapup" | "building"; runs: number; chatOpen: boolean; /** BOS-1951 */ merges?: number; checks?: number; unknownWait?: boolean; /** BOS-1877 */ phase?: "waiting" | "swapping"; expectedFinishAt?: string | null; overdue?: boolean };
type Thread = { id: string; name: string; role: "ceo" | "manager" | "worker"; duty: string | null; state: string; last: { role: Message["role"]; text: string; createdAt: string } | null };

/** Plain text with in-app links made clickable (BOS-358): one shared builder, see links.ts. */
export function linked(text: string, wikiCompanyId?: string, ctx: LinkContext = {}, mark: (words: string) => ReactNode = (w) => w): ReactNode {
  return linkPieces(text, { ...ctx, companyId: wikiCompanyId ?? ctx.companyId }).map((p, i) =>
    p.kind === "text" ? (
      <Fragment key={i}>{mark(p.text)}</Fragment>
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
        {mark(p.text)}
      </a>
    ),
  );
}

/** What a message shows as words (plain text and link text), for the find box: never the markup or an image. */
const visibleParts = (text: string) => linkPieces(text, {}).flatMap((p) => (p.kind === "text" || p.kind === "link" ? [p.text] : []));

/** The whole conversation as Markdown (BOS-2313): oldest first, no thinking traces; attachments stay as their links. */
export function chatMarkdown(agentName: string, date: string, items: Message[]): string {
  const who = (m: Message) => (m.role === "owner" ? "You" : m.role === "system" ? "System" : agentName);
  const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  return `# Chat with ${agentName}, ${date}\n\n${items.map((m) => `**${who(m)}** · ${utc(m.createdAt)}\n\n${m.text}\n`).join("\n")}`;
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

/** "Remember this" on the owner's own message (BOS-2184): adds the text as a new line of the standing rules, with Undo. */
export function RememberThis({ companyId, text }: { companyId: string; text: string }) {
  const [step, setStep] = useState<"idle" | "editing" | "added">("idle");
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/companies/${companyId}/standing-rules`;
  const call = (path: string, body: unknown, done: () => void) => {
    setBusy(true);
    setError(null);
    void api(`${url}/${path}`, { method: "POST", body }).then(
      () => {
        setBusy(false);
        done();
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };
  if (step === "added")
    return (
      <p className="remember-note muted" role="status">
        Added to standing rules.{" "}
        <button type="button" className="linkish" disabled={busy} onClick={() => call("undo", undefined, () => setStep("idle"))}>
          Undo
        </button>
        {error && <span className="error"> {error}</span>}
      </p>
    );
  if (step === "idle")
    return (
      <button type="button" className="linkish remember-btn" onClick={() => { setDraft(text); setError(null); setStep("editing"); }}>
        Remember this
      </button>
    );
  return (
    <div className="remember-box">
      <label>
        <span className="muted">Add this to the standing rules every agent reads:</span>
        <DraftTextarea draftKey={null} noDraft="a short edit of a message that is already in the chat, which stays there" value={draft} onChange={setDraft} rows={3} />
      </label>
      <div className="remember-actions">
        <button type="button" className="btn primary" disabled={busy || !draft.trim()} onClick={() => call("append", { text: draft }, () => setStep("added"))}>
          Add to standing rules
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => setStep("idle")}>
          Cancel
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
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
  // Older pages the owner loaded (BOS-2167), kept apart from the polled newest 200 so a poll never drops them.
  const [older, setOlder] = useState<{ key: string; items: Message[]; hasMore: boolean } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const keep = useRef<{ height: number; top: number } | null>(null);
  const convKey = `${company?.id ?? "none"}/${current?.id ?? "none"}`;
  const olderHere = older?.key === convKey ? older : null;
  const newest = chat.data?.items ?? [];
  const seenIds = new Set(newest.map((m) => m.id));
  const items = olderHere ? [...olderHere.items.filter((m) => !seenIds.has(m.id)), ...newest] : newest;
  const hasMore = olderHere ? olderHere.hasMore : (chat.data?.hasMore ?? false);
  const loadOlder = async () => {
    const first = items[0];
    if (!company || !current || !first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api<Chat>(`/api/companies/${company.id}/chat?agentId=${current.id}&before=${first.id}`);
      const log = logRef.current;
      keep.current = log ? { height: log.scrollHeight, top: log.scrollTop } : null;
      setOlder({ key: convKey, items: [...page.items, ...(olderHere?.items ?? [])], hasMore: page.hasMore ?? false });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  };
  const [preparing, setPreparing] = useState(false);
  const downloadChat = async () => {
    if (!company || !current || preparing) return;
    setPreparing(true);
    try {
      const url = `/api/companies/${company.id}/chat?agentId=${current.id}`;
      let page = await api<Chat>(url);
      let all = page.items;
      while (page.hasMore && all[0]) {
        page = await api<Chat>(`${url}&before=${all[0].id}`);
        all = [...page.items, ...all];
      }
      const day = new Date().toISOString().slice(0, 10);
      const slug = current.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
      download(`chat-${slug}-${day}.md`, chatMarkdown(current.name, day, all), "text/markdown;charset=utf-8");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreparing(false);
    }
  };
  // After older messages are added above, put the owner back on the message they were reading.
  useLayoutEffect(() => {
    const k = keep.current;
    const log = logRef.current;
    keep.current = null;
    if (k && log) log.scrollTop = k.top + (log.scrollHeight - k.height);
  }, [olderHere?.items.length]);
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
  // The palette stays mounted over this page and the page isn't keyed by route, so a result picked while a
  // chat is open (same chat or another agent's) arrives as a new messageId on this same instance: re-arm.
  // Declared before the scroll effect so it runs first in the same commit.
  useEffect(() => {
    target.current = messageId;
    setOlderThanShown(false);
  }, [messageId, current?.id]);
  // Only this conversation's data counts: right after a switch the previous agent's page is still in
  // chat.data for one render, and the target missing from it must not read as "older than shown".
  const loaded = !!current && chat.data?.agentId === current.id;
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
    // Keyed on the polled newest page (BOS-2167), so loading older messages doesn't jump to the end.
    end.current?.scrollIntoView({ block: "end" });
  }, [newest.length, newest.at(-1)?.id, current?.id, loaded, messageId]);
  useEffect(() => {
    if (!current || !latest) return;
    markSeen(current.id, latest);
    setSeen(readSeen());
  }, [current?.id, latest]);

  const ceo = team.find((t) => t.role === "ceo");

  // Find in this conversation and Go to date (BOS-2411). `at` is the current match as "the nth in message X", so
  // loading older messages above it moves nothing; the matches are counted over the words a message shows.
  const shownText = (m: Message) => (m.text.includes(ASK_CEO) && ceo ? m.text.split(ASK_CEO)[0]! : m.text);
  const partsOf = (m: Message) => ({ id: m.id, parts: visibleParts(shownText(m)) });
  const [findText, setFindText] = useState("");
  const [query, setQuery] = useState("");
  const [at, setAt] = useState<FindSpot | null>(null);
  const [findNote, setFindNote] = useState<string | null>(null);
  const [dateNote, setDateNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [jump, setJump] = useState<{ id: string } | null>(null);
  const searchRun = useRef(0);
  // After a short pause in typing; clearing the box takes effect at once.
  useEffect(() => {
    if (!findQuery(findText)) {
      setQuery("");
      return;
    }
    const t = setTimeout(() => setQuery(findText), 250);
    return () => clearTimeout(t);
  }, [findText]);
  useEffect(() => {
    setAt(null);
    setFindNote(null);
  }, [query]);
  useEffect(() => {
    searchRun.current++;
    setSearching(false);
    setFindText("");
    setQuery("");
    setAt(null);
    setFindNote(null);
    setDateNote(null);
  }, [convKey]);
  const spots = query ? findSpots(items.map(partsOf), query) : [];
  const here = spotIndex(spots, at);
  const curSpot = here >= 0 ? spots[here]! : null;
  const curKey = curSpot ? `${curSpot.id}:${curSpot.n}` : "";
  // The newest match is current until the owner steps.
  useEffect(() => {
    if (spots.length && here < 0) setAt(spots[spots.length - 1]!);
  }, [spots.length, here, query]);
  useEffect(() => {
    if (curKey) logRef.current?.querySelector(".find-hit.current")?.scrollIntoView({ block: "center" });
  }, [curKey, query]);
  useEffect(() => {
    if (jump) document.getElementById(`chat-msg-${jump.id}`)?.scrollIntoView({ block: "start" });
  }, [jump]);
  const step = (dir: 1 | -1) => setAt(stepSpot(spots, curSpot, dir));
  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };
  // Loads older pages until one has a match or the start is reached.
  const searchOlder = async () => {
    const first = items[0];
    if (!company || !current || !first || searching || !query) return;
    const run = ++searchRun.current;
    setSearching(true);
    setFindNote(null);
    setDateNote(null);
    try {
      let all = olderHere?.items ?? [];
      let top = first;
      let more = hasMore;
      let page: Message[] = [];
      let hits = 0;
      while (more && !hits) {
        const res = await api<Chat>(`/api/companies/${company.id}/chat?agentId=${current.id}&before=${top.id}`);
        if (searchRun.current !== run) return;
        page = res.items;
        all = [...page, ...all];
        more = (res.hasMore ?? false) && page.length > 0;
        top = page[0] ?? top;
        hits = page.reduce((sum, m) => sum + countHits(partsOf(m).parts, query), 0);
      }
      setOlder({ key: convKey, items: all, hasMore: more });
      if (hits) {
        setAt(findSpots(page.map(partsOf), query).at(-1) ?? null);
        setFindNote(`${hits} more found`);
      } else {
        setFindNote("No more matches; start of the conversation");
      }
      setError(null);
    } catch (err) {
      if (searchRun.current === run) setError((err as Error).message);
    } finally {
      if (searchRun.current === run) setSearching(false);
    }
  };
  const goToDate = async (value: string) => {
    setDateNote(null);
    const start = dayStart(value);
    if (start === null || !company || !current || !items.length || searching) return;
    const run = ++searchRun.current;
    setSearching(true);
    try {
      let list = items;
      let all = olderHere?.items ?? [];
      let more = hasMore;
      let loaded = false;
      while (more && new Date(list[0]!.createdAt).getTime() >= start) {
        const res = await api<Chat>(`/api/companies/${company.id}/chat?agentId=${current.id}&before=${list[0]!.id}`);
        if (searchRun.current !== run) return;
        loaded = true;
        all = [...res.items, ...all];
        list = [...res.items, ...list];
        more = (res.hasMore ?? false) && res.items.length > 0;
      }
      if (loaded) setOlder({ key: convKey, items: all, hasMore: more });
      const target = firstOnOrAfter(list, start);
      const nextDay = new Date(start);
      nextDay.setDate(nextDay.getDate() + 1);
      const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
      if (!target) {
        setDateNote(`There are no messages on or after ${day(new Date(start).toISOString())}.`);
      } else {
        if (new Date(target.createdAt).getTime() >= nextDay.getTime()) {
          setDateNote(!more && target.id === list[0]!.id ? `This chat doesn't go back that far: it starts on ${day(target.createdAt)}.` : `No messages on that day; showing the next one, on ${day(target.createdAt)}.`);
        }
        setJump({ id: target.id });
      }
      setError(null);
    } catch (err) {
      if (searchRun.current === run) setError((err as Error).message);
    } finally {
      if (searchRun.current === run) setSearching(false);
    }
  };
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
                <button type="button" className="btn" onClick={() => void downloadChat()} disabled={preparing}>
                  {preparing ? "Preparing" : "Download"}
                </button>
              </header>
              <div className="chat-find" role="search">
                <input
                  type="search"
                  aria-label="Find in this conversation"
                  placeholder="Find in this conversation"
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  onKeyDown={onFindKey}
                />
                {query && (
                  <span className="muted" role="status">
                    {spots.length ? `${here + 1} of ${spots.length}` : "No matches"}
                  </span>
                )}
                {query && (
                  <>
                    <button type="button" className="btn" onClick={() => step(-1)} disabled={spots.length < 2} title="Previous match">
                      Previous
                    </button>
                    <button type="button" className="btn" onClick={() => step(1)} disabled={spots.length < 2} title="Next match">
                      Next
                    </button>
                  </>
                )}
                {query && hasMore && (
                  <button type="button" className="btn" onClick={() => void searchOlder()} disabled={searching}>
                    {searching ? "Searching…" : "Search older messages"}
                  </button>
                )}
                <label className="chat-date">
                  Go to date
                  <input type="date" onChange={(e) => void goToDate(e.target.value)} disabled={searching} />
                </label>
                {(findNote || dateNote) && (
                  <p className="muted" role="status">
                    {dateNote ?? findNote}
                  </p>
                )}
              </div>
              <div className="chat-log" role="log" aria-live="polite" ref={logRef}>
                {hasMore && (
                  <button type="button" className="btn" onClick={() => void loadOlder()} disabled={loadingOlder}>
                    {loadingOlder ? "Loading…" : "Load older messages"}
                  </button>
                )}
                {!chat.data && chat.error && <LoadError what="this conversation" message={chat.error.message} onRetry={chat.reload} />}
                {!chat.data && !chat.error && <Loader label="Loading the conversation" size={16} />}
                {olderThanShown && <p className="muted">The message you searched for is older than the messages shown here, so the chat opens at its newest. Use "Load older messages" at the top to go back to it.</p>}
                {items.length === 0 && chat.data && (
                  <p className="muted">
                    {current.role === "ceo" || current.duty === "assistant" ? 'Try: "Add rate limiting to the login API before the beta, after the auth refactor."' : `Ask ${current.name} about their work, or for something to go on the board.`}
                  </p>
                )}
                {items.map((m, i) => {
                  const trace = m.trace;
                  // Matches are numbered in the order they are drawn, the same order findSpots counted them.
                  let seq = 0;
                  const mark = (words: string): ReactNode =>
                    !query
                      ? words
                      : splitHits(words, query).map((s: Segment, k) =>
                          s.hit ? (
                            <mark key={k} className={`find-hit${curSpot?.id === m.id && curSpot.n === seq++ ? " current" : ""}`}>
                              {s.text}
                            </mark>
                          ) : (
                            <Fragment key={k}>{s.text}</Fragment>
                          ),
                        );
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
                            {linked(m.text.split(ASK_CEO)[0]!, undefined, {}, mark)}
                            <button type="button" className="linkish" onClick={() => send(undefined, ceo, items.slice(0, i).reverse().find((x) => x.role === "owner")?.text ?? "")}>
                              Ask the CEO
                            </button>
                          </>
                        ) : (
                          linked(m.text, undefined, {}, mark)
                        )}
                      </p>
                      <small>
                        {m.role === "owner" ? "You" : m.role === "assistant" ? current.name : "Boss Man"} · {when(m.createdAt)}
                      </small>
                      {m.role === "owner" && <RememberThis companyId={company.id} text={m.text} />}
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
