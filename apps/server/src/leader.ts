// "One in charge": at most one server runs the background work and accepts runners (phase 3 design, item 6).
// The leader holds a Postgres advisory lock on a dedicated connection (not the pool: a pooled connection is
// handed around, which would silently drop a session lock). Any trouble with that connection means the server
// steps down at once, without waiting for Postgres to notice, and then tries again.
//
// No lock (role "single") when BOSSMAN_LEADER_LOCK=0, or on PGlite, which cannot share locks across processes:
// the server is then always the leader, exactly as before this module existed.
//
// A freeze of this server is not a lost lock (BOS-432). pg's own query_timeout is a plain timer started when the
// query is sent, and after a freeze Node runs due timers before it reads the socket: a reply that arrived in 1 ms
// lost to a 3 s timer, and the leader stepped down and closed every runner socket. So the heartbeat keeps its own
// deadline: when it runs out it first lets the socket be read, and a timer that fired late because the event loop
// was blocked gives the query a fresh window instead of a miss. A real miss (no reply in a fair window) counts a
// strike, and only `maxMisses` in a row (BOSSMAN_LEADER_MISSES, default 2) step down. An error on the connection
// or the query still steps down at once. "One in charge" does not depend on any of these timers: another server
// can only take the lock once Postgres ends this session, and that ends our socket, which steps down here at once.
import { performance } from "node:perf_hooks";
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
  /** How long a query on the lock connection may take, in time the event loop was free (default 3 s). */
  queryTimeoutMs?: number;
  /** Heartbeats in a row without a reply before stepping down (BOSSMAN_LEADER_MISSES, default 2; 1 = the old behaviour). */
  maxMisses?: number;
  log?: (message: string) => void;
};

/** A timer counts as late (the event loop was blocked) when it fires this much after its due time. */
const LATE_MS = 500;
/** A query keeps getting fresh windows while the loop keeps freezing, but not for ever. */
const MAX_REARMS = 5;
/**
 * However the freezes fall, a query on the lock connection is given up after this much wall-clock time, and a
 * heartbeat that old steps down at once. It must stay well under the session's idle_session_timeout (30 s): if the
 * heartbeat never reached Postgres, Postgres may end the session and hand the lock on after 30 s, and by then this
 * server must have stopped acting as the leader.
 */
export const MAX_OUTSTANDING_MS = 15_000;

class QueryTimeout extends Error {}

/**
 * Waits for `p` for `ms` of time in which this process could actually run. When the timer fires it first yields
 * once (setImmediate runs after the poll phase), so a reply already sitting in the socket is read before we judge.
 * A timer that fired late means the event loop was blocked: the query gets a fresh window rather than a miss,
 * up to MAX_REARMS times and never past `maxTotalMs` of wall-clock time since `since`.
 */
export function withinFairTime<T>(p: Promise<T>, ms: number, onLate?: (lateMs: number) => void, since = performance.now(), maxTotalMs = MAX_OUTSTANDING_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    let rearms = 0;
    const arm = () => {
      const due = performance.now() + ms;
      timer = setTimeout(() => {
        const late = performance.now() - due;
        setImmediate(() => {
          if (done) return;
          if (late > LATE_MS && rearms < MAX_REARMS && performance.now() + ms - since <= maxTotalMs) {
            rearms++;
            onLate?.(late);
            return arm();
          }
          done = true;
          reject(new QueryTimeout(`no reply in ${ms} ms`));
        });
      }, ms);
    };
    arm();
    p.then(
      (v) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createLeader(opts: LeaderOptions = {}): Leader {
  const log = opts.log ?? (() => {});
  const single = !opts.url || opts.enabled === false;
  const intervalMs = opts.intervalMs ?? 2000;
  const demoteWaitMs = opts.demoteWaitMs ?? 20_000;
  const queryTimeoutMs = opts.queryTimeoutMs ?? 3000;
  const maxMisses = Math.max(1, Math.floor(opts.maxMisses ?? 2));
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
  // The heartbeat still waiting for its reply, and how many heartbeats in a row have had none.
  let beat: Promise<unknown> | null = null;
  let beatSince = 0;
  let misses = 0;

  const run = async (cbs: (() => void | Promise<void>)[], what: string) => {
    const all = Promise.all(cbs.map(async (cb) => cb())).catch((err) => log(`LEADER: ${what} callback failed: ${(err as Error).message}`));
    await Promise.race([all, new Promise((r) => setTimeout(r, demoteWaitMs).unref())]);
  };

  /** Drops the connection; Postgres frees the lock when it sees the session end. */
  const drop = async () => {
    const c = client;
    client = null;
    beat = null;
    misses = 0;
    c?.removeAllListeners("error");
    c?.removeAllListeners("end");
    c?.on("error", () => {});
    await c?.end().catch(() => {});
  };

  const late = (what: string) => (ms: number) => log(`LEADER: ${what}: the timer fired ${Math.round(ms)} ms late (this server was frozen); not a miss, waiting again`);
  /** A query on the lock connection, with a deadline that a freeze of this server cannot run out. */
  const query = <T>(what: string, p: Promise<T>) => withinFairTime(p, queryTimeoutMs, late(what));

  /** The leader's heartbeat: false once `maxMisses` beats in a row had no reply. A connection or query error throws. */
  const heartbeat = async () => {
    // One heartbeat query at a time: while the last one has not answered, keep waiting on it rather than queue more.
    if (!beat) {
      const b: Promise<unknown> = client!.query("select 1").finally(() => {
        if (beat === b) beat = null;
      });
      b.catch(() => {}); // read below; a dropped connection's late rejection must not go unhandled
      beat = b;
      beatSince = performance.now();
    }
    try {
      await withinFairTime(beat, queryTimeoutMs, late("heartbeat"), beatSince);
    } catch (err) {
      if (!(err instanceof QueryTimeout)) throw err;
      misses++;
      const age = performance.now() - beatSince;
      log(`LEADER: heartbeat miss ${misses} of ${maxMisses}: ${err.message} (waiting ${Math.round(age)} ms in all)`);
      // Too old to trust, however the misses were counted: see MAX_OUTSTANDING_MS.
      if (age >= MAX_OUTSTANDING_MS) return false;
      return misses < maxMisses;
    }
    if (misses) log(`LEADER: heartbeat answered again after ${misses} miss(es)`);
    misses = 0;
    return true;
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
        if (!(await heartbeat())) await stepDown(`no heartbeat reply ${maxMisses} time(s) in a row`);
        return;
      }
      if (!contesting) return;
      client ??= await connect();
      const r = await query("lock attempt", client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [LEADER_LOCK_KEY]));
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
    // No query_timeout: pg's is a plain timer that a freeze of this server runs out (see the top of this file).
    // Every query here goes through query() instead.
    const c = new Client({ connectionString: opts.url, keepAlive: true, keepAliveInitialDelayMillis: 5000, connectionTimeoutMillis: queryTimeoutMs });
    // An idle connection that dies emits "error" (or just "end"); step down now rather than at the next heartbeat.
    c.on("error", (err) => {
      if (client === c) void stepDown(`lost the lock connection: ${err.message}`);
    });
    c.on("end", () => {
      if (client === c) void stepDown("lost the lock connection: it closed");
    });
    try {
      await c.connect();
      // If this process dies without closing (crash, power cut, network drop), Postgres would keep the session, and
      // the lock, until TCP keepalive notices: up to 2 h by default. The heartbeat keeps a live session busy every 2 s,
      // so only a dead one sits idle this long; Postgres then ends it and the lock is free for the next server.
      // 30 s is above the 20 s a demotion may hold the connection open without heartbeats. A heartbeat still waiting
      // on its reply counts as busy, so a missed beat (BOS-432) never lets the session time out under us.
      await query("connect", c.query("set idle_session_timeout = '30s'"));
    } catch (err) {
      c.removeAllListeners("error");
      c.removeAllListeners("end");
      c.on("error", () => {});
      await c.end().catch(() => {});
      throw err;
    }
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
