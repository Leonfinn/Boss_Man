// Server-health alerts (BOS-640, DR-016). The memory sampler (BOS-410) and the stall monitor (BOS-432)
// measure the server's memory and every freeze over a second, but on their own they only write log lines:
// on 7 Nov there were 50 freezes in an hour and rss reached 17.5 GB before anyone was told. This turns
// those readings into two cards:
//
// - Memory (to the CEO): rss passes MEMORY_SHARE of the memory the server may use, or it rose more than
//   RISE_MIB in each of the last two hours.
// - Freezes (to the owner): more than FREEZE_COUNT freezes over the stall threshold in FREEZE_WINDOW_MS,
//   whatever the memory figure.
//
// "The memory the server may use" is read from inside the server's own container, so it holds on any
// Docker host: the container's cgroup limit (v2 memory.max or v1 memory.limit_in_bytes) when one is set,
// otherwise the total the kernel reports. A host-reported total (BOS-420's host memory block, once it is
// on main) can be passed in; the smallest figure wins. There are no fixed sizes here: hosts differ.
//
// Every card names what to press (an open server update card, else restarting the server) and says when
// it clears: it closes itself (alert-clearing.ts, `serverCalm`) once its rule has stayed under its level
// for CALM_MS. While a card is open, or after one was answered in the same episode, no second card is
// raised for that rule: an episode ends only when the rule has been calm for CALM_MS.
//
// It runs on the leader's timer (main.ts, "server health"), so it measures the process that serves the
// owner. The readings are this process's only and are lost on restart, which is harmless: a restart is
// the usual cure, and the calm clock then starts from the first reading of the new process.
import { readFile } from "node:fs/promises";
import os from "node:os";
import type { AlertInput } from "./alert-ladder.js";

export const MEMORY_SHARE = 0.6;
export const RISE_MIB = 1024;
export const FREEZE_COUNT = 10;
export const FREEZE_WINDOW_MS = 10 * 60_000;
export const CALM_MS = 30 * 60_000;
const HOUR = 3_600_000;
/** Readings kept: a little over the two hours the rise rule looks back. */
const KEEP_MS = 2.5 * HOUR;
/** A reading counts for "an hour ago" when it is within this of that time. */
const NEAR_MS = 10 * 60_000;
/** The calm clock only runs while readings are coming in. */
const FRESH_MS = 5 * 60_000;

export type HealthRule = "memory" | "freezes";

export type MemoryLimit = { mb: number; source: "container limit" | "host memory" | "host-reported memory" };

export type ServerHealthDeps = {
  now?: () => number;
  /** The server's rss now, in MiB. */
  rssMb?: () => number;
  /** The memory the server may use; null when nothing says (then only the rise rule applies). */
  memoryLimit?: () => Promise<MemoryLimit | null>;
  /** Freezes over the threshold since a time (epoch ms), and the longest of them. */
  stallsSince: (sinceMs: number) => { count: number; worstMs: number; thresholdMs: number };
  /** The company Boss Man's own cards go to (the oldest, as for update cards). */
  homeCompany: () => Promise<string | null>;
  /** The open server update card, if any: the card names it as the thing to do. */
  openUpdateCard: () => Promise<{ id: string; question: string } | null>;
  /** Whether a card for this rule is still open (by its dedupe key). */
  isOpen: (dedupeKey: string) => Promise<boolean>;
  raise: (input: AlertInput) => Promise<{ id: string } | null>;
  log?: (msg: string) => void;
};

const KEY: Record<HealthRule, string> = { memory: "alert:server-memory", freezes: "alert:server-freezes" };
const gb = (mib: number) => `${(mib / 1024).toFixed(1)} GB`;

/** The smallest of the container limit, the kernel's total and a host-reported total. `dir` is the cgroup mount. */
export async function readMemoryLimit(opts: { dir?: string; totalBytes?: number; hostTotalMb?: () => Promise<number | null> } = {}): Promise<MemoryLimit | null> {
  const dir = opts.dir ?? "/sys/fs/cgroup";
  const total = opts.totalBytes ?? os.totalmem();
  const read = (f: string) => readFile(`${dir}/${f}`, "utf8").then((t) => t.trim(), () => "");
  const out: MemoryLimit[] = [];
  if (total > 0) out.push({ mb: Math.floor(total / 1048576), source: "host memory" });
  for (const raw of [await read("memory.max"), await read("memory/memory.limit_in_bytes")]) {
    // "max" (v2) or a huge number (v1) means no limit: only a figure below the machine's total is one.
    const bytes = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isFinite(bytes) && bytes > 0 && (!(total > 0) || bytes < total)) out.push({ mb: Math.floor(bytes / 1048576), source: "container limit" });
  }
  const host = await opts.hostTotalMb?.().catch(() => null);
  if (host && host > 0) out.push({ mb: Math.floor(host), source: "host-reported memory" });
  if (!out.length) return null;
  return out.reduce((a, b) => (b.mb < a.mb ? b : a));
}

export function serverHealthService(deps: ServerHealthDeps) {
  const now = deps.now ?? Date.now;
  const rssMb = deps.rssMb ?? (() => Math.round(process.memoryUsage.rss() / 1048576));
  const memoryLimit = deps.memoryLimit ?? (() => readMemoryLimit());
  const log = deps.log ?? (() => {});
  const readings: { at: number; rss: number }[] = [];
  let firstCheckAt: number | null = null;
  let lastCheckAt: number | null = null;
  const lastOver: Record<HealthRule, number | null> = { memory: null, freezes: null };
  /** A card was raised in this episode: no second one until the rule has been calm for CALM_MS. */
  const raisedInEpisode: Record<HealthRule, boolean> = { memory: false, freezes: false };

  /** The latest reading at or before `at`, if it is close enough to stand for that time. */
  const near = (at: number) => {
    for (let i = readings.length - 1; i >= 0; i--) {
      const r = readings[i]!;
      if (r.at <= at) return at - r.at <= NEAR_MS ? r : null;
    }
    return null;
  };

  /** How long the rule has been under its level, or null while it isn't (or nothing is being measured). */
  function calmFor(rule: HealthRule, t = now()): number | null {
    if (firstCheckAt === null || lastCheckAt === null || t - lastCheckAt > FRESH_MS) return null;
    const from = Math.max(lastOver[rule] ?? -Infinity, firstCheckAt);
    if (lastOver[rule] !== null && lastOver[rule]! >= lastCheckAt) return null;
    return t - from;
  }

  async function action(): Promise<string> {
    const card = await deps.openUpdateCard().catch(() => null);
    if (card) {
      const title = card.question.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 100);
      return `What to do: approve the open server update card ("${title}"). Installing it restarts the server, which frees its memory and usually ends the freezes.`;
    }
    return "What to do: no server update is waiting, so restart the server. Settings has no restart button yet; until it does, restart Boss Man's server container on the machine that runs it. It is back in a minute or two, and runs pick up again after.";
  }

  async function raise(rule: HealthRule, question: string, extra: Record<string, unknown>) {
    const companyId = await deps.homeCompany();
    if (!companyId) return null;
    if (await deps.isOpen(KEY[rule])) {
      raisedInEpisode[rule] = true;
      return null;
    }
    const card = await deps.raise({
      companyId,
      question: `${question}\n\n${await action()}`,
      ...(rule === "memory"
        ? { kind: "server_memory" as const, from: "ceo" as const, why: "only the CEO or the owner can restart the server" }
        : { kind: "server_freezes" as const, from: "owner" as const, why: "only the owner can restart the server or approve an update" }),
      dedupeKey: KEY[rule],
      clearWhen: [{ kind: "serverCalm", rule }],
      context: { serverHealth: { rule, ...extra } },
    });
    raisedInEpisode[rule] = true;
    if (card) log(`server health: raised the ${rule} card ${card.id}`);
    return card;
  }

  return {
    /** One reading and both rules. Returns what it saw, for tests and server_status. */
    async check() {
      const t = now();
      const rss = rssMb();
      readings.push({ at: t, rss });
      while (readings.length && readings[0]!.at < t - KEEP_MS) readings.shift();
      firstCheckAt ??= t;
      lastCheckAt = t;

      const limit = await memoryLimit().catch(() => null);
      const share = limit && limit.mb > 0 ? rss / limit.mb : null;
      const hourAgo = near(t - HOUR);
      const twoHoursAgo = near(t - 2 * HOUR);
      const rises = hourAgo && twoHoursAgo ? [rss - hourAgo.rss, hourAgo.rss - twoHoursAgo.rss] : null;
      const highShare = share !== null && share > MEMORY_SHARE;
      const climbing = !!rises && rises.every((r) => r > RISE_MIB);
      const freezes = deps.stallsSince(t - FREEZE_WINDOW_MS);
      const tooManyFreezes = freezes.count > FREEZE_COUNT;

      // An episode ends once the rule has stayed under its level for CALM_MS.
      for (const rule of ["memory", "freezes"] as const) {
        const calm = calmFor(rule, t);
        if (calm !== null && calm >= CALM_MS) raisedInEpisode[rule] = false;
      }
      if (highShare || climbing) lastOver.memory = t;
      if (tooManyFreezes) lastOver.freezes = t;

      if ((highShare || climbing) && !raisedInEpisode.memory) {
        const why = highShare
          ? `Boss Man's server is using ${gb(rss)} of memory, ${Math.round(share! * 100)}% of the ${gb(limit!.mb)} it may use (${limit!.source}). The alert level is ${Math.round(MEMORY_SHARE * 100)}%.`
          : `Boss Man's server memory has grown more than ${gb(RISE_MIB)} in each of the last two hours: ${gb(twoHoursAgo!.rss)}, then ${gb(hourAgo!.rss)}, now ${gb(rss)}.`;
        const more = highShare && climbing ? ` It has also grown more than ${gb(RISE_MIB)} in each of the last two hours.` : "";
        await raise(
          "memory",
          `${why}${more} If it keeps climbing the server starts to freeze and then runs out of memory.\n\nThis card closes itself once memory has stayed under ${Math.round(MEMORY_SHARE * 100)}% of what the server may use, and stopped growing ${gb(RISE_MIB)} an hour, for ${CALM_MS / 60_000} minutes.`,
          { rssMb: rss, limitMb: limit?.mb ?? null, limitSource: limit?.source ?? null, rises },
        );
      }
      if (tooManyFreezes && !raisedInEpisode.freezes) {
        await raise(
          "freezes",
          `Boss Man's server froze ${freezes.count} times for over ${Math.round(freezes.thresholdMs / 1000)} s in the last ${FREEZE_WINDOW_MS / 60_000} minutes (the longest ${(freezes.worstMs / 1000).toFixed(1)} s). Pages may hang or fail to load while it does. It is using ${gb(rss)} of memory${share !== null ? ` (${Math.round(share * 100)}% of the ${gb(limit!.mb)} it may use)` : ""}.\n\nThis card closes itself once there have been ${FREEZE_COUNT} or fewer freezes in ${FREEZE_WINDOW_MS / 60_000} minutes for ${CALM_MS / 60_000} minutes in a row.`,
          { freezes: freezes.count, worstMs: freezes.worstMs, rssMb: rss, limitMb: limit?.mb ?? null },
        );
      }
      return { rssMb: rss, limit, share, rises, freezes: freezes.count, memoryOver: highShare || climbing, freezesOver: tooManyFreezes };
    },

    /** For the closer (DR-016): why the rule's card can go, or null while it can't. */
    calmReason(rule: HealthRule): string | null {
      const calm = calmFor(rule);
      if (calm === null || calm < CALM_MS) return null;
      return rule === "memory"
        ? `the server's memory has stayed under the alert level for ${Math.floor(calm / 60_000)} minutes`
        : `the server has had ${FREEZE_COUNT} or fewer freezes in every ${FREEZE_WINDOW_MS / 60_000} minutes for ${Math.floor(calm / 60_000)} minutes`;
    },
  };
}

export type ServerHealth = ReturnType<typeof serverHealthService>;
