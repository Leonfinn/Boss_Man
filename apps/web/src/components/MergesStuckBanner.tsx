// The merge line banner (BOS-1507, design BOS-1490; two states since BOS-1594): one component for the Dashboard and
// Decisions. The server decides the line's state once (merge-line-health.ts, carried on the Merge queue read as
// `line`) and the jam alert reads the same verdict, so the two never disagree.
//  - stuck: nothing is moving and someone has to act. Red, names the cause and the one step that fixes it.
//  - over capacity: merges land, but slowly. Calm blue-grey, no alarm, says how long the queue will take.
//  - healthy: no banner.
// No dismiss button: it leaves when the problem does.
import { api } from "../api";
import { usePoll } from "../hooks";

/** The server's verdict on the merge line (merge-line-health.ts). */
export type MergeLine =
  | { state: "healthy" }
  | { state: "stuck"; cause: string; title: string; reason: string; fix: string; others: number }
  | { state: "over_capacity"; waiting: number; etaMinutes: number | null; lastLandedAt: string | null; advice: string | null };

/** The part of the Merge queue read the banner and the Dashboard's Merges line need. */
export type MergeHealthView = {
  waitingCount: number;
  stuckCount?: number;
  /** Absent from a server older than BOS-1594: then nothing is shown rather than a guess. */
  line?: MergeLine;
};

export type StuckSummary = { title: string; reason: string; fix: string; others: number };
export type SlowSummary = { waiting: number; etaMinutes: number | null; lastLandedAt: string | null; advice: string | null };

/** "16 h", "1 h 20 min", "45 min": the same words as the server's alert. */
export function waitedText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** What is stuck, or null: only the server's "stuck" verdict counts. */
export function stuckSummary(view: Pick<MergeHealthView, "line">): StuckSummary | null {
  const l = view.line;
  return l?.state === "stuck" ? { title: l.title, reason: l.reason, fix: l.fix, others: l.others } : null;
}

/** Merging but slowly, or null. */
export function slowSummary(view: Pick<MergeHealthView, "line">): SlowSummary | null {
  const l = view.line;
  return l?.state === "over_capacity" ? { waiting: l.waiting, etaMinutes: l.etaMinutes, lastLandedAt: l.lastLandedAt, advice: l.advice } : null;
}

/** "Merging, but slowly: 17 waiting, about 4 h to clear at the current rate, last landed 19:03." */
export function slowText(s: SlowSummary): string {
  const eta = s.etaMinutes === null ? "" : `, about ${waitedText(s.etaMinutes)} to clear at the current rate`;
  const last = s.lastLandedAt ? `, last landed ${clock(s.lastLandedAt)}` : "";
  return `Merging, but slowly: ${s.waiting} merge ${s.waiting === 1 ? "check" : "checks"} waiting${eta}${last}.`;
}

export function MergesStuckBanner({ stuck, slow, companyId }: { stuck: StuckSummary | null; slow?: SlowSummary | null; companyId?: string }) {
  const href = companyId ? `#/merge-queue/${companyId}` : "#/merge-queue";
  if (stuck) {
    const behind = stuck.others > 0 ? ` ${stuck.others === 1 ? "1 more is" : `${stuck.others} more are`} waiting behind it.` : "";
    return (
      <div className="merges-banner" role="status">
        <a className="merges-banner-link" href={href}>
          <span className="merges-banner-sym" aria-hidden="true">!</span>
          <span className="merges-banner-text">
            <strong>Merges are stuck: {stuck.title}</strong>
            <span>
              {sentence(stuck.reason)}
              {behind}
            </span>
            <span>Fix: {sentence(stuck.fix)}</span>
          </span>
          <span className="merges-banner-go">Open Merge queue</span>
        </a>
      </div>
    );
  }
  if (slow) {
    return (
      <div className="merges-banner merges-banner-slow" role="status">
        <a className="merges-banner-link" href={href}>
          <span className="merges-banner-sym" aria-hidden="true">…</span>
          <span className="merges-banner-text">
            <strong>{slowText(slow)}</strong>
            {slow.advice ? <span>{slow.advice}</span> : null}
          </span>
          <span className="merges-banner-go">Open Merge queue</span>
        </a>
      </div>
    );
  }
  return null;
}

/** The banner with its own read, for a page that has no Merge queue read of its own (Decisions). A failed read shows nothing. */
export function MergesStuckBannerFor({ companyId }: { companyId: string | undefined }) {
  const view = usePoll(
    (signal) => (companyId ? api<MergeHealthView>(`/api/companies/${companyId}/merge-queue`, { signal }).catch(() => null) : Promise.resolve(null)),
    20_000,
    `merge-banner-${companyId}`,
  );
  return <MergesStuckBanner stuck={view.data ? stuckSummary(view.data) : null} slow={view.data ? slowSummary(view.data) : null} companyId={companyId} />;
}
