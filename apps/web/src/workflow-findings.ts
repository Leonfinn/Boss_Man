// The "What this shows" sentences of the Workflow report (BOS-1883 design). Pure: figures in, words out.

/** Fewest finished tickets a summary needs, in the chosen period and in the one before it. */
export const MIN_DONE = 5;
/** How far a figure must move, as a share of the earlier one, before the sentence says up or down. */
export const CHANGE_SHARE = 0.2;
const MIN_HANDOFF = 3;
const PERIODS = [7, 14, 30, 90];

type Stats = { done: number; medianCycleMs: number | null };
type Handoff = { from: string; to: string; kind: "assign" | "review"; count: number; medianWaitMs: number | null; bounceRate: number | null };
type Feature = {
  id: string;
  title: string;
  tailFlag: boolean;
  tail: { ref: string | null; title: string; ageMs: number }[];
  criticalPath: { ageing: { id: string; ref: string | null; title: string; reasons: string[] }[] } | null;
};

/** The part of the report's figures the findings read. `overall` and `previous` are missing from an older server. */
export type FindingsInput = {
  days: number;
  overall?: Stats;
  previous?: { overall: Stats; handoffs: Handoff[] } | null;
  handoffs: Handoff[];
  features: Feature[];
  sizeNotes: { role: string; size: number; likeSize: number }[];
};

/** A run of words, or words that link somewhere. */
export type Part = string | { text: string; href: string; title?: string };
export type FindingTarget = "roles" | "handoffs" | "features" | "sizes";
export type Finding = { lead: Part[]; detail: Part[]; target: FindingTarget; seeLabel: string };
export type Findings = {
  scope: string;
  /** Set when there is too little data: the one sentence, and the period the button switches to (null at 90 days). */
  sparse: { text: string; nextDays: number | null } | null;
  items: Finding[];
};

const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** "30 minutes", "6 hours", "1.5 days": words, so a screen reader says them well. */
export function timeWords(ms: number): string {
  const m = ms / 60_000;
  if (m < 60) {
    const n = Math.max(1, Math.round(m));
    return `${n} ${n === 1 ? "minute" : "minutes"}`;
  }
  const h = m / 60;
  if (h < 48) {
    const v = h < 10 ? trim(Math.round(h * 10) / 10) : String(Math.round(h));
    return `${v} ${v === "1" ? "hour" : "hours"}`;
  }
  const d = h / 24;
  const v = d < 10 ? trim(Math.round(d * 10) / 10) : String(Math.round(d));
  return `${v} ${v === "1" ? "day" : "days"}`;
}

const label = (s: string) => s.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
/** "the reviewer", "the CEO", "you". */
function roleWords(role: string): string {
  if (role === "owner") return "you";
  if (role === "ceo") return "the CEO";
  return `the ${label(role).toLowerCase()}`;
}
/** "a developer's" / "the CEO's" / "your". */
const possessive = (role: string) => (role === "owner" ? "your" : role === "ceo" ? "the CEO's" : `a ${label(role).toLowerCase()}'s`);

type Dir = "up" | "down" | "same";
function direction(now: number, before: number): Dir {
  if (before === 0) return now === 0 ? "same" : "up";
  const change = (now - before) / before;
  return change >= CHANGE_SHARE ? "up" : change <= -CHANGE_SHARE ? "down" : "same";
}
const comparison = (dir: Dir, before: string) => (dir === "up" ? `, up from ${before}` : dir === "down" ? `, down from ${before}` : ", about the same as before");

function cut(title: string): string {
  if (title.length <= 60) return title;
  const head = title.slice(0, 60);
  const sp = head.lastIndexOf(" ");
  return `${(sp > 0 ? head.slice(0, sp) : head).trimEnd()}…`;
}

const REASON: Record<string, string> = { "Nobody is assigned": "nobody has it", Blocked: "it is blocked", "Older than usual for this role": "it has been open longer than usual" };
const reasonWords = (r: string) => REASON[r] ?? r.charAt(0).toLowerCase() + r.slice(1);

function pace(o: Stats, prev: Stats | null): Finding {
  const ok = prev !== null && prev.done >= MIN_DONE;
  const lead = `The team finished ${o.done} tickets${ok ? comparison(direction(o.done, prev.done), String(prev.done)) : ""}.`;
  const detail: Part[] = [];
  if (o.medianCycleMs !== null) {
    const cmp = ok && prev.medianCycleMs !== null ? comparison(direction(o.medianCycleMs, prev.medianCycleMs), timeWords(prev.medianCycleMs)) : "";
    detail.push(`A ticket usually takes ${timeWords(o.medianCycleMs)} from start to finish${cmp}.`);
  }
  return { lead: [lead], detail, target: "roles", seeLabel: "See roles" };
}

function waits(f: FindingsInput): Finding | null {
  const pool = f.handoffs.filter((h) => h.count >= MIN_HANDOFF && h.medianWaitMs !== null);
  if (!pool.length) return null;
  const top = pool.reduce((a, b) => ((b.medianWaitMs as number) > (a.medianWaitMs as number) || (b.medianWaitMs === a.medianWaitMs && b.count > a.count) ? b : a));
  const wait = top.medianWaitMs as number;
  const prev = f.previous?.handoffs.find((h) => h.from === top.from && h.to === top.to && h.kind === top.kind);
  const cmp = prev && prev.count >= MIN_HANDOFF && prev.medianWaitMs !== null ? comparison(direction(wait, prev.medianWaitMs), timeWords(prev.medianWaitMs)) : "";
  const time = timeWords(wait);
  if (wait >= 3_600_000) {
    if (top.kind === "review") return { lead: ["Reviews are where work waits longest."], detail: [`${cap(possessive(top.from))} ticket usually waits ${time} for ${roleWords(top.to)}'s verdict${cmp}.`], target: "handoffs", seeLabel: "See handoffs" };
    const who = top.from === "owner" ? "Work you or Boss Man assign" : `Work from ${roleWords(top.from)}`;
    return { lead: ["Picking up work is where it waits longest."], detail: [`${who} usually waits ${time} before ${roleWords(top.to)} starts it${cmp}.`], target: "handoffs", seeLabel: "See handoffs" };
  }
  return { lead: ["Work rarely waits."], detail: [`The longest usual wait is ${time}, for ${roleWords(top.to)}'s ${top.kind === "review" ? "verdict" : "pick-up"}.`], target: "handoffs", seeLabel: "See handoffs" };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function lookAt(f: FindingsInput, companyId: string | null): Finding | null {
  const featureHref = (id: string) => (companyId ? `#/features/${companyId}/${id}` : "#/features");
  const held = f.features.filter((x) => x.criticalPath && x.criticalPath.ageing.length > 0);
  const first = held[0];
  const a = first?.criticalPath?.ageing[0];
  if (first && a) {
    const reasons = a.reasons.map(reasonWords).join(" and ");
    const more = held.length - 1;
    const detail: Part[] = [{ text: a.ref ?? a.title, href: `#/tickets/${a.id}`, title: a.title }, ` is on its longest chain of tasks and ${reasons}.`];
    if (more > 0) detail.push(` ${more} more ${more === 1 ? "feature is" : "features are"} held up.`);
    return { lead: ["“", { text: cut(first.title), href: featureHref(first.id), title: first.title }, "” is held up."], detail, target: "features", seeLabel: "See features" };
  }
  const slow = f.features.find((x) => x.tailFlag);
  if (slow) {
    const oldest = slow.tail.reduce<Feature["tail"][number] | null>((a, b) => (a === null || b.ageMs > a.ageMs ? b : a), null);
    return {
      lead: ["“", { text: cut(slow.title), href: featureHref(slow.id), title: slow.title }, "” is nearly done, but its last tasks are slow."],
      detail: oldest ? [`${oldest.ref ?? oldest.title} has been open ${timeWords(oldest.ageMs)}.`] : [],
      target: "features",
      seeLabel: "See features",
    };
  }
  const back = f.handoffs.filter((h) => h.kind === "review" && h.count >= 5 && h.bounceRate !== null && h.bounceRate >= 0.3).sort((a, b) => (b.bounceRate as number) - (a.bounceRate as number))[0];
  if (back) {
    return { lead: [`Reviews send back ${Math.round((back.bounceRate as number) * 10)} in 10 of ${roleWords(back.from)}'s tickets.`], detail: ["Each one sent back costs another round of work."], target: "handoffs", seeLabel: "See handoffs" };
  }
  const note = f.sizeNotes[0];
  if (note) return { lead: [`${label(note.role)} size ${note.size} tasks take about as long as size ${note.likeSize}.`], detail: ["They may be sized too low."], target: "sizes", seeLabel: "See sizes" };
  return null;
}

/** The scope line, and up to three sentences. Null when the server did not send the whole-team figures. */
export function findings(sc: FindingsInput, companyId: string | null = null): Findings | null {
  const o = sc.overall;
  if (!o) return null;
  const n = sc.days;
  if (o.done < MIN_DONE) {
    const idx = PERIODS.indexOf(n);
    const nextDays = idx >= 0 && idx < PERIODS.length - 1 ? (PERIODS[idx + 1] ?? null) : null;
    const need = n === 90 ? "a summary needs at least 5 in 90 days." : "a summary needs at least 5.";
    const text =
      o.done === 0
        ? `Nothing was finished in the last ${n} days, so there is nothing to sum up yet.`
        : `Not enough finished work in the last ${n} days to say. ${o.done} ${o.done === 1 ? "ticket was" : "tickets were"} finished; ${need}`;
    return { scope: `Last ${n} days.`, sparse: { text, nextDays }, items: [] };
  }
  const prev = sc.previous && sc.previous.overall.done >= MIN_DONE ? sc.previous.overall : null;
  const scope = prev ? `Last ${n} days, compared with the ${n} days before.` : `Last ${n} days. There are no figures from the ${n} days before, so nothing is compared yet.`;
  const items: Finding[] = [pace(o, prev)];
  const w = waits(prev ? sc : { ...sc, previous: null });
  if (w) items.push(w);
  const l = lookAt(sc, companyId);
  if (l) items.push(l);
  return { scope, sparse: null, items };
}
