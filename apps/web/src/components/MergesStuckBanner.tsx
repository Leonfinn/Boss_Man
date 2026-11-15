// The stuck-merges banner (BOS-1507, design BOS-1490): one component for the Dashboard and Decisions. It
// shows while the Merge queue view has work stuck in the line Boss Man itself is meant to move, the same
// test as the server's "Merges are stuck" alert (merge-jam.ts jammedRows), and it goes away by itself when
// merges move. No dismiss button: it leaves when the problem does.
import { api } from "../api";
import { usePoll } from "../hooks";

/** The part of the Merge queue read the banner and the Dashboard's Merges line need. */
export type MergeHealthView = {
  waitingCount: number;
  stuckCount?: number;
  running: Array<{ ref: string | null; title: string; minutes: number; what: string; overLimit: boolean; phase: string }>;
  waiting: Array<{ ref: string | null; title: string; minutes: number; label: string; next: string | null; stuck: boolean; actor: string | null; decisionId: string | null }>;
};

export type StuckSummary = { title: string; reason: string; others: number };

/** "16 h", "1 h 20 min", "45 min": the same words as the server's alert. */
export function waitedText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const upFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * What is stuck, or null when merges are moving. The same rows as the server's jammedRows: a merge check past
 * its limit, or a waiting row marked stuck that Boss Man must move (not the owner's or an agent's turn, and not
 * held by a card, which already sits in Needs you).
 */
export function stuckSummary(view: Pick<MergeHealthView, "running" | "waiting">): StuckSummary | null {
  // An answer without the two lists isn't a Merge queue read; it counts as nothing stuck rather than a crash.
  const running = (view.running ?? []).filter((r) => r.what === "merge_check" && r.overLimit);
  const waiting = (view.waiting ?? []).filter((w) => w.stuck && w.actor === "system" && !w.decisionId);
  const total = running.length + waiting.length;
  if (total === 0) return null;
  const others = total - 1;
  if (running.length) {
    const r = running[0]!;
    const ref = r.ref ?? `"${r.title}"`;
    return { title: `${ref} has been ${r.phase === "merging" ? "merging" : "in its check"} for ${waitedText(r.minutes)}`, reason: `${ref} is past the one-hour limit for a merge check`, others };
  }
  const w = waiting[0]!;
  const ref = w.ref ?? `"${w.title}"`;
  return { title: `${ref} has waited ${waitedText(w.minutes)} to merge`, reason: upFirst(w.label), others };
}

export function MergesStuckBanner({ stuck, companyId }: { stuck: StuckSummary | null; companyId?: string }) {
  if (!stuck) return null;
  const behind = stuck.others > 0 ? ` ${stuck.others === 1 ? "1 more is" : `${stuck.others} more are`} waiting behind it.` : "";
  return (
    <div className="merges-banner" role="status">
      <a className="merges-banner-link" href={companyId ? `#/merge-queue/${companyId}` : "#/merge-queue"}>
        <span className="merges-banner-sym" aria-hidden="true">!</span>
        <span className="merges-banner-text">
          <strong>Merges are stuck: {stuck.title}</strong>
          <span>
            {sentence(stuck.reason)}
            {behind}
          </span>
        </span>
        <span className="merges-banner-go">Open Merge queue</span>
      </a>
    </div>
  );
}

/** The banner with its own read, for a page that has no Merge queue read of its own (Decisions). A failed read shows nothing. */
export function MergesStuckBannerFor({ companyId }: { companyId: string | undefined }) {
  const view = usePoll(
    (signal) => (companyId ? api<MergeHealthView>(`/api/companies/${companyId}/merge-queue`, { signal }).catch(() => null) : Promise.resolve(null)),
    20_000,
    `merge-banner-${companyId}`,
  );
  return <MergesStuckBanner stuck={view.data ? stuckSummary(view.data) : null} companyId={companyId} />;
}
