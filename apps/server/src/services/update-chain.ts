// BOS-2672 (RCA-011): the update chain a wrap-up belongs to. Three rounds of fixes (BOS-2056, BOS-2610, this) each taught
// the wrap-up one more moment of an update, because "which update is this for" was a three-value label set once, at the
// press, from one phase of one record. Here the chain is read from the records that already exist on every pass (the
// server's deploy wait, the queued runner press, the host's last report), and the wrap-up keeps a tie to every step it
// saw. `stepTie` is the one table of what happens next: a step that starts joins, and the wrap-up ends when the last
// step is in, or at once when a step fails, is cancelled or gives up. Pure, so every state has its own test.
import type { WrapEnd, WrapRunnerStage, WrapServerStage, WrapTieView } from "@boss-man/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";
import type { DeployWait } from "./deploy-wait.js";
import { WAIT_RULES, type WaitKind } from "./update-waits.js";

/** The server step as the records show it now. `decisionId` null: a trial is running with no deploy wait behind it. */
export type ChainServer = { decisionId: string | null; approvedAt: string | null; stage: WrapServerStage; trialEndsAt: string | null };
/** The runner step as the records show it now: queued by the owner's press, or with the host (sent or building). */
export type ChainRunner = { queuedAt: string | null; stage: "queued" | "building"; startsAt: string | null; why: string | null };
/** The host's last report (outbox/status.json). */
export type ChainReport = { id: string; target: string; result: string; ended: string };

export type UpdateChain = {
  server: ChainServer | null;
  runner: ChainRunner | null;
  last: ChainReport | null;
  /** Why a queued runner update was cancelled (a switched-back server update), when it was. */
  queueCancelled: { at: string; why: string } | null;
  /** How the tied server request ended when Boss Man ended it without the host (its card's end stamp). */
  tiedServerEnd: "cancelled" | "not_sent" | "replaced" | null;
};
export const EMPTY_CHAIN: UpdateChain = { server: null, runner: null, last: null, queueCancelled: null, tiedServerEnd: null };

/** What the chain is built from: each field is one record Boss Man already keeps. */
export type ChainInput = {
  wait: DeployWait | null;
  /** The standby trial's end (self-deploy's runner-due row), when one is running. */
  trialEndsAt: string | null;
  /** The owner's queued runner press, or the combined button's wish before its deploy lands. */
  runnerQueued: { pressedAt: string | null; startsAt: string | null; why: string | null } | null;
  /** A runner request waiting in the host's inbox or running on the host. */
  runnerUnderWay: boolean;
  last: ChainReport | null;
  queueCancelled: { at: string; why: string } | null;
  tiedServerEnd: UpdateChain["tiedServerEnd"];
};

const SERVER_STAGE: Record<DeployWait["phase"], WrapServerStage> = { waiting: "approved", sent: "going-in", window: "live-trial", handover: "handover" };

export function chainFrom(i: ChainInput): UpdateChain {
  const w = i.wait;
  const server: ChainServer | null = w
    ? { decisionId: w.decisionId, approvedAt: w.approvedAt, stage: SERVER_STAGE[w.phase], trialEndsAt: w.windowUntil ?? i.trialEndsAt }
    : i.trialEndsAt
      ? { decisionId: null, approvedAt: null, stage: "live-trial", trialEndsAt: i.trialEndsAt }
      : null;
  const runner: ChainRunner | null = i.runnerUnderWay
    ? { queuedAt: i.runnerQueued?.pressedAt ?? null, stage: "building", startsAt: null, why: null }
    : i.runnerQueued
      ? { queuedAt: i.runnerQueued.pressedAt, stage: "queued", startsAt: i.runnerQueued.startsAt, why: i.runnerQueued.why }
      : w?.thenRunners
        ? { queuedAt: w.approvedAt, stage: "queued", startsAt: w.windowUntil ?? null, why: "the server update to go in and finish its trial" }
        : null;
  return { server, runner, last: i.last, queueCancelled: i.queueCancelled, tiedServerEnd: i.tiedServerEnd };
}

/** Where the chain's records come from (app.ts wires them to the deploy wait and self-deploy). */
export type ChainSources = {
  wait: () => Promise<DeployWait | null>;
  trialUntil: () => Promise<string | null>;
  facts: () => Promise<Pick<ChainInput, "runnerQueued" | "runnerUnderWay" | "last" | "queueCancelled">>;
};

/** Reads the chain now. `tiedDecisionId`: the server request a wrap-up is tied to, whose card end is read if it ended without the host. */
export async function readUpdateChain(db: Db, src: ChainSources, tiedDecisionId: string | null): Promise<UpdateChain> {
  const [wait, trialEndsAt, facts] = await Promise.all([src.wait(), src.trialUntil(), src.facts()]);
  let tiedServerEnd: UpdateChain["tiedServerEnd"] = null;
  if (tiedDecisionId && /^[0-9a-f-]{36}$/i.test(tiedDecisionId)) {
    const [d] = await db.select({ context: decisions.context }).from(decisions).where(eq(decisions.id, tiedDecisionId));
    const r = (d?.context as { result?: { result?: string } } | null)?.result?.result;
    tiedServerEnd = r === "cancelled" || r === "not_sent" || r === "replaced" ? r : null;
  }
  return chainFrom({ wait, trialEndsAt, ...facts, tiedServerEnd });
}

/** The server step a wrap-up is tied to. `joinedLive`: tied once it was already live, so it is in when its trial ends. */
export type TieServer = { decisionId: string | null; approvedAt: string | null; stage: WrapServerStage; trialEndsAt: string | null; joinedAt: string; joinedLive: boolean; liveAt?: string; doneAt?: string };
/** The runner step a wrap-up is tied to. `goneSince`: a queued press that has vanished, waiting out RUNNER_GONE_GRACE_MS. */
export type TieRunner = { queuedAt: string | null; stage: "queued" | "building"; startsAt: string | null; why: string | null; joinedAt: string; buildingSince?: string; goneSince?: string };
export type WrapTie = { server?: TieServer; runner?: TieRunner };

/** A queued runner press that is no longer queued nor with the host after this long was cancelled (one pass can fall between the two). */
export const RUNNER_GONE_GRACE_MS = 60_000;
const BROKE = new Set(["failed", "partial", "rolled_back", "rejected", "nothing_new"]);
const after = (iso: string, since: string) => Date.parse(iso) >= Date.parse(since);

/** Which update the tie is for, in the old three words (update-waits.ts and the chat screen read them). */
export const forUpdateOf = (tie: WrapTie | undefined): "server" | "runner" | "none" => (tie?.runner ? "runner" : tie?.server ? "server" : "none");

/**
 * One pass for a wrap-up: joins the steps that are under way, and says whether it ends now. `building`: update-runner.sh
 * asked for its building hold on this pass. `buildMaxMin`: the build hold's own limit (maintenance.ts).
 */
export function stepTie(tie: WrapTie, chain: UpdateChain, now: Date, opts: { building?: boolean; buildMaxMin: number }): { tie: WrapTie; end: WrapEnd | null } {
  const t = now.toISOString();
  let server = tie.server;
  let runner = tie.runner;
  const done = (end: WrapEnd) => ({ tie: { ...(server ? { server } : {}), ...(runner ? { runner } : {}) }, end });

  // The server step: join it, follow its stage, and see how it ended.
  const cs = chain.server;
  if (cs && !server?.doneAt) {
    const live = cs.stage === "live-trial" || cs.stage === "handover";
    server = {
      decisionId: cs.decisionId ?? server?.decisionId ?? null,
      approvedAt: cs.approvedAt ?? server?.approvedAt ?? null,
      stage: cs.stage,
      trialEndsAt: cs.trialEndsAt,
      joinedAt: server?.joinedAt ?? t,
      joinedLive: server ? server.joinedLive : live,
      ...(server?.liveAt || live ? { liveAt: server?.liveAt ?? t } : {}),
    };
  }
  const report = chain.last;
  if (server && !server.doneAt) {
    // The host reported this request broke (failed, switched back in its trial, refused, nothing new).
    const ours = report && server.decisionId && report.id === server.decisionId ? report : null;
    if (ours && BROKE.has(ours.result)) return done({ how: "failed", step: "server", switchedBack: ours.result === "rolled_back" });
    if (!cs) {
      // The server step is over: it went in, or it ended without going live.
      if (!server.decisionId && report?.target === "server" && report.result === "rolled_back" && after(report.ended, server.joinedAt)) return done({ how: "failed", step: "server", switchedBack: true });
      if (ours?.result === "deployed" || server.liveAt || !server.decisionId) server = { ...server, doneAt: t };
      else if (chain.tiedServerEnd === "cancelled") return done({ how: "cancelled", step: "server" });
      else if (chain.tiedServerEnd === "not_sent") return done({ how: "gave-up", step: "server", didNot: "go in: the machine stayed short of memory" });
      else return done({ how: "gave-up", step: "server", didNot: "go in" });
    }
  }

  // The runner step: join it, follow it, and see how it ended. Once it is with the host only its own ends count.
  const cr = chain.runner;
  if (cr || opts.building) {
    const building = !!opts.building || cr?.stage === "building" || !!runner?.buildingSince;
    runner = {
      queuedAt: runner?.queuedAt ?? cr?.queuedAt ?? t,
      stage: building ? "building" : "queued",
      startsAt: cr?.startsAt ?? runner?.startsAt ?? null,
      why: cr?.why ?? runner?.why ?? null,
      joinedAt: runner?.joinedAt ?? t,
      ...(building ? { buildingSince: runner?.buildingSince ?? t } : {}),
    };
  }
  if (runner) {
    if (report?.target === "runner" && after(report.ended, runner.joinedAt)) {
      if (BROKE.has(report.result)) return done({ how: "failed", step: "runner", switchedBack: report.result === "rolled_back" });
      if (report.result === "deployed") return done({ how: "in", server: !!server, runner: true });
    }
    if (runner.buildingSince) {
      if (now.getTime() - Date.parse(runner.buildingSince) > opts.buildMaxMin * 60_000) return done({ how: "gave-up", step: "runner", didNot: "start", minutes: opts.buildMaxMin });
    } else if (!cr) {
      const gone = runner.goneSince ?? t;
      runner = { ...runner, goneSince: gone };
      if (now.getTime() - Date.parse(gone) >= RUNNER_GONE_GRACE_MS) {
        const why = chain.queueCancelled && after(chain.queueCancelled.at, runner.joinedAt) ? chain.queueCancelled.why : null;
        return done({ how: "cancelled", step: "runner", why });
      }
    } else {
      if (runner.goneSince) {
        const { goneSince: _g, ...rest } = runner;
        runner = rest;
      }
      const endMin = WAIT_RULES["runner-queued"].endMin;
      if (now.getTime() - Date.parse(runner.joinedAt) > endMin * 60_000) return done({ how: "gave-up", step: "runner", didNot: "start", minutes: endMin });
    }
    // With a runner step, the wrap-up waits for it: its drain takes the wrap-up over and ends it.
    return { tie: { ...(server ? { server } : {}), runner }, end: null };
  }

  // Only a server step: in when it goes live, or (tied once already live) when its trial is over.
  if (server && (server.doneAt || (!server.joinedLive && server.liveAt))) return done({ how: "in", server: true, runner: false });
  return { tie: server ? { server } : {}, end: null };
}

/** BOS-2786: what Boss Man's own wrap-up records when it starts one: the press it is for, and when it asks agents to finish. */
export type AutoWrap = { queuedAt: string | null; startsAt: string; tellAt: string };

/**
 * BOS-2786: whether Boss Man starts its own wrap-up now, and for which press. Only for a runner update that is queued
 * (not yet with the host) behind a trial that ends in the future: `startsAt` is that trial's end. `offFor`: the press the
 * owner cancelled Boss Man's wrap-up for, which is never started again. Agents are asked to finish `leadMin` before the end,
 * or at once when less is left.
 */
export function autoWrapDue(chain: UpdateChain, now: Date, opts: { offFor: string | null; leadMin: number }): AutoWrap | null {
  const r = chain.runner;
  if (!r || r.stage !== "queued") return null;
  // The press's own start time, else the end of the trial running now (the deploy wait's window, or the host's trial).
  const trialEnd = chain.server?.stage === "live-trial" ? chain.server.trialEndsAt : null;
  const startsAt = r.startsAt ?? trialEnd;
  if (!startsAt) return null;
  const ends = Date.parse(startsAt);
  if (!Number.isFinite(ends) || ends <= now.getTime()) return null;
  if (opts.offFor !== null && opts.offFor === (r.queuedAt ?? "")) return null;
  const tellAt = new Date(Math.max(now.getTime(), ends - opts.leadMin * 60_000)).toISOString();
  return { queuedAt: r.queuedAt, startsAt, tellAt };
}

/**
 * BOS-2786: Boss Man's own wrap-up gives up when its runner update is still only queued `graceMin` after the trial's end
 * (something else holds the press back). Once the host is building it, the build's own limit applies instead.
 */
export function autoWrapStuck(tie: WrapTie | undefined, auto: AutoWrap, now: Date, graceMin: number): boolean {
  const r = tie?.runner;
  if (!r || r.buildingSince || r.stage !== "queued") return false;
  const ends = Date.parse(r.startsAt ?? auto.startsAt);
  return Number.isFinite(ends) && now.getTime() - ends > graceMin * 60_000;
}

/**
 * The screen's view of a tie (shared wording, wrapUpWords). `swapping`: the runner drain has taken the wrap-up over.
 * `auto` (BOS-2786): Boss Man started it, and when it asks (or asked) agents to finish; absent once the owner pressed too.
 */
export function tieView(tie: WrapTie | undefined, since: string, opts: { swapping?: boolean; liftsAt?: string | null; auto?: { tellAt: string } | null } = {}): WrapTieView {
  const s = tie?.server && !tie.server.doneAt ? tie.server : tie?.server?.doneAt && (tie.runner || opts.swapping) ? tie.server : null;
  const r = tie?.runner;
  const runnerStage: WrapRunnerStage | null = opts.swapping ? "swapping" : r ? r.stage : null;
  return {
    since,
    ...(s ? { server: { approvedAt: s.approvedAt, stage: s.doneAt ? "live-trial" : s.stage, liveAt: s.liveAt ?? null, trialEndsAt: s.trialEndsAt } } : {}),
    ...(runnerStage ? { runner: { queuedAt: r?.queuedAt ?? null, stage: runnerStage, startsAt: r?.startsAt ?? null, why: r?.why ?? null } } : {}),
    ...(!s && !runnerStage ? { liftsAt: opts.liftsAt ?? null } : {}),
    ...(opts.auto ? { by: "boss-man" as const, tellAt: opts.auto.tellAt } : {}),
  };
}

/**
 * Every server and runner wait stage (update-waits.ts WAIT_RULES), and the wrap-up stage it shows as. A test walks
 * WAIT_RULES against this, so a new stage can't be added without saying what a wrap-up pressed in it is tied to.
 */
export const WAIT_STAGE_TO_WRAP: Record<Exclude<WaitKind, "wrapup">, { server?: WrapServerStage; runner?: WrapRunnerStage }> = {
  "server-quiet": { server: "approved" },
  "server-behind-runner": { server: "approved" },
  "server-host-memory": { server: "going-in" },
  "server-build": { server: "going-in" },
  "server-window": { server: "live-trial" },
  "server-handover": { server: "handover" },
  "runner-queued": { runner: "queued" },
  "runner-building": { runner: "building" },
  "runner-drain": { runner: "swapping" },
  "runner-landing": { runner: "swapping" },
  "runner-settle": { runner: "swapping" },
  "runner-launcher": { runner: "swapping" },
  "runner-reconnect": { runner: "swapping" },
  "owner-force": { runner: "swapping" },
};
