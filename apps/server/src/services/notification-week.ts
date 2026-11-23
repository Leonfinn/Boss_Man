// "Last 7 days" on Settings → Notifications (BOS-2420): the notices grouped by day in the owner's
// time zone, so the owner can see what quiet hours and the per-agent cap did. Pure: the service reads the rows.

export type WeekRow = {
  id: string;
  createdAt: Date;
  pushedAt: Date | null;
  demotedBy: string | null;
  pushError: string | null;
  agentId: string | null;
  agentName: string | null;
  link: string;
  title: string;
};

export type DayCounts = { notices: number; pushed: number; quiet: number; cap: number; failed: number };
export type WeekSummary = {
  timeZone: string;
  days: Array<{ day: string } & DayCounts>;
  totals: DayCounts;
  topAgents: Array<{ agentId: string; name: string; notices: number; pushed: number }>;
  lastFailure: { id: string; at: string; error: string; link: string; title: string } | null;
};

const zero = (): DayCounts => ({ notices: 0, pushed: 0, quiet: 0, cap: 0, failed: 0 });

/** The calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function dayIn(timeZone: string, t: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t);
  const g = (type: string) => p.find((x) => x.type === type)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** The 7 days ending today (oldest first) as day keys; steps 24 h back from now and takes each day's date in the zone. */
export function lastSevenDays(timeZone: string, now: Date): string[] {
  const out: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const k = dayIn(timeZone, new Date(now.getTime() - i * 86_400_000));
    if (!out.includes(k)) out.push(k);
  }
  // A 23 or 25 hour day can repeat or skip a key; pad from the front so there are always 7.
  while (out.length < 7) {
    const first = new Date(`${out[0]}T12:00:00Z`);
    out.unshift(new Date(first.getTime() - 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export function summarizeWeek(rows: WeekRow[], timeZone: string, now: Date): WeekSummary {
  const keys = lastSevenDays(timeZone, now);
  const byDay = new Map(keys.map((k) => [k, zero()]));
  const totals = zero();
  const agents = new Map<string, { agentId: string; name: string; notices: number; pushed: number }>();
  let last: WeekRow | null = null;
  for (const r of rows) {
    const c = byDay.get(dayIn(timeZone, r.createdAt));
    if (!c) continue;
    for (const t of [c, totals]) {
      t.notices++;
      if (r.pushedAt) t.pushed++;
      if (r.demotedBy === "quiet hours") t.quiet++;
      if (r.demotedBy === "cap") t.cap++;
      if (r.pushError) t.failed++;
    }
    if (r.agentId) {
      const a = agents.get(r.agentId) ?? { agentId: r.agentId, name: r.agentName ?? "An agent", notices: 0, pushed: 0 };
      a.notices++;
      if (r.pushedAt) a.pushed++;
      agents.set(r.agentId, a);
    }
    if (r.pushError && (!last || r.createdAt > last.createdAt)) last = r;
  }
  return {
    timeZone,
    days: keys.map((day) => ({ day, ...byDay.get(day)! })),
    totals,
    topAgents: [...agents.values()].sort((a, b) => b.notices - a.notices || a.name.localeCompare(b.name)).slice(0, 5),
    lastFailure: last ? { id: last.id, at: last.createdAt.toISOString(), error: last.pushError!, link: last.link, title: last.title } : null,
  };
}
