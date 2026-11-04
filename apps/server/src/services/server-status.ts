// A read-only view of the server for the CEO, in its chat and its runs (BOS-224): what commit is
// live and when it went live, whether this server leads, this company's runner, the wakes and runs
// that are waiting or failed, the latest migration, and recent server errors (secrets redacted).
// Company-specific parts are filtered to one company; the server facts are shared by every
// company, because there is one server.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { migrationsFolder } from "../db/client.js";
import { agents, runners, runs as runsTable, tickets, wakes } from "../db/schema.js";
import type { ErrorBuffer } from "./error-buffer.js";

export type ServerStatusDeps = {
  /** "leader", "standby" or "single" (leader.ts). */
  role: () => string;
  /** Whether this company's runner has an open socket right now (runnersService.isConnected). */
  isConnected: (runnerId: string) => boolean;
  /** Whether the runner connected in the last few minutes (runnersService.isSettling). */
  isSettling?: (runnerId: string, at: Date) => boolean;
  /** When the runner's current connection opened (runnersService.connectedSince). */
  connectedSince?: (runnerId: string) => Date | null;
  /** What the host deployer last reported (selfDeployService.overview). */
  deploy: () => Promise<{ enabled: boolean; status: unknown; available: unknown; pending: boolean }>;
  /** The runner-update hold, if one is on (maintenance). */
  hold: () => Promise<{ reason: string; since: string; deadline: string; force?: boolean } | null>;
  errors: ErrorBuffer;
  /** The last hour of permission decisions for one company (permission-log.ts, BOS-306). */
  permissions?: (companyId: string) => unknown;
  /** Synthetic's cached quota reading, its age, history and this company's agents paid from it (BOS-239). */
  syntheticUsage?: (companyId: string) => Promise<unknown>;
  commit: string;
  startedAt: Date;
  now?: () => Date;
};

type DeployStatus = { target?: string; result?: string; to_commit?: string; from_commit?: string; ended?: string; message?: string } | null;
type Available = { deployed?: string; tip?: string; checkedAt?: string } | null;

const short = (sha: string | undefined | null) => (sha ? sha.slice(0, 8) : null);
const ageSeconds = (since: Date | null | undefined, now: Date) => (since ? Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000)) : null);

/** The last migration this database applied, from drizzle's own table and the journal. */
async function latestMigration(db: Db): Promise<{ appliedAt: string | null; name: string | null }> {
  let applied: number | null = null;
  try {
    const res = (await db.execute(sql`select max(created_at) as applied from drizzle.__drizzle_migrations`)) as unknown as { rows?: Array<{ applied: string | number | null }> } | Array<{ applied: string | number | null }>;
    const rows = Array.isArray(res) ? res : (res.rows ?? []);
    const v = rows[0]?.applied;
    applied = v === null || v === undefined ? null : Number(v);
  } catch {
    applied = null; // no migrations table: nothing applied
  }
  if (applied === null || Number.isNaN(applied)) return { appliedAt: null, name: null };
  // The journal maps drizzle's created_at back to the migration's file name.
  try {
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ when: number; tag: string }> };
    const hit = journal.entries.find((e) => e.when === applied);
    return { appliedAt: new Date(applied).toISOString(), name: hit?.tag ?? null };
  } catch {
    return { appliedAt: new Date(applied).toISOString(), name: null };
  }
}

export function serverStatusService(db: Db, deps: ServerStatusDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    /** The read-only server status, filtered to one company wherever it could name another's work. */
    async status(companyId: string) {
      const at = now();
      const [runner] = await db.select({ id: runners.id, imageVersion: runners.imageVersion, harnessVersions: runners.harnessVersions, lastSeenAt: runners.lastSeenAt }).from(runners).where(eq(runners.companyId, companyId));
      // Mid-swap: an update hold is on and the runner is away, or it only just came back and is
      // starting its queued runs. "Never started" alerts wait while this is true.
      const connected = runner ? deps.isConnected(runner.id) : false;
      const swapping = runner ? (connected ? !!deps.isSettling?.(runner.id, at) : !!(await deps.hold())) : false;

      // The ticket each waiting wake is for, and whether it's Urgent, so an urgent wake that is
      // waiting can be found and its reason read (BOS-253).
      const waiting = await db
        .select({ id: wakes.id, reason: wakes.reason, statusReason: wakes.statusReason, createdAt: wakes.createdAt, agent: agents.name, ticketId: wakes.ticketId, ticketUrgent: tickets.urgent })
        .from(wakes)
        .leftJoin(agents, eq(agents.id, wakes.agentId))
        .leftJoin(tickets, eq(tickets.id, wakes.ticketId))
        .where(and(eq(wakes.companyId, companyId), inArray(wakes.status, ["queued", "deferred"])))
        .orderBy(wakes.createdAt)
        .limit(20);

      const failedWakes = await db
        .select({ id: wakes.id, reason: wakes.reason, statusReason: wakes.statusReason, createdAt: wakes.createdAt, agent: agents.name })
        .from(wakes)
        .leftJoin(agents, eq(agents.id, wakes.agentId))
        .where(and(eq(wakes.companyId, companyId), eq(wakes.status, "dropped")))
        .orderBy(desc(wakes.createdAt))
        .limit(10);

      const recentRuns = await db
        .select({ id: runsTable.id, startedAt: runsTable.startedAt, endedAt: runsTable.endedAt, outcome: runsTable.outcome, purpose: runsTable.purpose, agent: agents.name })
        .from(runsTable)
        .leftJoin(agents, eq(agents.id, runsTable.agentId))
        .where(eq(runsTable.companyId, companyId))
        .orderBy(desc(runsTable.startedAt))
        .limit(10);

      const failedRuns = await db
        .select({ id: runsTable.id, startedAt: runsTable.startedAt, endedAt: runsTable.endedAt, outcome: runsTable.outcome, agent: agents.name })
        .from(runsTable)
        .leftJoin(agents, eq(agents.id, runsTable.agentId))
        .where(and(eq(runsTable.companyId, companyId), sql`(${runsTable.outcome} like 'error:%' or ${runsTable.outcome} = 'interrupted')`))
        .orderBy(desc(runsTable.endedAt))
        .limit(10);

      const deploy = await deps.deploy().catch(() => null);
      const status = (deploy?.status as DeployStatus) ?? null;
      const available = (deploy?.available as Available) ?? null;
      const recentErrors = deps.errors.recent(20, companyId);
      // Only a finished SERVER deploy says which commit is live. A refused or failed request (e.g. a runner update) names a commit that never went live.
      const serverDeployed = status?.target === "server" && status.result === "deployed";

      return {
        server: {
          role: deps.role(),
          commit: short(deps.commit),
          startedAt: deps.startedAt.toISOString(),
          uptimeSeconds: ageSeconds(deps.startedAt, at),
        },
        deploy: {
          enabled: !!deploy?.enabled,
          liveCommit: short(serverDeployed ? status?.to_commit : (available?.deployed ?? deps.commit)),
          liveSince: serverDeployed ? (status?.ended ?? null) : null,
          lastResult: status?.result ?? null,
          lastMessage: status?.message ?? null,
          pending: !!deploy?.pending,
          mainTip: short(available?.tip),
          checkedAt: available?.checkedAt ?? null,
        },
        maintenance: await deps.hold(),
        migration: await latestMigration(db),
        runner: runner
          ? {
              connected: deps.isConnected(runner.id),
              connectedSince: deps.connectedSince?.(runner.id)?.toISOString() ?? null,
              swapping,
              lastSeenAt: runner.lastSeenAt?.toISOString() ?? null, imageVersion: runner.imageVersion, harnessVersions: runner.harnessVersions ?? null,
            }
          : null,
        wakes: {
          waiting: waiting.map((w) => ({ id: w.id, agent: w.agent, reason: w.reason, ticketId: w.ticketId, urgent: !!w.ticketUrgent, held: w.statusReason, waitingSeconds: ageSeconds(w.createdAt, at) })),
          failed: failedWakes.map((w) => ({ id: w.id, agent: w.agent, reason: w.reason, why: w.statusReason, at: w.createdAt.toISOString(), ageSeconds: ageSeconds(w.createdAt, at) })),
        },
        runs: {
          recent: recentRuns.map((r) => ({ id: r.id, agent: r.agent, startedAt: r.startedAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null, outcome: r.outcome, purpose: r.purpose })),
          failures: failedRuns.map((r) => ({ id: r.id, agent: r.agent, startedAt: r.startedAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null, reason: r.outcome })),
        },
        // Only this company's lines, and only the message each was logged with: never a query, its
        // parameters or a stack. The buffer is server-wide, so lines with no company are counted,
        // not shown (security review round 2).
        errors: { count: deps.errors.count(companyId), recent: recentErrors, untagged: deps.errors.untagged() },
        // Which rule decided each permission request in the last hour, and how many cards reached the CEO and the owner (BOS-306). Resets when the server restarts.
        permissions: deps.permissions ? deps.permissions(companyId) : null,
        // The owner's own quota, so every company's CEO reads the same reading; the agents paid from
        // it are scoped to this company (see funding.syntheticUsage). A failed reading is unknown,
        // never an error, and never blocks this view.
        syntheticUsage: deps.syntheticUsage ? await deps.syntheticUsage(companyId).catch(() => []) : [],
      };
    },
  };
}
