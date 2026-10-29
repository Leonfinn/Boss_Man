import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";

export type TicketReview = { id: string; kind: string; round: number; seq: number; status: string; reviewer: string | null; notes: string | null; overruleReason: string | null; waitingOn?: string | null; createdAt?: string; decidedAt?: string | null };

/** The reviews' names joined for a sentence: "Ada", "Ada and Sam". */
export const names = (rs: TicketReview[]) => [...new Set(rs.map((r) => r.reviewer ?? "a reviewer"))].join(" and ");

export const STATUS: Record<string, string> = { pending: "Waiting", approved: "Approved", changes_requested: "Changes requested", overruled: "Overruled by the CEO", skipped: "Not run" };
const TONE: Record<string, string> = { pending: "amber", approved: "green", changes_requested: "red", overruled: "purple", skipped: "" };

export const useTicketReviews = (ticketId: string) => usePoll((signal) => api<TicketReview[]>(`/api/tickets/${ticketId}/reviews`, { signal }), 15_000, `reviews-${ticketId}`).data;

/** "4 reviews · round 15 · all approved", or "1 asks for changes". */
export function reviewsSummary(reviews: TicketReview[]) {
  const latest = reviews[0]!.round;
  const current = reviews.filter((r) => r.round === latest);
  const asking = current.filter((r) => r.status === "changes_requested").length;
  const waiting = current.filter((r) => r.status === "pending").length;
  const state = asking ? `${asking} ask${asking === 1 ? "s" : ""} for changes` : waiting ? `${waiting} waiting` : "all approved";
  return `${reviews.length} review${reviews.length === 1 ? "" : "s"} · round ${latest} · ${state}`;
}

/** The reviews a ticket needs, newest round first: one line each (kind, reviewer, round, status) that opens to its notes and any CEO overrule reason; the heading opens them all. */
export function TicketReviews({ reviews }: { reviews: TicketReview[] | null }) {
  const [all, setAll] = useState(false);
  if (!reviews?.length) return null;
  const latest = reviews[0]!.round;
  return (
    <section className="card" aria-label="Reviews" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button type="button" aria-expanded={all} onClick={() => setAll(!all)} style={{ display: "flex", gap: 10, alignItems: "baseline", background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left" }}>
        <span style={{ color: "var(--muted)", width: 12, flex: "none" }}>{all ? "▾" : "▸"}</span>
        <span className="fold-title">Reviews</span>
        <small className="muted">{reviewsSummary(reviews)}</small>
      </button>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {reviews.map((r) => {
          const line = (
            <>
              <strong style={{ textTransform: "capitalize" }}>{r.kind}</strong> review by {r.reviewer ?? "you (no agent can review it)"} · round {r.round} · <span className={`tag ${TONE[r.status] ?? ""}`}>{r.status === "pending" ? `Waiting for ${r.reviewer ?? "you"}` : (STATUS[r.status] ?? r.status)}</span>
            </>
          );
          const hasBody = r.waitingOn || r.notes || r.overruleReason;
          return (
            <li key={r.id} style={{ opacity: r.round === latest ? 1 : 0.7 }}>
              {hasBody ? (
                <details open={all || undefined}>
                  <summary style={{ cursor: "pointer" }}>{line}</summary>
                  <div style={{ paddingLeft: 18 }}>
                    {r.waitingOn && <div className="muted" style={{ fontSize: 14 }}>{r.waitingOn}</div>}
                    {r.notes && <div className="muted" style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{r.notes}</div>}
                    {r.overruleReason && <div style={{ fontSize: 14 }}>Overruled by the CEO: {r.overruleReason}</div>}
                  </div>
                </details>
              ) : (
                <div style={{ paddingLeft: 18 }}>{line}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
