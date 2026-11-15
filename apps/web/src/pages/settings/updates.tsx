import { when } from "../Runs";

export type UpdateRow = { at: string; title: string; body: string; state: "ok" | "resolved" | "problem"; todo: string | null };
export type LiveRow = { slug: string; name: string; registered: boolean; connected: boolean; at: string | null; imageVersion: string | null; fault: string | null; swap?: { retryAt: string | null; tries: number } | null; swapFailed?: string | null; guard?: { reason: string; since: string | null } | null };
export type Report = { live: LiveRow[]; update: UpdateRow | null };
export type LastUpdate = { at: string; startedAt: string | null; ok: boolean; title: string; body: string } | null;
export type MaintenanceView = ({ on: false } | { on: true; kind?: "update" | "settings" | "wrapup"; deadline: string; runs: number; companies: number; blocking?: boolean }) & { last?: LastUpdate };
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
  /** A rate-limit refusal counted from its own time (BOS-953): the panel counts down to `until`, then says you can deploy now. */
  deployWait?: { until: string } | null;
  /** BOS-1086: the owner's queued runner update and what it waits for (null when none is queued). */
  runnerQueue?: { pressedAt: string; startsAt: string | null; why: string } | null;
  /** A server deploy approved while a runner update was queued or under way: it goes by itself once the runner update is with the host. */
  heldDeploy?: { id: string; commit: string; since: string } | null;
  /** Why a queued runner update was cancelled (a rolled-back server update), until the next press. */
  queueCancelled?: { at: string; why: string } | null;
};

/** A server update waiting for a quiet machine (BOS-420). */
export type DeployWaitView =
  | { on: false }
  | { on: true; phase: "waiting" | "sent" | "window" | "handover"; origin: "approve" | "hand"; commit: string; deadline: string; windowUntil?: string; quiet?: { ready: boolean; runs: number; checks: number; freeMb: number | null; needMb: number | null; why: string[] } };

/** One row of Recent updates, from GET /api/self-deploy/history (BOS-1238). */
export type HistoryRow = { id: string; target: "server" | "runner"; commit: string; changes: number; result: string | null; message: string | null; at: string };

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
export type StatusButton = { id: "ask-wrapup" | "try-again" | "review-deploy" | "check-now" | "stop-stragglers"; label: string; blue: boolean; disabled?: boolean; hint?: string; runIds?: string[] };
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
  const rateLimited = !!view.deployWait && Date.parse(view.deployWait.until) > now;
  const w = wait && wait.on ? wait : null;
  const wrap = maint && maint.on && ((maint as WrapUpStatus).wrapAsked || maint.kind === "wrapup") ? (maint as WrapUpStatus) : null;
  const queueNormal = view.runnerQueue ? [{ id: "cancel-queue" as const, label: "Cancel queued runner update" }] : [];

  // 1. Update failed: the last report was a failure and nothing newer has deployed.
  const failed = !!s && (s.result === "failed" || s.result === "rolled_back" || s.result === "rejected");
  const ignorable = !!s && s.result === "rejected" && (isReplaced(s.message) || s.target === "runner" || rateLimited);
  if (s && failed && !ignorable && !view.active) {
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

  // 2. Waiting for agents (and a plain wrap-up, which holds new work the same way).
  if (maint && maint.on && maint.kind !== "wrapup") {
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
    return {
      tone: "amber",
      tag: "Wrapping up",
      say: n === 0 ? "Every agent has finished. Nothing new starts until you cancel the wrap-up." : `${plural(n, "agent is", "agents are")} still finishing the step ${n === 1 ? "it is" : "they are"} on.`,
      more: "Nothing new starts until you press Cancel wrap-up.",
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
  const ri = view.runnerImage;
  const image = ri?.needed ? `Runner image: ${ri.running ? ri.running.slice(0, 8) : "version not recorded"}; the live server needs ${ri.needed.slice(0, 8)}${ri.running ? (ri.running === ri.needed ? " (match). " : " (a runner update may still be needed). ") : ". "}` : "";
  return {
    tone: "green",
    tag: "Up to date",
    say: "Boss Man is up to date.",
    more: `${server}${runners}${image}Last checked for changes ${ago(view.available.checkedAt, now)}.`,
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

/** Recent updates: the tag for one history row. A rejected-as-stale update is REPLACED (grey), not a failure. */
export function historyTag(r: HistoryRow): { tag: string; tone: StatusTone } {
  if (r.result === "deployed") return { tag: r.target === "runner" ? "Done" : "Live", tone: "green" };
  if (r.result === "rolled_back") return { tag: "Switched back", tone: "red" };
  if (r.result === "failed") return { tag: "Failed", tone: "red" };
  if (r.result === "rejected") return isReplaced(r.message) ? { tag: "Replaced", tone: "grey" } : { tag: "Failed", tone: "red" };
  if (r.result === "nothing_new") return { tag: "Done", tone: "grey" };
  return { tag: "Waiting", tone: "amber" };
}
export const historyWhat = (r: HistoryRow) => (r.target === "runner" ? "Runners, all companies" : r.result === "rejected" && isReplaced(r.message) ? "Server: not sent, a newer update replaced it" : r.changes ? `Server, ${plural(r.changes, "change", "changes")}` : "Server");

/** The live state of one company's runner, leading the panel: connected or not, and since when. */
export function LiveState({ r }: { r: LiveRow }) {
  const connected = r.registered && r.connected;
  return (
    <li style={{ listStyle: "none" }}>
      <strong>{r.name}</strong>{" "}
      {connected ? (
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
        {connected && r.imageVersion ? ` · image ${r.imageVersion}` : ""}
        {r.fault ? ` · ${r.fault}` : ""}
        {!connected && r.swapFailed ? ` · ${r.swapFailed}` : ""}
        {!connected && !r.swap && !r.swapFailed && r.guard ? ` · ${r.guard.reason}` : ""}
      </span>
    </li>
  );
}
