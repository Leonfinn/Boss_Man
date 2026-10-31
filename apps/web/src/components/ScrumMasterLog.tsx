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
  /** A record-only entry (BOS-166): what the watchdog would have done. Nothing was sent. */
  recorded?: boolean;
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

/** The time of an action on its own, e.g. "21:27" (or "27 Oct 21:27" on another day), for a one-line log. */
export function actionTime(createdAt: string, now: Date = new Date()): string {
  const t = new Date(createdAt);
  const sameDay = t.toDateString() === now.toDateString();
  return t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(sameDay ? {} : { day: "numeric", month: "short" }) });
}

/** A warning's one-line heading on a ticket's page, e.g. "Settled by the Scrum Master" or "Passed to the CEO": the ticket is the page you're on, so it isn't named. */
export function actionSummary(a: Pick<SmAction, "kind" | "targetName" | "targetIsCeo" | "targetIsScrumMaster"> & { actorName?: string | null }): string {
  if (a.kind === "alert_resolved") return `Settled by ${a.actorName ?? "the Scrum Master"}`;
  if (a.kind !== "alert_hop") return actionHeading(a);
  if (a.targetIsCeo) return "Passed to the CEO";
  if (a.targetIsScrumMaster) {
    const name = a.targetName?.trim();
    return name && name.toLowerCase() !== "scrum master" ? `Passed to the Scrum Master (${name})` : "Passed to the Scrum Master";
  }
  return `Passed to ${a.targetName ?? "you"}`;
}

/** A ticket page's folded summary: "7 warnings today · all settled", "7 warnings today · 2 open", or "3 actions · all settled". */
export function smSummary(groups: Array<{ issueKey: string | null; status: SmAction["issueStatus"]; label: string | null }>): string {
  const issues = groups.filter((g) => g.issueKey);
  if (!issues.length) return `${groups.length} action${groups.length === 1 ? "" : "s"} · all settled`;
  const open = issues.filter((g) => g.status === "open").length;
  const day = issues.map((g) => g.label?.match(/^\d+\w* warning on \S+ (today|on .*)$/)?.[1]).find(Boolean);
  const many = issues.length === 1 ? "1 warning" : day ? `${issues.length} warnings ${day}` : `${issues.length} warnings`;
  return `${many} · ${open ? `${open} open` : "all settled"}`;
}

/** What the Scrum Master and the watchdog did, each with its one-line reason and an undo while one is possible. */
export function ScrumMasterLog({ companyId, ticketId, heading, folded }: { companyId: string; ticketId?: string; heading?: string; folded?: boolean }) {
  // Folded, every action is listed so an older open issue can still be found, so take more than a screenful.
  const log = usePoll((signal) => api<SmAction[]>(`/api/companies/${companyId}/watchdog/actions?limit=${folded ? 500 : 100}${ticketId ? `&ticketId=${ticketId}` : "&excludeKind=sweep_wake"}`, { signal }), 15_000, `sm-log-${companyId}-${ticketId ?? "all"}-${folded ? "folded" : "full"}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
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
        {a.recorded && <span className="tag amber">Not sent</span>}
        {a.after?.refused && <span className="tag amber">Refused</span>}
        {a.undoneAt && <span className="tag">Undone</span>}
        <span className="muted" style={{ fontSize: 13, marginLeft: "auto" }}>
          {a.actorName ?? "Scrum Master"} · {when(a.createdAt)}
        </span>
      </div>
      <p style={{ margin: "4px 0" }}>{a.reason}</p>
      <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
        {!ticketId && a.ticketId && <a href={`#/tickets/${a.ticketId}`}>Open the ticket</a>}
        {a.undoable && !a.undoneAt && !a.recorded && (
          <button type="button" className="link" disabled={busy === a.id} onClick={() => void undo(a.id)}>
            {busy === a.id ? "Undoing…" : "Undo"}
          </button>
        )}
      </div>
    </li>
  );

  if (folded) {
    // On a ticket's own page: a folded heading with a summary, the last 3 actions one line each (newest first), and each line opens to its full text. An open issue is never hidden.
    const issues = groups.filter((g) => g.issueKey);
    // What one line stands for: a warning's whole journey (it opens to every row), or a single action.
    const shown = issues.length
      ? [...issues.slice(3).filter((g) => g.status === "open"), ...issues.slice(0, 3)]
      : groups.slice(0, 3);
    const hidden = issues.length
      ? issues.slice(3).filter((g) => g.status !== "open").reduce((n, g) => n + g.rows.length, 0) + issues.slice(0, 3).reduce((n, g) => n + Math.max(0, g.rows.length - 1), 0)
      : groups.length - 3;
    const total = groups.reduce((n, g) => n + (g.issueKey ? g.rows.length : 1), 0);
    const time = (iso: string) => (
      <span className="label" style={{ flex: "none" }}>
        {actionTime(iso)}
      </span>
    );
    const line = (g: (typeof groups)[number]) => (
      <>
        {time(g.rows[0]!.createdAt)}
        {g.issueKey && <span className={`tag ${g.status === "open" ? "green" : "grey"}`}>{g.status === "open" ? "Open" : "Settled"}</span>}
        <span style={{ minWidth: 0 }}>
          {actionSummary(g.rows[0]!)}: {g.rows[0]!.reason}
        </span>
      </>
    );
    return (
      <section className="card" aria-label="Scrum Master activity" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 14px" }}>
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)} style={{ display: "flex", gap: 10, alignItems: "baseline", background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left", flexWrap: "wrap" }}>
          <span style={{ color: "var(--muted)", width: 12, flex: "none" }}>{all ? "▾" : "▸"}</span>
          <span className="fold-title">{heading ?? "Scrum Master"}</span>
          {!!rows.length && <small className="muted">{smSummary(groups)}</small>}
        </button>
        {error && <p role="alert" className="error">{error}</p>}
        {!log.data ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">Nothing yet. The Scrum Master's actions appear here with the reason for each.</p> : null}
        <ul style={{ margin: 0, listStyle: "none", paddingLeft: 0, display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
          {(all ? groups : shown).map((g) => (
            <li key={g.key}>
              <details open={all || undefined}>
                <summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>{line(g)}</summary>
                <ul style={{ listStyle: "none", paddingLeft: 18, margin: 0 }}>{g.rows.map(row)}</ul>
              </details>
            </li>
          ))}
          {!all && hidden > 0 && (
            <li>
              <button type="button" className="link" onClick={() => setAll(true)}>
                Show all {total} actions
              </button>
            </li>
          )}
        </ul>
      </section>
    );
  }

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
