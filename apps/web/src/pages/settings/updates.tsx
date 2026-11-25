import { when } from "../Runs";

export type UpdateRow = { at: string; title: string; body: string; state: "ok" | "resolved" | "problem"; todo: string | null };
export type LiveRow = { slug: string; name: string; registered: boolean; connected: boolean; at: string | null; imageVersion: string | null; fault: string | null; swap?: { retryAt: string | null; tries: number } | null; swapFailed?: string | null; guard?: { reason: string; since: string | null } | null };
export type Report = { live: LiveRow[]; update: UpdateRow | null };
export type LastUpdate = { at: string; startedAt: string | null; ok: boolean; title: string; body: string } | null;
/** BOS-1600: a check on a runner that a swap waits on. Absent (`checks` undefined) from an older server. */
export type RunnerCheckView = { ticket: string | null; kind: string; scope: string; startedAt: string | null; runningForMinutes: number; usuallyMinutes: number | null };
export type MaintenanceView = ({ on: false } | { on: true; kind?: "update" | "settings" | "wrapup" | "building"; deadline: string; runs: number; companies: number; blocking?: boolean; checks?: number; checksList?: RunnerCheckView[]; since?: string; phase?: "waiting" | "swapping"; expectedFinishAt?: string | null; overdue?: boolean; /** BOS-2531: false only while a runner is being swapped, until chatBackBy at the latest. */ chatOpen?: boolean; chatBackBy?: string | null; /** BOS-1951 */ merges?: number; mergesList?: { ticket: string | null }[]; unknownWait?: boolean; /** BOS-2479: checks on a check worker (not waited for) and the latest go-ahead. */ workerChecksList?: WorkerCheckView[]; goAheadAt?: string | null; /** BOS-2056: the owner's wrap-up: since when, and which update it is for. */ wrapAsked?: boolean; wrapSince?: string; wrapForUpdate?: "server" | "runner" | "none" }) & { last?: LastUpdate };

/** "BOS-1525 merge check, started 19:41, usually about 15 min" (BOS-1600). */
export function checkSentence(c: RunnerCheckView): string {
  const what = c.kind === "merge" ? "merge check" : c.scope === "quick" ? "quick check" : "check";
  return `${c.ticket ?? "A"} ${what}${c.startedAt ? `, started ${atTime(c.startedAt)}` : ""}${c.usuallyMinutes ? `, usually about ${c.usuallyMinutes} min` : ""}`;
}

/**
 * What a runner update is waiting for, in plain words, from live state (BOS-1600). "swapping the runners now" only
 * when nothing is left to wait for. Agent runs and checks are named separately.
 */
export function waitingFor(m: { runs: number; companies: number; checks?: number; checksList?: RunnerCheckView[]; merges?: number; mergesList?: { ticket: string | null }[]; unknownWait?: boolean; chatOpen?: boolean }): string {
  const n = m.runs;
  const k = m.checks ?? 0;
  const g = m.merges ?? 0;
  const agents = `${plural(n, "run", "runs")} in ${plural(m.companies, "company", "companies")} to finish`;
  const list = (m.checksList ?? []).map(checkSentence).join("; ");
  const checks = `${plural(k, "check", "checks")} to finish before swapping the runners${list ? `: ${list}` : ""}`;
  // BOS-1951: a merge being pushed to main holds the swap too (a few seconds normally), named by ticket.
  const names = (m.mergesList ?? []).map((x) => x.ticket).filter((t): t is string => !!t).join(", ");
  const merges = `${plural(g, "merge", "merges")} being pushed to main${names ? ` (${names})` : ""}`;
  const parts = [...(n > 0 ? [agents] : []), ...(k > 0 ? [checks] : []), ...(g > 0 ? [merges] : [])];
  if (parts.length) return `waiting for ${parts.join(", and for ")}`;
  if (m.unknownWait) return "waiting on something Boss Man cannot name (no agent run, check or merge is going)";
  // BOS-2531: "now" only while a runner is really being recreated (the server says so with chatOpen false). With
  // nothing left to wait for and no runner mid-swap, the swap is next, not under way. An older server sends no chatOpen.
  if (m.chatOpen === true) return "about to swap the runners (nothing is left to wait for)";
  return "swapping the runners now";
}
/** BOS-2479: a check on a separate check worker, which a runner update lets run and never waits for. */
export type WorkerCheckView = { ticket: string | null; kind: string; scope: string };

/**
 * BOS-2479: what the banner adds after "waiting for …": the checks on a check worker it does not wait for, named by ticket
 * and counted by kind ("2 quick checks on a check worker keep running and are not waited for (BOS-2456, BOS-2468)."), and
 * the latest time the update goes ahead. On 24 Nov the owner saw two quick checks running and read them as the wait.
 * Both fields are absent from an older server, which then gets nothing extra.
 */
export function updateWaitExtras(m: { workerChecksList?: WorkerCheckView[]; goAheadAt?: string | null }): string {
  const list = m.workerChecksList ?? [];
  const counts = new Map<string, number>(); // not state: local to this call
  for (const c of list) {
    const word = c.kind === "merge" ? "merge check" : c.scope === "full" ? "full check" : c.scope === "quick" ? "quick check" : "check";
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const kinds = [...counts].map(([word, k]) => plural(k, word, `${word}s`)).join(" and ");
  const names = list.map((c) => c.ticket).filter((t): t is string => !!t);
  const one = list.length === 1;
  const worker = list.length ? `${kinds} on a check worker ${one ? "keeps" : "keep"} running and ${one ? "is" : "are"} not waited for${names.length ? ` (${names.join(", ")})` : ""}.` : "";
  const goAhead = m.goAheadAt ? `Goes ahead by ${atTime(m.goAheadAt)} at the latest.` : "";
  return [worker, goAhead].filter(Boolean).join(" ");
}

/**
 * BOS-1877: when a drain started and when it should end, in plain words, from the server's forecast. All fields are
 * absent from an older server, which then gets no timing line. `overdue` says so plainly instead of promising a time.
 */
export function drainTiming(m: { since?: string; phase?: "waiting" | "swapping"; expectedFinishAt?: string | null; overdue?: boolean; runs: number; chatOpen?: boolean; chatBackBy?: string | null }): string {
  if (!m.phase) return "";
  if (m.phase === "swapping") {
    // BOS-2531: phase "swapping" only means nothing counted is left. A runner is being recreated when chatOpen is false.
    if (m.chatOpen === true) return "The runners are swapped next.";
    return m.chatBackBy ? `Back by ${atTime(m.chatBackBy)} at the latest.` : "";
  }
  const started = m.since ? `Started ${atTime(m.since)}. ` : "";
  if (m.overdue) return `${started}This is taking longer than expected.`;
  if (m.expectedFinishAt) return `${started}Expected to finish about ${atTime(m.expectedFinishAt)}.`;
  return `${started}${m.runs > 0 ? "No time estimate: it goes ahead when those agents end." : ""}`.trim();
}

/** `gotMessage` and `step` (BOS-1016) are absent from an older server. */
export type WrapUpRun = { runId: string; agent: string | null; ticket: string | null; ticketTitle: string | null; runningForMinutes: number; sinceWrapUpMinutes: number; waitingOn: { question: string; tier: string | null } | null; gotMessage?: boolean; step?: { title: string; sinceMinutes: number } | null };
/** The owner's wrap-up ask is on: its own hold, or asked while an update waits (BOS-988), which keeps the update's kind. */
export type WrapUpStatus = MaintenanceView & { on: true; wrapAsked?: boolean; minutes?: number; notRespondingAfter: number; runsList: WrapUpRun[] };

/* ---------- The status box (BOS-1238, design: BOS-1214) ---------- */

export type SelfDeployView = {
  enabled: boolean;
  pending: boolean;
  status: { result: string; message: string; target: string; to_commit: string; ended: string; started: string } | null;
  available: { tip: string; deployed: string; checkedAt: string; commits?: { sha: string; subject?: string }[]; runnerChanged?: boolean; bluegreen?: boolean } | null;
  /** BOS-1472: the host's staging lane: whether it is on, whether a request waits, and the last result with each smoke check. Absent from an older server. */
  staging?: { configured: boolean; pending: boolean; last: { result: string; message: string; commit: string; runnerImage: string | null; smoke: string | null; checks: { name: string; result: string; why: string }[]; at: string } | null };
  /** When the host deployer last showed it is alive, and whether that is overdue (BOS-753). Absent from an older server. */
  deployer?: { reportedAt: string | null; late: boolean };
  lateAfterMinutes?: number;
  /** The runner trial, with the real time it ends (BOS-953). Null/absent when no trial is running. */
  trial?: { endsAt: string; seconds: number } | null;
  /** BOS-1469: a request waiting for the host or running; it comes first, and the last result moves below it as the previous attempt. */
  active?: { phase: "waiting" | "running"; what: string; since: string } | null;
  /** BOS-1469: the last real run when a refusal came after it (a refusal never replaces it). */
  previousRun?: { result: string; message: string; target: string; to_commit: string; ended: string; started: string } | null;
  /** BOS-1469: the runner image's version next to the one the live server needs. */
  runnerImage?: { running: string | null; needed: string | null };
  /** BOS-1648: the server's one answer to "is a runner update needed?", with its words; null when there is no runner. */
  runnerUpdate?: { state: "needed" | "not_needed" | "unknown"; words: string; tickets: string[] } | null;
  /** A rate-limit refusal counted from its own time (BOS-953): the panel counts down to `until`, then says you can deploy now. */
  deployWait?: { until: string; target?: string } | null;
  /** BOS-1086: the owner's queued runner update and what it waits for (null when none is queued). */
  runnerQueue?: { pressedAt: string; startsAt: string | null; why: string } | null;
  /** A server deploy approved while a runner update was queued or under way: it goes by itself once the runner update is with the host. */
  heldDeploy?: { id: string; commit: string; since: string } | null;
  /** Why a queued runner update was cancelled (a rolled-back server update), until the next press. */
  queueCancelled?: { at: string; why: string } | null;
  /** BOS-2554 (DR-076 A): a failed update that is held while its failure is looked into, with the words to show. Absent from an older server. */
  failureHolds?: { subject: "server_deploy" | "runner_update"; commit: string; since: string; releaseBy: string; outcome: string | null; words: string }[];
};

/** A server update waiting for a quiet machine (BOS-420). */
export type DeployWaitView =
  | { on: false }
  | { on: true; phase: "waiting" | "sent" | "window" | "handover"; origin: "approve" | "hand"; commit: string; deadline: string; windowUntil?: string; quiet?: { ready: boolean; runs: number; checks: number; freeMb: number | null; needMb: number | null; why: string[] } };

/** One row of Recent updates, from GET /api/self-deploy/history (BOS-1238). */
export type HistoryRow = { id: string; target: "server" | "runner"; commit: string; changes: number; /** BOS-2549: how many of them the card names (the rest are only counted). */ shown?: number; /** BOS-2549: the short commit of the update that replaced this one. */ replacedBy?: string | null; result: string | null; message: string | null; at: string };

const gbOf = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

/** The plain-words line for a waiting update: what it waits for, and what is held back meanwhile (BOS-420). */
export function waitLine(w: Extract<DeployWaitView, { on: true }>): string {
  const q = w.quiet;
  const mem = q?.freeMb != null && q.needMb != null ? ` ${gbOf(q.freeMb)} free of the ${gbOf(q.needMb)} it needs.` : "";
  const held = " Meanwhile new merge checks wait and fewer runs start.";
  if (w.phase === "waiting")
    return w.origin === "hand"
      ? q?.ready
        ? `Ready: the machine is quiet. Apply the update to ${w.commit.slice(0, 8)} by hand now.${mem}${held}`
        : `Making room before you apply the update to ${w.commit.slice(0, 8)} by hand: ${q?.why.join("; ") || "checking"}.${mem}${held}`
      : `The update to ${w.commit.slice(0, 8)} is waiting for a quiet machine: ${q?.why.join("; ") || "checking"}.${mem} You'll be asked at ${when(w.deadline)} if it is still waiting.${held}`;
  if (w.phase === "sent") return `The update to ${w.commit.slice(0, 8)} has gone to the machine.${held}`;
  if (w.phase === "window") return `The update is live; its standby window runs until ${when(w.windowUntil ?? w.deadline)}.${held}`;
  return `The update is live; waiting for the runner update to start.${held}`;
}

/** The label of the button that takes back a waiting update (BOS-420). */
export const waitCancelLabel = (w: Extract<DeployWaitView, { on: true }>) =>
  w.phase === "waiting" && w.origin === "hand" ? "Stop making room" : w.phase === "waiting" || w.phase === "sent" ? "Cancel the update" : "Lift the hold now";

/**
 * BOS-2056: what the owner's wrap-up is for, in plain words. A wrap-up that joined a runner update's hold ("update" kind with
 * wrapSince) is for the runner update; a wrap-up hold names the server update it was pressed for, or says no update was waiting.
 */
export function wrapUpFor(m: { kind?: string; wrapSince?: string; since?: string; wrapForUpdate?: "server" | "runner" | "none" }): { forUpdate: "server" | "runner" | "none"; at: string | null } {
  const forUpdate = m.wrapForUpdate ?? (m.kind === "wrapup" ? "none" : "runner");
  return { forUpdate, at: m.wrapSince ?? m.since ?? null };
}

/** The top banner for a standalone wrap-up hold: names the update it is for, or says none was waiting (BOS-2056). */
export function wrapUpBannerText(m: { runs: number; wrapSince?: string; since?: string; wrapForUpdate?: "server" | "runner" | "none" }): string {
  const { forUpdate, at } = wrapUpFor({ ...m, kind: "wrapup" });
  const runs = m.runs > 0 ? ` Waiting for ${plural(m.runs, "run", "runs")} to finish.` : "";
  if (forUpdate === "server") return `Wrapping up for the server update${at ? ` (asked at ${atTime(at)})` : ""}. Nothing new starts until it goes in; this lifts by itself then.${runs}`;
  if (forUpdate === "runner") return `Wrapping up for the runner update${at ? ` (asked at ${atTime(at)})` : ""}. Nothing new starts until it goes in; this lifts by itself when it does, fails or is cancelled.${runs}`;
  return `You asked agents to wrap up${at ? ` at ${atTime(at)}` : ""} (no update was waiting). It lifts by itself after an hour, or sooner if you cancel it on Settings → Server and runner.${runs}`;
}

/** What a "Waiting" row in Recent updates waits on, in plain words (BOS-2056). Null when the row is not waiting. */
export function historyWaitingOn(r: HistoryRow, wait: DeployWaitView | null, maint: MaintenanceView | null, queued: boolean): string | null {
  if (historyTag(r).tag !== "Waiting") return null;
  const w = wait && wait.on ? wait : null;
  if (r.target === "runner") {
    if (queued) return "waiting for the update in front of it to finish";
    if (maint && maint.on && maint.kind !== "wrapup") return `the runner swap: ${waitingFor(maint as Parameters<typeof waitingFor>[0])}`;
    return "waiting for the host to start the runner swap";
  }
  if (!w) return "waiting for your approval (nothing has been sent to the host yet)";
  if (w.phase === "waiting") return `waiting for a quiet machine${w.quiet?.why.length ? `: ${w.quiet.why.join("; ")}` : ""} (you have approved it)`;
  if (w.phase === "sent") return "waiting for the host to build and switch to the new server";
  if (w.phase === "window") return "waiting for the new server's standby window to end";
  return "waiting for the runner update to start";
}

/** "15:33", in the reader's own clock, from an ISO instant (BOS-953). */
export function atTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
/** "in about 6 minutes", or "now", from now to an instant (BOS-953). */
export function inAbout(iso: string, now: number): string {
  const mins = Math.ceil((Date.parse(iso) - now) / 60_000);
  return mins <= 0 ? "now" : mins === 1 ? "in about 1 minute" : `in about ${mins} minutes`;
}
/** "a minute ago", "12 minutes ago", "3 hours ago", from an instant to now. */
export function ago(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 2) return "a minute ago";
  if (mins < 120) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

/** The host's failure messages in plain words (BOS-1214). The raw text always stays under "What the host said". */
export const PLAIN_REASONS: { match: RegExp; reason: string }[] = [
  { match: /smoke test .*failed/i, reason: "the new version failed its first check (the setup page didn't answer)" },
  { match: /did not come up as a standby/i, reason: "the new version didn't start in time" },
  { match: /migration (?:failed|stopped)|The migration failed/i, reason: "the database update failed and was undone; your data is unchanged" },
  { match: /^Rejected: the request file/i, reason: "the request was damaged and refused; nothing changed" },
  { match: /^Rolled back to /i, reason: "a check failed during the trial, so Boss Man switched back" },
];
export const DEFAULT_REASON = "the update stopped with an error";
export function plainReason(raw: string | null | undefined): string {
  const text = raw ?? "";
  return PLAIN_REASONS.find((r) => r.match.test(text))?.reason ?? DEFAULT_REASON;
}
/** Rejected only because a newer update replaced it (8 Nov): history, never a failure. */
export const isReplaced = (msg: string | null | undefined) => /is not on main any more/i.test(msg ?? "");

export type StatusTone = "red" | "amber" | "blue" | "green" | "grey";
export type StatusButton = { id: "ask-wrapup" | "try-again" | "review-deploy" | "check-now" | "stop-stragglers" | "update-now"; label: string; blue: boolean; disabled?: boolean; hint?: string; runIds?: string[] };
export type UpdateStatus = {
  tone: StatusTone;
  /** One word. */
  tag: string;
  /** The bold sentence: where things stand now. */
  say: string;
  /** The grey line: what happens next. */
  more: string;
  /** A line naming what needs the owner, when something does. */
  next: string | null;
  /** The one main button, or null. */
  primary: StatusButton | null;
  /** Normal (not blue) buttons that belong to this state. */
  normal: { id: "cancel-wait" | "cancel-queue" | "cancel-update"; label: string }[];
  /** The trial's progress, for the bar. */
  progress?: { doneMin: number; totalMin: number };
  /** The host's own words for a failure. */
  raw?: string;
  /** Alert, not status, for a failure. */
  alert?: boolean;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const shortName = (name: string | null) => (name ? name.split(/\s+[-–]\s+/)[0]! : "An agent");

/** The merges behind "N changes": merge commits only, as the changes list counts them. */
const changeCount = (commits: { subject?: string }[] | undefined) => (commits ?? []).filter((c) => /^Merge "(.*)" \(([^)]*)\)$/.test(c.subject ?? "")).length;

/** "Today's 15:24 update", or "The 12 Nov 15:24 update", from the host's end time. */
function stamp(iso: string, now: number, what: string): string {
  const d = new Date(iso);
  const n = new Date(now);
  const same = d.toDateString() === n.toDateString();
  return same ? `Today's ${atTime(iso)} ${what}` : `The ${when(iso)} ${what}`;
}

/** The agents still running, as "Parsley (BOS-1238) and Dougal (BOS-5)". */
export function runsSentence(runs: WrapUpRun[]): string {
  const names = runs.map((r) => `${shortName(r.agent)}${r.ticket ? ` (${r.ticket})` : ""}`);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export type StatusExtras = { runnersAt?: string | null };

/**
 * Where the update stands, in one word, one sentence and at most one main button (BOS-1238). Pure: the rows are
 * checked in the design table's order and the first match wins. `view` is null while loading.
 */
export function updateStatus(view: SelfDeployView | null, maint: MaintenanceView | null, wait: DeployWaitView | null, now: number, extras: StatusExtras = {}): UpdateStatus {
  if (!view) return { tone: "grey", tag: "Checking…", say: "Checking…", more: "", next: null, primary: null, normal: [] };
  const s = view.status;
  const offered = !!(view.available && view.available.tip && view.available.tip !== view.available.deployed && !(s?.result === "deployed" && s.to_commit === view.available.tip));
  // Each kind of deploy has its own 10-minute limit: a refused runner press must not grey the server buttons (BOS-1469).
  const waitOn = !!view.deployWait && Date.parse(view.deployWait.until) > now;
  const rateLimited = waitOn && view.deployWait?.target !== "runner";
  const runnerAgain = waitOn && view.deployWait?.target === "runner" ? `Runner update: press Build and update runners again from ${atTime(view.deployWait!.until)}. ` : "";
  const w = wait && wait.on ? wait : null;
  const wrap = maint && maint.on && ((maint as WrapUpStatus).wrapAsked || maint.kind === "wrapup") ? (maint as WrapUpStatus) : null;
  const queueNormal = view.runnerQueue ? [{ id: "cancel-queue" as const, label: "Cancel queued runner update" }] : [];

  // 1. Update failed: the last report was a failure and nothing newer has deployed.
  const failed = !!s && (s.result === "failed" || s.result === "rolled_back" || s.result === "rejected");
  const ignorable = !!s && s.result === "rejected" && (isReplaced(s.message) || s.target === "runner" || rateLimited);
  // BOS-2556: a newer update already waiting on the server (approved, sent, or in its window) or queued for the host
  // takes the banner; the older failure stays as its row in Recent updates and "Try again" is not offered twice.
  const newerPending = !!w || view.pending;
  if (s && failed && !ignorable && !view.active && !newerPending) {
    const what = s.target === "runner" ? "runner update" : s.target === "restart" ? "restart" : "update";
    const earlier = s.target === "runner" ? "the earlier runner image" : "the earlier version";
    const more = [`Why: ${plainReason(s.message)}.`, view.queueCancelled?.why].filter(Boolean).join(" ");
    return {
      tone: "red",
      tag: "Update failed",
      say: `${stamp(s.ended || s.started, now, what)} didn't go in. Boss Man is still on ${earlier}, so nothing is broken.`,
      more,
      next: offered ? "Try again once. If it fails again, tell the CEO in chat; the reason above is what they need." : "Nothing to retry: the next change will be offered when it merges.",
      primary: offered ? { id: "try-again", label: "Try again", blue: true, disabled: rateLimited } : null,
      normal: queueNormal,
      raw: s.message,
      alert: true,
    };
  }

  // 1b. BOS-1955: the new image is being built; new work is held from now so the swap does not wait for it later.
  if (maint && maint.on && maint.kind === "building")
    return { tone: "blue", tag: "Building", say: "The new runner image is being built and checked. New runs wait until the update has gone in.", more: "Runs already going carry on. If the build fails, new runs start again by themselves.", next: null, primary: null, normal: [{ id: "cancel-update", label: "Cancel the runner update" }] };

  // 2. Waiting for agents (and a plain wrap-up, which holds new work the same way).
  if (maint && maint.on && maint.kind !== "wrapup") {
    // BOS-1600: no agent is left but a check on a runner is. Say so, and give the plain choice: wait, or stop the checks.
    if (maint.runs <= 0 && (maint.checks ?? 0) > 0) {
      const what = maint.kind === "settings" ? "setting change" : "runner update";
      const k = maint.checks ?? 0;
      return {
        tone: "amber",
        tag: "Waiting for checks",
        say: `The ${what} is ${waitingFor(maint)}.`,
        more: `Nothing new starts until ${k === 1 ? "it is" : "they are"} done. Waiting is safe: ${k === 1 ? "it carries" : "they carry"} on and the swap follows by itself. ${maint.workerChecksList?.length ? "" : "Checks on a separate check worker are not waited for. "}${updateWaitExtras(maint)}`.trim(),
        next: `Or stop ${k === 1 ? "it" : "them"} now: ${k === 1 ? "it starts" : "they start"} again from the beginning after the swap, so the time already spent is lost.`,
        primary: { id: "update-now", label: `Stop the ${k === 1 ? "check" : "checks"} and update now`, blue: false },
        normal: [{ id: "cancel-update", label: `Cancel the ${what}` }],
      };
    }
    if (maint.runs <= 0)
      return { tone: "blue", tag: "Updating", say: "The runner update is going in now. Pages keep working.", more: "Each runner is swapped as its company goes idle.", next: null, primary: null, normal: [] };
    const what = maint.kind === "settings" ? "setting change" : "runner update";
    const n = maint.runs;
    const asked = wrap?.wrapAsked ? wrap : null;
    const base = { tone: "amber" as const, tag: "Waiting for agents", say: `The ${what} is waiting for ${plural(n, "agent", "agents")} to finish.` };
    if (!asked)
      return { ...base, more: "Nothing new starts until they stop. Asking them to wrap up is usually quicker.", next: null, primary: { id: "ask-wrapup", label: "Ask agents to wrap up", blue: true }, normal: [{ id: "cancel-update", label: `Cancel the ${what}` }] };
    const list = asked.runsList;
    const oldest = Math.max(0, ...list.map((r) => r.sinceWrapUpMinutes));
    const late = list.filter((r) => !r.waitingOn && r.sinceWrapUpMinutes >= asked.notRespondingAfter);
    const pastDeadline = Date.parse(asked.deadline) <= now;
    const stuck = late.length ? `${late.length} ${late.length === 1 ? "isn't" : "aren't"} responding. You can stop ${late.length === 1 ? "it" : "them"} below; anything ${late.length === 1 ? "it hasn't" : "they haven't"} saved is lost.` : null;
    if (pastDeadline && list.length > 0)
      return {
        ...base,
        more: `They were asked to wrap up ${oldest} minutes ago and the wait is over.`,
        next: `Still running: ${runsSentence(list)}. Stopping ends them where they got to, and anything they haven't saved is lost. They aren't woken again afterwards: their tickets wait where they stopped.${stuck ? ` ${stuck}` : ""}`,
        primary: { id: "stop-stragglers", label: `Stop ${list.length} and carry on with the update`, blue: true, runIds: list.map((r) => r.runId) },
        normal: [{ id: "cancel-update", label: `Cancel the ${what}` }],
      };
    return {
      ...base,
      more: `They were asked to wrap up ${oldest} minutes ago. If any are still going at ${atTime(asked.deadline)}, Boss Man asks you what to do.`,
      next: stuck,
      primary: null,
      normal: [{ id: "cancel-update", label: `Cancel the ${what}` }],
    };
  }
  if (wrap && maint && maint.on && maint.kind === "wrapup") {
    const n = wrap.runsList.length;
    const { forUpdate, at } = wrapUpFor(wrap);
    const forServer = forUpdate !== "none";
    const who = forUpdate === "server" ? "Wrapping up for the server update. " : forUpdate === "runner" ? "Wrapping up for the runner update. " : "";
    return {
      tone: "amber",
      tag: "Wrapping up",
      say: `${who}${n === 0 ? "Every agent has finished." : `${plural(n, "agent is", "agents are")} still finishing the step ${n === 1 ? "it is" : "they are"} on.`}`,
      more: forServer
        ? "Nothing new starts until that update goes in or is cancelled. The wrap-up then lifts by itself and work restarts; you do not need to press anything."
        : `You asked agents to wrap up${at ? ` at ${atTime(at)}` : ""} and no update was waiting. It lifts by itself after an hour, or press Cancel wrap-up to restart work now.`,
      next: null,
      primary: null,
      normal: [],
    };
  }

  // 3. Approved, waiting for a quiet machine (BOS-420). A later phase is the update going in.
  if (w && w.phase === "waiting")
    return { tone: "amber", tag: "Approved, waiting", say: w.origin === "hand" ? "The machine is being made ready for your hand-applied update." : "Your update is approved and waiting for a quiet machine.", more: waitLine(w), next: null, primary: null, normal: [{ id: "cancel-wait", label: waitCancelLabel(w) }] };

  // 4. Updating.
  if (view.active || view.pending || s?.result === "running" || (w && w.phase === "sent")) {
    // BOS-1469: the waiting/running request comes first; the last real result sits below it as the previous attempt.
    const a = view.active;
    const prev = view.previousRun ?? s;
    const prevLine = a && prev && prev.result !== "running" ? `Previous attempt: ${prev.result.replace(/_/g, " ")}, ${prev.target} ${prev.to_commit.slice(0, 8)}, ${when(prev.ended || prev.started)}. ${prev.message}` : "";
    const say = a
      ? `${a.what}, pressed ${when(a.since)}: ${a.phase === "waiting" ? "waiting for the host, it checks every minute." : `running since ${when(a.since)}.`}`
      : "The update is going in now. Pages keep working.";
    return { tone: "blue", tag: "Updating", say, more: [a ? "" : "This takes about 5 minutes.", prevLine].filter(Boolean).join(" "), next: !a && view.pending ? "A request is waiting for the host (it checks every minute)." : null, primary: null, normal: w && w.phase === "sent" ? [{ id: "cancel-wait", label: waitCancelLabel(w) }] : [] };
  }

  // 5. In trial.
  const trialOn = !!view.trial && Date.parse(view.trial.endsAt) > now;
  if (view.trial && trialOn) {
    const totalMin = Math.max(1, Math.round(view.trial.seconds / 60));
    const left = Math.max(0, Math.ceil((Date.parse(view.trial.endsAt) - now) / 60_000));
    return {
      tone: "blue",
      tag: "In trial",
      say: `The new version is live and on trial until ${atTime(view.trial.endsAt)}, ${inAbout(view.trial.endsAt, now)}.`,
      more: "Boss Man watches it and switches back by itself if a check fails. You don't need to do anything.",
      next: w ? waitLine(w) : null,
      primary: null,
      normal: queueNormal,
      progress: { doneMin: Math.min(totalMin, Math.max(0, totalMin - left)), totalMin },
    };
  }
  if (w)
    return { tone: "blue", tag: "In trial", say: "The new version is live and its standby window is running.", more: waitLine(w), next: null, primary: null, normal: [{ id: "cancel-wait", label: waitCancelLabel(w) }, ...queueNormal] };

  // 6. Update ready.
  if (offered) {
    const n = changeCount(view.available?.commits);
    const when_ = rateLimited && view.deployWait ? `You can deploy again from ${atTime(view.deployWait.until)}.` : "";
    return {
      tone: "blue",
      tag: "Update ready",
      say: n > 0 ? `A server update with ${plural(n, "change", "changes")} is ready.` : "A server update is ready.",
      more: `Pages keep working while it goes in, about 5 minutes. A 15-minute trial follows; if a check fails, Boss Man switches back by itself.${view.available?.runnerChanged ? " This one also needs a runner update: after it goes in, press Build and update runners under Other actions." : ""}`,
      next: when_ || null,
      primary: { id: "review-deploy", label: "Review and deploy", blue: true, disabled: rateLimited, hint: when_ || undefined },
      normal: queueNormal,
    };
  }

  // 7. Host not reporting.
  const d = view.deployer;
  if (!view.available && (!d || !d.reportedAt || d.late))
    return { tone: "amber", tag: "Host not reporting", say: "Boss Man can't see the update helper on your server.", more: deployerLine(view), next: null, primary: null, normal: queueNormal };
  if (!view.available)
    return { tone: "grey", tag: "Checking", say: "Boss Man is checking what is waiting.", more: deployerLine(view), next: null, primary: null, normal: queueNormal };

  // 8. Up to date.
  const server = s && s.target === "server" && s.result === "deployed" ? `Server updated ${when(s.ended || s.started)}. ` : "";
  const runners = extras.runnersAt ? `Runners updated ${when(extras.runnersAt)}. ` : "";
  // BOS-1648: the runner line is the server's one answer, word for word: needed, not needed, or can't tell (a fault,
  // with its reason). Never "may be needed".
  const ru = view.runnerUpdate;
  const image = ru ? `${ru.words}${ru.state === "needed" ? " Press Build and update runners under Other actions." : ""} ` : "";
  return {
    tone: ru && ru.state !== "not_needed" ? "amber" : "green",
    tag: ru?.state === "needed" ? "Runner update needed" : ru?.state === "unknown" ? "Can't tell" : "Up to date",
    say: ru?.state === "needed" ? "The server is up to date; the runners need an update." : ru?.state === "unknown" ? "The server is up to date; Boss Man can't tell whether the runners need an update." : "Boss Man is up to date.",
    more: `${server}${runners}${image}${runnerAgain}Last checked for changes ${ago(view.available.checkedAt, now)}.`,
    next: null,
    primary: { id: "check-now", label: "Check for updates now", blue: false },
    normal: queueNormal,
  };
}

/** The line under the sentence when the host has no offer to show (BOS-753): "not reported" only when it really is overdue. */
export function deployerLine(v: SelfDeployView): string {
  const d = v.deployer;
  if (!d) return "The host deployer has not reported yet.";
  if (!d.reportedAt) return "The host deployer has not reported yet. Check that its cron job is running.";
  if (d.late) return `The host deployer last reported ${when(d.reportedAt)}, more than ${v.lateAfterMinutes ?? 10} minutes ago; it should report every minute. Check that its cron job is running.`;
  return `The host deployer last reported ${when(d.reportedAt)}. It is reading main again and shows what is waiting within a few minutes.`;
}

/** How far the runner swap has got (BOS-1558): the newest image any runner reports is the new one; the rest are still waiting. */
export type RunnerProgress = { inProgress: boolean; done: number; total: number; newest: string | null };
export function runnerProgress(live: LiveRow[] | null | undefined, maint: MaintenanceView | null | undefined, needed?: string | null): RunnerProgress {
  const runners = (live ?? []).filter((l) => l.registered);
  const stamps = runners.map((l) => l.imageVersion).filter((v): v is string => !!v);
  // BOS-2546: "done" is measured against the image the update is for (`runnerImage.needed`); only without one does the fleet's newest stand in.
  const newest = needed || (stamps.length ? stamps.reduce((a, b) => (b > a ? b : a)) : null);
  // Same test as LiveState's "Connected" (a leftover swap mark must not hide a runner that is already up on the new image, BOS-2525).
  // Image stamps are fixed-width (YYYYMMDDHHMM), so the string comparison orders them correctly.
  const done = runners.filter((l) => l.connected && !!l.imageVersion && !!newest && l.imageVersion >= newest).length;
  // A runner update's hold (not a setting change or a wrap-up) is on, so the swap is not finished whatever the images say.
  const held = !!maint && maint.on && maint.kind !== "settings" && maint.kind !== "wrapup" && maint.kind !== "building";
  return { inProgress: held, done, total: runners.length, newest };
}

/** Recent updates: the tag for one history row. A rejected-as-stale update is REPLACED (grey), not a failure. `swap`: only for the newest runner row. */
export function historyTag(r: HistoryRow, swap?: RunnerProgress | null): { tag: string; tone: StatusTone } {
  if (r.result === "deployed" && r.target === "runner" && swap?.inProgress) return { tag: swap.total > 0 ? `Swapping (${swap.done} of ${plural(swap.total, "company", "companies")} done)` : "Swapping", tone: "amber" };
  if (r.result === "deployed") return { tag: r.target === "runner" ? "Done" : "Live", tone: "green" };
  if (r.result === "replaced") return { tag: "Replaced", tone: "grey" };
  if (r.result === "cancelled") return { tag: "Cancelled", tone: "grey" };
  if (r.result === "not_sent") return { tag: "Not sent", tone: "amber" };
  if (r.result === "unknown") return { tag: "Unknown", tone: "grey" };
  if (r.result === "rolled_back") return { tag: "Switched back", tone: "red" };
  if (r.result === "failed") return { tag: "Failed", tone: "red" };
  if (r.result === "rejected") return isReplaced(r.message) ? { tag: "Replaced", tone: "grey" } : { tag: "Failed", tone: "red" };
  if (r.result === "nothing_new") return { tag: "Done", tone: "grey" };
  return { tag: "Waiting", tone: "amber" };
}
export const historyWhat = (r: HistoryRow) => (r.target === "runner" ? "Runners, all companies" : r.result === "cancelled" ? "Server: cancelled, nothing was sent" : r.result === "not_sent" ? "Server: not sent, the machine was short of memory" : r.result === "unknown" ? "Server: no record of how this ended" : r.result === "rejected" && isReplaced(r.message) ? "Server: not sent, a newer update replaced it" : r.result === "replaced" ? `Server${r.changes ? `, ${plural(r.changes, "change", "changes")}` : ""}: replaced by a newer update${r.replacedBy ? ` (${r.replacedBy})` : ""}` : r.changes ? `Server, ${plural(r.changes, "change", "changes")}${r.shown !== undefined && r.shown < r.changes ? ` (showing ${r.shown} of ${r.changes})` : ""}` : "Server");

/** The live state of one company's runner, leading the panel: connected or not, and since when. */
export function LiveState({ r, progress }: { r: LiveRow; progress?: RunnerProgress | null }) {
  const connected = r.registered && r.connected;
  const old = !!progress?.inProgress && connected && !!r.imageVersion && !!progress.newest && r.imageVersion < progress.newest;
  return (
    <li style={{ listStyle: "none" }}>
      <strong>{r.name}</strong>{" "}
      {old ? (
        <span className="tag amber">Waiting for runs to finish</span>
      ) : connected ? (
        <span className="tag green">Connected</span>
      ) : r.swap ? (
        <span className="tag amber">Updating</span>
      ) : r.swapFailed ? (
        <span className="tag red">Update failed</span>
      ) : r.guard ? (
        <span className="tag red">Paused: network guard</span>
      ) : (
        <span className="tag red">Not connected</span>
      )}{" "}
      <span className="muted">
        {connected ? "since" : r.at ? "last seen" : ""} {r.at ? when(r.at) : ""}
        {old ? ` · waiting for runs to finish, old image ${r.imageVersion}` : connected && r.imageVersion ? ` · image ${r.imageVersion}` : ""}
        {r.fault ? ` · ${r.fault}` : ""}
        {!connected && r.swapFailed ? ` · ${r.swapFailed}` : ""}
        {!connected && !r.swap && !r.swapFailed && r.guard ? ` · ${r.guard.reason}` : ""}
      </span>
    </li>
  );
}
