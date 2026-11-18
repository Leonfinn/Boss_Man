// The merge line banner (BOS-1507, design BOS-1490; two states since BOS-1594): one component for the Dashboard and
// Decisions. The server decides the line's state once (merge-line-health.ts, carried on the Merge queue read as
// `line`) and the jam alert reads the same verdict, so the two never disagree.
//  - stuck: nothing is moving and someone has to act. Red, names the cause and the one step that fixes it.
//  - over capacity: merges land, but slowly. Calm blue-grey, no alarm, says how long the queue will take.
//  - healthy: no banner.
// No dismiss button: it leaves when the problem does.
// Every count here is written with its one label from @boss-man/shared owner-figures (R43, BOS-1716).
import { figureText, slowLineCounts } from "@boss-man/shared";
import { api } from "../api";
import { usePoll } from "../hooks";

/** The server's verdict on the merge line (merge-line-health.ts). */
export type MergeLine =
  | { state: "healthy" }
  | { state: "stuck"; cause: string; title: string; reason: string; fix: string; others: number }
  | { state: "over_capacity"; waiting: number; inQueue?: number; etaMinutes: number | null; lastLandedAt: string | null; advice: string | null }
  | { state: "held_behind_fix"; held: number; fixes: HeldFix[]; since: string | null }
  | { state: "paused"; reason: string; since: string; until: string; inUse: number; slots: number };

/** R44: new checks are paused on purpose (a server update). */
export type PausedSummary = { reason: string; since: string; until: string; inUse: number; slots: number };

/** The deliberate pause, or null: only the server's "paused" verdict counts. */
export function pausedSummary(view: Pick<MergeHealthView, "line"> | null | undefined): PausedSummary | null {
  const l = view?.line;
  return l?.state === "paused" ? { reason: l.reason, since: l.since, until: l.until, inUse: l.inUse, slots: l.slots } : null;
}

/** "Paused for a server update since 08:52; new checks start once it is done, by 11:52 at the latest." */
export function pausedText(p: PausedSummary): string {
  return `Paused for ${p.reason} since ${clock(p.since)}; new checks start once it is done, by ${clock(p.until)} at the latest.`;
}

/** "2 of 5 in use: new checks paused": the slot line while the pause lasts. */
export function pausedSlotsText(p: PausedSummary): string {
  return `${p.inUse} of ${p.slots} ${p.slots === 1 ? "slot" : "slots"} in use: new checks paused`;
}

/** A ticket that fixes the merge check and holds approved work (R28). */
export type HeldFix = { ticketId: string; ref: string | null; title: string; stateText: string; ownerUpdate: boolean; updateCardId?: string | null };
export type HeldSummary = { held: number; fixes: HeldFix[]; since: string | null };

/** Approved work held behind a main fix, or null: only the server's "held_behind_fix" verdict counts. */
export function heldSummary(view: Pick<MergeHealthView, "line"> | null | undefined): HeldSummary | null {
  const l = view?.line;
  return l?.state === "held_behind_fix" ? { held: l.held, fixes: l.fixes, since: l.since } : null;
}

/** The one plain sentence for the line, with what ends it; the same words everywhere it shows. */
export function heldText(h: HeldSummary): string {
  const fixes = h.fixes.map((f) => `${f.ref ?? `"${f.title}"`} (${f.stateText})`).join(" and ");
  const end = h.fixes.some((f) => f.ownerUpdate) ? "They go on once the server update runs." : "They merge by themselves once it is merged and live.";
  return `Main is red: ${figureText("mergeQueue.heldBehindFix", h.held)} the fix ${fixes}${h.since ? `, since ${clock(h.since)}` : ""}. ${end}`;
}

/** The calm amber line (never the red "stuck" banner); links the fix tickets. */
export function HeldBehindFixLine({ held }: { held: HeldSummary }) {
  return (
    <div className="mq-held-fix" role="status" data-held-behind-fix="true">
      <strong>Main is red: {figureText("mergeQueue.heldBehindFix", held.held)} the fix</strong>{" "}
      {held.fixes.map((f, i) => (
        <span key={f.ticketId}>
          {i > 0 ? " and " : ""}
          <a href={`#/tickets/${f.ticketId}`} title={f.title}>{f.ref ?? f.title}</a> ({f.stateText})
        </span>
      ))}
      {held.since ? `, since ${clock(held.since)}` : ""}. {held.fixes.some((f) => f.ownerUpdate) ? "They go on once the server update runs." : "They merge by themselves once it is merged and live."}
      {held.fixes.filter((f) => f.ownerUpdate && f.updateCardId).slice(0, 1).map((f) => (
        <span key={f.updateCardId}>
          {" "}
          <a href={`#/decisions/${f.updateCardId}`} data-update-card={f.updateCardId}>Open the update card</a>.
        </span>
      ))}
    </div>
  );
}

/** The part of the Merge queue read the banner and the Dashboard's Merges line need. */
export type MergeHealthView = {
  waitingCount: number;
  /** R43 mergeQueue.inLine: waiting and running, the badge's figure; absent from an older server (use waitingCount). */
  lineCount?: number;
  stuckCount?: number;
  /** Absent from a server older than BOS-1594: then nothing is shown rather than a guess. */
  line?: MergeLine;
  /** R47: absent from an older server, and null when a limit is set or the line has not grown. */
  startBrakeOff?: BrakeOffSummary | null;
};

/** R43 mergeQueue.inLine: the one "N in the merge line" figure the badge, the Merges tab and the Dashboard show. */
export function inLineOf(view: Pick<MergeHealthView, "waitingCount" | "lineCount">): number {
  return view.lineCount ?? view.waitingCount;
}

export type StuckSummary = { title: string; reason: string; fix: string; others: number };
export type SlowSummary = { waiting: number; inQueue?: number; etaMinutes: number | null; lastLandedAt: string | null; advice: string | null };

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
  return l?.state === "over_capacity" ? { waiting: l.waiting, inQueue: l.inQueue, etaMinutes: l.etaMinutes, lastLandedAt: l.lastLandedAt, advice: l.advice } : null;
}

/** "Merging, but slowly: 17 for Boss Man to merge, about 4 h to clear at the current rate, last landed 19:03." */
export function slowText(s: SlowSummary): string {
  const eta = s.etaMinutes === null ? ", estimating the time to clear…" : `, about ${waitedText(s.etaMinutes)} to clear at the current rate`;
  const last = s.lastLandedAt ? `, last landed ${clock(s.lastLandedAt)}` : "";
  return `Merging, but slowly: ${slowLineCounts(s)}${eta}${last}.`;
}

/** R47: the start brake has no limit and the line has grown for an hour; null when a limit is set (nothing is said then). */
export type BrakeOffSummary = { waiting: number; suggestedLimit: number };
export function brakeOffSummary(view: Pick<MergeHealthView, "startBrakeOff">): BrakeOffSummary | null {
  return view.startBrakeOff ?? null;
}
export const brakeOffText = (b: BrakeOffSummary) => `Start brake off, ${b.waiting} waiting; suggested limit ${b.suggestedLimit}`;

export function MergesStuckBanner({ stuck, slow, paused, brakeOff, companyId }: { stuck: StuckSummary | null; slow?: SlowSummary | null; paused?: PausedSummary | null; brakeOff?: BrakeOffSummary | null; companyId?: string }) {
  const href = companyId ? `#/merge-queue/${companyId}` : "#/merge-queue";
  if (!stuck && !slow && !paused && brakeOff) {
    return (
      <div className="merges-banner merges-banner-slow" role="status">
        <a className="merges-banner-link" href="#/settings">
          <span className="merges-banner-sym" aria-hidden="true">…</span>
          <span className="merges-banner-text">
            <strong>{brakeOffText(brakeOff)}</strong>
            <span>The merge line has grown for an hour and new starts are not held. Set "Hold new starts while this many merges are waiting" in Settings.</span>
          </span>
          <span className="merges-banner-go">Open Settings</span>
        </a>
      </div>
    );
  }
  if (paused) {
    return (
      <div className="merges-banner merges-banner-slow" role="status" data-merge-paused="true">
        <a className="merges-banner-link" href={href}>
          <span className="merges-banner-sym" aria-hidden="true">‖</span>
          <span className="merges-banner-text">
            <strong>{pausedText(paused)}</strong>
            <span>{sentence(pausedSlotsText(paused))}</span>
          </span>
          <span className="merges-banner-go">Open Merge queue</span>
        </a>
      </div>
    );
  }
  if (stuck) {
    const behind = stuck.others > 0 ? ` ${figureText("mergeQueue.behindIt", stuck.others)}.` : "";
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
  return <MergesStuckBanner stuck={view.data ? stuckSummary(view.data) : null} slow={view.data ? slowSummary(view.data) : null} paused={view.data ? pausedSummary(view.data) : null} brakeOff={view.data ? brakeOffSummary(view.data) : null} companyId={companyId} />;
}
