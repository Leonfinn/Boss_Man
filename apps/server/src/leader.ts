// "One in charge": at most one server runs the background work and accepts runners (phase 3 design, item 6).
// The leader holds a Postgres advisory lock on a dedicated connection (not the pool: a pooled connection is
// handed around, which would silently drop a session lock). Any trouble with that connection means the server
// steps down at once, without waiting for Postgres to notice, and then tries again.
//
// No lock (role "single") when BOSSMAN_LEADER_LOCK=0, or on PGlite, which cannot share locks across processes:
// the server is then always the leader, exactly as before this module existed.
import { Client } from "pg";

/** Advisory-lock key for "this server is in charge". The migrate lock is the next number (db/migrate-lib.ts). */
export const LEADER_LOCK_KEY = 5_141_440_001;

export type Role = "leader" | "standby" | "single";

export type Leader = {
  role(): Role;
  isLeader(): boolean;
  /** Callbacks run when this server becomes, or stops being, the leader. Register before start(). */
  onPromote(cb: () => void | Promise<void>): void;
  onDemote(cb: () => void | Promise<void>): void;
  /** Makes the first attempt (so a lone server leads before it listens), then keeps contesting on a timer. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** SIGUSR1: release the lock and stay out of the contest until promote(). */
  demote(): Promise<void>;
  /** SIGUSR2: contest the lock. */
  promote(): Promise<void>;
};

export type LeaderOptions = {
  /** Postgres URL; without it (PGlite) there is no lock and the server is "single". */
  url?: string;
  /** false = BOSSMAN_LEADER_LOCK=0, the kill switch. */
  enabled?: boolean;
  /** "standby" starts without contesting until promote(). */
  role?: "auto" | "standby";
  /** Heartbeat and retry period (default 2 s). */
  intervalMs?: number;
  /** How long a demotion waits for background passes to finish (default 20 s). */
  demoteWaitMs?: number;
  log?: (message: string) => void;
};

export function createLeader(opts: LeaderOptions = {}): Leader {
  const log = opts.log ?? (() => {});
  const single = !opts.url || opts.enabled === false;
  const intervalMs = opts.intervalMs ?? 2000;
  const demoteWaitMs = opts.demoteWaitMs ?? 20_000;
  const promoted: (() => void | Promise<void>)[] = [];
  const demoted: (() => void | Promise<void>)[] = [];

  let held = single;
  let contesting = !single && opts.role !== "standby";
  let client: Client | null = null;
  let timer: NodeJS.Timeout | null = null;
  let busy: Promise<void> | null = null;
  let stopped = false;
  // true while a demotion finishes: the connection still holds the lock (advisory locks are re-entrant per session), so no re-acquiring yet.
  let stepping = false;
  let lastErr = "";

  const run = async (cbs: (() => void | Promise<void>)[], what: string) => {
    const all = Promise.all(cbs.map(async (cb) => cb())).catch((err) => log(`LEADER: ${what} callback failed: ${(err as Error).message}`));
    await Promise.race([all, new Promise((r) => setTimeout(r, demoteWaitMs).unref())]);
  };

  /** Drops the connection; Postgres frees the lock when it sees the session end. */
  const drop = async () => {
    const c = client;
    client = null;
    c?.removeAllListeners("error");
    c?.on("error", () => {});
    await c?.end().catch(() => {});
  };

  const stepDown = async (why: string) => {
    if (!held || single) return;
    held = false; // first, synchronously: from here nothing may act as the leader
    stepping = true;
    log(`LEADER: *** this server is now STANDBY (${why}) ***`);
    try {
      await run(demoted, "demote");
    } finally {
      await drop();
      stepping = false;
    }
  };

  const attempt = async () => {
    if (stopped || single || stepping) return;
    try {
      if (held) {
        await client!.query("select 1");
        return;
      }
      if (!contesting) return;
      client ??= await connect();
      const r = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [LEADER_LOCK_KEY]);
      if (!r.rows[0]?.ok) return;
      held = true;
      log("LEADER: *** this server is now the LEADER (holds the lock) ***");
      await run(promoted, "promote");
    } catch (err) {
      if (held) await stepDown(`lost the lock connection: ${(err as Error).message}`);
      else {
        const m = (err as Error).message;
        if (m !== lastErr) log(`LEADER: could not contest the lock: ${m}`);
        lastErr = m;
        await drop();
      }
    }
  };

  const connect = async () => {
    const c = new Client({ connectionString: opts.url, keepAlive: true, keepAliveInitialDelayMillis: 5000, query_timeout: 3000, connectionTimeoutMillis: 3000 });
    // An idle connection that dies emits "error"; step down now rather than at the next heartbeat.
    c.on("error", (err) => {
      if (client === c) void stepDown(`lost the lock connection: ${err.message}`);
    });
    await c.connect();
    return c;
  };

  const tick = () => {
    // One attempt at a time; a slow demotion must not stack up more.
    busy ??= attempt().finally(() => (busy = null));
    return busy;
  };

  return {
    role: () => (single ? "single" : held ? "leader" : "standby"),
    isLeader: () => held,
    onPromote: (cb) => void promoted.push(cb),
    onDemote: (cb) => void demoted.push(cb),
    async start() {
      if (single) {
        if (opts.role === "standby") log("LEADER: BOSSMAN_ROLE=standby is ignored: there is no leader lock (BOSSMAN_LEADER_LOCK=0 or PGlite), so this server is always in charge.");
        await run(promoted, "promote");
        return;
      }
      log(`LEADER: lock enabled, role ${contesting ? "auto (contesting)" : "standby (not contesting until SIGUSR2)"}`);
      await tick();
      timer = setInterval(() => void tick(), intervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await busy;
      await stepDown("shutting down");
      await drop();
    },
    async demote() {
      if (single) return void log("LEADER: SIGUSR1 ignored: no leader lock, this server is always in charge.");
      contesting = false;
      await busy;
      if (held) await stepDown("demoted by SIGUSR1");
      else log("LEADER: SIGUSR1: already standby; not contesting until SIGUSR2");
      await drop();
    },
    async promote() {
      if (single) return void log("LEADER: SIGUSR2 ignored: no leader lock, this server is always in charge.");
      contesting = true;
      log("LEADER: SIGUSR2: contesting the lock");
      await tick();
    },
  };
}
