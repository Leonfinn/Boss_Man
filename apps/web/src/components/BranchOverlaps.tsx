import type { TicketDetail } from "../api";

/**
 * "Changes the same files as BOS-12 …" (BOS-2179): other open tickets of the project whose branches change the same
 * files as this one, from the files each recorded on its last move to review, approval or merge attempt. Advisory:
 * nothing is held. Shows nothing when there is no overlap.
 */
export function BranchOverlaps({ t }: { t: Pick<TicketDetail, "branchOverlaps"> }) {
  const list = t.branchOverlaps ?? [];
  if (!list.length) return null;
  return (
    <div role="note" aria-label="Changes the same files as other work">
      {list.map((o) => (
        <p key={o.ticketId} className="muted" style={{ fontSize: 14, margin: "4px 0" }}>
          Changes the same files as <a href={`#/tickets/${o.ticketId}`}>{o.ref ?? `"${o.title}"`}</a>
          {o.ref ? ` "${o.title}"` : ""} ({o.state === "review" ? "in review" : o.state === "blocked" ? "blocked" : "in progress"}): {o.files.join(", ")}
          {o.more ? ` and ${o.more} more` : ""}. Nothing is held; agree the order if one should land first.
        </p>
      ))}
    </div>
  );
}
