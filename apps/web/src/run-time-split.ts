import type { TranscriptItem } from "./api";

export type TimeRow = { key: string; label: string; ms: number; share: number };
export type LongCall = { tool: string; what: string; ms: number; noResult: boolean; index: number };
export type TimeSplit = { totalMs: number; rows: TimeRow[]; longest: LongCall[] };

const TOOL_LABELS: Record<string, string> = { execute: "Commands (Bash)", read: "Read", edit: "Edit", search: "Search", fetch: "Fetch", think: "Think", delete: "Delete", move: "Move", other: "Other tools" };

type Call = { start: number; end: number; tool: string; what: string; noResult: boolean; index: number };

function atOf(item: TranscriptItem): number {
  const t = Date.parse(item.at);
  if (Number.isFinite(t)) return t;
  const u = (item.event.update ?? {}) as Record<string, unknown>;
  const v = typeof u.at === "string" ? Date.parse(u.at) : NaN;
  return Number.isFinite(v) ? v : NaN;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Splits a run's time into tool calls (by tool), permission waits and the model's own time
 * (everything else). Every moment is counted once: where calls overlap, the time is shared
 * between them; a permission wait takes priority over the call it holds up. A call whose
 * result never came runs to the run's end (or to `nowMs` for a run still going) and is marked
 * "no result". Returns null when the items carry no usable timestamps (older runs).
 */
export function runTimeSplit(items: TranscriptItem[], endedAtMs: number | null, nowMs: number): TimeSplit | null {
  const times = items.map(atOf).filter((t) => !Number.isNaN(t));
  if (times.length < 2) return null;
  const first = Math.min(...times);
  const last = Math.max(...times);
  const end = Math.max(endedAtMs ?? nowMs, last);
  const runEnded = endedAtMs != null;

  const open = new Map<string, Call>();
  const calls: Call[] = [];
  const waits: Array<[number, number]> = [];
  const pendingWaits: Array<{ start: number; id: string | null }> = [];

  items.forEach((item, index) => {
    const t = atOf(item);
    if (Number.isNaN(t)) return;
    // A permission wait ends when the held-up call moves on (or, with no call named, at the next step).
    if (item.type !== "run.permission_request") {
      const u = (item.event.update ?? {}) as Record<string, unknown>;
      const id = typeof u.toolCallId === "string" ? u.toolCallId : null;
      for (let i = pendingWaits.length - 1; i >= 0; i--) {
        const w = pendingWaits[i]!;
        if (w.id === null || w.id === id) {
          waits.push([w.start, t]);
          pendingWaits.splice(i, 1);
        }
      }
    }
    if (item.type === "run.permission_request") {
      pendingWaits.push({ start: t, id: typeof item.event.toolCallId === "string" ? item.event.toolCallId : null });
      return;
    }
    if (item.type !== "run.update") return;
    const u = (item.event.update ?? {}) as Record<string, unknown>;
    if (u.kind !== "tool_call" && u.kind !== "tool_call_update") return;
    const id = typeof u.toolCallId === "string" ? u.toolCallId : `seq-${item.seq}`;
    let call = open.get(id);
    if (!call) {
      const kind = typeof u.toolKind === "string" && u.toolKind ? u.toolKind : "other";
      const title = typeof u.title === "string" ? u.title : "";
      call = { start: t, end: end, tool: kind, what: clip(String(u.inputSummary ?? title).replace(/\s+/g, " ").trim(), 90), noResult: true, index };
      open.set(id, call);
      calls.push(call);
    } else if (typeof u.title === "string" && u.title && !u.inputSummary && call.what === "") {
      call.what = clip(u.title, 90);
    }
    if (u.status === "completed" || u.status === "failed") {
      call.end = Math.max(t, call.start);
      call.noResult = false;
    }
  });
  // A wait nobody answered runs to the end.
  for (const w of pendingWaits) waits.push([w.start, end]);
  // A call that never got a result only counts to the run's end when the run is over.
  if (!runEnded) for (const c of calls) if (c.noResult) c.end = end;

  // Sweep over every boundary, giving each slice to one bucket.
  const bounds = new Set<number>([first, end]);
  for (const c of calls) {
    bounds.add(c.start);
    bounds.add(c.end);
  }
  for (const [a, b] of waits) {
    bounds.add(a);
    bounds.add(b);
  }
  const points = [...bounds].filter((p) => p >= first && p <= end).sort((a, b) => a - b);
  const byTool = new Map<string, number>();
  const callMs = new Map<Call, number>();
  let permission = 0;
  let model = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = b - a;
    if (waits.some(([s, e]) => s <= a && e >= b)) {
      permission += len;
      continue;
    }
    const active = calls.filter((c) => c.start <= a && c.end >= b);
    if (!active.length) {
      model += len;
      continue;
    }
    for (const c of active) {
      byTool.set(c.tool, (byTool.get(c.tool) ?? 0) + len / active.length);
      callMs.set(c, (callMs.get(c) ?? 0) + len / active.length);
    }
  }
  const totalMs = end - first;
  const share = (ms: number) => (totalMs > 0 ? ms / totalMs : 0);
  const rows: TimeRow[] = [...byTool.entries()].map(([k, ms]) => ({ key: `tool:${k}`, label: TOOL_LABELS[k] ?? k, ms, share: share(ms) }));
  rows.push({ key: "permission", label: "Waiting on permission cards", ms: permission, share: share(permission) });
  rows.push({ key: "model", label: "Model thinking between steps", ms: model, share: share(model) });
  rows.sort((x, y) => y.ms - x.ms);
  const longest = [...calls]
    .sort((x, y) => y.end - y.start - (x.end - x.start))
    .slice(0, 5)
    .map((c) => ({ tool: TOOL_LABELS[c.tool] ?? c.tool, what: c.what, ms: c.end - c.start, noResult: c.noResult, index: c.index }));
  return { totalMs, rows, longest };
}

/** "1 h 5 min", "4 min 12 s", "9 s". */
export function spanWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
