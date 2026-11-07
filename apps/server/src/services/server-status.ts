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
import type { AddonFacts } from "./addons.js";
import type { HostFactsRecord } from "./host-facts.js";
import type { BlueGreen } from "./bluegreen.js";
import { checkQueue } from "./check-queue.js";
import type { ErrorBuffer } from "./error-buffer.js";
import type { MemorySampler } from "./memory-sampler.js";
import { lastRestart } from "./runner-restarts.js";
import type { StallSummary } from "./stall-monitor.js";

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
  /** Both colours' /api/health, the same probe as GET /api/bluegreen (DR-020 E). Absent: treated as a single server. */
  colours?: () => Promise<BlueGreen>;
  /** The runner-update hold, if one is on (maintenance). */
  hold: () => Promise<{ reason: string; since: string; deadline: string; force?: boolean } | null>;
  errors: ErrorBuffer;
  /** Event-loop stalls, GC pauses and memory (stall-monitor.ts, BOS-432). Server-wide; route patterns only, no ids. */
  stalls?: () => StallSummary;
  /** The last hour of permission decisions for one company (permission-log.ts, BOS-306). */
  permissions?: (companyId: string) => unknown;
  /** Synthetic's cached quota reading, its age, history and this company's agents paid from it (BOS-239). */
  syntheticUsage?: (companyId: string) => Promise<unknown>;
  /** Which add-ons are running (addons.ts, DR-023): server-wide, like commit. Absent: null. */
  addons?: () => Promise<AddonFacts>;
  /** The host's settings record (host-facts.ts, BOS-419): each fact's value, source and any conflict. Absent: null. */
  hostFacts?: () => Promise<HostFactsRecord>;
  /** Where this process's memory sits, server-wide like commit (memory-sampler.ts, BOS-410). */
  memory?: Pick<MemorySampler, "status">;
  /** The run limits in force and the work runs going, across all companies and in this one (scheduler.runLimits, BOS-582). Absent: null. */
  runLimits?: (companyId: string) => Promise<unknown>;
  commit: string;
  startedAt: Date;
  now?: () => Date;
};

type DeployStatus = { target?: string; result?: string; to_commit?: string; from_commit?: string; ended?: string; message?: string } | null;
type Available = { deployed?: string; tip?: string; checkedAt?: string; soakSeconds?: number | null } | null;
export type Stack = "healthy" | "degraded" | "down";

/** The host's default standby window (SOAK_SECONDS in host-deployer.sh) when the host doesn't report its own. */
const DEFAULT_SOAK_SECONDS = 900;
const leads = (role: string | null | undefined) => role === "leader" || role === "single";

/**
 * One word for the whole stack (DR-020 E), with the reasons in plain words. "down": no database or
 * no leader. "degraded": the deployer's last result was failed or partial (it stays degraded until a
 * later deploy result replaces it), two leaders, or the other colour is down while the deployer's
 * plan has it running. Outside the standby window after a swap the other colour is stopped on
 * purpose (host-deployer.sh soak_tick), so its being down then is healthy.
 * TODO(DR-020 D): when the deployer reports its health checklist, take its overall result here too.
 */
export function stackSummary(input: { role: string; colours: BlueGreen | null; dbStartedAt: string | null; status: DeployStatus; available: Available; now: Date }): { stack: Stack; why: string[] } {
  const down: string[] = [];
  const degraded: string[] = [];
  if (!input.dbStartedAt) down.push("The database did not answer.");
  const bg = input.colours;
  const self = bg?.enabled ? bg.colours.find((c) => c.colour === bg.self) : undefined;
  const others = bg?.enabled ? bg.colours.filter((c) => c.colour !== bg.self) : [];
  // This process's own role is fresher than its probe entry, so it is counted from deps.role.
  const leaders = (leads(input.role) ? 1 : 0) + others.filter((c) => c.up && leads(c.role)).length;
  if (leaders === 0) down.push("No server answers as leader.");
  if (leaders > 1) degraded.push("More than one server says it leads.");
  if (bg === null) degraded.push("The other colour could not be checked.");
  const s = input.status;
  if (s && (s.result === "failed" || s.result === "partial")) degraded.push(`The last ${s.target === "runner" ? "runner" : "server"} deploy ${s.result === "partial" ? "only partly worked" : "failed"}${s.message ? `: ${s.message}` : "."}`);
  if (bg?.enabled && self) {
    const ended = s?.target === "server" && s.result === "deployed" && s.ended ? Date.parse(s.ended) : NaN;
    const soakMs = (input.available?.soakSeconds ?? DEFAULT_SOAK_SECONDS) * 1000;
    const inStandbyWindow = !Number.isNaN(ended) && input.now.getTime() < ended + soakMs;
    for (const c of others) if (!c.up && inStandbyWindow) degraded.push(`${c.colour} is down, but it should be running as a standby until the standby window after the last update ends.`);
  }
  if (down.length) return { stack: "down", why: [...down, ...degraded] };
  if (degraded.length) return { stack: "degraded", why: degraded };
  return { stack: "healthy", why: [] };
}

const short = (sha: string | undefined | null) => (sha ? sha.slice(0, 8) : null);
const ageSeconds = (since: Date | null | undefined, now: Date) => (since ? Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000)) : null);

/** When the database server last started (pg_postmaster_start_time), or null if it didn't answer. */
async function databaseStartedAt(db: Db): Promise<string | null> {
  try {
    const res = (await db.execute(sql`select pg_postmaster_start_time() as started`)) as unknown as { rows?: Array<{ started: unknown }> } | Array<{ started: unknown }>;
    const v = (Array.isArray(res) ? res : (res.rows ?? []))[0]?.started;
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

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
      // A failed probe is "couldn't check", never "single server": that would hide a down colour.
      const colours = deps.colours ? await deps.colours().catch(() => null) : ({ enabled: false } as const);
      const dbStartedAt = await databaseStartedAt(db);
      const role = deps.role();
      const { stack, why } = stackSummary({ role, colours, dbStartedAt, status, available, now: at });

      return {
        // Report "up" only from this (DR-020 E): one server answering says nothing about the rest.
        stack,
        stackWhy: why,
        colours,
        database: { startedAt: dbStartedAt },
        server: {
          role,
          commit: short(deps.commit),
          startedAt: deps.startedAt.toISOString(),
          uptimeSeconds: ageSeconds(deps.startedAt, at),
          // This process only (the colour that answered), in MiB; no company data (BOS-410).
          memory: deps.memory ? deps.memory.status() : null,
        },
        // Freezes over 1 s with memory, GC and requests in flight (BOS-432), plus the memory reading now.
        stalls: deps.stalls?.() ?? null,
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
        // The all-companies and per-company run limits and how many work runs each has going (BOS-582).
        // A wake held "at a concurrency limit: all companies" waits for the first; "this company" for the second.
        runLimits: deps.runLimits ? await deps.runLimits(companyId).catch(() => null) : null,
        maintenance: await deps.hold(),
        // The check queue (DR-003): what runs, who waits and at which place, the last results, and whether main is red.
        checks: await checkQueue(db).status(companyId, at),
        migration: await latestMigration(db),
        runner: runner
          ? {
              connected: deps.isConnected(runner.id),
              connectedSince: deps.connectedSince?.(runner.id)?.toISOString() ?? null,
              swapping,
              lastSeenAt: runner.lastSeenAt?.toISOString() ?? null, imageVersion: runner.imageVersion, harnessVersions: runner.harnessVersions ?? null,
              // When and why the runner last restarted (BOS-594): update, setting change, owner restart, host, crash or out of memory.
              lastRestart: await lastRestart(db, runner.id),
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
        // ntfy, Tailscale and Penpot: state (not_set_up, stopped, needs_login, running, unknown), since and source (DR-023).
        // Only "running" means the add-on is up; never tell the owner otherwise.
        addons: deps.addons ? await deps.addons() : null,
        hostFacts: deps.hostFacts ? await deps.hostFacts().catch(() => null) : null,
      };
    },
  };
}
