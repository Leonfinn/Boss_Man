// The Timeline tab's milestones: one row each, in normal flow, so a long title wraps and pushes the next row down
// instead of printing over it (BOS-2558 design, BOS-2560 build). Status, counts and forecast come from the server,
// worked out once, so the row and the summary line can't disagree. Nothing here is positioned except the markers
// inside a row's own date strip.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BurnupPoint, MilestoneStatus, RoadmapCompany, RoadmapMilestone } from "../api";
import { dayOf, short } from "../short-date";

const DAY = 86_400_000;

export const STATUS: Record<MilestoneStatus, { label: string; tone: string; icon: string; colour: string }> = {
  done: { label: "Done", tone: "green", icon: "✓", colour: "var(--green-ink)" },
  late: { label: "Late", tone: "red", icon: "■", colour: "var(--red-ink)" },
  at_risk: { label: "At risk", tone: "amber", icon: "▲", colour: "var(--amber-ink)" },
  on_track: { label: "On track", tone: "blue", icon: "●", colour: "var(--link)" },
  no_work: { label: "No tickets", tone: "grey", icon: "○", colour: "var(--muted)" },
  no_date: { label: "No date", tone: "grey", icon: "○", colour: "var(--muted)" },
};

/** Worst first, the order the summary line counts in. */
const SUMMARY_ORDER: MilestoneStatus[] = ["late", "at_risk", "on_track", "no_date", "no_work"];

const daysBetween = (from: string, to: string) => Math.round((dayOf(to) - dayOf(from)) / DAY);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const weekday = (d: string) => new Date(dayOf(d)).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });

export type DateRange = { start: number; end: number };

/**
 * The date range every row's strip shares, so objectives line up: from a week before today (or before the earliest
 * open due date) to a week after the latest of eight weeks out, the latest due date and the latest expected finish.
 * Done milestones are left out, so a finished one from last month doesn't stretch it.
 */
export function rangeOf(companies: RoadmapCompany[], now: string): DateRange {
  const open = companies.flatMap((c) => c.objectives.flatMap((o) => o.milestones.filter((m) => m.status !== "done")));
  const t = dayOf(now);
  const dues = open.flatMap((m) => (m.targetDate ? [dayOf(m.targetDate)] : []));
  const finishes = open.flatMap((m) => (m.forecast.expectedFinish && m.status !== "no_work" ? [dayOf(m.forecast.expectedFinish)] : []));
  return { start: Math.min(t - 7 * DAY, ...dues.map((d) => d - 7 * DAY)), end: Math.max(t + 56 * DAY, ...dues, ...finishes) + 7 * DAY };
}

const at = (r: DateRange, ms: number) => `${Math.max(0, Math.min(100, ((ms - r.start) / (r.end - r.start)) * 100)).toFixed(2)}%`;

/** "Done (4, latest 20 Nov)" etc.: the one-line counts under an objective, worst first, no zero counts. */
export function summaryLine(ms: RoadmapMilestone[]): string {
  const n = (s: MilestoneStatus) => ms.filter((m) => m.status === s).length;
  const done = n("done");
  const open = ms.length - done;
  if (open === 0) return `No open milestones · ${done} done`;
  const parts = [
    ...SUMMARY_ORDER.flatMap((s) => (n(s) ? [`${n(s)} ${s === "no_work" ? "with no tickets" : STATUS[s].label.toLowerCase()}`] : [])),
  ];
  const lead = n("on_track") === open ? `All ${open} on track` : parts.join(" · ");
  return done ? `${lead} · ${done} done` : lead;
}

/** The two meta lines of a row, and whether the second is a warning. */
export function metaLines(m: RoadmapMilestone, now: string): { line1: string; line2: string; warn: boolean } {
  const f = m.forecast;
  const total = f.pointsDone + f.pointsLeft;
  // Rounded down: 99.6% shows 99%, never 100% while work is left.
  const pct = total > 0 ? Math.floor((f.pointsDone * 100) / total) : m.total > 0 ? Math.floor((m.done * 100) / m.total) : 0;
  const due = m.targetDate ? `Due ${weekday(m.targetDate)} ${short(m.targetDate)}` : null;
  const addOns = [m.blocked ? plural(m.blocked, "ticket blocked", "tickets blocked") : null, f.unsized ? (f.unsized === 1 ? "1 ticket has no size" : `${f.unsized} tickets have no size`) : null].filter(Boolean);
  const tail = addOns.length ? ` · ${addOns.join(" · ")}` : "";
  if (m.status === "no_work") return { line1: `${due ?? "No date"} · no tickets yet`, line2: "Add tickets or features to it to get a forecast.", warn: false };
  const line1 = [due, `${pct}% done`, `${f.pointsLeft} points left`].filter(Boolean).join(" · ");
  const when = f.expectedFinish ? short(f.expectedFinish) : null;
  const late = m.targetDate && m.targetDate < now;
  let line2: string;
  if (!when) line2 = late ? `${plural(daysBetween(m.targetDate!, now), "day", "days")} past its date · nothing finished in the last 4 weeks, so no estimate yet` : "Nothing finished in the last 4 weeks, so no estimate yet";
  else if (late) line2 = `${plural(daysBetween(m.targetDate!, now), "day", "days")} past its date · at its pace about ${when}`;
  else if (m.status === "no_date") line2 = `At its pace about ${when} · give it a date to get a status`;
  else if (f.daysLate > 0) line2 = `At its pace about ${when}, ${plural(f.daysLate, "day", "days")} after its date`;
  else line2 = `At its pace about ${when}`;
  return { line1, line2: line2 + tail, warn: !!late || f.daysLate > 0 || m.blocked > 0 || !when };
}

/** The sentence a screen reader gets for the progress chart. */
export function burnupLabel(b: BurnupPoint[], m?: Pick<RoadmapMilestone, "targetDate" | "forecast">): string {
  const first = b[0]!;
  const last = b.at(-1)!;
  const move = (a: number, z: number) => (a === z ? `stayed at ${z}` : `${z > a ? "rose" : "fell"} from ${a} to ${z}`);
  const finish = m?.forecast.expectedFinish && m.forecast.pointsLeft > 0 ? ` At its pace it finishes about ${short(m.forecast.expectedFinish)}${m.targetDate ? `; due ${short(m.targetDate)}` : ""}.` : m?.targetDate ? ` Due ${short(m.targetDate)}.` : "";
  return `Points done ${move(first.done, last.done)} over ${b.length} weeks; planned ${move(first.total, last.total)}.${finish}`;
}

/** Done lines (solid), planned (dashed) and the pace projection (dotted), drawn at real pixel size so the axis text stays small on a phone. */
function ProgressChart({ m, now }: { m: RoadmapMilestone; now: string }) {
  const b = m.burnup ?? [];
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  useEffect(() => {
    if (!holder.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.min(560, Math.floor(e!.contentRect.width)))));
    ro.observe(holder.current);
    return () => ro.disconnect();
  }, []);
  let chart: ReactNode;
  if (b.length < 2) chart = <p className="muted">Not enough history for a chart yet.</p>;
  else {
    const H = 164;
    const L = 36;
    const R = 14;
    const T = 24;
    const B = 28;
    const t = dayOf(now);
    const x0 = dayOf(b[0]!.weekEnd);
    const due = m.targetDate ? dayOf(m.targetDate) : null;
    const fin = m.forecast.expectedFinish && m.forecast.pointsLeft > 0 ? dayOf(m.forecast.expectedFinish) : null;
    const x1 = Math.max(t + 7 * DAY, due ?? 0, fin != null ? fin + 4 * DAY : 0);
    const top = Math.max(1, ...b.map((p) => p.total));
    const px = (d: number) => L + ((d - x0) / (x1 - x0)) * (width - L - R);
    const py = (v: number) => T + (1 - v / top) * (H - T - B);
    const line = (key: "done" | "total") => b.map((p) => `${px(dayOf(p.weekEnd)).toFixed(1)},${py(p[key]).toFixed(1)}`).join(" ");
    const last = b.at(-1)!;
    const tx = px(t);
    const dueX = due != null && due >= x0 ? px(due) : null;
    return (
      <div ref={holder} className="rm-chart-holder">
        <svg className="rm-chart" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={burnupLabel(b, m)}>
          <line x1={L} y1={T} x2={L} y2={H - B} className="axis" />
          <line x1={L} y1={H - B} x2={width - R} y2={H - B} className="axis" />
          <text x={L - 6} y={py(0) + 4} textAnchor="end">0</text>
          <text x={L - 6} y={py(top) + 4} textAnchor="end">{top}</text>
          {dueX != null && (
            <>
              <line x1={dueX} y1={T - 4} x2={dueX} y2={H - B} className="due" />
              <text x={dueX} y={11} textAnchor={dueX < L + 36 ? "start" : dueX > width - 40 ? "end" : "middle"}>Due {short(m.targetDate!)}</text>
            </>
          )}
          <line x1={tx} y1={T} x2={tx} y2={H - B} className="today" />
          <polyline points={line("total")} className="planned" />
          <polyline points={line("done")} className="done" />
          {fin != null && (
            <>
              <line x1={tx} y1={py(last.done)} x2={px(fin)} y2={py(last.total)} className="pace" />
              <circle cx={px(fin)} cy={py(last.total)} r="4" className="finish" />
            </>
          )}
          {tx - L > 70 && <text x={L} y={H - 8} textAnchor="start">{short(b[0]!.weekEnd)}</text>}
          <text x={tx} y={H - 8} textAnchor="middle">Today</text>
        </svg>
      </div>
    );
  }
  return <div ref={holder} className="rm-chart-holder">{chart}</div>;
}

/** One milestone's strip: today, the bar from today to its expected finish (○) and its due date (◆) on the shared range. */
function Strip({ m, range, now }: { m: RoadmapMilestone; range: DateRange; now: string }) {
  const t = dayOf(now);
  const fin = m.status !== "no_work" && m.forecast.expectedFinish ? dayOf(m.forecast.expectedFinish) : null;
  return (
    <span className="rm-strip" aria-hidden="true">
      {monthStarts(range).map((mo) => (
        <span key={mo.at} className="tick" style={{ left: at(range, mo.at) }} />
      ))}
      <span className="today" style={{ left: at(range, t) }} />
      {fin != null && fin > t && <span className={`bar ${m.status}`} style={{ left: at(range, t), width: `calc(${at(range, fin)} - ${at(range, t)})` }} />}
      {fin != null && <span className={`finish ${m.status}`} style={{ left: at(range, fin) }} />}
      {m.targetDate && <span className="due" style={{ left: at(range, dayOf(m.targetDate)) }} />}
    </span>
  );
}

/** Month starts inside the range. */
function monthStarts(r: DateRange) {
  const out: Array<{ at: number; label: string; year: string | null }> = [];
  const d = new Date(r.start);
  let m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  while (m.getTime() < r.end) {
    out.push({ at: m.getTime(), label: m.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }), year: m.getUTCMonth() === 0 ? String(m.getUTCFullYear()) : null });
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
  }
  return out;
}

function MonthAxis({ range }: { range: DateRange }) {
  const all = monthStarts(range);
  const step = Math.ceil(all.length / 6); // a long range: label every other month rather than crowd the names together
  return (
    <div className="rm-axis" aria-hidden="true">
      {all.map((mo, i) =>
        i % step === 0 ? (
          // Near the right edge the name hangs to the left of its month start, so it can't run out of the card.
          <span key={mo.at} className={`month${(mo.at - range.start) / (range.end - range.start) > 0.88 ? " end" : ""}`} style={{ left: at(range, mo.at) }}>
            {mo.label}
            {mo.year && <span className="yr"> {mo.year}</span>}
          </span>
        ) : null,
      )}
    </div>
  );
}

const finishedOn = (m: RoadmapMilestone) => (m.finishedAt ? m.finishedAt.slice(0, 10) : null);

/** The rows of one objective, the key, the rules and the folded Done group. */
export function MilestoneRows({ ms, range, now, selected, onSelect, detail }: { ms: RoadmapMilestone[]; range: DateRange; now: string; selected: string | null; onSelect: (id: string | null) => void; detail: (m: RoadmapMilestone) => ReactNode }) {
  const open = ms.filter((m) => m.status !== "done").sort((a, b) => (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999") || a.title.localeCompare(b.title));
  const done = ms.filter((m) => m.status === "done").sort((a, b) => (finishedOn(b) ?? "").localeCompare(finishedOn(a) ?? ""));
  const latest = done[0] ? finishedOn(done[0]) : null;
  return (
    <>
      <p className="rm-summary">{summaryLine(ms)}</p>
      {open.length > 0 && (
        <>
          <MonthAxis range={range} />
          <ul className="rm-rows">
            {open.map((m) => {
              const st = STATUS[m.status];
              const { line1, line2, warn } = metaLines(m, now);
              const isOpen = selected === m.id;
              return (
                <li key={m.id} className={`rm-row ${m.status}`} data-status={m.status}>
                  <button type="button" className="rm-rowbtn" aria-expanded={isOpen} onClick={() => onSelect(isOpen ? null : m.id)}>
                    <span className={`rm-chip ${st.tone}`}>
                      <span aria-hidden="true">{st.icon}</span> {st.label}
                    </span>
                    <span className="rm-text">
                      <b className="rm-title">{m.title}</b>
                      <span className="rm-meta">{line1}</span>
                      <span className={`rm-meta2${warn ? " warn" : ""}`}>{line2}</span>
                    </span>
                    <Strip m={m} range={range} now={now} />
                  </button>
                  {isOpen && (
                    <div className="rm-open">
                      <h4>Progress over the last 8 weeks</h4>
                      <p className="rm-legend">
                        <span><i className="solid" aria-hidden="true" /> Points done</span>
                        <span><i className="dashed" aria-hidden="true" /> Points planned</span>
                        <span><i className="dotted" aria-hidden="true" /> At its pace</span>
                      </p>
                      <ProgressChart m={m} now={now} />
                      <p className="muted rm-pace">{m.forecast.pace > 0 ? `Its pace: ${Number.isInteger(m.forecast.pace) ? m.forecast.pace : m.forecast.pace.toFixed(1)} points a week, from the points of this milestone finished in the last 4 weeks.` : "Nothing finished in the last 4 weeks, so no pace yet."}</p>
                      {detail(m)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="rm-key muted">
            <span><i className="due" aria-hidden="true" /> Due date</span>
            <span><i className="finish" aria-hidden="true" /> Expected finish at its pace</span>
            <span><i className="today" aria-hidden="true" /> Today</span>
          </p>
        </>
      )}
      <details className="rm-rules">
        <summary>How the status is worked out</summary>
        <ul>
          <li><b>✓ Done:</b> Every ticket in it is finished.</li>
          <li><b>● On track:</b> At its pace it finishes by its date, and nothing in it is blocked.</li>
          <li><b>▲ At risk:</b> At its pace it finishes after its date, or a ticket in it is blocked, or nothing in it was finished in the last 4 weeks.</li>
          <li><b>■ Late:</b> Its date has passed and work is left.</li>
          <li><b>Its pace:</b> Points of this milestone finished in the last 4 weeks, per week. Tickets of its features count too.</li>
        </ul>
      </details>
      {done.length > 0 && (
        <details className="rm-done">
          <summary>Done ({done.length}{latest ? `, latest ${short(latest)}` : ""})</summary>
          <ul>
            {done.map((m) => (
              <li key={m.id}>
                <span className="rm-chip green"><span aria-hidden="true">✓</span> Done</span>
                <span className="rm-title">{m.title}</span>
                <span className="muted">
                  {finishedOn(m) ? `Finished ${short(finishedOn(m)!)}` : "Finished"}
                  {m.targetDate ? ` · due ${short(m.targetDate)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
