// BOS-1938: one plain line for a finished check job: quick or full, how long, its three longest stages and how busy the
// machine was when it started. A job from before BOS-1923 (or one whose times were pruned) has no stage times: null.

type Job = { stages: string | null; ranFull: boolean | null; busyAtStart: number | null; startedAt: Date | null; endedAt: Date | null };

const minutes = (s: number) => (s < 60 ? `${s} s` : `${Math.max(1, Math.round(s / 60))} min`);

function parse(raw: string | null): Array<{ name: string; seconds: number }> {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is { name: string; seconds: number } => !!s && typeof s.name === "string" && Number.isFinite(s.seconds) && s.seconds >= 0);
  } catch {
    return [];
  }
}

/** "Full check, 28 min: server tests 16 min · shell tests 6 min · web tests 3 min · other 3 min. 2 of 3 slots busy when it started." */
export function stageLine(job: Job, slots: number): string | null {
  const stages = parse(job.stages);
  if (!stages.length) return null;
  const sum = stages.reduce((n, s) => n + s.seconds, 0);
  const total = job.startedAt && job.endedAt ? Math.max(sum, Math.round((job.endedAt.getTime() - job.startedAt.getTime()) / 1000)) : sum;
  const top = [...stages].sort((a, b) => b.seconds - a.seconds).slice(0, 3);
  const rest = total - top.reduce((n, s) => n + s.seconds, 0);
  const parts = top.map((s) => `${s.name} ${minutes(s.seconds)}`);
  if (stages.length > 3 && rest > 0) parts.push(`other ${minutes(rest)}`);
  const busy = job.busyAtStart === null ? "" : ` ${job.busyAtStart} of ${Math.max(slots, job.busyAtStart + 1)} ${slots === 1 ? "slot" : "slots"} busy when it started.`;
  return `${job.ranFull ? "Full check" : "Quick check"}, ${minutes(total)}: ${parts.join(" · ")}.${busy}`;
}
