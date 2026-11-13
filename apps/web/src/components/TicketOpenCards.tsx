import { api, type TicketLinks } from "../api";
import { usePoll } from "../hooks";

/**
 * The open decision cards a ticket waits on (BOS-1159), at the top of the ticket page with an answer
 * button each. The Board says a ticket "waits on your decision"; before this the page only listed the
 * card inside a folded dependencies section, so the owner found no pending card on the ticket.
 * Shares its read with the dependencies section, so it adds no request of its own.
 */
export function TicketOpenCards({ ticketId }: { ticketId: string }) {
  const links = usePoll((signal) => api<TicketLinks>(`/api/tickets/${ticketId}/links`, { signal }), 30_000, `links-${ticketId}`);
  const cards = (links.data?.waitsOn ?? []).filter((w) => w.kind === "decision" && w.open);
  if (!cards.length) return null;
  return (
    <section className="card" aria-label="Waiting on your decision" data-testid="ticket-open-cards" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 style={{ fontSize: 17, fontWeight: 600 }}>{cards.length === 1 ? "Waiting on your decision" : `Waiting on ${cards.length} decisions from you`}</h2>
      {cards.map((c) => (
        <div key={c.dependencyId} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 280px", whiteSpace: "pre-wrap" }}>{c.title.split("\n")[0]}</span>
          <a className="btn primary small" href={c.link}>
            Answer in Decisions
          </a>
        </div>
      ))}
    </section>
  );
}
