// The "Where work stands" strip (BOS-1909, from the BOS-1905 mock-ups): how many tickets are being worked, then a lighter
// dashed group for the three kinds that move by themselves and count toward no limit. An item at 0 is hidden; with all three
// at 0 only "N in progress" shows. Each item links to its lane.
import type { MouseEvent } from "react";

export type WorkStandsCounts = { inProgress: number; nextUp: number; beingChecked: number; watching: number };

/** The id of each lane's heading on the Board (`lane-<column id>`, or its own name for the review and blocked sub-lanes). */
export type WorkStandsTargets = { inProgress?: string; nextUp?: string; beingChecked?: string; watching?: string };

/** Moves the view to a lane and puts keyboard focus on its heading. Plain `#lane-x` links would collide with the hash router. */
export function goToLane(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  el.focus({ preventScroll: true });
}

type Item = { key: keyof WorkStandsCounts; icon: string; words: string };
const QUIET: Item[] = [
  { key: "nextUp", icon: "→", words: "next up" },
  { key: "beingChecked", icon: "⧗", words: "being checked" },
  { key: "watching", icon: "👁", words: "merged, watching" },
];

/** Moves the view to a card (BOS-1910) and puts keyboard focus on its title link. */
export function goToCard(ticketId: string) {
  const el = document.querySelector<HTMLElement>(`[data-ticket-id="${ticketId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  el.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
}

export function WorkStands({ counts, targets, hrefFor, stuck = 0, stuckTicketId, onShowStuck, working }: { /** BOS-2879: agents with a live run now (the figure of "N agents running now"); leads the strip so "in progress" is not read as agents. Omitted: no pill. */ working?: number; /** BOS-2351: on the Board, clicking "looks stuck" calls this to show only the stuck cards, instead of moving to the first. */ onShowStuck?: () => void; counts: WorkStandsCounts; targets?: WorkStandsTargets; /** Off the Board: where each item goes instead (the Board page). */ hrefFor?: string; /** BOS-1910: tickets the watchdog has handed to the Scrum Master; hidden at 0. */ stuck?: number; /** The first of them, which the item links to. */ stuckTicketId?: string }) {
  const quiet = QUIET.filter((i) => counts[i.key] > 0);
  const link = (i: Item | "inProgress", text: string, icon: string) => {
    const key = i === "inProgress" ? "inProgress" : i.key;
    const target = targets?.[key];
    const onClick = target ? (e: MouseEvent) => { e.preventDefault(); goToLane(target); } : undefined;
    return (
      <a key={key} className={`standing-item ${key}`} href={hrefFor ?? `#lane-${target ?? key}`} onClick={onClick} data-testid={`standing-${key}`}>
        {icon && <span aria-hidden="true" className="standing-icon">{icon}</span>}
        <b>{counts[key]}</b> {text}
      </a>
    );
  };
  return (
    <div className="standing" role="group" aria-label="Where work stands" data-testid="work-stands">
      {working != null && (
        <a className="standing-item working" href="#/agents" data-testid="standing-working">
          <span aria-hidden="true" className="standing-icon">●</span>
          <b>{working}</b> {working === 1 ? "agent" : "agents"} working now
        </a>
      )}
      {link("inProgress", working != null ? (counts.inProgress === 1 ? "task in progress" : "tasks in progress") : "in progress", working != null ? "" : "●")}
      {stuck > 0 && (
        <a className="standing-item stuck" href={hrefFor ?? "#"} onClick={hrefFor ? undefined : onShowStuck ? (e) => { e.preventDefault(); onShowStuck(); } : stuckTicketId ? (e) => { e.preventDefault(); goToCard(stuckTicketId); } : undefined} data-testid="standing-stuck">
          <span aria-hidden="true" className="standing-icon">⚠</span>
          <b>{stuck}</b> looks stuck
        </a>
      )}
      {quiet.length > 0 && (
        <div className="standing-quiet" role="group" aria-label="Moving by itself, nothing to do">
          <span className="standing-quiet-title">Moving by itself, nothing to do:</span>
          {quiet.map((i) => link(i, i.words, i.icon))}
        </div>
      )}
    </div>
  );
}
