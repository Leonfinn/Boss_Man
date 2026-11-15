// Runner updates by "drain, then swap" (docs/09-self-deploy.md, phase 2). One server-wide hold,
// separate from a company's Pause: while it is on, the scheduler starts no new run anywhere.
// Runs already going finish. Each company's runner is recreated on the new image as soon as that
// company has no run, and when every runner is on it the hold lifts by itself.
// The hold is one `settings` row, so there is no migration and a restart keeps it.
import { rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, checkWorkers, companies, decisions, runnerEvents, runs, settings, tickets } from "../db/schema.js";
import { CANCEL_RUNNER_UPDATE, CANCEL_UPDATE, DEADLINE_WAIT_MINUTES, KEEP_WAITING_MORE, STOP_AND_UPDATE, STOP_THESE_CARRY_ON, WAIT_TEN_MORE } from "./decisions.js";
import type { NotifyInput } from "./notifications.js";
import { expectRestart } from "./runner-restarts.js";
import { runnerBusy, runsByCompany } from "./runner-busy.js";

export const MAINTENANCE_KEY = "maintenance";

/**
 * The words a failed swap's note carries (BOS-382), shared with runner-report.ts, which reads them back to pick the
 * panel's wording. Reword them here and both sides move together.
 */
export const SWAP_PUT_BACK = "put back on the previous runner image";
export const SWAP_PUT_BACK_RUNNING = `${SWAP_PUT_BACK} and is running that`;
export const SWAP_PUT_BACK_FAILED = "going back to the previous runner image failed";
/** How long a recreated runner has to dial in (the drain's reconnect wait), and how long it still counts as mid-swap. */
export const SWAP_WINDOW_MS = 5 * 60_000;
/** Said to every running agent when a runner update starts waiting, and after each ticket move while it waits. */
export const WRAP_UP = "A runner update is waiting for your run to end. Commit your work, update your ticket, then end your turn now. Don't start anything new: you'll be woken again once the update is done.";
/** The same, for a runner restart that applies new runner settings (BOS-594). */
export const WRAP_UP_SETTINGS = "A runner restart for a setting change is waiting for your run to end. Commit your work, update your ticket, then end your turn now. Don't start anything new: you'll be woken again once the runner is back.";
/** The owner pressed "Ask agents to wrap up" (BOS-929): the same clean stop, before an update or a runner rebuild. */
export const WRAP_UP_ASKED = "The owner asked every agent to wrap up before an update. Finish the step you are on, commit your work on the ticket branch, write the ticket's state note with the next step, reply to anything pending, then end your turn now. Don't start anything new: no new checks either. If a command you were running was moved to the background, don't wait for a long check: say in the state note that it needs running again. You'll be woken again once it is done.";
/**
 * The owner pressed "Ask agents to wrap up" while an update already waits (BOS-988). The update's own message only
 * reaches the runs going when the hold started; this one reaches every run still going now, and keeps the update's
 * message too, so an agent that reads only the last message still knows an update is behind it.
 */
export const WRAP_UP_DURING_UPDATE = `${WRAP_UP_ASKED} A runner update is already waiting: it goes ahead by itself as soon as the running agents have finished.`;
/** What a drain is for. "update": swap each runner not on the current image. "settings": recreate every runner once,
 * whatever its image, so new launcher settings (memory, check slots, CPU) reach it without cutting runs off (BOS-594).
 * "wrapup": the owner asked every agent to stop cleanly (BOS-929); nothing is swapped, so there is no runner to wait
 * for: the hold only keeps new runs from starting until the owner cancels it or the update it was for finishes. */
export type HoldKind = "update" | "settings" | "wrapup";
/**
 * How long the "Ask agents to wrap up" panel lets a run go before flagging it "still going" (BOS-929). Never stopped
 * automatically. 30, not 10 (BOS-1016): a merge check takes 15 minutes or more and a full check 30 to 50, and an agent
 * that can't be steered (OpenCode) only reads the message when such a step ends.
 */
export const WRAPUP_NOT_RESPONDING_MINUTES = 30;
/** The reason drain.json carries for a setting change (scripts/update-runner.sh --settings). */
export const SETTINGS_REASON = "setting change";
/** How the last runner update ended, for Settings (BOS-465). `swapped` says which companies it swapped, so a later Settings visit knows which history belongs to which runner. */
export type LastUpdate = { at: string; startedAt: string | null; ok: boolean; title: string; body: string; swapped?: Record<string, string> };
export const MAINTENANCE_LAST_KEY = "maintenance:last";
/** The status_reason a held wake carries; it stays queued (like a paused company's) and launches once the hold lifts. */
export const HOLD_REASON = "update pending";

export type Hold = {
  reason: string;
  /** Absent on a hold saved before BOS-594: an update. */
  kind?: HoldKind;
  since: string;
  deadline: string;
  /** How long one wait is: the first deadline, and each "Keep waiting". */
  minutes: number;
  /** The owner chose "Stop the remaining runs and update now". */
  force?: boolean;
  /** slug -> when its runner was recreated; the hold waits for these to reconnect. */
  swapped?: Record<string, string>;
  /** slug -> why its runner could not be recreated. */
  failed?: Record<string, string>;
  /** slug -> a swap that failed and is tried again after `next` (BOS-382): the hold stays on while it is retried. */
  tries?: Record<string, { n: number; next: string; last: string }>;
  /** The "update is stuck" page has been sent for this hold (once). */
  stalledPaged?: boolean;
  /**
   * When the owner asked agents to wrap up (BOS-988). Cleared when the hold lifts. A hold whose kind is not
   * "wrapup" may still carry this: the owner pressed the button while an update was waiting, which is more than
   * the update's own start message.
   */
  wrapSince?: string;
  /** The still-running-list timeout for the owner's wrap-up ask (BOS-929/988): only a flag, never an automatic stop. */
  wrapNotRespondingAfter?: number;
  /** runId -> when the owner's wrap-up message went to it (BOS-988), so a drain pass never tells a run twice. */
  wrapTold?: Record<string, string>;
  /** runId -> when this hold's own update/settings message went to it, so a later run gets it once too (BOS-988). */
  startTold?: Record<string, string>;
};

export async function getHold(db: Db): Promise<Hold | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, MAINTENANCE_KEY));
  return (row?.value as Hold | null | undefined) ?? null;
}

/**
 * A runner update already waiting for runs (DR-046 part 2), or null (BOS-1010). A wrap-up hold (BOS-929) swaps
 * no image, so it is not a pending runner update. This is what the owner-card lint's R16 reads, so a card that
 * asks the owner to press Build and update runners again is refused while one is under way.
 */
export const runnerCardHold = (hold: Hold | null): Hold | null => (hold && hold.kind !== "wrapup" ? hold : null);

/**
 * Whether the hold keeps new runs from starting right now (BOS-1414). Only while a drain is really under way: before
 * its deadline, or once the owner chose "Stop the remaining runs and update now". Past the deadline the owner has been
 * asked what to do; until they answer (Keep waiting gives a new deadline), the drain is stalled, not under way, and
 * background agents must keep working overnight. A wrap-up the owner asked for holds until they cancel it.
 */
export const holdBlocksStarts = (hold: Hold | null, at: Date): boolean => {
  if (!hold) return false;
  if (hold.kind === "wrapup" || hold.wrapSince || hold.force) return true;
  return at < new Date(hold.deadline);
};
/** What a wake released from a stalled drain shows in place of "update pending". */
export const HOLD_RELEASED_REASON = "released: the runner update waited past its deadline and is waiting for the owner's answer; new runs are not held for it";

export type FleetRunner = { slug: string; companyId: string | null; current: boolean | undefined };

export type MaintenanceDeps = {
  /** The launcher's runners, each with its company and whether it runs the current image. */
  fleet: () => Promise<FleetRunner[]>;
  recreate: (slug: string) => Promise<unknown>;
  /** Puts a company's runner back on the image it ran before, when the new one would not start (BOS-382). */
  rollback?: (slug: string) => Promise<unknown>;
  /** How many times a swap is tried before going back to the previous image (default 3), and the first wait between tries (doubles each time). */
  swapTries?: number;
  swapRetryMs?: number;
  connected: (companyId: string) => Promise<boolean>;
  /** Resolves when no scheduling pass is mid-flight, so a count of runs taken after it cannot be outdated by a launch. */
  settled: () => Promise<unknown>;
  tick: () => Promise<unknown>;
  /** The per-run Stop (runs.ts cancel): BOS-1377's "Stop these and carry on" and BOS-1238's button stop runs through it. */
  cancelRun?: (runId: string) => Promise<unknown>;
  notify: (n: NotifyInput) => Promise<unknown>;
  /** Sends a message into every run still going, so agents wrap up instead of looking for more work. */
  tellRunning?: (text: string) => Promise<unknown>;
  /** BOS-988: sends the message to just these runs and answers with the ids it reached, so a run is told once. */
  tellRuns?: (text: string, runIds: string[]) => Promise<string[]>;
  /** The hold has lifted: wake the agents who ended their runs for it, as WRAP_UP promised (BOS-574). */
  afterHold?: (since: Date) => Promise<unknown>;
  /** The deployer folder; update-runner.sh drops inbox/drain.json there to ask for a drain. */
  dir?: string;
  drainMinutes?: number;
  /** A recreated runner that has not reconnected after this long is reported, and the hold lifts anyway. */
  reconnectMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
};

export function maintenanceService(db: Db, deps: MaintenanceDeps) {
  const now = deps.now ?? (() => new Date());
  const reconnectMs = deps.reconnectMs ?? SWAP_WINDOW_MS;
  const swapTries = Math.max(1, deps.swapTries ?? 3);
  const swapRetryMs = deps.swapRetryMs ?? 30_000;

  /** BOS-382: the new runner would not start after every try. Go back to the previous image; say plainly what happened either way. */
  async function goBack(slug: string, why: string, n: number): Promise<string> {
    const tried = `the new runner would not start (${n} tr${n === 1 ? "y" : "ies"}: ${why})`;
    if (!deps.rollback) return tried;
    try {
      await deps.rollback(slug); // leader-only
      deps.log?.(`drain: ${slug} is back on the previous runner image`);
      return `${tried}, so it was ${SWAP_PUT_BACK_RUNNING}`;
    } catch (err) {
      return `${tried}, and ${SWAP_PUT_BACK_FAILED} too (${(err as Error).message}). Press Start runner in Settings > Runner`;
    }
  }
  const trigger = deps.dir && path.join(deps.dir, "inbox", "drain.json");

  const save = (h: Hold) => db.insert(settings).values({ key: MAINTENANCE_KEY, value: h }).onConflictDoUpdate({ target: settings.key, set: { value: h } });

  /**
   * Live runs per company. `workOnly` leaves out the owner's chat and the CEO's reply lane (BOS-349):
   * those never hold a runner swap, and they are what the banner's "N agents" counts.
   */
  const activeByCompany = (workOnly = false) => runsByCompany(db, workOnly);
  /**
   * What holds a swap (BOS-1471): work runs plus running check jobs, so a recreate never kills a merge check
   * in flight. The shared function is also what a server update's quiet-host wait reads (runner-busy.ts).
   */
  const busyByCompany = async () => (await runnerBusy(db)).byCompany;

  /**
   * The wrap-up panel's list (BOS-929): every work run still going, with its agent, ticket reference and when it
   * started. A run with an open permission card is named as waiting for an answer, with who it waits on (Brains's
   * part B), so the panel never calls a run stuck when it is really waiting on the owner. `told` (runId -> when it
   * was messaged, BOS-988) gives each run its own "asked N min ago": a run that started after the ask is told at the
   * next drain pass, and its own time says so.
   */
  async function liveWorkRuns(db: Db, since: string, told: Record<string, string> = {}) {
    const live = await db
      .select({
        runId: runs.id,
        agentId: runs.agentId,
        agentName: agents.name,
        ticketId: runs.ticketId,
        ticketRef: sql<string | null>`(select case when t."number" is null then null else coalesce(nullif(c."ticket_prefix", ''), 'T') || '-' || t."number"::text end from "tickets" t left join "companies" c on c."id" = t."company_id" where t."id" = ${runs.ticketId})`,
        ticketTitle: tickets.title,
        startedAt: runs.startedAt,
      })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(tickets, eq(tickets.id, runs.ticketId))
      .where(and(isNull(runs.endedAt), sql`${runs.purpose} is distinct from 'chat'`, sql`${runs.purpose} is distinct from 'reply'`))
      .orderBy(asc(runs.startedAt));
    // An open permission card names the run it holds (BOS-932/DR-048). One per run is enough to say it is waiting.
    const waiters = new Map<string, { question: string; tier: string | null }>();
    if (live.length) {
      const cards = await db
        .select({ runId: sql<string>`${decisions.context}->>'runId'`, question: decisions.question, tier: decisions.tier })
        .from(decisions)
        .where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open"), sql`${decisions.context}->>'runId' is not null`));
      for (const c of cards) if (c.runId && !waiters.has(c.runId)) waiters.set(c.runId, { question: c.question, tier: c.tier });
    }
    // BOS-1016: what each run is doing, from its own events (the runner_events_run index serves both queries),
    // so a run inside one long step is shown as that, not as stuck. `gotMessage`: a Boss Man message reached the
    // agent after it was told (steered mid-step, or at the end of its turn). `step`: the tool call it is in, if any.
    const activity = new Map<string, { gotMessage: boolean; step: { title: string; sinceMinutes: number } | null }>();
    for (const r of live) {
      const toldAt = new Date(told[r.runId] ?? since);
      const [got] = await db
        .select({ one: sql<number>`1` })
        .from(runnerEvents)
        .where(and(sql`(${runnerEvents.payload}->>'runId') = ${r.runId}`, eq(runnerEvents.type, "run.update"), sql`${runnerEvents.payload}->'update'->>'kind' = 'message_delivered'`, sql`${runnerEvents.payload}->'update'->>'text' like 'Message from Boss Man:%'`, gte(runnerEvents.receivedAt, toldAt)))
        .limit(1);
      // The newest tool events, newest first. Updates carry no call id, so the newest one says whether a step is
      // running; the step's title and start come from the run of pending/in-progress events it ends.
      const tools = await db
        .select({ payload: runnerEvents.payload, at: runnerEvents.occurredAt })
        .from(runnerEvents)
        .where(and(sql`(${runnerEvents.payload}->>'runId') = ${r.runId}`, eq(runnerEvents.type, "run.update"), sql`${runnerEvents.payload}->'update'->>'kind' in ('tool_call', 'tool_call_update')`))
        .orderBy(desc(runnerEvents.seq))
        .limit(20);
      const open = (p: unknown) => ["pending", "in_progress"].includes(String((p as { update?: { status?: unknown } }).update?.status));
      let step: { title: string; sinceMinutes: number } | null = null;
      if (tools[0] && open(tools[0].payload)) {
        let i = 0;
        while (i + 1 < tools.length && open(tools[i + 1]!.payload)) i++;
        const title = tools.slice(0, i + 1).map((t) => (t.payload as { update?: { title?: unknown } }).update?.title).find((t): t is string => typeof t === "string" && t.length > 0);
        step = { title: (title ?? "a tool").slice(0, 120), sinceMinutes: Math.max(0, Math.round((now().getTime() - new Date(tools[i]!.at).getTime()) / 60_000)) };
      }
      activity.set(r.runId, { gotMessage: !!got, step });
    }
    return live.map((r) => {
      const w = r.runId ? waiters.get(r.runId) : undefined;
      const own = r.runId ? told[r.runId] : undefined;
      return {
        ...(activity.get(r.runId) ?? { gotMessage: false, step: null }),
        runId: r.runId,
        agentId: r.agentId,
        agent: r.agentName,
        ticketId: r.ticketId,
        ticket: r.ticketRef,
        ticketTitle: r.ticketTitle,
        runningForMinutes: Math.max(0, Math.round((now().getTime() - new Date(r.startedAt).getTime()) / 60_000)),
        sinceWrapUpMinutes: Math.max(0, Math.round((now().getTime() - new Date(own ?? since).getTime()) / 60_000)),
        waitingOn: w ? { question: w.question, tier: w.tier } : null,
      };
    });
  }

  /** Every work run still going, as ids: whoever started before an ask and is still going gets told, once (BOS-988). */
  async function liveWorkRunIds() {
    const live = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(isNull(runs.endedAt), sql`${runs.purpose} is distinct from 'chat'`, sql`${runs.purpose} is distinct from 'reply'`));
    return live.map((r) => r.id);
  }

  async function withdrawQuestion() {
    await db
      .update(decisions)
      .set({ status: "withdrawn", dedupeKey: null })
      .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'maintenance'`));
  }

  /** Whether this runner still needs recreating in this drain. */
  function needsSwap(h: Hold, r: FleetRunner, swapped: Record<string, string>) {
    return h.kind === "settings" ? !swapped[r.slug] : !r.current;
  }

  /** What drain.json asks for: a setting change when it says so, else an image update. Unreadable or odd contents count as an update, as before. */
  function kindOf(text: string): HoldKind {
    try {
      return (JSON.parse(text) as { reason?: unknown })?.reason === SETTINGS_REASON ? "settings" : "update";
    } catch {
      return "update";
    }
  }

  /**
   * BOS-1437 (DR-060): check workers run on other hosts, so this swap doesn't touch them, and a worker built from an older commit
   * than the runner sits idle until it is updated. The done card says so with the steps; empty when no worker is set up.
   */
  async function workerUpdateSteps(): Promise<string> {
    const rows = await db.select({ name: checkWorkers.name }).from(checkWorkers).where(eq(checkWorkers.enabled, true));
    if (!rows.length) return "";
    const names = rows.map((w) => w.name).join(", ");
    return ` Check workers are not swapped by this update and take no checks until they match (${names}). On each worker host: in its compose.yaml, replace the 40-character commit on the two lines marked "CHANGE THIS (commit)" with the new runner commit, and run docker compose up -d next to it (it rebuilds the worker by itself). The steps are in docs/34-check-workers.md; the Checks panel shows which workers are out of date.`;
  }

  async function end(title: string, level: NotifyInput["level"], body: string) {
    const h = await getHold(db);
    const last: LastUpdate = { at: now().toISOString(), startedAt: h?.since ?? null, ok: level !== "page", title, body, ...(h?.swapped ? { swapped: h.swapped } : {}) };
    await db.insert(settings).values({ key: MAINTENANCE_LAST_KEY, value: last }).onConflictDoUpdate({ target: settings.key, set: { value: last } });
    await db.delete(settings).where(eq(settings.key, MAINTENANCE_KEY));
    await withdrawQuestion();
    await deps.notify({ companyId: null, level, title, body, link: "#/settings" });
    // The agents that wrapped up for the update are woken again, as they were told they would be (BOS-574).
    if (h && deps.afterHold) await deps.afterHold(new Date(h.since)).catch((err) => deps.log?.(`waking agents after the update failed: ${(err as Error).message}`));
    // Held wakes were only waiting; one pass starts them.
    await deps.tick();
  }

  /** The one question at a deadline. The key names the deadline, so "Keep waiting" earns a new one at the next. */
  async function askAtDeadline(h: Hold, n: number, inCompanies: number, checksN = 0) {
    const [home] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
    if (!home) return;
    // BOS-1377: the runs this card shows are the ones told at wrap-up that are still going; "Stop these" touches only them.
    const told = { ...h.startTold, ...h.wrapTold };
    const shown = (await liveWorkRuns(db, h.wrapSince ?? h.since, told)).filter((r) => told[r.runId]);
    const options = shown.length ? [STOP_THESE_CARRY_ON, WAIT_TEN_MORE, CANCEL_RUNNER_UPDATE] : [WAIT_TEN_MORE, CANCEL_RUNNER_UPDATE];
    const names = shown.map((r) => `${r.agent ?? "an agent"} (${r.ticket ?? "no ticket"})`).join(", ");
    const stopText = shown.length ? ` "Stop these and carry on" stops ${names}: anything they haven't saved is lost, and their tickets wake again after the update. No other run is touched.` : "";
    await db
      .insert(decisions)
      .values({
        companyId: home.id,
        kind: "approval",
        question: `The runner update has waited ${h.minutes} minutes and ${n ? `${n} run${n === 1 ? " is" : "s are"}` : ""}${n && checksN ? " and " : ""}${checksN ? `${checksN} check${checksN === 1 ? " is" : "s are"}` : ""} still going in ${inCompanies} compan${inCompanies === 1 ? "y" : "ies"}.${stopText} Or wait ${DEADLINE_WAIT_MINUTES} more minutes, or cancel the runner update (the work going carries on). Until you answer, new runs and checks are not held for this update; it goes ahead by itself once a company has no run or check left.`,
        options,
        recommendedOption: WAIT_TEN_MORE,
        dedupeKey: `maintenance:${h.since}:${h.deadline}`,
        context: { type: "maintenance", since: h.since, runIds: shown.map((r) => r.runId) },
      })
      .onConflictDoNothing();
  }

  /**
   * Tells the message to every work run still going that this hold has not told yet, and answers with
   * runId -> when it was told, merged into the earlier ones. One pass, so two asks close together can't tell a
   * run twice (BOS-988). Returns nothing to merge when nobody was told.
   */
  async function tell(text: string, h: Hold, field: "startTold" | "wrapTold"): Promise<Record<string, string>> {
    const already = h[field] ?? {};
    const live = await liveWorkRunIds();
    const fresh = live.filter((id) => !already[id]);
    const nowIso = now().toISOString();
    const reached = deps.tellRuns ? await deps.tellRuns(text, fresh).catch((err) => (deps.log?.(`telling running agents to wrap up failed: ${(err as Error).message}`), [])) : (await deps.tellRunning?.(text).catch((err) => (deps.log?.(`telling running agents to wrap up failed: ${(err as Error).message}`), null)), fresh);
    const told = { ...already };
    for (const id of reached ?? fresh) told[id] = nowIso;
    // Kept on the saved hold, so a drain pass or another press sees who was already told.
    await save({ ...h, [field]: told });
    return told;
  }

  /** Tells every work run still going this hold has not told yet, once; the hold was just saved. */
  async function tellOnce(text: string, h: Hold) {
    return tell(text, h, h.kind === "wrapup" ? "wrapTold" : "startTold");
  }

  const self = {
    /** Turns the hold on. Idempotent: a second call returns the hold that is already on. // leader-only */
    async start(opts: { reason?: string; minutes?: number; kind?: HoldKind } = {}): Promise<Hold> {
      const kind = opts.kind ?? "update";
      const have = await getHold(db);
      if (have) {
        // The owner's wrap-up asked for while an update or setting change is waiting (BOS-988): the update is exactly
        // when they need it, so it joins the hold instead of being refused. The update keeps its own kind, start and
        // deadline, so it still goes ahead by itself when the runs end; the wrap-up adds only its ask, its timeout and
        // who it told. Runs already told keep their time, so pressing again tells only the runs that came after.
        if (kind === "wrapup" && have.kind !== "wrapup") {
          const asked = have.wrapSince ?? now().toISOString();
          const up: Hold = { ...have, wrapSince: asked, wrapNotRespondingAfter: WRAPUP_NOT_RESPONDING_MINUTES };
          await save(up);
          const told = await tell(WRAP_UP_DURING_UPDATE, up, "wrapTold");
          return { ...up, wrapTold: told };
        }
        // A setting change asked for during an image update: recreate every runner from now on, including any
        // already swapped, since they were made with the old settings. The recreate also puts them on the new image.
        if (kind === "settings" && have.kind !== "settings") {
          const up: Hold = { ...have, kind, reason: SETTINGS_REASON, swapped: {} };
          await save(up);
          return up;
        }
        // A real update asked for while the owner's wrap-up hold is on (BOS-929): the update takes over, since it
        // carries the same "nothing new starts" and lifts by itself when the runners are swapped. Its own
        // start message goes out below, so an agent that missed the wrap-up is told again by the update.
        if ((kind === "update" || kind === "settings") && have.kind === "wrapup") {
          const up: Hold = { ...have, kind, reason: kind === "settings" ? SETTINGS_REASON : "runner update", since: now().toISOString() };
          await save(up);
          await tellOnce(kind === "settings" ? WRAP_UP_SETTINGS : WRAP_UP, up);
          return up;
        }
        return have;
      }
      // A wrap-up has no deadline: nothing is waiting on a swap, so it never asks "stop them now?". The panel's
      // "still going" timeout is only a flag for the owner (WRAPUP_NOT_RESPONDING_MINUTES).
      const minutes = opts.minutes ?? (kind === "wrapup" ? WRAPUP_NOT_RESPONDING_MINUTES : (deps.drainMinutes ?? 30));
      const t = now();
      const h: Hold = { reason: opts.reason ?? (kind === "settings" ? SETTINGS_REASON : kind === "wrapup" ? "asking agents to wrap up" : "runner update"), kind, since: t.toISOString(), deadline: new Date(t.getTime() + minutes * 60_000).toISOString(), minutes };
      await save(h);
      const said = kind === "settings" ? WRAP_UP_SETTINGS : kind === "wrapup" ? WRAP_UP_ASKED : WRAP_UP;
      const told = kind === "wrapup" ? await tell(said, h, "wrapTold") : await tell(said, h, "startTold");
      await deps.notify({
        companyId: null,
        level: "note",
        title: kind === "settings" ? "Setting change pending: waiting for runs to finish" : kind === "wrapup" ? "Agents asked to wrap up" : "Update pending: waiting for runs to finish",
        body:
          kind === "wrapup"
            ? `Every running agent was asked to finish its step and stop cleanly. Nothing new starts in any company until you cancel the wrap-up or the update it was for finishes. Runs still going after ${minutes} minutes are only flagged, never stopped for you.`
            : `Nothing new starts in any company. Each runner is ${kind === "settings" ? "recreated with the new settings" : "swapped"} as its company goes idle. If runs are still going after ${minutes} minutes, you will be asked.`,
        link: "#/settings",
      });
      return kind === "wrapup" ? { ...h, wrapSince: h.since, wrapNotRespondingAfter: WRAPUP_NOT_RESPONDING_MINUTES, wrapTold: told } : { ...h, startTold: told };
    },

    /** What the banner shows. */
    async status() {
      const h = await getHold(db);
      const [l] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MAINTENANCE_LAST_KEY));
      const last = (l?.value ?? null) as LastUpdate | null;
      // A past failure is history once every runner is connected on the new image: say so, not the old problem.
      let healthy = false;
      if (!h && last && !last.ok) {
        try {
          const fleet = await deps.fleet();
          healthy = fleet.length > 0 && (await Promise.all(fleet.map(async (r) => r.current === true && !!r.companyId && (await deps.connected(r.companyId))))).every(Boolean);
        } catch {
          healthy = false;
        }
      }
      if (!h) return last && !last.ok ? { on: false as const, last, healthy } : { on: false as const, last };
      const active = await activeByCompany(true);
      const runsTotal = [...active.values()].reduce((a, b) => a + b, 0);
      // BOS-349: while work runs are still going, the chat page stays open and says so; otherwise the swap can land any moment.
      const base = { on: true as const, kind: h.kind ?? "update", reason: h.reason, since: h.since, deadline: h.deadline, runs: runsTotal, companies: active.size, chatOpen: runsTotal > 0, blocking: holdBlocksStarts(h, now()), last };
      // The wrap-up panel's list (BOS-929): each work run still going, with its ticket and a run waiting on an open
      // permission card named as waiting for an answer (Brains's part B), so it is never called "not responding".
      // A wrap-up asked for while an update waits (BOS-988) keeps the update's kind but carries the ask, so it shows
      // the same list here; each run's own "asked N min ago" comes from when it was told.
      if (h.kind !== "wrapup" && !h.wrapSince) return base;
      const wrapSince = h.wrapSince ?? h.since;
      const list = await liveWorkRuns(db, wrapSince, h.wrapTold);
      return {
        ...base,
        wrapAsked: true,
        ...(h.kind === "wrapup" ? { minutes: h.minutes } : {}),
        notRespondingAfter: h.wrapNotRespondingAfter ?? WRAPUP_NOT_RESPONDING_MINUTES,
        runsList: list,
      };
    },

    /** Lifts the hold without finishing the swap; runners already swapped stay on the new image. // leader-only */
    async cancel() {
      const h = await getHold(db);
      if (!h) return false;
      if (h.kind === "wrapup") await end("Wrap-up cancelled", "note", "New runs start again. Agents that were still going finish on their own; any that ended cleanly are woken on their tickets.");
      else await end("Runner update cancelled", "note", "New runs start again. Runners not swapped yet still run the old image; start the update again when you like.");
      return true;
    },

    /**
     * "Cancel wrap-up" (BOS-988) while an update is waiting: only the owner's ask is taken back, so the update keeps
     * waiting and goes ahead as normal when the runs end. The runs were already told once and are not told again.
     * With no update, this is the same as cancel(): the whole wrap-up hold goes. // leader-only
     */
    async cancelWrap() {
      const h = await getHold(db);
      if (!h) return false;
      if (h.kind === "wrapup") return self.cancel();
      if (!h.wrapSince) return false;
      const { wrapSince: _s, wrapNotRespondingAfter: _n, wrapTold: _t, ...rest } = h;
      await save(rest);
      return true;
    },

    /**
     * "Stop N and carry on with the update" (BOS-1238): which of the runs the owner was shown may be stopped. The
     * scope is fixed here, not by the page: only runs that were told to wrap up (`wrapTold`), only once the hold's
     * deadline has passed, and only those still going now. A run that has since ended is skipped; an id that was
     * never told is never returned, whatever the request says. It stops nothing itself: the caller ends each id
     * through the same per-run stop as BOS-929's Stop this run.
     */
    async stragglers(shown: string[]): Promise<{ ok: true; ids: string[]; skipped: number } | { ok: false; reason: "no_wrapup" | "too_early" }> {
      const h = await getHold(db);
      if (!h || !(h.kind === "wrapup" || h.wrapSince)) return { ok: false, reason: "no_wrapup" };
      if (now() < new Date(h.deadline)) return { ok: false, reason: "too_early" };
      const told = new Set(Object.keys(h.wrapTold ?? {}));
      const asked = [...new Set(shown)].filter((id) => told.has(id));
      if (!asked.length) return { ok: true, ids: [], skipped: shown.length };
      const live = await db.select({ id: runs.id }).from(runs).where(and(inArray(runs.id, asked), isNull(runs.endedAt)));
      const ids = live.map((r) => r.id);
      return { ok: true, ids, skipped: shown.length - ids.length };
    },

    /**
     * Stops exactly these runs through the per-run Stop (BOS-1377; BOS-1238's button calls this too): only ids the hold
     * told at wrap-up that are still going are stopped, so a run that ended since is skipped and a run that started later
     * is never touched. No lane pause, no ticket moves, no dropped wakes: the stopped tickets wake after the hold lifts.
     * Answers which runs it stopped and which it skipped. // leader-only
     */
    async stopRuns(runIds: string[]) {
      const h = await getHold(db);
      const told = new Set([...Object.keys(h?.startTold ?? {}), ...Object.keys(h?.wrapTold ?? {})]);
      const stopped: string[] = [];
      const skipped: string[] = [];
      const going = new Set(await liveWorkRunIds());
      for (const id of new Set(runIds)) {
        if (!told.has(id) || !going.has(id) || !deps.cancelRun) {
          skipped.push(id);
          continue;
        }
        try {
          await deps.cancelRun(id);
          stopped.push(id);
        } catch (err) {
          skipped.push(id); // it ended just now, or could not be stopped: the rest are still tried
          deps.log?.(`wrap-up stop: run ${id} was not stopped: ${(err as Error).message}`);
        }
      }
      return { stopped, skipped };
    },

    /** The owner's answer to the deadline question. `ctx.runIds` are the runs the card listed (BOS-1377). */
    async answered(answer: string, ctx: { runIds?: string[] } = {}) {
      const h = await getHold(db);
      if (!h) return;
      // A wrap-up never asks the deadline question, so its answers are for an old card: nothing to do.
      if (h.kind === "wrapup") return;
      const later = (minutes: number) => new Date(now().getTime() + minutes * 60_000).toISOString();
      if (answer === STOP_THESE_CARRY_ON) {
        await self.stopRuns(ctx.runIds ?? []);
        // Give the stops time to land; the hold keeps new runs out meanwhile and asks again if some are still going.
        await save({ ...(await getHold(db) ?? h), deadline: later(DEADLINE_WAIT_MINUTES) });
      } else if (answer === WAIT_TEN_MORE) await save({ ...h, deadline: later(DEADLINE_WAIT_MINUTES) });
      else if (answer === CANCEL_RUNNER_UPDATE || answer === CANCEL_UPDATE) await self.cancel();
      // Cards raised before BOS-1377 keep their old meanings.
      else if (answer === STOP_AND_UPDATE) await save({ ...h, force: true });
      else await save({ ...h, deadline: later(h.minutes) });
    },

    /**
     * One pass of the drain, called every few seconds. // leader-only: phase 3 runs this on the leader alone.
     * It starts a drain when update-runner.sh asked for one, swaps each idle company's runner,
     * asks at the deadline, and lifts the hold once every runner is on the new image.
     */
    async step() {
      let asked: HoldKind | null = null;
      if (trigger && (await stat(trigger).then(() => true, () => false))) {
        // The file's existence is the request; its "reason" says whether it is a setting change (BOS-594).
        asked = kindOf(await readFile(trigger, "utf8").catch(() => ""));
        await rm(trigger, { force: true });
      }
      let h = await getHold(db);
      // A real update or setting change takes over a wrap-up hold here too, not only from the button (BOS-929): its
      // trigger file must end the wrap-up and swap, or new work stays held until the owner cancels by hand.
      const takesOver = !!h && h.kind === "wrapup" && (asked === "update" || asked === "settings");
      if (asked && (!h || (asked === "settings" && h.kind !== "settings") || takesOver)) {
        await self.start({ kind: asked });
        // Re-read, so the hold carries who its start message already reached (BOS-988): the pass below tells the rest.
        h = await getHold(db);
      }
      if (!h) return;

      // A wrap-up hold (BOS-929) swaps nothing and asks nothing: it only keeps new runs from starting until the
      // owner cancels it, or a real update takes it over in start() above. The scheduler's hold already does that.
      if (h.kind === "wrapup") return;

      // BOS-988: the hold's own message went only to the runs going when it started, and the runner puts a message
      // behind the run's current turn. A run that started just before the hold (its start already on the wire) or
      // just after it would never hear it, so each pass tells the still-running runs once. A wrap-up the owner asked
      // for during the update keeps its own promise too: a run that starts now still gets its wrap-up message.
      const startTold = await tell(h.kind === "settings" ? WRAP_UP_SETTINGS : WRAP_UP, h, "startTold");
      h = (await getHold(db)) ?? h;
      if (h.wrapSince) await tell(WRAP_UP_DURING_UPDATE, h, "wrapTold");
      h = (await getHold(db)) ?? h;
      // Merge in the run -> told map from this pass, so the hold saved at the end of the pass keeps them.
      h = { ...h, startTold };

      let fleet: FleetRunner[];
      try {
        fleet = await deps.fleet();
      } catch (err) {
        deps.log?.(`drain: the launcher did not answer: ${(err as Error).message}`);
        return;
      }
      if (fleet.some((r) => r.current === undefined)) {
        await end("Runner update stopped", "page", "The launcher is older than the server and cannot say which runners are on the new image. Update the launcher (scripts/deploy.sh --runner), then start the update again.");
        return;
      }
      const t = now();
      // BOS-1471: running check jobs hold a swap like agent runs do, with the same deadline and the same ask.
      const first = await runnerBusy(db);
      let active = first.byCompany;
      const total = first.runsTotal + first.checksTotal;
      if (!h.force && total > 0 && t >= new Date(h.deadline)) await askAtDeadline(h, first.runsTotal, active.size, first.checksTotal);

      const failed = { ...h.failed };
      const swapped = { ...h.swapped };
      const tries = { ...h.tries };
      for (const r of fleet) {
        if (!needsSwap(h, r, swapped) || failed[r.slug]) continue;
        if (swapped[r.slug] && t.getTime() - new Date(swapped[r.slug]!).getTime() < 60_000) continue;
        if (tries[r.slug] && t < new Date(tries[r.slug]!.next)) continue; // a failed swap, waiting for its next try
        if (!h.force && r.companyId && (active.get(r.companyId) ?? 0) > 0) continue;
        // A pass that began before the hold may still be launching; wait for it, then look again.
        await deps.settled();
        active = await busyByCompany();
        if (!h.force && r.companyId && (active.get(r.companyId) ?? 0) > 0) continue;
        try {
          // Said before the call, so the runner's next hello is recorded as this, not as a crash (BOS-594).
          if (r.companyId) await expectRestart(db, r.companyId, h.kind === "settings" ? "setting change" : "update", now());
          await deps.recreate(r.slug); // leader-only
          swapped[r.slug] = now().toISOString();
          delete tries[r.slug];
        } catch (err) {
          const why = (err as Error).message;
          const n = (tries[r.slug]?.n ?? 0) + 1;
          deps.log?.(`drain: could not recreate ${r.slug} (try ${n} of ${swapTries}): ${why}`);
          // A network guard failure is not the new image's fault: the previous image starts behind the same guard,
          // so trying again or going back can't help. It is reported at once.
          const guardFault = /network guard/i.test(why);
          if (!guardFault && n < swapTries) {
            tries[r.slug] = { n, next: new Date(now().getTime() + swapRetryMs * 2 ** (n - 1)).toISOString(), last: why };
            continue;
          }
          delete tries[r.slug];
          failed[r.slug] = guardFault ? why : await goBack(r.slug, why, n);
        }
      }
      h = { ...h, swapped, failed, tries };
      // No swap for twice the reconnect time while runners still wait: say so once, so a hold is never silently stuck.
      // A runner whose swap failed and is being tried again is not stuck: it is on its retry schedule (BOS-382), and the end of it pages.
      const waiting = fleet.filter((r) => !r.current && !failed[r.slug] && !swapped[r.slug] && !tries[r.slug]);
      if (waiting.length && !h.stalledPaged) {
        const lastProgress = Math.max(new Date(h.since).getTime(), ...Object.values(swapped).map((s) => new Date(s).getTime()));
        if (t.getTime() - lastProgress >= 2 * reconnectMs) {
          h = { ...h, stalledPaged: true };
          const minutes = Math.round((t.getTime() - lastProgress) / 60_000);
          // A company with work runs going is waited for on purpose (BOS-497): say so, rather than call the update stuck.
          const busy = (r: FleetRunner) => !h!.force && !!r.companyId && (active.get(r.companyId) ?? 0) > 0;
          const idle = waiting.filter((r) => !busy(r));
          const busyList = waiting.filter(busy).map((r) => r.slug);
          if (!idle.length)
            await deps.notify({ companyId: null, level: "page", title: "Runner update is waiting for running work", body: `No runner has been swapped for ${minutes} minutes because ${busyList.join(", ")} still ${busyList.length === 1 ? "has" : "have"} work runs or checks going. This wait is on purpose: each runner is swapped as soon as its runs finish, and at the deadline you are asked whether to stop them. New runs are held everywhere until then. To stop waiting, open Settings > Server and runner and cancel the update.`, link: "#/settings" });
          else
            await deps.notify({ companyId: null, level: "page", title: "Runner update is stuck", body: `No runner has been swapped for ${minutes} minutes. Still waiting on: ${idle.map((r) => r.slug).join(", ")}${busyList.length ? ` (and on ${busyList.join(", ")}, which still ${busyList.length === 1 ? "has" : "have"} work runs or checks going)` : ""}. New runs are held everywhere. Open Settings > Server and runner: wait for that company to finish, or cancel the update.`, link: "#/settings" });
        }
      }
      await save(h);

      if (fleet.some((r) => needsSwap(h!, r, swapped) && !failed[r.slug] && !swapped[r.slug])) return; // still waiting for an idle company
      // Everything is swapped or failed. Re-read what runs the new image before judging.
      const after = await deps.fleet().catch(() => fleet);
      if (h.kind !== "settings" && after.some((r) => !r.current && !failed[r.slug])) return;
      const slow: string[] = [];
      for (const r of after) {
        const at = swapped[r.slug];
        if (!at || !r.companyId || (await deps.connected(r.companyId))) continue;
        if (now().getTime() - new Date(at).getTime() < reconnectMs) return; // give it time to dial in
        slow.push(r.slug);
      }
      // A runner that failed to swap but came back by itself on the new image needs nothing from the owner.
      for (const r of after) if (failed[r.slug] && r.current && r.companyId && (await deps.connected(r.companyId))) delete failed[r.slug];
      const bad = [...Object.entries(failed).map(([s, m]) => `${s}: ${m}`), ...slow.map((s) => `${s}: has not reconnected`)];
      // The hold lifts either way: keeping every company stopped for one runner would cost more than it protects.
      const settingsDone = h.kind === "settings";
      if (bad.length) await end(settingsDone ? "Runner restart for a setting change finished with problems" : "Runner update finished with problems", "page", `${bad.join("; ")}. New runs have started again. Check Settings > Runner for those companies.`);
      else if (settingsDone) await end("Runners restarted with the new settings", "note", `${after.length ? `All ${after.length} runner${after.length === 1 ? " was" : "s were"}` : "No runners were"} recreated after their runs finished. New runs have started again.`);
      else await end("Runners updated", "note", `${after.length ? `All ${after.length} runner${after.length === 1 ? " is" : "s are"}` : "No runners were"} on the new image. New runs have started again.${await workerUpdateSteps()}`);
    },
  };
  return self;
}
export type Maintenance = ReturnType<typeof maintenanceService>;
