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

export function WorkStands({ counts, targets, hrefFor }: { counts: WorkStandsCounts; targets?: WorkStandsTargets; /** Off the Board: where each item goes instead (the Board page). */ hrefFor?: string }) {
  const quiet = QUIET.filter((i) => counts[i.key] > 0);
  const link = (i: Item | "inProgress", text: string, icon: string) => {
    const key = i === "inProgress" ? "inProgress" : i.key;
    const target = targets?.[key];
    const onClick = target ? (e: MouseEvent) => { e.preventDefault(); goToLane(target); } : undefined;
    return (
      <a key={key} className={`standing-item ${key}`} href={hrefFor ?? `#lane-${target ?? key}`} onClick={onClick} data-testid={`standing-${key}`}>
        <span aria-hidden="true" className="standing-icon">{icon}</span>
        <b>{counts[key]}</b> {text}
      </a>
    );
  };
  return (
    <div className="standing" role="group" aria-label="Where work stands" data-testid="work-stands">
      {link("inProgress", "in progress", "●")}
      {quiet.length > 0 && (
        <div className="standing-quiet" role="group" aria-label="Moving by itself, nothing to do">
          <span className="standing-quiet-title">Moving by itself, nothing to do:</span>
          {quiet.map((i) => link(i, i.words, i.icon))}
        </div>
      )}
    </div>
  );
}
