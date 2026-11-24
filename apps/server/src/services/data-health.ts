// BOS-2380: data and database health for the server health box (not server-health.ts, the memory and freeze alerts): free space on the data disk, database size and growth, query limit hits,
// long-running queries. Read on demand; checkWarnings() runs inside the hourly disk pass (services/disk.ts).
import { statfsSync } from "node:fs";
import { desc, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, decisions, serverSizeReadings } from "../db/schema.js";
import { limitCounts } from "../db/limit-counts.js";

export const HEALTH_LIMITS = { warnPercent: 0.1, warnBytes: 5 * 1024 ** 3, growthWarn: 0.5, slowSeconds: 60 };
const DAY_MS = 86_400_000;
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** First 80 characters of a query with every value removed: quoted text, numbers and $n placeholders become "?". Never parameters. */
export function maskQuery(text: string): string {
  // One left-to-right pass, closed forms first: $tag$…$tag$, E'…' (backslash escapes), '…' (doubled quotes). Then a string left open
  // (Postgres cut the text off inside it) masks from its opening quote to the end.
  const strings = /\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|\b[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|\$([A-Za-z_]\w*)?\$[\s\S]*|(?:\b[Ee])?'[\s\S]*/g;
  const flat = text
    .replace(strings, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
  return flat.slice(0, 80);
}

export type DataHealth = {
  disk: { freeBytes: number; totalBytes: number; freePercent: number } | null;
  database: { bytes: number | null; dayAgoBytes: number | null; weekAgoBytes: number | null; growthPercent7d: number | null };
  /** The last 14 daily readings, oldest first. */
  history: { day: string; bytes: number }[];
  limits: { statementTimeouts: number; poolFull: number; since: "last 24 hours (since the server started if less)" };
  slowQueries: { seconds: number; query: string }[];
  warnings: string[];
};

export function dataHealthService(db: Db, deps: { dataDir?: string; now?: () => Date; statfs?: (dir: string) => { bavail: number; blocks: number; bsize: number } } = {}) {
  const now = deps.now ?? (() => new Date());
  const dataDir = () => deps.dataDir ?? process.env.BOSSMAN_PGLITE_DIR ?? process.cwd();
  const statfs = deps.statfs ?? ((dir: string) => statfsSync(dir));

  function disk() {
    try {
      const s = statfs(dataDir());
      const totalBytes = s.blocks * s.bsize;
      const freeBytes = s.bavail * s.bsize;
      return totalBytes > 0 ? { freeBytes, totalBytes, freePercent: (freeBytes / totalBytes) * 100 } : null;
    } catch {
      return null; // a folder statfs can't read: the page says "not available" rather than failing
    }
  }

  async function dbBytes(): Promise<number | null> {
    try {
      const r = (await db.execute(sql`select pg_database_size(current_database())::bigint as bytes`)) as unknown as { rows?: { bytes: string | number }[] } | { bytes: string | number }[];
      const rows = Array.isArray(r) ? r : (r.rows ?? []);
      return rows[0] ? Number(rows[0].bytes) : null;
    } catch {
      return null;
    }
  }

  async function slowQueries(): Promise<{ seconds: number; query: string }[]> {
    try {
      const r = (await db.execute(sql`
        select extract(epoch from (now() - query_start))::int as seconds, query
          from pg_stat_activity
         where datname = current_database() and state = 'active' and pid <> pg_backend_pid()
           and now() - query_start > make_interval(secs => ${HEALTH_LIMITS.slowSeconds})
         order by query_start limit 20`)) as unknown as { rows?: { seconds: number; query: string }[] } | { seconds: number; query: string }[];
      const rows = Array.isArray(r) ? r : (r.rows ?? []);
      return rows.map((x) => ({ seconds: Number(x.seconds), query: maskQuery(String(x.query ?? "")) }));
    } catch {
      return []; // PGlite has no pg_stat_activity detail worth showing
    }
  }

  /** Keeps today's reading (first one of the day wins) and returns the readings from `days` days ago and the day before. */
  async function recordAndRead(bytes: number | null) {
    const at = now();
    if (bytes !== null) await db.insert(serverSizeReadings).values({ day: dayKey(at), dbBytes: bytes, recordedAt: at }).onConflictDoNothing();
    const since = dayKey(new Date(at.getTime() - 13 * DAY_MS));
    const rows = await db.select().from(serverSizeReadings).where(gte(serverSizeReadings.day, since)).orderBy(desc(serverSizeReadings.day));
    const near = (days: number) => rows.find((r) => r.day === dayKey(new Date(at.getTime() - days * DAY_MS)))?.dbBytes ?? null;
    const history = rows.slice(0, 14).reverse().map((r) => ({ day: r.day, bytes: Number(r.dbBytes) }));
    return { dayAgo: near(1), weekAgo: near(7), history };
  }

  function warningsFor(d: ReturnType<typeof disk>, bytes: number | null, weekAgo: number | null): string[] {
    const out: string[] = [];
    if (d && d.freeBytes < Math.max(d.totalBytes * HEALTH_LIMITS.warnPercent, HEALTH_LIMITS.warnBytes)) {
      out.push(`The server's data disk is running low: ${gb(d.freeBytes)} free of ${gb(d.totalBytes)} (${d.freePercent.toFixed(0)}%).`);
    }
    if (bytes !== null && weekAgo !== null && weekAgo > 0 && bytes / weekAgo - 1 > HEALTH_LIMITS.growthWarn) {
      out.push(`The database grew ${Math.round((bytes / weekAgo - 1) * 100)}% in 7 days, from ${gb(weekAgo)} to ${gb(bytes)}.`);
    }
    return out;
  }

  return {
    /** The page's figures, read now. */
    async read(): Promise<DataHealth> {
      const d = disk();
      const bytes = await dbBytes();
      const { dayAgo, weekAgo, history } = await recordAndRead(bytes);
      return {
        disk: d,
        database: { bytes, dayAgoBytes: dayAgo, weekAgoBytes: weekAgo, growthPercent7d: bytes !== null && weekAgo ? Math.round((bytes / weekAgo - 1) * 100) : null },
        history,
        limits: { ...limitCounts(now().getTime()), since: "last 24 hours (since the server started if less)" },
        slowQueries: await slowQueries(),
        warnings: warningsFor(d, bytes, weekAgo),
      };
    },

    /** Hourly: record the reading and raise one notice a day per company (the dedupe key holds the date). Returns the number raised. */
    async checkWarnings(): Promise<number> {
      const d = disk();
      const bytes = await dbBytes();
      const { weekAgo } = await recordAndRead(bytes);
      const warnings = warningsFor(d, bytes, weekAgo);
      if (!warnings.length) return 0;
      let raised = 0;
      for (const c of await db.select({ id: companies.id }).from(companies)) {
        const rows = await db
          .insert(decisions)
          .values({
            companyId: c.id,
            kind: "question",
            tier: "owner",
            question: `${warnings.join(" ")} See Settings → Updates → Server health. Free space on the server's disk (old Docker images, logs, backups) or move the data folder to a bigger disk; nothing is stopped by this warning.`,
            options: ["Got it"],
            recommendedOption: "Got it",
            dedupeKey: `serverhealth:${c.id}:${dayKey(now())}`,
            context: { type: "question" },
          })
          .onConflictDoNothing()
          .returning({ id: decisions.id });
        raised += rows.length;
      }
      return raised;
    },
  };
}
