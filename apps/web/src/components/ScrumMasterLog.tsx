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
  /** Which warning this row belongs to: its flag or alert, so the feed can group by issue. */
  issueKey?: string | null;
  issueStatus?: "open" | "settled" | null;
  /** e.g. "2nd warning on BOS-149 today". */
  issueLabel?: string | null;
};

/** The heading for a log row: the plain label, or for a warning's journey a sentence naming who has it, which warning it was and the ticket. */
export function actionHeading(a: Pick<SmAction, "kind" | "targetName" | "targetIsCeo" | "targetIsScrumMaster" | "warning">): string {
  const label = (WATCHDOG_ACTION_LABEL as Record<string, string | undefined>)[a.kind] ?? "Something happened";
  if (a.kind !== "alert_hop" && a.kind !== "alert_resolved") return label;
  const which = a.warning ? `: ${a.warning}` : "";
  if (a.kind === "alert_resolved") return `Warning settled${which}`;
  const name = a.targetName?.trim();
  const to = a.targetIsCeo
    ? name && name.toLowerCase() !== "ceo"
      ? `the CEO (${name})`
      : "the CEO"
    : a.targetIsScrumMaster
      ? name && name.toLowerCase() !== "scrum master"
        ? `the Scrum Master (${name})`
        : "the Scrum Master"
      : name ?? "you";
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

  // One group per issue, newest first; rows without an issue stand on their own.
  const groups: Array<{ key: string; issueKey: string | null; status: SmAction["issueStatus"]; label: string | null; ticketRef: string | null; ticketId: string | null; rows: SmAction[] }> = [];
  for (const a of rows) {
    const key = a.issueKey ?? `single:${a.id}`;
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, issueKey: a.issueKey ?? null, status: a.issueStatus ?? null, label: a.issueLabel ?? null, ticketRef: a.ticketRef ?? null, ticketId: a.ticketId, rows: [] };
      groups.push(g);
    }
    g.rows.push(a);
  }

  const row = (a: SmAction) => (
    <li key={a.id} style={{ padding: "8px 0", opacity: a.undoneAt ? 0.6 : 1, borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontWeight: 600 }}>{actionHeading(a)}</strong>
        {a.issueStatus && <span className={`tag ${a.issueStatus === "open" ? "green" : "grey"}`}>{a.issueStatus === "open" ? "Open" : "Settled"}</span>}
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
  );

  return (
    <section aria-label="Scrum Master activity">
      {heading && <h2 className="section-label">{heading}</h2>}
      {error && <p role="alert" className="error">{error}</p>}
      {!log.data ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">Nothing yet. The Scrum Master's actions appear here with the reason for each.</p> : null}
      <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {groups.map((g) =>
          g.issueKey ? (
            <li key={g.key} className="card" style={{ padding: "10px 14px" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                {g.ticketRef && g.ticketId && <a href={`#/tickets/${g.ticketId}`}>{g.ticketRef}</a>}
                <span className={`tag ${g.status === "open" ? "green" : "grey"}`}>{g.status === "open" ? "Open" : "Settled"}</span>
                <span className="muted" style={{ fontSize: 13 }}>{g.label}</span>
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>{g.rows.map(row)}</ul>
            </li>
          ) : (
            <li key={g.key} className="card" style={{ padding: "10px 14px" }}>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>{g.rows.map(row)}</ul>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
