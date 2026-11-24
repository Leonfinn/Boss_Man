// A ticket's activity (R65, R76): the conversation with its agents and each run's progress in
// one feed, oldest first, like a chat. A run that's going shows what the agent is doing as it
// happens; finished runs fold their steps away. The box at the bottom talks to the agent: into
// its live run (after the current turn, or interrupting it), or as a new run.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { systemAuthor, ticketRef } from "@boss-man/shared";
import { api, type Agent } from "../api";
import { NEWLINE_KEY_HINT, useCoarsePointer, usePoll } from "../hooks";
import { useDraft } from "../drafts";
import { linked, visibleParts } from "../pages/Chat";
import { countHits, findQuery, findSpots, spotIndex, splitHits, stepSpot, type FindSpot, type Segment } from "../chat-find";
import { ImagePreviews, useImageAttach, withAttachments } from "./ImageAttach";
import { OwnerMessageBox, tooLongToSend } from "./OwnerMessageBox";
import { outcomeTag, when } from "../pages/Runs";
import { STATUS, type TicketReview } from "./TicketReviews";
import { describe, useTranscript } from "../transcript";
import { Loader } from "./Loader";
import { LoadError } from "./LoadError";
import { stopRun } from "../stop-run";

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
/** One page of the conversation: the newest messages, or with `?before=` the ones before (BOS-2168). */
type Conversation = { items: Message[]; hasMore?: boolean; live: { id: string; agent: string | null } | null };

/** Oldest first, in the server's order: by time, then by id for messages sharing a time. */
const byTime = (a: Message, b: Message) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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
  if (!items.length) return <Loader label={live ? "Starting the run" : "Loading activity"} />;
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
  const [stopping, setStopping] = useState(false);
  const convo = usePoll((signal) => api<Conversation>(`/api/tickets/${ticketId}/messages`, { signal }), busy ? 3000 : 10_000, ticketId);
  const runs = usePoll((signal) => api<RunRow[]>(`/api/tickets/${ticketId}/runs`, { signal }), busy ? 3000 : 10_000, ticketId);
  // The ticket's reply box, kept while the server is away or the page reloads (BOS-637).
  const [text, setText, clearText] = useDraft(`ticket/${ticketId}/reply`);
  const img = useImageAttach(companyId, ticketId);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // "" is whoever is working the ticket; another agent (e.g. the CEO) can be asked about it instead.
  const [to, setTo] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const live = convo.data?.live ?? null;
  const other = agents.find((a) => a.id === to) ?? null;
  const working = live?.agent ?? assignee;
  useEffect(() => setBusy(live !== null), [live]);

  // Older pages loaded with "Load older messages" (BOS-2168), kept apart from the poll, which only
  // ever asks for the newest page. Once any are loaded, each polled page is folded in as well, so
  // a message that slides out of the newest page as new ones arrive stays on screen too.
  const [kept, setKept] = useState<ReadonlyMap<string, Message>>(() => new Map());
  const [olderMore, setOlderMore] = useState<boolean | null>(null);
  const [older, setOlder] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const shownTicket = useRef(ticketId);
  shownTicket.current = ticketId;
  useEffect(() => {
    setKept(new Map());
    setOlderMore(null);
    setOlder({ loading: false, error: null });
  }, [ticketId]);
  useEffect(() => {
    const items = convo.data?.items;
    if (items) setKept((prev) => (prev.size ? new Map([...prev, ...items.map((m) => [m.id, m] as const)]) : prev));
  }, [convo.data]);
  // The polled page wins over a kept copy: it carries the latest reply state (BOS-425).
  const messages = kept.size ? [...new Map([...kept, ...(convo.data?.items ?? []).map((m) => [m.id, m] as const)]).values()].sort(byTime) : (convo.data?.items ?? []);
  const hasOlder = olderMore ?? convo.data?.hasMore ?? false;
  const feedBox = useRef<HTMLDivElement>(null);
  // Where the oldest message sat on screen before the older page went in above it.
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest || older.loading) return;
    const key = `m${oldest.id}`;
    const el = feedBox.current?.querySelector<HTMLElement>(`[data-key="${key}"]`);
    anchor.current = el ? { key, top: el.getBoundingClientRect().top } : null;
    setOlder({ loading: true, error: null });
    const id = ticketId;
    try {
      const page = await api<Conversation>(`/api/tickets/${id}/messages?before=${encodeURIComponent(oldest.id)}`);
      if (shownTicket.current !== id) return;
      const newest = convo.data?.items ?? [];
      setKept((prev) => new Map([...page.items.map((m) => [m.id, m] as const), ...prev, ...newest.map((m) => [m.id, m] as const)]));
      setOlderMore(page.hasMore ?? false);
      setOlder({ loading: false, error: null });
    } catch (err) {
      anchor.current = null;
      if (shownTicket.current === id) setOlder({ loading: false, error: (err as Error).message });
    }
  };
  // Keep the message the owner was reading where it was: move the scroll by however far the older
  // page pushed it down. The feed scrolls itself on a wide screen and the page does on a phone.
  useLayoutEffect(() => {
    const a = anchor.current;
    const box = feedBox.current;
    if (!a || !box) return;
    anchor.current = null;
    const el = box.querySelector<HTMLElement>(`[data-key="${a.key}"]`);
    if (!el) return;
    const shift = el.getBoundingClientRect().top - a.top;
    if (!shift) return;
    if (box.scrollHeight > box.clientHeight) box.scrollTop += shift;
    else window.scrollBy(0, shift);
  }, [kept]);

  // Find in this conversation (BOS-2422), over the helper chat uses (chat-find.ts). `at` is "the nth match in
  // message X", so older pages added above move nothing. A message's matches run through its summary, then its
  // Details, in the order they are drawn.
  const split = (m: Message) => (m.author === "agent" ? splitDetails(m.text) : { summary: m.text, details: null });
  const partsOf = (m: Message) => {
    const { summary, details } = split(m);
    return { id: m.id, parts: [...visibleParts(summary), ...(details ? visibleParts(details) : [])] };
  };
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [query, setQuery] = useState("");
  const [at, setAt] = useState<FindSpot | null>(null);
  const [findNote, setFindNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const searchRun = useRef(0);
  const findBox = useRef<HTMLInputElement>(null);
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
  const closeFind = () => {
    searchRun.current++;
    setSearching(false);
    setFindOpen(false);
    setFindText("");
    setQuery("");
    setAt(null);
    setFindNote(null);
  };
  useEffect(closeFind, [ticketId]);
  useEffect(() => {
    if (findOpen) findBox.current?.focus();
  }, [findOpen]);
  const spots = query ? findSpots(messages.map(partsOf), query) : [];
  const here = spotIndex(spots, at);
  const curSpot = here >= 0 ? spots[here]! : null;
  const curKey = curSpot ? `${curSpot.id}:${curSpot.n}` : "";
  useEffect(() => {
    if (spots.length && here < 0) setAt(spots[0]!);
  }, [spots.length, here, query]);
  useEffect(() => {
    if (curKey) feedBox.current?.querySelector(".find-hit.current")?.scrollIntoView({ block: "center" });
  }, [curKey, query]);
  const step = (dir: 1 | -1) => setAt(stepSpot(spots, curSpot, dir));
  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };
  // Ctrl+F or Cmd+F with focus in the conversation opens the box instead of the browser's own find.
  const onSectionKey = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setFindOpen(true);
      findBox.current?.focus();
    }
  };
  // Loads older pages until one has a match or the start is reached.
  const searchOlder = async () => {
    const first = messages[0];
    if (!first || searching || !query) return;
    const run = ++searchRun.current;
    const id = ticketId;
    setSearching(true);
    setFindNote(null);
    try {
      let top = first;
      let more = hasOlder;
      let page: Message[] = [];
      let loaded: Message[] = [];
      let hits = 0;
      while (more && !hits) {
        const res = await api<Conversation>(`/api/tickets/${id}/messages?before=${encodeURIComponent(top.id)}`);
        if (searchRun.current !== run || shownTicket.current !== id) return;
        page = res.items;
        loaded = [...loaded, ...page];
        more = (res.hasMore ?? false) && page.length > 0;
        top = page[0] ?? top;
        hits = page.reduce((sum, m) => sum + countHits(partsOf(m).parts, query), 0);
        setOlderMore(more);
      }
      const newest = convo.data?.items ?? [];
      setKept((prev) => new Map([...loaded.map((m) => [m.id, m] as const), ...prev, ...newest.map((m) => [m.id, m] as const)]));
      if (hits) {
        setAt(findSpots(page.map(partsOf), query).at(-1) ?? null);
        setFindNote(`${hits} more found`);
      } else {
        setFindNote("No more matches; start of the conversation");
      }
    } catch (err) {
      if (searchRun.current === run) setFindNote((err as Error).message);
    } finally {
      if (searchRun.current === run) setSearching(false);
    }
  };
  // Matches in a message are numbered in the order they are drawn, the same order findSpots counted them.
  const markIn = (m: Message, seq: { n: number }) => (words: string): ReactNode =>
    !query
      ? words
      : splitHits(words, query).map((s: Segment, k) =>
          s.hit ? (
            <mark key={k} className={`find-hit${curSpot?.id === m.id && curSpot.n === seq.n++ ? " current" : ""}`}>
              {s.text}
            </mark>
          ) : (
            <Fragment key={k}>{s.text}</Fragment>
          ),
        );

  const feed = [
    ...messages.map((m) => ({ at: m.createdAt, key: `m${m.id}`, m, r: null as RunRow | null, mark: null })),
    ...(runs.data ?? []).map((r) => ({ at: r.startedAt, key: `r${r.id}`, m: null as Message | null, r, mark: null })),
    ...reviewMarks(reviews ?? []).map((mark) => ({ at: mark.at, key: mark.key, m: null as Message | null, r: null as RunRow | null, mark })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  // Follow the newest item down. Keyed on the last item, not the count, so older messages added
  // above (BOS-2168) don't throw the owner to the bottom.
  // Braces: scrollIntoView returns a Promise in Chromium 150+, and React would call it as the clean-up.
  const lastKey = feed.at(-1)?.key;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lastKey]);

  const send = async (interrupt = false) => {
    const outgoing = withAttachments(text, img.attached);
    if (!outgoing.trim()) return;
    try {
      await api(`/api/tickets/${ticketId}/messages`, { method: "POST", body: { text: outgoing.trim(), interrupt, ...(other ? { agentId: other.id } : {}) } });
      // Sent: the draft goes. A failed send keeps it, so Send can be pressed again (BOS-637).
      clearText();
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
      clearText();
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
    setStopping(true);
    try {
      const said = await stopRun(live.id, live.agent);
      if (said) setNote({ ok: true, text: said });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setStopping(false);
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
    <section className="card activity" aria-labelledby="activity-h" onKeyDown={onSectionKey}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h2 id="activity-h">Activity</h2>
        <button type="button" className="btn" aria-expanded={findOpen} onClick={() => (findOpen ? closeFind() : setFindOpen(true))} title="Find in this conversation (Ctrl+F)">
          Find
        </button>
      </div>
      {findOpen && (
        <div className="chat-find" role="search">
          <input ref={findBox} type="search" aria-label="Find in this conversation" placeholder="Find in this conversation" value={findText} onChange={(e) => setFindText(e.target.value)} onKeyDown={onFindKey} />
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
          {query && hasOlder && (
            <button type="button" className="btn" onClick={() => void searchOlder()} disabled={searching}>
              {searching ? "Searching…" : "Search older messages"}
            </button>
          )}
          {searching && (
            <p className="muted" role="status">
              Searching older messages…
            </p>
          )}
          {!searching && findNote && (
            <p className="muted" role="status">
              {findNote}
            </p>
          )}
        </div>
      )}
      <div className="activity-feed" role="log" aria-live="polite" ref={feedBox}>
        {hasOlder && messages.length > 0 && (
          <div style={{ textAlign: "center" }}>
            <button className="btn" type="button" disabled={older.loading} onClick={() => void loadOlder()}>
              {older.loading ? "Loading older messages…" : "Load older messages"}
            </button>
            {older.error && (
              <p className="error" role="alert" style={{ fontSize: 13 }}>
                {older.error}
              </p>
            )}
          </div>
        )}
        {!convo.data && !convo.error && <Loader label="Loading the conversation" />}
        {!convo.data && convo.error && (
          <LoadError
            what="the conversation"
            message={convo.error.message}
            onRetry={() => {
              convo.reload();
              runs.reload();
            }}
          />
        )}
        {convo.data && !runs.data && runs.error && (
          <LoadError what="the runs" message={runs.error.message} onRetry={runs.reload} />
        )}
        {feed.length === 0 && convo.data && <p className="muted">No activity yet. When an agent works on this task, you'll see what it's doing here, and you can talk to it below.</p>}
        {feed.map(({ key, m, r, mark }) =>
          mark ? (
            <p key={key} className={`activity-mark ${mark.tone}`}>
              {mark.text} · {when(mark.at)}
            </p>
          ) : r ? (
            <RunBlock key={key} run={r} />
          ) : (
            <div key={key} data-key={key} className={`chat-msg ${m!.author === "agent" ? "assistant" : m!.author}`}>
              {(() => {
                const { summary, details } = split(m!);
                const mark = markIn(m!, { n: 0 });
                // Details open when the current match is in them.
                const inDetails = !!query && !!details && curSpot?.id === m!.id && curSpot.n >= countHits(visibleParts(summary), query);
                return (
                  <>
                    <p>{linked(summary, companyId, refCtx, mark)}</p>
                    {details && (
                      <details open={inDetails || undefined}>
                        <summary>Details</summary>
                        <p>{linked(details, companyId, refCtx, mark)}</p>
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
          <button className="btn primary" type="submit" disabled={(!text.trim() && !img.attached.length) || img.busy || tooLongToSend(text, img.attached)} title={!text.trim() && !img.attached.length ? "Type a message first" : undefined}>
            Send
          </button>
          {live && (
            <>
              <button className="btn" type="button" disabled={(!text.trim() && !img.attached.length) || !!other} onClick={() => void send(true)} title="Stops the agent's current turn, then gives it your message">
                Interrupt and send
              </button>
              <button className="btn" type="button" disabled={stopping} onClick={() => void stop()} style={{ color: "var(--red-ink)" }}>
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
