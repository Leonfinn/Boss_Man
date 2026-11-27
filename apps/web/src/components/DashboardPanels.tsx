// The Dashboard's two lead panels (BOS-1507, design BOS-1490): "Needs you" (what is waiting for the owner,
// with a button to each item) and "Right now" (four fixed health lines). Every state has a symbol and words,
// never colour alone, and a line that couldn't be read says "not known" instead of turning green.
import { useState } from "react";
import type { Decision, DecisionTally } from "../api";
import { raisedAgo } from "../age";
import type { MergeHealthView, SlowSummary, StuckSummary } from "./MergesStuckBanner";
import { heldSummary, heldText, inLineOf, pausedSlotsText, pausedSummary, pausedText, slowText, waitedText } from "./MergesStuckBanner";
// R43 (BOS-1716): each count in these panels is written with its one label from the shared list.
import { figureText } from "@boss-man/shared";
import { inForceHeadline, inForceReason, type LimitInForce } from "../limit-in-force";

export const NEEDS_YOU_MAX = 5;

/** What the server's dashboard read says about the lines it owns; a missing field is an older server. */
export type HealthData = {
  runner?: { registered: boolean; connected: boolean; lastSeenAt: string | null } | null;
  usage?: { agents: number; accounts: string[]; firstResetAt: string | null } | null;
  update?: { waiting: boolean; phase: string | null; deadline: string | null } | null;
  /** BOS-1634: agents at once across all companies, as saved and in force; absent from an older server. */
  runLimit?: LimitInForce | null;
};

export type LineTone = "ok" | "warn" | "bad" | "unknown";
export type HealthLine = {
  key: "runner" | "merges" | "usage" | "update";
  tone: LineTone;
  /** ✓ ‖ ↑ ! ✕ ?: the symbol is always shown beside the words. */
  symbol: string;
  /** The state in words: "Runner offline". */
  state: string;
  /** The short phone-pill words. */
  pill: string;
  /** The one plain sentence under it. */
  text: string;
  href: string;
  linkText: string;
  /** BOS-2538: how often this line is read in words, e.g. "Updates every 20 s."; healthLines fills it in from
   *  LINE_REFRESH, and RightNow falls back to the same list when a caller builds its own lines. */
  refresh?: string;
};

/** BOS-2538: the freshness note under one line, naming its own interval. Runner, Usage limits and Update come from
 *  the dashboard poll (10 s); Merges from the merge-queue poll (20 s, shared with the merges banner). Keep this in
 *  step with Dashboard.tsx's two usePoll calls. */
export const LINE_REFRESH: Record<HealthLine["key"], string> = { runner: "10 s", merges: "20 s", usage: "10 s", update: "10 s" };
export function refreshNote(key: HealthLine["key"]): string {
  return `Updates every ${LINE_REFRESH[key]}.`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const hoursText = (ms: number) => waitedText(Math.max(0, Math.round(ms / 60_000)));

/** The four lines, always in this order: Runner, Merges, Usage limits, Update. */
export function healthLines(input: { health: HealthData | null | undefined; merges: MergeHealthView | null | undefined; stuck: StuckSummary | null; slow?: SlowSummary | null; running: number; companyId: string; now?: number; /** BOS-2814: a must-have is missing, so no agent can start. */ cantStart?: boolean }): HealthLine[] {
  const { health, merges, stuck, slow, running, companyId, cantStart } = input;
  const now = input.now ?? Date.now();
  const system = `#/settings/${companyId}/updates`;
  const runnerHref = `#/settings/${companyId}/runner`;

  let runner: HealthLine;
  const r = health?.runner;
  if (r == null) runner = { key: "runner", tone: "unknown", symbol: "?", state: "Runner: not known", pill: "Runner not known", text: "Couldn't check. Trying again in 10 s.", href: runnerHref, linkText: "Runner settings" };
  else if (!r.registered) runner = { key: "runner", tone: "warn", symbol: "‖", state: "No runner set up", pill: "No runner set up", text: "Nothing can run until a runner connects.", href: runnerHref, linkText: "Runner settings" };
  else if (!r.connected) {
    const since = r.lastSeenAt ? `Since ${clock(r.lastSeenAt)} (${hoursText(now - new Date(r.lastSeenAt).getTime())}). ` : "";
    runner = { key: "runner", tone: "bad", symbol: "✕", state: "Runner offline", pill: "Runner offline", text: `${since}Runs and checks can't start.`, href: runnerHref, linkText: "Runner settings" };
  } else runner = { key: "runner", tone: "ok", symbol: "✓", state: "Runner connected", pill: "Runner connected", text: `${figureText("runs.running", running)}.`, href: runnerHref, linkText: "Runner settings" };

  let mergesLine: HealthLine;
  if (!merges) mergesLine = { key: "merges", tone: "unknown", symbol: "?", state: "Merges: couldn't check", pill: "Merges not known", text: "The server didn't answer. Trying again in 20 s.", href: `#/merge-queue/${companyId}`, linkText: "Merge queue" };
  else if (stuck) {
    const behind = inLineOf(merges) > 0 ? ` ${figureText("mergeQueue.inLine", inLineOf(merges))}.` : "";
    mergesLine = { key: "merges", tone: "bad", symbol: "!", state: "Merges stuck", pill: "Merges stuck", text: `${stuck.title}.${behind}`, href: `#/merge-queue/${companyId}`, linkText: "Merge queue" };
  } else if (slow) {
    mergesLine = { key: "merges", tone: "warn", symbol: "…", state: "Merging, but slowly", pill: "Merging slowly", text: slowText(slow), href: `#/merge-queue/${companyId}`, linkText: "Merge queue" };
  } else if (pausedSummary(merges)) {
    const p = pausedSummary(merges)!;
    mergesLine = { key: "merges", tone: "warn", symbol: "‖", state: "Merges paused", pill: "Merges paused", text: `${pausedText(p)} ${pausedSlotsText(p)}.`, href: `#/merge-queue/${companyId}`, linkText: "Merge queue" };
  } else if (heldSummary(merges)) {
    // R28: calm amber, never the red "stuck" line: merges wait on the main fix on purpose.
    const h = heldSummary(merges)!;
    mergesLine = { key: "merges", tone: "warn", symbol: "‖", state: "Merges held behind the main fix", pill: "Merges held", text: heldText(h), href: `#/merge-queue/${companyId}`, linkText: "Merge queue" };
  } else mergesLine = { key: "merges", tone: "ok", symbol: "✓", state: "Merges moving", pill: "Merges moving", text: inLineOf(merges) > 0 ? `${figureText("mergeQueue.inLine", inLineOf(merges))}, none stuck.` : "Nothing in the merge line.", href: `#/merge-queue/${companyId}`, linkText: "Merge queue" };

  let usage: HealthLine;
  const u = health?.usage;
  if (u == null) usage = { key: "usage", tone: "unknown", symbol: "?", state: "Usage limits: not known", pill: "Limits not known", text: "This server is older than the check. It shows after the next update.", href: "#/agents", linkText: "Agents" };
  else if (u.agents > 0) {
    const who = u.accounts.length === 1 ? `${u.accounts[0]} account` : u.accounts.length > 1 ? `${u.accounts.length} accounts` : "An account";
    const reset = u.firstResetAt ? (u.accounts.length > 1 ? `, first resets at ${clock(u.firstResetAt)}` : ` resets at ${clock(u.firstResetAt)}`) : " has no reset time yet";
    usage = { key: "usage", tone: "warn", symbol: "‖", state: figureText("usage.held", u.agents), pill: u.firstResetAt ? `${u.agents} held till ${clock(u.firstResetAt)}` : `${u.agents} held`, text: `${who}${reset}.`, href: "#/agents", linkText: "Agents" };
  } else if (cantStart) usage = { key: "usage", tone: "warn", symbol: "‖", state: "No usage limit holds, but no agent can start yet", pill: "Can't start yet", text: "Agents can't start until setup is finished.", href: "#/setup", linkText: "Finish setting up" };
  else usage = { key: "usage", tone: "ok", symbol: "✓", state: "No agent held by a usage limit", pill: "No limit holds", text: "Every agent can start when it has work.", href: "#/agents", linkText: "Agents" };

  let update: HealthLine;
  const up = health?.update;
  if (up == null) update = { key: "update", tone: "unknown", symbol: "?", state: "Updates: not known", pill: "Updates not known", text: "Couldn't check.", href: system, linkText: "Updates" };
  else if (up.waiting) update = { key: "update", tone: "warn", symbol: "↑", state: "Update waiting", pill: "Update waiting", text: up.deadline ? `Server update waits for a quiet machine; you'll be asked at ${clock(up.deadline)}.` : "Server update waits for a quiet machine.", href: system, linkText: "Updates" };
  else update = { key: "update", tone: "ok", symbol: "✓", state: "No update waiting", pill: "No update waiting", text: "Nothing is waiting to be installed.", href: system, linkText: "Updates" };
  // BOS-1634: while the update's hold keeps fewer agents running than the owner saved, this line says so, with the
  // server's numbers and reason, and links to the waiting update. It also covers the standby window after an update
  // goes live, when the hold is still on.
  const held = inForceHeadline(health?.runLimit);
  if (held && health?.runLimit) update = { key: "update", tone: "warn", symbol: "↑", state: `Agents at once: ${held}`, pill: `Agents ${health.runLimit.inForce} of ${health.runLimit.saved}`, text: `${up?.waiting && up.deadline ? `Server update waits for a quiet machine; you'll be asked at ${clock(up.deadline)}. ` : ""}${inForceReason(health.runLimit)}`, href: `#/settings/${companyId}/updates`, linkText: "the waiting update" };

  // BOS-2538: every line carries its own interval, so the heading names none (the Merges line is read every 20 s).
  return [runner, mergesLine, usage, update].map((l) => ({ ...l, refresh: refreshNote(l.key) }));
}

/** BOS-2538: what each line is called while the first read is still on its way. */
const RIGHT_NOW_NAME: Record<HealthLine["key"], string> = { runner: "Runner", merges: "Merges", usage: "Usage limits", update: "Updates" };

export function RightNow({ lines, paused, companyId, loading, onResume }: { lines: HealthLine[] | null; paused: boolean; companyId: string; loading?: boolean; /** Resumes this company; the notice shows a Resume button when given. */ onResume?: () => Promise<void> }) {
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  return (
    <section className="card dash-panel dash-right" aria-labelledby="dash-right">
      <h2 id="dash-right" className="dash-panel-head">
        Right now
        <small className="muted">{loading ? "Checking…" : <><span className="dash-head-wide">Updates at the times below</span><span className="dash-head-narrow">Each line says how often it updates</span></>}</small>
      </h2>
      {paused && (
        <p className="dash-line tone-warn">
          <span className="dash-sym" aria-hidden="true">‖</span>
          <span><strong>Company paused</strong> Nothing starts until you resume it. <a href={`#/settings/${companyId}/team`}>Settings</a></span>
          {onResume && (
            <button
              type="button"
              className="btn"
              disabled={resuming}
              onClick={() => {
                setResuming(true);
                setResumeError(null);
                onResume()
                  .catch((e: unknown) => setResumeError(e instanceof Error ? e.message : "Could not resume."))
                  .finally(() => setResuming(false));
              }}
            >
              {resuming ? "Resuming…" : "Resume"}
            </button>
          )}
          {resumeError && <span role="alert" className="muted"> {resumeError}</span>}
        </p>
      )}
      <ul className="dash-lines">
        {(lines ?? (["runner", "merges", "usage", "update"] as const).map((key) => ({ key, tone: "unknown" as const, symbol: "…", state: `${RIGHT_NOW_NAME[key]}: checking…`, pill: `${RIGHT_NOW_NAME[key]}…`, text: "", href: "#", linkText: "" }))).map((l) => (
          <li key={l.key} className={`dash-line tone-${l.tone}`}>
            <a className="dash-line-link" href={l.href} aria-label={l.text ? `${l.state}. ${l.text} ${refreshNote(l.key)} Open ${l.linkText}.` : `${l.state} ${refreshNote(l.key)}`}>
              <span className="dash-sym" aria-hidden="true">{l.symbol}</span>
              <span className="dash-line-text">
                <strong className="dash-state">{l.state}</strong>
                <span className="dash-pill" aria-hidden="true">{l.pill}</span>
                {l.text && <span className="dash-sentence">{l.text}</span>}
                <span className="dash-refresh">{("refresh" in l && l.refresh) || refreshNote(l.key)}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The tag and button words for one of the owner's items. */
export function needsKind(d: Pick<Decision, "kind" | "options" | "context">): { tag: string; button: string } {
  if (d.kind === "signoff" || d.context?.type === "risk_review") return { tag: "Sign-off", button: "Sign off" };
  if (d.options.includes("Approve plan")) return { tag: "Review", button: "Review" };
  return { tag: "Card", button: "Answer" };
}

export function needsList(decisions: Decision[]): Decision[] {
  return decisions.filter((d) => !d.waiting).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function spanText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return m === 1 ? "1 minute" : `${m} minutes`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "1 hour" : `${h} hours`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

/** (BOS-2174) "Oldest waiting 3 days · usually answered in 5 hours"; a part the server couldn't work out is left out. */
export function waitLine(tally: DecisionTally | null | undefined, now = Date.now()): string | null {
  const parts: string[] = [];
  if (tally?.oldestOpenAt) parts.push(`Oldest waiting ${spanText(now - new Date(tally.oldestOpenAt).getTime())}`);
  if (tally?.medianAnswerMs != null) parts.push(`usually answered in ${spanText(tally.medianAnswerMs)}`);
  return parts.length ? parts.join(" · ") : null;
}

export function NeedsYou({ decisions, tally, cantStart = false }: { decisions: Decision[] | null; tally: DecisionTally | null | undefined; /** BOS-2814: no agent can start yet, so "Nothing needs you" would mislead. */ cantStart?: boolean }) {
  if (!decisions) {
    return (
      <section className="card dash-panel dash-needs" aria-labelledby="dash-needs" aria-busy="true">
        <h2 id="dash-needs" className="dash-panel-head">Needs you <small className="muted">Checking…</small></h2>
        <ul className="dash-needs-list" aria-hidden="true">
          {[0, 1, 2].map((i) => <li key={i} className="dash-needs-item skeleton"><span /></li>)}
        </ul>
      </section>
    );
  }
  const queue = needsList(decisions);
  const open = tally?.open ?? queue.length;
  const waiting = tally?.waiting ?? decisions.filter((d) => !!d.waiting).length;
  const shown = queue.slice(0, NEEDS_YOU_MAX);
  const more = Math.max(0, open - shown.length);
  const waitingText = waiting > 0 ? `${figureText("decisions.withTeam", waiting)}, nothing to do yet` : null;
  return (
    <section className="card dash-panel dash-needs" aria-labelledby="dash-needs">
      <h2 id="dash-needs" className="dash-panel-head">
        Needs you
        {open > 0 && <span className="dash-count" aria-label={figureText("decisions.needYou", open)}>{open}</span>}
      </h2>
      {open > 0 && waitLine(tally) && <p className="muted dash-needs-wait">{waitLine(tally)}</p>}
      {shown.length === 0 && open === 0 && cantStart ? (
        <p className="dash-calm">
          <span className="dash-sym" aria-hidden="true">‖</span>
          <span>No decisions yet. When an agent needs an answer, an approval or more budget, it appears here.</span>
        </p>
      ) : shown.length === 0 && open === 0 ? (
        <p className="dash-calm">
          <span className="dash-sym" aria-hidden="true">✓</span>
          <span>
            <strong>Nothing needs you.</strong>{" "}
            {waiting > 0 ? `${waiting === 1 ? "1 card is" : `${waiting} cards are`} with the team; you'll be told if one comes to you.` : "You'll be told if something comes to you."}
          </span>
        </p>
      ) : (
        <ul className="dash-needs-list">
          {shown.map((d) => {
            const k = needsKind(d);
            const ref = d.about?.[0]?.ref ?? d.blocks[0]?.ref ?? null;
            const small = [ref, d.agentName ?? d.forAgentName ?? null, d.recommendedOption ? `recommends ${d.recommendedOption}` : null, raisedAgo(d.createdAt, Date.now())].filter(Boolean).join(" · ");
            return (
              <li key={d.id} className="dash-needs-item">
                <span className="tag amber">{k.tag}</span>
                <a className="dash-needs-title" href={`#/decisions/${d.id}`} title={d.question}>{d.question}</a>
                <small className="muted">{small}</small>
                <a className="btn primary dash-needs-btn" href={`#/decisions/${d.id}`} aria-label={`${k.button}: ${d.question}`}>{k.button}</a>
              </li>
            );
          })}
        </ul>
      )}
      <p className="dash-needs-foot">
        {more > 0 && <span>{more} more {more === 1 ? "needs" : "need"} you · </span>}
        {waitingText && open > 0 && <span>{waitingText} · </span>}
        <a href="#/decisions">{more > 0 ? `Open Decisions (all ${open})` : "Open Decisions"}</a>
      </p>
    </section>
  );
}
