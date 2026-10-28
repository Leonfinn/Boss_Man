import { useState } from "react";
import { WATCHDOG_ACTION_LABEL } from "@boss-man/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { when } from "../pages/Runs";

export type SmAction = {
  id: string;
  kind: string;
  ticketId: string | null;
  reason: string;
  actorName: string | null;
  createdAt: string;
  undoable: boolean;
  undoneAt: string | null;
  after: { refused?: string } | null;
  targetName?: string | null;
  targetIsCeo?: boolean;
  targetIsScrumMaster?: boolean;
  ticketRef?: string | null;
  /** For a warning's log rows: the warning's question, e.g. "Review looks stuck". */
  warning?: string | null;
};

/** The heading for a log row: the plain label, or for a warning's journey a sentence naming who has it, which warning it was and the ticket. */
export function actionHeading(a: Pick<SmAction, "kind" | "targetName" | "targetIsCeo" | "targetIsScrumMaster" | "warning">): string {
  const label = (WATCHDOG_ACTION_LABEL as Record<string, string | undefined>)[a.kind] ?? "Something happened";
  if (a.kind !== "alert_hop" && a.kind !== "alert_resolved") return label;
  const which = a.warning ? `: ${a.warning}` : "";
  if (a.kind === "alert_resolved") return `Warning settled${which}`;
  const to = a.targetName ? (a.targetIsCeo ? `the CEO (${a.targetName})` : a.targetIsScrumMaster ? `the Scrum Master (${a.targetName})` : a.targetName) : "you";
  return `Warning passed to ${to}${which}`;
}

/** What the Scrum Master and the watchdog did, each with its one-line reason and an undo while one is possible. */
export function ScrumMasterLog({ companyId, ticketId, heading }: { companyId: string; ticketId?: string; heading?: string }) {
  const log = usePoll((signal) => api<SmAction[]>(`/api/companies/${companyId}/watchdog/actions?limit=100${ticketId ? `&ticketId=${ticketId}` : "&excludeKind=sweep_wake"}`, { signal }), 15_000, `sm-log-${companyId}-${ticketId ?? "all"}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const undo = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/watchdog-actions/${id}/undo`, { method: "POST", body: {} });
      log.reload();
    } catch (e) {
      setError((e as { message?: string }).message ?? "That couldn't be undone.");
    } finally {
      setBusy(null);
    }
  };
  const rows = Array.isArray(log.data) ? log.data : [];
  if (ticketId && log.data && !rows.length) return null;
  return (
    <section aria-label="Scrum Master activity">
      {heading && <h2 className="section-label">{heading}</h2>}
      {error && <p role="alert" className="error">{error}</p>}
      {!log.data ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">Nothing yet. The Scrum Master's actions appear here with the reason for each.</p> : null}
      <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((a) => (
          <li key={a.id} className="card" style={{ padding: "10px 14px", opacity: a.undoneAt ? 0.6 : 1 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong style={{ fontWeight: 600 }}>{actionHeading(a)}</strong>
              {a.ticketRef && a.ticketId && (a.kind === "alert_hop" || a.kind === "alert_resolved") && <a href={`#/tickets/${a.ticketId}`}>{a.ticketRef}</a>}
              {a.after?.refused && <span className="tag amber">Refused</span>}
              {a.undoneAt && <span className="tag">Undone</span>}
              <span className="muted" style={{ fontSize: 13, marginLeft: "auto" }}>
                {a.actorName ?? "Scrum Master"} · {when(a.createdAt)}
              </span>
            </div>
            <p style={{ margin: "4px 0" }}>{a.reason}</p>
            <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
              {!ticketId && a.ticketId && <a href={`#/tickets/${a.ticketId}`}>Open the ticket</a>}
              {a.undoable && !a.undoneAt && (
                <button type="button" className="link" disabled={busy === a.id} onClick={() => void undo(a.id)}>
                  {busy === a.id ? "Undoing…" : "Undo"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
