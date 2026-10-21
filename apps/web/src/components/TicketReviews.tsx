import { api } from "../api";
import { usePoll } from "../hooks";

export type TicketReview = { id: string; kind: string; round: number; seq: number; status: string; reviewer: string | null; notes: string | null; overruleReason: string | null };

const STATUS: Record<string, string> = { pending: "Waiting", approved: "Approved", changes_requested: "Changes requested", overruled: "Overruled by the CEO", skipped: "Not run" };
const TONE: Record<string, string> = { pending: "amber", approved: "green", changes_requested: "red", overruled: "purple", skipped: "" };

/** The reviews a ticket needs, newest round first: kind, reviewer, status, notes and any CEO overrule reason. */
export function TicketReviews({ ticketId }: { ticketId: string }) {
  const reviews = usePoll((signal) => api<TicketReview[]>(`/api/tickets/${ticketId}/reviews`, { signal }), 15_000, `reviews-${ticketId}`).data;
  if (!reviews?.length) return null;
  const latest = reviews[0]!.round;
  return (
    <section className="card" aria-label="Reviews" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ margin: 0 }}>Reviews</h3>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {reviews.map((r) => (
          <li key={r.id} style={{ opacity: r.round === latest ? 1 : 0.7 }}>
            <strong style={{ textTransform: "capitalize" }}>{r.kind}</strong> review by {r.reviewer ?? "nobody"} · round {r.round} · <span className={`tag ${TONE[r.status] ?? ""}`}>{STATUS[r.status] ?? r.status}</span>
            {r.notes && <div className="muted" style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{r.notes}</div>}
            {r.overruleReason && <div style={{ fontSize: 14 }}>Overruled by the CEO: {r.overruleReason}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
