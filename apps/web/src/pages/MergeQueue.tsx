// The merge queue (BOS-587): approved work waiting to merge, the check running now, and how the
// last ones ended. Read-only and in plain words; it never changes the queue. It reloads on the
// usual live-update poll, so a merge that starts or finishes shows without a page reload.
import { useState } from "react";
import type { Company } from "../api";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago } from "./Dashboard";

type Phase = "queued" | "checking" | "merging" | "waiting_to_retry";
type RunningNow = { ticketId: string; ref: string | null; title: string; phase: Phase; startedAt: string; startedBy: string; minutes: number; what: "merge_check" | "agent_check"; slot: number; overLimit: boolean };
type WaitingState = "waiting_for_slot" | "check_failed_retrying" | "needs_you" | "waiting_for_sign_off" | "waiting_for_check_capacity" | "checking" | "waiting_host" | "waiting_for_decision" | "waiting_for_other_ticket" | "held";
/** Approved work held by the carried-work guard (BOS-130, BOS-766): the ticket(s) it waits for. */
type CarriedHold = { ticketId: string | null; ref: string | null; title: string };
/** The card a waiting merge is held by (BOS-1078): named, with who raised it and a link straight to it. */
type HoldingCard = { id: string; kind: "sign_off" | "hold" | "merge"; question: string; raisedBy: string | null; raisedAt: string; staleHint: string | null };
type WaitingRow = { ticketId: string; ref: string | null; title: string; minutes: number; state: WaitingState; label: string; stuck: boolean; next: string | null; actor: "agent" | "ceo" | "owner" | "system" | null; decisionId: string | null; risk: string; urgent: boolean; failedCheck: boolean; carried?: CarriedHold[]; card?: HoldingCard | null; signedOffAt?: string | null };
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

function Running({ rows, slots }: { rows: RunningNow[]; slots: number }) {
  return (
    <section>
      <h2>Running now</h2>
      <p className="muted" style={{ fontSize: 14 }}>
        {slots === 1 ? "One check slot runs at a time." : `${slots} check slots run at a time.`} A check that runs over an hour is flagged.
      </p>
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

export function Waiting({ rows }: { rows: WaitingRow[] }) {
  return (
    <section>
      <h2>Waiting to merge</h2>
      <p className="muted" style={{ fontSize: 14 }}>
        In the order they will go: urgent work first, then the longest wait. Anything waiting over an hour, or whose check failed, is highlighted.
      </p>
      {!rows.length ? (
        <p className="muted">No approved work is waiting to merge.</p>
      ) : (
        <div className="mq-list">
          {rows.map((r) => (
            <article key={r.ticketId} className={`card mq-item${r.stuck ? " stuck" : ""}`} data-stuck={r.stuck ? "true" : undefined}>
              <div className="mq-head">
                <TicketLink id={r.ticketId} ref={r.ref} title={r.title} />
                <span className="mq-wait">{waited(r.minutes)}</span>
              </div>
              <p className="mq-line">
                <span className={`tag ${r.stuck ? "red" : r.state === "waiting_for_sign_off" || r.state === "needs_you" || r.state === "waiting_for_decision" ? "amber" : "grey"}`}>{r.label}</span>
                {r.urgent && <span className="tag blue"> urgent</span>}
              </p>
              {/* A carried-work hold (BOS-130, BOS-766, BOS-819): name the ticket it waits for, from the typed
                  list, so the row never depends on reading a title out of the hold's sentence. */}
              {r.carried?.length ? (
                <p className="mq-line" data-carried="true">
                  It needs{" "}
                  {r.carried.map((c, i) => (
                    <span key={c.ticketId ?? `${c.title}-${i}`}>
                      {i > 0 ? (i === r.carried!.length - 1 ? " and " : ", ") : null}
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
              {r.next && (
                <p className="mq-next">
                  Next: {r.next}
                  {r.actor && r.actor !== "system" ? ` (${actingText(r.actor)})` : ""}
                  {/* A card named above has its own link; the merge's own cards (a stuck check) link here, straight to the card. */}
                  {r.actor === "owner" && r.decisionId && (!r.card || r.card.kind === "merge") ? (
                    <>
                      {" "}
                      <a href={`#/decisions/${r.decisionId}`}>Needs you: open the card</a>
                    </>
                  ) : null}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Recent({ rows }: { rows: RecentRow[] }) {
  return (
    <section>
      <h2>Recently finished</h2>
      {!rows.length ? (
        <p className="muted">Nothing has merged or failed recently.</p>
      ) : (
        <div className="mq-list">
          {rows.map((r, i) => (
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
        </div>
      )}
    </section>
  );
}

type CheckRow = { id: string; ticketId: string; ref: string | null; title: string; kind: "merge" | "quick" | "full"; requestedBy: string | null; state: "running" | "waiting"; position: number | null; minutes: number; fixesMain: boolean; heldBy: string | null };
type CheckQueueData = { mode: "legacy" | "server"; slots: number; running: number; rows: CheckRow[] };
const KIND: Record<CheckRow["kind"], string> = { merge: "merge check", quick: "quick check", full: "full check" };

/** The "Queued checks" tab (BOS-1174): every check running or waiting in the server's check queue. Read-only. */
export function QueuedChecks({ companyId }: { companyId: string }) {
  const { data, error } = usePoll((signal) => api<CheckQueueData>(`/api/companies/${companyId}/check-queue`, { signal }), 10_000, `check-queue-${companyId}`);
  if (error && !data) return <p className="banner" role="alert">Couldn't load the queued checks. It will try again shortly.</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <section>
      <h2>Queued checks</h2>
      <p className="muted" style={{ fontSize: 14 }}>
        {data.running} of {data.slots} check {data.slots === 1 ? "slot" : "slots"} running. Running first, then waiting in the order they will start.
        {data.mode === "legacy" ? " The server-owned check queue is switched off, so only checks it already knows about are listed." : ""}
      </p>
      {!data.rows.length ? (
        <p className="muted">No checks queued</p>
      ) : (
        <div className="mq-list" data-checks-list="true">
          {data.rows.map((r) => (
            <article key={r.id} className="card mq-item" data-check-state={r.state}>
              <div className="mq-head">
                <TicketLink id={r.ticketId} ref={r.ref} title={r.title} />
                <span className="mq-wait">{waited(r.minutes)}</span>
              </div>
              <p className="mq-line">
                <span className={`tag ${r.state === "running" ? "blue" : "grey"}`}>{r.state === "running" ? "running" : r.position ? `waiting, place ${r.position}` : "held"}</span>{" "}
                {KIND[r.kind]}
                {r.requestedBy ? `, requested by ${r.requestedBy}` : ""}
                {r.fixesMain ? " (fixes main)" : ""}. {r.state === "running" ? "Running for" : "Waiting for"} {waited(r.minutes)}.
              </p>
              {r.heldBy && <p className="mq-next" data-held-by-reason="true">Held: {r.heldBy}.</p>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function MergeQueue({ companies, companyId }: { companies: Company[]; companyId: string | undefined }) {
  const company = companies.find((c) => c.id === companyId);
  const [tab, setTab] = useState<"merges" | "checks">("merges");
  const { data, error } = usePoll((signal) => (companyId ? api<MergeQueueData>(`/api/companies/${companyId}/merge-queue`, { signal }) : Promise.resolve(null)), 10_000, `merge-queue-${companyId}`);
  if (!companyId) return <p className="muted">Pick a company to see its merge queue.</p>;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Merge queue</h1>
          {company && <p className="sub">{company.name}: approved work on its way to merge.</p>}
        </div>
        {data && <p className="sub">{data.waitingCount > 0 ? `${data.waitingCount} waiting to merge` : "Nothing waiting to merge"}</p>}
      </header>
      <div className="tabs" role="tablist" aria-label="Merge queue views">
        <button type="button" role="tab" aria-selected={tab === "merges"} onClick={() => setTab("merges")}>Merges</button>
        <button type="button" role="tab" aria-selected={tab === "checks"} onClick={() => setTab("checks")}>Queued checks</button>
      </div>
      {tab === "checks" ? (
        <QueuedChecks companyId={companyId} />
      ) : (
        <>
      {error ? <p className="banner" role="alert">Couldn't load the merge queue. It will try again shortly.</p> : null}
      {!data && !error ? (
        <p className="muted">Loading…</p>
      ) : data ? (
        <>
          <Running rows={data.running} slots={data.slots} />
          <Waiting rows={data.waiting} />
          <Recent rows={data.recent} />
        </>
      ) : null}
        </>
      )}
    </>
  );
}
