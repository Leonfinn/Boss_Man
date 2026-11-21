// The daily database backup's status and its one alert (BOS-2176). The `backup` service of docker-compose.yml runs
// scripts/daily-backup.sh, which writes two rows to the settings table after each pass:
//   daily_backup_last    { at, file, bytes }   the newest daily backup that was saved
//   daily_backup_failed  { at, message }       the last pass failed (removed again by the next good one)
// This file only reads them. Settings → Server shows the time; when the newest backup is over 36 hours old the owner
// gets one alert, which closes itself (DR-016, clearWhen backupFresh) the moment a fresh backup is recorded.
// An install that has no backup yet (just installed, or the service was never started) is given 36 hours from the first
// time the server noticed, so nobody is alerted before the first backup could have run.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

export const BACKUP_STALE_MS = 36 * 3_600_000;
export const LAST_KEY = "daily_backup_last";
export const FAILED_KEY = "daily_backup_failed";
const WATCH_KEY = "daily_backup_watch_since";
export const BACKUP_ALERT_KEY = "alert:daily-backup";

export type DailyBackupStatus = {
  /** When the newest automatic backup was saved, or null when there is none. */
  lastAt: string | null;
  file: string | null;
  bytes: number | null;
  /** The last attempt failed (and no good one has followed): when, and why in plain words. */
  failed: { at: string; message: string } | null;
  /** Over 36 hours since the newest backup (or since the server first noticed there was none). */
  stale: boolean;
};

const iso = (x: unknown): string | null => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : null);

async function read(db: Db, key: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row && row.value && typeof row.value === "object" ? (row.value as Record<string, unknown>) : null;
}

export async function dailyBackupStatus(db: Db, now: Date): Promise<DailyBackupStatus> {
  const last = await read(db, LAST_KEY);
  const failed = await read(db, FAILED_KEY);
  const lastAt = iso(last?.at);
  const failedAt = iso(failed?.at);
  const since = lastAt ?? iso((await read(db, WATCH_KEY))?.since);
  return {
    lastAt,
    file: typeof last?.file === "string" ? last.file : null,
    bytes: typeof last?.bytes === "number" ? last.bytes : null,
    failed: failedAt ? { at: failedAt, message: typeof failed?.message === "string" ? failed.message : "The backup failed" } : null,
    stale: since !== null && now.getTime() - Date.parse(since) > BACKUP_STALE_MS,
  };
}

/** For the closer: why the alert can go (a fresh backup is recorded), or null while it can't. */
export async function backupFreshReason(db: Db, now: Date): Promise<string | null> {
  const s = await dailyBackupStatus(db, now);
  return s.lastAt && !s.stale ? `a new automatic backup was saved at ${s.lastAt}` : null;
}

export type DailyBackupDeps = {
  now: () => Date;
  homeCompany: () => Promise<string | null>;
  isOpen: (dedupeKey: string) => Promise<boolean>;
  raise: (input: Record<string, unknown>) => Promise<{ id: string } | null | undefined | unknown>;
  /** The host's filled compose prefix (`cd <checkout> && docker compose -f …`, DR-052), or null when the host hasn't reported one. */
  composeCmd?: () => Promise<string | null>;
  log?: (m: string) => void;
};

/** The owner's steps for a stopped backup service, built from host facts. `--no-deps` so the database is not recreated. */
export function backupSteps(cmd: string | null): string {
  if (!cmd) {
    return "What to do: Boss Man doesn't have this server's compose command yet (the host deployer hasn't reported it; see Settings → Server and runner → This server). On the machine that runs Boss Man, go to the folder that holds docker-compose.yml (the checkout), and run docker compose with the same -f files your server uses: up -d --no-deps backup. Then check it with ps backup, and read why it stopped with logs --tail 30 backup. Do not leave out --no-deps: without it the database is started again from the base file alone. If the disk is full, free some space; the backups restart by themselves (a pass runs every 15 minutes).";
  }
  return `What to do: on the machine that runs Boss Man, run these one at a time:\n1. ${cmd} up -d --no-deps backup\n2. ${cmd} ps backup\n3. ${cmd} logs --tail 30 backup\nIf the disk is full, free some space; the backups restart by themselves (a pass runs every 15 minutes).`;
}

export function dailyBackupService(db: Db, deps: DailyBackupDeps) {
  return {
    status: () => dailyBackupStatus(db, deps.now()),

    /** One pass (the leader's timer): starts the "nothing yet" clock, and raises the one alert when the time is up. */
    async check(): Promise<{ raised: boolean }> {
      const t = deps.now();
      const s = await dailyBackupStatus(db, t);
      if (!s.lastAt && !(await read(db, WATCH_KEY))) {
        await db.insert(settings).values({ key: WATCH_KEY, value: { since: t.toISOString() } }).onConflictDoNothing();
        return { raised: false };
      }
      if (!s.stale) return { raised: false };
      if (await deps.isOpen(BACKUP_ALERT_KEY)) return { raised: false };
      const companyId = await deps.homeCompany();
      if (!companyId) return { raised: false };
      const age = s.lastAt ? `The newest automatic backup was saved ${Math.floor((t.getTime() - Date.parse(s.lastAt)) / 3_600_000)} hours ago.` : "No automatic backup has been saved yet.";
      const why = s.failed ? `The last attempt failed: ${s.failed.message}.` : "The backup service may not be running.";
      const question = [
        `Boss Man's daily database backup is overdue. ${age} ${why}`,
        backupSteps(await deps.composeCmd?.().catch(() => null) ?? null),
        "This card closes by itself once a new backup has been saved. You get one card, not one every day.",
      ].join("\n\n");
      const card = await deps.raise({
        companyId,
        kind: "daily_backup_stale",
        question,
        from: "owner",
        why: "only the owner can start the backup service or free the disk on the host",
        dedupeKey: BACKUP_ALERT_KEY,
        clearWhen: [{ kind: "backupFresh" }],
        context: { dailyBackup: { lastAt: s.lastAt, failed: s.failed } },
      });
      if (card) deps.log?.("daily backup: raised the overdue card");
      return { raised: !!card };
    },
  };
}

export type DailyBackup = ReturnType<typeof dailyBackupService>;
