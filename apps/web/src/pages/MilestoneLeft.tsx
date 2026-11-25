// BOS-2580: a milestone's "What's left" list. Every ticket that isn't done, grouped by who has to move. The server works
// each group and wait out from ticket state, waits-on links and open cards when the list is read (R59); nobody types anything.
import { LEFT_GROUPS, LEFT_GROUP_LABEL, type LeftGroup } from "@boss-man/shared";

export type LeftWait = { kind: "ticket" | "card" | "engagement" | "date" | "note"; text: string; id?: string };
export type MilestoneTicketRow = {
  id: string;
  ref?: string;
  title: string;
  state: string;
  outcome: string | null;
  assignee: string | null;
  group?: LeftGroup | null;
  waits?: LeftWait[];
  cardId?: string | null;
  quietDays?: number | null;
  watchUntil?: string | null;
  updatedDaysAgo?: number | null;
  stuck?: boolean;
};

const niceDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** The facts under a ticket's title: what it waits on, when its watch ends, when it was last touched. Exported for the tests. */
export function leftFacts(t: MilestoneTicketRow, today: string): string[] {
  const out: string[] = [];
  for (const w of t.waits ?? []) {
    if (w.kind === "ticket") out.push(`waits on ${w.text}`);
    else if (w.kind === "card") out.push("waits on your card");
    else if (w.kind === "engagement") out.push(`waits on ${w.text}`);
    else out.push(w.kind === "date" ? `held: ${w.text}` : w.text);
  }
  if (t.stuck) out.push("looks stuck");
  if (t.group === "running" || t.group === "look") {
    if (t.watchUntil) {
      const ahead = Math.round((Date.parse(`${t.watchUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      out.push(ahead < 0 ? `date passed ${days(-ahead)} ago` : ahead === 0 ? "ends today" : ahead === 1 ? `ends tomorrow, ${niceDate(t.watchUntil)}` : `ends ${niceDate(t.watchUntil)}`);
    } else if (t.group === "look") out.push("no end date");
  }
  if (t.updatedDaysAgo != null) out.push(t.updatedDaysAgo === 0 ? "updated today" : `no update for ${days(t.updatedDaysAgo)}`);
  return out;
}

function Item({ t, today }: { t: MilestoneTicketRow; today: string }) {
  const facts = leftFacts(t, today);
  return (
    <li className="rm-left-item" data-testid="rm-left-item">
      <div className="rm-left-main">
        {t.ref && <a href={`#/tickets/${t.id}`} className="rm-left-ref">{t.ref}</a>}
        <a href={`#/tickets/${t.id}`} className="rm-left-title">{t.title}</a>
        {t.assignee && <span className="muted rm-left-who">{t.assignee}</span>}
      </div>
      {facts.length > 0 && <p className="muted rm-left-facts">{facts.join(" · ")}</p>}
      {t.cardId && (
        <a className="btn small rm-left-card" href={`#/decisions/${t.cardId}`}>
          Open card
        </a>
      )}
    </li>
  );
}

export function MilestoneLeft({ rows, today }: { rows: MilestoneTicketRow[]; today: string }) {
  const left = rows.filter((t) => t.group);
  const finished = rows.filter((t) => !t.group);
  const by = (g: LeftGroup) => left.filter((t) => t.group === g);
  const owner = by("owner");
  const quiet = by("look").length;
  return (
    <section className="rm-left" aria-label="What's left">
      <h4>What's left: {left.length === 0 ? "nothing, every ticket is done" : `${left.length} ${left.length === 1 ? "ticket" : "tickets"} not done`}</h4>
      {LEFT_GROUPS.map((g) => {
        const items = by(g);
        if (!items.length) return null;
        const list = (
          <ul className="rm-left-list">
            {items.map((t) => (
              <Item key={t.id} t={t} today={today} />
            ))}
          </ul>
        );
        // "Being built" is always folded shut, and a long Running list too, so the groups that need someone stay in view.
        const folded = g === "building" || (g === "running" && items.length > 5);
        return folded ? (
          <details key={g} className="rm-left-group" data-group={g}>
            <summary>
              {LEFT_GROUP_LABEL[g]} ({items.length})
            </summary>
            {list}
          </details>
        ) : (
          <div key={g} className="rm-left-group" data-group={g}>
            <h5>
              {LEFT_GROUP_LABEL[g]} ({items.length})
            </h5>
            {list}
          </div>
        );
      })}
      {owner.length === 0 && left.length > 0 && <p className="muted">Nothing here is waiting for you{quiet ? ` · ${quiet} ${quiet === 1 ? "has" : "have"} gone quiet` : ""}.</p>}
      {finished.length > 0 && (
        <details className="rm-left-group">
          <summary>Finished ({finished.length})</summary>
          <ul className="rm-tickets">
            {finished.map((t) => (
              <li key={t.id}>
                <a href={`#/tickets/${t.id}`}>{t.title}</a>
                <span className={`tag ${t.outcome === "cancelled" ? "" : "green"}`}>{t.outcome === "cancelled" ? "cancelled" : "done"}</span>
                {t.assignee && <span className="muted">{t.assignee}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
