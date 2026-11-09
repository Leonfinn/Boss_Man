// The merge queue (BOS-587): approved work waiting to merge, the check running now, and how the
// last ones ended. Read-only and in plain words; it never changes the queue. It reloads on the
// usual live-update poll, so a merge that starts or finishes shows without a page reload.
import type { Company } from "../api";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago } from "./Dashboard";

type Phase = "queued" | "checking" | "merging" | "waiting_to_retry";
type RunningNow = { ticketId: string; ref: string | null; title: string; phase: Phase; startedAt: string; startedBy: string; minutes: number; what: "merge_check" | "agent_check"; slot: number; overLimit: boolean };
type WaitingState = "waiting_for_slot" | "check_failed_retrying" | "needs_you" | "waiting_for_sign_off" | "waiting_for_check_capacity" | "checking" | "waiting_host" | "waiting_for_decision" | "waiting_for_other_ticket" | "held";
/** Approved work held by the carried-work guard (BOS-130, BOS-766): the ticket(s) it waits for. */
type CarriedHold = { ticketId: string | null; ref: string | null; title: string };
type WaitingRow = { ticketId: string; ref: string | null; title: string; minutes: number; state: WaitingState; label: string; stuck: boolean; next: string | null; actor: "agent" | "ceo" | "owner" | "system" | null; decisionId: string | null; risk: string; urgent: boolean; failedCheck: boolean; carried?: CarriedHold[] };
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

function Waiting({ rows }: { rows: WaitingRow[] }) {
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
              {r.next && (
                <p className="mq-next">
                  Next: {r.next}
                  {r.actor && r.actor !== "system" ? ` (${ACTOR[r.actor]} is acting)` : ""}
                  {r.actor === "owner" && r.decisionId ? (
                    <>
                      {" "}
                      <a href="#/decisions">Needs you: open the card</a>
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

export function MergeQueue({ companies, companyId }: { companies: Company[]; companyId: string | undefined }) {
  const company = companies.find((c) => c.id === companyId);
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
  );
}
