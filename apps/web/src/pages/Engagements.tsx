import { useEffect, useState } from "react";
import { api, type EngagementRow, type EngagementView } from "../api";
import { useOlder, usePoll } from "../hooks";

const PAGE = 50;
import { away } from "../server-watch";
import { when } from "./Runs";
import { NotFoundBlock } from "../components/NotFoundBlock";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { ShowOlder } from "../components/ShowOlder";

const STATUS: Record<string, { label: string; tone: string }> = {
  requested: { label: "Requested", tone: "blue" },
  countered: { label: "Counter-offer", tone: "amber" },
  accepted: { label: "Accepted", tone: "blue" },
  in_progress: { label: "In progress", tone: "blue" },
  delivered: { label: "Delivered", tone: "amber" },
  signed_off: { label: "Signed off", tone: "green" },
  rejected: { label: "Declined", tone: "" },
};
const statusTag = (s: string) => <span className={`tag ${STATUS[s]?.tone ?? ""}`}>{STATUS[s]?.label ?? s}</span>;

const STEPS = ["requested", "accepted", "in_progress", "delivered", "signed_off"] as const;
const STEP_LABEL: Record<(typeof STEPS)[number], string> = { requested: "Requested", accepted: "Accepted", in_progress: "In progress", delivered: "Delivered", signed_off: "Signed off" };

const SHOW_KEY = "bm.engagements.show";

/** The owner's last choice, so a reload keeps it. Anything unknown falls back to Open. */
function savedShow(): string {
  try {
    const v = localStorage.getItem(SHOW_KEY);
    return v === "all" || (v && v in STATUS) ? v : "open";
  } catch {
    return "open";
  }
}

export function Engagements() {
  const [show, setShow] = useState(savedShow);
  const pick = (v: string) => {
    try {
      localStorage.setItem(SHOW_KEY, v);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
    setShow(v);
  };
  // The box updates at once; the list reloads once typing pauses (BOS-2315).
  const [typed, setTyped] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const filter = (show === "all" ? "" : `&status=${show}`) + (term ? `&q=${encodeURIComponent(term)}` : "");
  // The server filters and sends the newest PAGE; older ones come on "Show older" (BOS-2165), under the same filter.
  const list = usePoll((signal) => api<EngagementRow[]>(`/api/engagements?limit=${PAGE}${filter}`, { signal }), 15_000, `engagements:${show}:${term}`);
  const older = useOlder(list.data, PAGE, (before) => api<EngagementRow[]>(`/api/engagements?limit=${PAGE}${filter}&before=${before}`), `engagements:${show}:${term}`);
  const rows = older.rows ?? [];
  const none = term ? `No engagements match "${term}".` : null;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Engagements</h1>
          <p className="sub">Work one company does for another, with agreed terms and a cost cap charged to the requester.</p>
        </div>
      </header>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
        <label className="label" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          Show
          <select value={show} onChange={(e) => pick(e.target.value)}>
            <option value="open">Open</option>
            <option value="all">All</option>
            {Object.entries(STATUS).map(([k, s]) => (
              <option key={k} value={k}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="label" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          Search engagements
          <input type="search" maxLength={200} placeholder="Title or company" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
      </div>
      {!list.data ? (
        list.error && !away(list.error) ? (
          <LoadError what="engagements" message={list.error.message} onRetry={list.reload} />
        ) : (
          <Loader label="Loading engagements" />
        )
      ) : rows.length === 0 ? (
        <p className="muted">
          {none ?? (show === "all"
            ? "No engagements yet. A CEO asks another company for work, and you approve it in Decisions."
            : show === "open"
              ? "No open engagements."
              : "No engagements with this status.")}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Engagement</th>
                <th scope="col">From → to</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ textAlign: "right" }}>Cap</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <a href={`#/engagements/${e.id}`}>{e.title}</a>
                  </td>
                  <td>
                    {e.requester} → {e.provider}
                  </td>
                  <td>{statusTag(e.status)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {e.budgetCapUsd != null ? `$${e.budgetCapUsd.toFixed(2)}` : "None"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ShowOlder older={older} />
    </>
  );
}

export function Engagement({ id }: { id: string }) {
  const view = usePoll((signal) => api<EngagementView>(`/api/engagements/${id}`, { signal }), 15_000, id);
  const e = view.data;
  if (view.error && !away(view.error)) return view.error.status === 404 ? <NotFoundBlock title="Engagement not found" backHref="#/engagements" backLabel="Back to Engagements">This engagement doesn't exist any more, or the link is wrong.</NotFoundBlock> : <LoadError what="the engagement" message={view.error.message} onRetry={view.reload} />;
  if (!e) return <Loader label="Loading the engagement" />;
  const reached = e.status === "countered" ? 0 : e.status === "rejected" ? -1 : STEPS.indexOf(e.status as (typeof STEPS)[number]);
  const capFraction = e.budgetCapUsd ? Math.min(1, e.spentUsd / e.budgetCapUsd) : 0;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">
            <a href="#/engagements">Engagements</a> · {e.requester} → {e.provider}
          </p>
          <h1>{e.title}</h1>
        </div>
        {statusTag(e.status)}
      </header>

      {e.status !== "rejected" && (
        <ol className="steps" aria-label="Engagement progress">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === reached ? "step" : undefined} className={i < reached ? "done" : i === reached ? "now" : ""}>
              {STEP_LABEL[s]}
              {s === "requested" && e.status === "countered" && <small>Counter-offer waiting</small>}
            </li>
          ))}
        </ol>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <section className="card" aria-labelledby="terms-h" style={{ flex: "1 1 340px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 id="terms-h" style={{ fontSize: 16, fontWeight: 600 }}>
            Terms
          </h2>
          <div>
            <p className="label">Scope</p>
            <p style={{ whiteSpace: "pre-wrap" }}>{e.scope}</p>
          </div>
          {e.deliverables && (
            <div>
              <p className="label">Deliverable</p>
              <p style={{ whiteSpace: "pre-wrap" }}>{e.deliverables}</p>
            </div>
          )}
          {e.acceptanceCriteria.length > 0 && (
            <div>
              <p className="label">Done when</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {e.acceptanceCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <p className="label">Cost, charged to {e.requester}</p>
            <p style={{ fontSize: 14 }}>
              ${e.spentUsd.toFixed(2)}
              {e.budgetCapUsd != null ? ` of a $${e.budgetCapUsd.toFixed(2)} cap` : ", no cap"}
            </p>
            {e.budgetCapUsd != null && (
              <div className={`bar${capFraction >= 0.9 ? " warn" : ""}`} aria-hidden="true">
                <span style={{ width: `${Math.round(capFraction * 100)}%` }} />
              </div>
            )}
          </div>
          {e.delivery?.summary && (
            <div>
              <p className="label">Delivered</p>
              <p style={{ whiteSpace: "pre-wrap" }}>{e.delivery.summary}</p>
              {e.delivery.refs?.length ? <p className="mono" style={{ fontSize: 13 }}>{e.delivery.refs.join(", ")}</p> : null}
            </div>
          )}
          <p className="muted" style={{ fontSize: 13, background: "var(--ground)", borderRadius: 6, padding: "10px 12px" }}>
            Each company sees this page and the thread only. {e.provider}'s own tasks, secrets and deploy targets stay private to it.
          </p>
        </section>

        <div style={{ flex: "2 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
        {e.tickets && e.tickets.length > 0 && (
          <section aria-labelledby="work-h" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 id="work-h" style={{ fontSize: 16, fontWeight: 600 }}>
              Work
            </h2>
            <p className="muted" style={{ fontSize: 13 }}>
              {e.tickets.filter((t) => t.state === "done").length} of {e.tickets.length} done
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Ticket</th>
                    <th scope="col">State</th>
                    <th scope="col">Assignee</th>
                    <th scope="col" style={{ textAlign: "right" }}>Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {e.tickets.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <a href={`#/tickets/${t.id}`}>
                          {t.ref ? <span className="mono">{t.ref} </span> : null}
                          {t.title}
                        </a>
                      </td>
                      <td>{t.state.replace(/_/g, " ")}</td>
                      <td>{t.assignee ?? "Unassigned"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>
                        ${t.spentUsd.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        <section aria-labelledby="thread-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 id="thread-h" style={{ fontSize: 16, fontWeight: 600 }}>
            Thread
          </h2>
          {e.thread.length === 0 && <p className="muted">No messages yet.</p>}
          {e.thread.map((m, i) => (
            <article key={i} className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: m.from === e.requester ? "var(--accent)" : "var(--green-ink)" }}>
                  {m.from}
                  {m.kind !== "message" && <span className="muted" style={{ fontWeight: 400 }}> · {m.kind.replace(/_/g, " ")}</span>}
                </span>
                <span className="mono muted" style={{ fontSize: 12 }}>
                  {when(m.at)}
                </span>
              </div>
              <p style={{ fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.body}</p>
            </article>
          ))}
        </section>
        </div>
      </div>
    </>
  );
}
