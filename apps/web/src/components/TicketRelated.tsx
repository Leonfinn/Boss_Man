import { useState } from "react";
import { api, FEATURE_STATUS_LABEL, type FeatureStatus, type RelatedTicket, type TicketRelated as Related } from "../api";
import { usePoll } from "../hooks";

const STATE_LABEL: Record<string, string> = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "Review", done: "Done" };
const STATE_TONE: Record<string, string> = { backlog: "", ready: "amber", in_progress: "blue", blocked: "red", review: "purple", done: "green" };
const SHOWN = 5;

/** Open tickets first, done ones last; otherwise the order the server gave. */
const openFirst = (rows: RelatedTicket[]) => [...rows.filter((r) => r.state !== "done"), ...rows.filter((r) => r.state === "done")];

function Row({ t }: { t: RelatedTicket }) {
  return (
    <li className="related-row">
      <a href={`#/tickets/${t.id}`} title={t.title}>
        {t.ref ? <strong>{t.ref}</strong> : null}
        <span className="related-title">{t.title}</span>
      </a>
      <span className={`tag ${t.cancelled ? "" : (STATE_TONE[t.state] ?? "")}`}>{t.cancelled ? "Cancelled" : (STATE_LABEL[t.state] ?? t.state)}</span>
    </li>
  );
}

function Group({ label, rows }: { label: string; rows: RelatedTicket[] }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const sorted = openFirst(rows);
  const visible = all ? sorted : sorted.slice(0, SHOWN);
  return (
    <div className="related-group">
      <h3 className="related-label">{label}</h3>
      <ul className="related-list">
        {visible.map((t) => (
          <Row key={t.id} t={t} />
        ))}
      </ul>
      {sorted.length > SHOWN && (
        <button type="button" className="related-more" onClick={() => setAll(!all)}>
          {all ? "show fewer" : `show ${sorted.length - SHOWN} more`}
        </button>
      )}
    </div>
  );
}

/** The right-hand column's Related section: the tickets around this one, each group only when it has something. */
export function TicketRelated({ ticketId, companyId }: { ticketId: string; companyId: string }) {
  const rel = usePoll((signal) => api<Related>(`/api/tickets/${ticketId}/related`, { signal }), 30_000, `related-${ticketId}`);
  const r = rel.data;
  if (!r?.subtasks) return null;
  const empty = !r.feature && !r.parent && ![r.subtasks, r.peers, r.waitsOn, r.blocks, r.mentioned].some((x) => x.length);
  return (
    <section aria-label="Related tickets" className="related">
      <h2 className="section-label">Related</h2>
      {empty && <p className="muted" style={{ margin: 0, fontSize: 14 }}>No related tickets</p>}
      {r.feature && (
        <div className="related-group">
          <h3 className="related-label">Feature</h3>
          <ul className="related-list">
            <li className="related-row">
              <a href={`#/features/${companyId}/${r.feature.id}`} title={r.feature.title}>
                <span className="related-title">{r.feature.title}</span>
              </a>
              <span className="tag">{FEATURE_STATUS_LABEL[r.feature.status as FeatureStatus] ?? r.feature.status}</span>
            </li>
          </ul>
        </div>
      )}
      <Group label="Parent" rows={r.parent ? [r.parent] : []} />
      <Group label="Sub-tasks" rows={r.subtasks} />
      <Group label="Peers" rows={r.peers} />
      <Group label="Waits on" rows={r.waitsOn} />
      <Group label="Blocks" rows={r.blocks} />
      <Group label="Mentioned" rows={r.mentioned} />
    </section>
  );
}
