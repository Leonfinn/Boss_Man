// The merge queue (BOS-587): approved work waiting to merge, the check running now, and how the
// last ones ended. Read-only and in plain words; it never changes the queue. It reloads on the
// usual live-update poll, so a merge that starts or finishes shows without a page reload.
// BOS-1239 (design BOS-1207): what needs the owner comes first (status pills, a Needs you card), the
// merge order stays as it is, rows carry one short state word, and "main is red" is said once.
import { useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { Company } from "../api";
import { api } from "../api";
import { usePoll, useRoute } from "../hooks";
import { ago } from "./Dashboard";

type Phase = "queued" | "checking" | "merging" | "waiting_to_retry";
type RunningNow = { ticketId: string; ref: string | null; title: string; phase: Phase; startedAt: string; startedBy: string; minutes: number; what: "merge_check" | "agent_check"; slot: number; overLimit: boolean };
type WaitingState = "waiting_for_slot" | "check_failed_retrying" | "needs_you" | "waiting_for_sign_off" | "waiting_for_check_capacity" | "checking" | "waiting_host" | "waiting_for_decision" | "waiting_for_other_ticket" | "held";
/** Approved work held by the carried-work guard (BOS-130, BOS-766): the ticket(s) it waits for. */
type CarriedHold = { ticketId: string | null; ref: string | null; title: string };
/** The card a waiting merge is held by (BOS-1078): named, with who raised it and a link straight to it. */
type HoldingCard = { id: string; kind: "sign_off" | "hold" | "merge"; question: string; raisedBy: string | null; raisedAt: string; staleHint: string | null };
type WaitingRow = { ticketId: string; ref: string | null; title: string; minutes: number; state: WaitingState; label: string; stuck: boolean; next: string | null; actor: "agent" | "ceo" | "owner" | "system" | null; decisionId: string | null; risk: string; urgent: boolean; failedCheck: boolean; carried?: CarriedHold[]; card?: HoldingCard | null; signedOffAt?: string | null; place?: number | null; why?: string | null };
type RecentRow = { ticketId: string; ref: string | null; title: string; result: "merged" | "check_failed"; detail: string; at: string };
type MergeQueueData = { companyId: string; mode: "legacy" | "server"; slots: number; running: RunningNow[]; waiting: WaitingRow[]; recent: RecentRow[]; waitingCount: number };

const PHASE: Record<Phase, string> = { queued: "waiting for a check slot", checking: "running the check", merging: "merging", waiting_to_retry: "trying again after the runner restarted" };
const ACTOR: Record<NonNullable<WaitingRow["actor"]>, string> = { agent: "the agent", ceo: "the CEO", owner: "you", system: "Boss Man" };

/** "4 waiting to merge" for the side menu's badge, or null when nothing waits. */
export function waitingLabel(n: number): string | null {
  return n > 0 ? `${n} waiting to merge` : null;
}

/** "12m", "1h 20m", "3h". */
function waited(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "12:55" today, "9 Nov, 12:55" on another day. */
export function clockText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

/** Who is acting, in plain grammar: "you're acting", "the CEO is acting". */
export function actingText(actor: NonNullable<WaitingRow["actor"]>): string {
  return actor === "owner" ? "you're acting" : `${ACTOR[actor]} is acting`;
}

const upFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const slotsText = (n: number) => `${n} ${n === 1 ? "slot" : "slots"}`;

/** The one short state word on a waiting row (BOS-1207): the colour on its left edge only repeats it. */
export function rowState(r: WaitingRow): { word: string; tone: "amber" | "red" | "grey" | "blue" } {
  if (r.actor === "owner") return { word: "Needs you", tone: "amber" };
  if (r.state === "check_failed_retrying") return { word: "Check failed", tone: "red" };
  if (r.stuck) return { word: "Stuck", tone: "red" };
  if (r.state === "checking") return { word: "Checking", tone: "blue" };
  if (r.state === "held" || r.state === "waiting_host" || r.state === "waiting_for_other_ticket" || r.state === "waiting_for_decision") return { word: "Held", tone: "grey" };
  return { word: "Waiting", tone: "grey" };
}

/** The free-slot sentence: never "the slot" when there are several slots. */
export function freeSlotsText(free: number, slots: number): string {
  if (free >= slots) return slots === 1 ? "The slot is free." : slots === 2 ? "Both slots are free." : `All ${slots} slots are free.`;
  if (free === 0) return slots === 1 ? "The slot is busy." : "No slot is free.";
  return `${free} of ${slots} slots are free.`;
}

/** The Needs you button for a row, by the kind of card behind it. Null when there is no card to open. */
function needsButton(r: WaitingRow): { text: string; href: string } | null {
  const id = r.card?.id ?? r.decisionId;
  if (!id) return null;
  const href = `#/decisions/${id}`;
  if (r.card?.kind === "sign_off" || (!r.card && r.state === "waiting_for_sign_off")) return { text: "Open the sign-off", href };
  if (!r.card || r.card.kind === "merge") return { text: "Open the stopped check", href };
  return { text: r.card.raisedBy ? `Open ${r.card.raisedBy}'s card` : "Open the CEO's card", href };
}

/**
 * The card that holds this merge (BOS-1078): its question, who raised it and a link straight to it. When the owner
 * has already signed off, it says so, so a different card holding the merge never reads as a second sign-off.
 */
function HeldBy({ row }: { row: WaitingRow }) {
  const card = row.card;
  if (!card || card.kind === "merge") return null;
  const link = (
    <a href={`#/decisions/${card.id}`} data-card-link={card.id}>
      {card.kind === "sign_off" ? "Open the sign-off card" : "Open that card"}
    </a>
  );
  if (card.kind === "sign_off")
    return (
      <p className="mq-line" data-held-by="sign_off">
        Needs you: your sign-off on this work. {link}
      </p>
    );
  const who = card.raisedBy ?? "Boss Man";
  return (
    <p className="mq-line" data-held-by="card">
      {row.signedOffAt ? <>You signed this off at {clockText(row.signedOffAt)}. It's held by a different card: </> : <>Held by a card: </>}
      <q>{card.question}</q>, raised by {who}. {link}
      {card.staleHint ? (
        <>
          {" "}
          <span className="tag amber" data-stale="true">probably stale</span> {card.staleHint} The CEO has been asked to check it.
        </>
      ) : null}
    </p>
  );
}

function TicketLink({ id, ref, title }: { id: string; ref: string | null; title: string }) {
  return (
    <a href={`#/tickets/${id}`} title={title}>
      {ref && <span className="mono">{ref}</span>} {title}
    </a>
  );
}

function SectionHead({ title, fact }: { title: string; fact: string }) {
  return (
    <div className="mq-sec-head">
      <h2>{title}</h2>
      <span className="muted">{fact}</span>
    </div>
  );
}

function Running({ rows, slots }: { rows: RunningNow[]; slots: number }) {
  return (
    <section>
      <SectionHead title="Running now" fact={`${rows.length} of ${slotsText(slots)} busy · flagged after an hour`} />
      {!rows.length ? (
        <p className="muted">Nothing is checking or merging right now.</p>
      ) : (
        <div className="mq-list">
          {rows.map((r) => (
            <article key={r.ticketId} className={`card mq-item${r.overLimit ? " stuck" : ""}`}>
              <div className="mq-head">
                <TicketLink id={r.ticketId} ref={r.ref} title={r.title} />
                <span className={`tag ${r.overLimit ? "red" : "blue"}`}>{r.overLimit ? "over an hour" : "in progress"}</span>
              </div>
              <p className="mq-line">
                Slot {r.slot}: {PHASE[r.phase]} (the {r.what === "merge_check" ? "merge check" : "agent's own check"}). Started {waited(r.minutes)} ago at {new Date(r.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} by {r.startedBy}.
              </p>
              {r.overLimit && <p className="mq-next">Next: Boss Man keeps trying by itself; if it can't finish, it puts a card in your Decisions.</p>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/** The Needs you card (BOS-1207): only items where the owner is the one to act, each with a button to its card. */
function NeedsYou({ rows }: { rows: WaitingRow[] }) {
  if (!rows.length) return null;
  return (
    <section id="mq-needs" tabIndex={-1} className="mq-needs" aria-labelledby="mq-needs-h">
      <h2 id="mq-needs-h">Needs you</h2>
      <ul>
        {rows.map((r) => {
          const b = needsButton(r) ?? { text: "Open ticket", href: `#/tickets/${r.ticketId}` };
          return (
            <li key={r.ticketId} data-needs-row={r.ticketId}>
              <div className="mq-needs-text">
                <TicketLink id={r.ticketId} ref={r.ref} title={r.title} />
                <span className="mq-line">
                  {upFirst(r.label)}. <span className="mq-wait">waiting {waited(r.minutes)}</span>
                </span>
              </div>
              <a className="btn" href={b.href} data-needs-button="true">
                {b.text}
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** BOS-1384: "Move to front" for a merge that is queued for a check slot, is not already next, and is not held by something else. */
function MoveToFront({ companyId, row, onMoved }: { companyId: string; row: WaitingRow; onMoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="mq-front">
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await api(`/api/companies/${companyId}/merge-queue/${row.ticketId}/front`, { method: "POST" });
            onMoved();
          } catch (e) {
            setErr(e instanceof Error ? e.message : "Couldn't move it.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Move to front
      </button>
      {err ? <span role="alert" className="muted"> {err}</span> : null}
    </span>
  );
}

export function Waiting({ rows, companyId, onMoved }: { rows: WaitingRow[]; companyId?: string; onMoved?: () => void }) {
  const firstFailed = rows.findIndex((r) => r.actor !== "owner" && r.state === "check_failed_retrying");
  const firstStuck = rows.findIndex((r) => r.actor !== "owner" && r.state !== "check_failed_retrying" && r.stuck);
  return (
    <section>
      <SectionHead title="Waiting to merge" fact="In merge order: urgent first, then the longest wait" />
      {!rows.length ? (
        <p className="muted">No approved work is waiting to merge.</p>
      ) : (
        <div className="mq-list">
          {rows.map((r, i) => {
            const s = rowState(r);
            const edge = r.actor === "owner" ? " need" : s.tone === "red" ? " stuck" : "";
            return (
              <article key={r.ticketId} id={i === firstFailed ? "mq-first-failed" : i === firstStuck ? "mq-first-stuck" : undefined} tabIndex={i === firstFailed || i === firstStuck ? -1 : undefined} className={`card mq-item${edge}`} data-stuck={r.stuck ? "true" : undefined} data-state-word={s.word}>
                <div className="mq-head">
                  <span className="mq-title">
                    <span className="mq-pos">{i + 1}</span>
                    <TicketLink id={r.ticketId} ref={r.ref} title={r.title} />
                  </span>
                  <span className="mq-wait">waiting {waited(r.minutes)}</span>
                </div>
                <p className="mq-line">
                  <span className={`tag ${s.tone}`}>{s.word}</span>
                  {r.urgent && <span className="tag blue"> urgent</span>}{" "}
                  {upFirst(r.label)}.{r.next ? ` ${r.next}` : ""}
                  {r.actor && r.actor !== "system" ? ` (${actingText(r.actor)})` : ""}
                  {r.why ? <span className="tag grey" data-why="true"> next because: {r.why}</span> : null}
                  {companyId && onMoved && r.place && r.place > 1 && (r.state === "waiting_for_slot" || r.state === "waiting_for_check_capacity") ? <> <MoveToFront companyId={companyId} row={r} onMoved={onMoved} /></> : null}
                </p>
                {/* A carried-work hold (BOS-130, BOS-766, BOS-819): name the ticket it waits for, from the typed
                    list, so the row never depends on reading a title out of the hold's sentence. */}
                {r.carried?.length ? (
                  <p className="mq-line" data-carried="true">
                    It needs{" "}
                    {r.carried.map((c, j) => (
                      <span key={c.ticketId ?? `${c.title}-${j}`}>
                        {j > 0 ? (j === r.carried!.length - 1 ? " and " : ", ") : null}
                        {c.ticketId ? (
                          <a href={`#/tickets/${c.ticketId}`} title={c.title}>
                            {c.ref ?? c.title}
                          </a>
                        ) : (
                          c.ref ?? c.title
                        )}
                      </span>
                    ))}{" "}
                    to merge first.
                  </p>
                ) : null}
                <HeldBy row={r} />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

const RECENT_SHOWN = 3;

function Recent({ rows }: { rows: RecentRow[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, RECENT_SHOWN);
  const more = rows.length - shown.length;
  return (
    <section>
      <SectionHead title="Recently finished" fact="" />
      {!rows.length ? (
        <p className="muted">Nothing has merged or failed recently.</p>
      ) : (
        <div className="mq-list">
          {shown.map((r, i) => (
            <article key={`${r.ticketId}-${i}`} className="card mq-item">
              <div className="mq-head">
                <TicketLink id={r.ticketId} ref={r.ref} title={r.title} />
                <span className={`tag ${r.result === "merged" ? "green" : "red"}`}>{r.result === "merged" ? "merged" : "check failed"}</span>
              </div>
              <p className="mq-line">
                {r.detail} · {ago(r.at)}
              </p>
            </article>
          ))}
          {more > 0 && (
            <button type="button" className="btn small" onClick={() => setAll(true)} aria-expanded={false}>
              Show {more} more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

type CheckRow = { id: string; ticketId: string; ref: string | null; title: string; kind: "merge" | "quick" | "full"; requestedBy: string | null; state: "running" | "waiting"; position: number | null; minutes: number; fixesMain: boolean; why?: string | null; heldBy: string | null; heldByMain: boolean };
type CheckQueueData = { mode: "legacy" | "server"; slots: number; running: number; rows: CheckRow[] };
const KIND: Record<CheckRow["kind"], string> = { merge: "merge check", quick: "quick check", full: "full check" };

/** The one "main is red" banner (BOS-1207): said once, naming the ticket that fixes main when one is queued. */
function MainRedBanner({ held, rows }: { held: number; rows: CheckRow[] }) {
  const fix = rows.find((r) => r.fixesMain);
  return (
    <div className="mq-red" data-main-red="true">
      <strong>Main is failing its check, so new checks wait.</strong>{" "}
      {held} {held === 1 ? "check is" : "checks are"} held until{" "}
      {fix ? (
        <>
          the fix (<a href={`#/tickets/${fix.ticketId}`} title={fix.title}>{fix.ref ?? fix.title}</a>) merges
        </>
      ) : (
        "main is fixed"
      )}
      . Checks that fix main still run.
    </div>
  );
}

/** The "Queued checks" tab (BOS-1174): every check running or waiting in the server's check queue. Read-only. */
export function QueuedChecks({ data }: { data: CheckQueueData }) {
  const held = data.rows.filter((r) => r.heldByMain).length;
  const free = Math.max(0, data.slots - data.running);
  return (
    <section>
      <SectionHead title="Queued checks" fact={`${data.running} of ${slotsText(data.slots)} busy · running first, then in start order`} />
      {data.mode === "legacy" && <p className="muted" style={{ fontSize: 14 }}>The server-owned check queue is switched off, so only checks it already knows about are listed.</p>}
      {held > 0 && <MainRedBanner held={held} rows={data.rows} />}
      {!data.rows.length ? (
        <div className="card mq-empty" data-checks-empty="true">
          <strong>No checks queued.</strong> When an agent or the merge gate asks for a check, it shows here until it finishes.{" "}
          {freeSlotsText(free, data.slots)}
        </div>
      ) : (
        <div className="mq-list" data-checks-list="true">
          {data.rows.map((r) => (
            <article key={r.id} className="card mq-item" data-check-state={r.state}>
              <div className="mq-head">
                <span className="mq-title">
                  {r.position ? <span className="mq-pos">{r.position}</span> : null}
                  <TicketLink id={r.ticketId} ref={r.ref} title={r.title} />
                </span>
                <span className="mq-wait">for {waited(r.minutes)}</span>
              </div>
              <p className="mq-line">
                <span className={`tag ${r.state === "running" ? "blue" : r.heldByMain ? "amber" : "grey"}`}>{r.state === "running" ? "Running" : r.heldByMain ? "Held" : "Waiting"}</span>
                {r.fixesMain && <span className="tag green"> fixes main</span>}
                {r.why && !r.fixesMain ? <span className="tag grey"> {r.why}</span> : null}{" "}
                {upFirst(KIND[r.kind])}
                {r.requestedBy ? `, requested by ${r.requestedBy}` : ""}.
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

type Tab = "merges" | "checks";
const TABS: Tab[] = ["merges", "checks"];

export function MergeQueue({ companies, companyId }: { companies: Company[]; companyId: string | undefined }) {
  const company = companies.find((c) => c.id === companyId);
  // The chosen tab lives in the address (#/merge-queue/<company>/checks), so a reload or a link keeps it.
  const [route, go] = useRoute();
  const tab: Tab = route[0] === "merge-queue" && route[2] === "checks" ? "checks" : "merges";
  const mq = usePoll((signal) => (companyId ? api<MergeQueueData>(`/api/companies/${companyId}/merge-queue`, { signal }) : Promise.resolve(null)), 10_000, `merge-queue-${companyId}`);
  const cqPoll = usePoll((signal) => (companyId ? api<CheckQueueData>(`/api/companies/${companyId}/check-queue`, { signal }) : Promise.resolve(null)), 10_000, `check-queue-${companyId}`);
  if (!companyId) return <p className="muted">Pick a company to see its merge queue.</p>;
  const data = mq.data;
  const cq = cqPoll.data && Array.isArray(cqPoll.data.rows) ? cqPoll.data : null;
  const needsYou = data ? data.waiting.filter((r) => r.actor === "owner") : [];
  const failed = data ? data.waiting.filter((r) => r.actor !== "owner" && r.state === "check_failed_retrying").length : 0;
  const stuck = data ? data.waiting.filter((r) => r.actor !== "owner" && r.state !== "check_failed_retrying" && r.stuck).length : 0;
  const heldChecks = cq ? cq.rows.filter((r) => r.heldByMain).length : 0;
  const base = `#/merge-queue/${companyId}`;

  const pick = (t: Tab) => go(t === "checks" ? `merge-queue/${companyId}/checks` : `merge-queue/${companyId}`);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
    pick(next);
    document.getElementById(`mq-tab-${next}`)?.focus();
  };
  // A pill on the open tab moves focus to its target; one aimed at the other tab just follows its link.
  const jump = (id: string, onTab: Tab) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (onTab !== tab) return;
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    el.focus();
    el.scrollIntoView?.({ block: "start" });
  };
  const pills = [
    needsYou.length > 0 && { key: "needs", tone: "amber", text: `${needsYou.length} need you`, href: tab === "merges" ? undefined : base, onClick: jump("mq-needs", "merges") },
    heldChecks > 0 && { key: "red", tone: "red", text: `Main is red: ${heldChecks} ${heldChecks === 1 ? "check" : "checks"} held`, href: `${base}/checks`, onClick: undefined },
    failed > 0 && { key: "failed", tone: "red", text: `${failed} check failed`, href: tab === "merges" ? undefined : base, onClick: jump("mq-first-failed", "merges") },
    stuck > 0 && { key: "stuck", tone: "red", text: `${stuck} stuck over an hour`, href: tab === "merges" ? undefined : base, onClick: jump("mq-first-stuck", "merges") },
  ].filter(Boolean) as { key: string; tone: string; text: string; href: string | undefined; onClick: ((e: MouseEvent<HTMLAnchorElement>) => void) | undefined }[];

  const tabButton = (t: Tab, label: string, count: number | null, warn: boolean) => (
    <button key={t} type="button" role="tab" id={`mq-tab-${t}`} aria-selected={tab === t} aria-controls={`mq-panel-${t}`} tabIndex={tab === t ? 0 : -1} onClick={() => pick(t)} onKeyDown={onKey}>
      {label}
      {count !== null && <span className={`tab-count${warn ? " warn" : ""}`}>{count}</span>}
    </button>
  );

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Merge queue</h1>
          {company && <p className="sub">{company.name}: approved work on its way to merge.</p>}
        </div>
      </header>
      {data &&
        (pills.length ? (
          <ul className="mq-status" aria-label="What needs attention">
            {pills.map((p) => (
              <li key={p.key}>
                <a className={`mq-pill ${p.tone}`} href={p.href ?? base} onClick={p.onClick}>
                  {p.text}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted mq-calm">Nothing needs you. Everything here is moving by itself.</p>
        ))}
      <div className="tabs" role="tablist" aria-label="Merge queue views">
        {tabButton("merges", "Merges", data ? data.waitingCount + data.running.length : null, needsYou.length > 0)}
        {tabButton("checks", "Queued checks", cq ? cq.rows.length : null, heldChecks > 0)}
      </div>
      {tab === "checks" ? (
        <div role="tabpanel" id="mq-panel-checks" aria-labelledby="mq-tab-checks">
          {cqPoll.error && !cqPoll.data ? <p className="banner" role="alert">Couldn't load the queued checks. It will try again shortly.</p> : cq ? <QueuedChecks data={cq} /> : <p className="muted">Loading…</p>}
        </div>
      ) : (
        <div role="tabpanel" id="mq-panel-merges" aria-labelledby="mq-tab-merges">
          {mq.error ? <p className="banner" role="alert">Couldn't load the merge queue. It will try again shortly.</p> : null}
          {!data && !mq.error ? (
            <p className="muted">Loading…</p>
          ) : data ? (
            <>
              <NeedsYou rows={needsYou} />
              <Running rows={data.running} slots={data.slots} />
              <Waiting rows={data.waiting} companyId={companyId} onMoved={() => { mq.reload(); cqPoll.reload(); }} />
              <Recent rows={data.recent} />
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
