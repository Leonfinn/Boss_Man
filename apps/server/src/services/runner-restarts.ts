// Why each runner restarted (BOS-594). On 6 Nov nobody could explain three restarts, and each cost about
// an hour. Two sources decide the reason, in this order:
//   1. Boss Man's own intent: before it asks the launcher to recreate or restart a runner (an update drain,
//      a setting-change drain, the owner's Restart or Reconnect button) it writes why, here.
//   2. What the runner says in hello: when the host machine booted, and whether its previous process was
//      stopped from outside (SIGTERM) or ended without being told (a crash or the out-of-memory killer).
// Each restart goes into the feed (activity, kind "runner_restart") and the latest one is kept for
// server_status. Both are `settings` rows, so there is no migration and a server restart keeps them.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { record } from "./activity.js";

export const RESTART_REASONS = ["update", "setting change", "owner restart", "host", "crash or out of memory", "unknown"] as const;
export type RestartReason = (typeof RESTART_REASONS)[number];
/** The reasons Boss Man itself causes, written before it asks for the restart. */
export type RestartIntent = "update" | "setting change" | "owner restart";

const INTENT_KEY = "runner-restart-intent:";
const LAST_KEY = "runner-restart:";
/** An intent older than this is not this restart's: a recreate the launcher refused, or one long since done. */
export const INTENT_TTL_MS = 15 * 60_000;
/** A host that booted this recently, with no earlier boot time to compare, counts as a host restart. */
const FRESH_HOST_MS = 15 * 60_000;

export type Intent = { reason: RestartIntent; at: string };
export type LastRestart = { at: string; reason: RestartReason; detail: string; bootId: string; hostBootAt: string | null };
export type HelloRestart = { bootId: string; previousExit?: "stopped" | "crashed"; hostBootAt?: string };

/** Records why Boss Man is about to restart a company's runner. Call it just before the launcher call. */
export async function expectRestart(db: Db, companyId: string, reason: RestartIntent, at: Date = new Date()) {
  const value: Intent = { reason, at: at.toISOString() };
  await db.insert(settings).values({ key: `${INTENT_KEY}${companyId}`, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

const DETAIL: Record<RestartIntent, string> = {
  update: "Boss Man swapped it onto a new runner image (Build and update runners).",
  "setting change": "Boss Man recreated it with new runner settings, after the runs had drained.",
  "owner restart": "The owner pressed Restart or Reconnect in Settings.",
};

/** The reason for one restart, from what Boss Man meant to do and what the runner reported. Pure, for the tests. */
export function classifyRestart(input: { intent: Intent | null; hello: HelloRestart; previous: LastRestart | null; at: Date }): { reason: RestartReason; detail: string } {
  const { intent, hello, previous, at } = input;
  if (intent && at.getTime() - new Date(intent.at).getTime() <= INTENT_TTL_MS) return { reason: intent.reason, detail: DETAIL[intent.reason] };
  const boot = hello.hostBootAt ? new Date(hello.hostBootAt) : null;
  if (boot && !Number.isNaN(boot.getTime())) {
    const before = previous?.hostBootAt ? new Date(previous.hostBootAt) : null;
    // btime can wobble by a second between reads; a real reboot moves it by far more.
    const moved = before ? Math.abs(boot.getTime() - before.getTime()) > 60_000 : at.getTime() - boot.getTime() < FRESH_HOST_MS;
    if (moved) return { reason: "host", detail: `The host machine restarted (booted ${boot.toISOString()}).` };
  }
  if (hello.previousExit === "stopped")
    return { reason: "host", detail: "The runner was stopped or recreated on the host, outside Boss Man (by hand, for example a setting applied with docker commands, or Docker itself restarting)." };
  if (hello.previousExit === "crashed")
    return { reason: "crash or out of memory", detail: "The runner process ended without being told to stop: it crashed or ran out of memory, and Docker started it again." };
  return { reason: "unknown", detail: "The runner didn't say how its last process ended (an older runner image, or its first start)." };
}

export async function lastRestart(db: Db, runnerId: string): Promise<LastRestart | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, `${LAST_KEY}${runnerId}`));
  return (row?.value as LastRestart | undefined) ?? null;
}

/**
 * A runner said hello with a new boot id: work out why, keep it for server_status and put it in the feed.
 * `firstBoot` (no boot id was known before) only stores the host's boot time, as a baseline: there was no
 * earlier process to have restarted.
 */
export async function recordRestart(db: Db, runner: { id: string; companyId: string }, hello: HelloRestart, opts: { firstBoot: boolean; at?: Date }): Promise<LastRestart> {
  const at = opts.at ?? new Date();
  const [intentRow] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, `${INTENT_KEY}${runner.companyId}`));
  const intent = (intentRow?.value as Intent | undefined) ?? null;
  const previous = await lastRestart(db, runner.id);
  const { reason, detail } = classifyRestart({ intent, hello, previous, at });
  const last: LastRestart = { at: at.toISOString(), reason, detail, bootId: hello.bootId, hostBootAt: hello.hostBootAt ?? previous?.hostBootAt ?? null };
  await db.insert(settings).values({ key: `${LAST_KEY}${runner.id}`, value: last }).onConflictDoUpdate({ target: settings.key, set: { value: last } });
  // An intent is used once: a later restart of its own must not borrow it.
  if (intent) await db.delete(settings).where(eq(settings.key, `${INTENT_KEY}${runner.companyId}`));
  if (!opts.firstBoot)
    await record(db, { companyId: runner.companyId, kind: "runner_restart", summary: `Runner restarted (${reason}): ${detail}`, detail: { reason, bootId: hello.bootId, previousExit: hello.previousExit ?? null, hostBootAt: hello.hostBootAt ?? null }, at });
  return last;
}
