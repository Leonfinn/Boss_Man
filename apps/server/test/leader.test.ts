// Leader election and the separate migrate step need a real Postgres (PGlite cannot share locks across
// processes). They run when TEST_DATABASE_URL is set (CI provides it) and are skipped otherwise.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { createLeader, LEADER_LOCK_KEY, type Leader } from "../src/leader.js";
import { assertMigrated, MIGRATE_LOCK_KEY, runMigrations } from "../src/db/migrate-lib.js";

const URL = process.env.TEST_DATABASE_URL;
const FAST = 100;

async function waitFor(ok: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const made: Leader[] = [];
const mk = (o: Parameters<typeof createLeader>[0] = {}) => {
  const l = createLeader({ url: URL, intervalMs: FAST, ...o });
  made.push(l);
  return l;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map((l) => l.stop()));
});

it("kill switch and PGlite: always the leader, no lock, signals ignored", async () => {
  for (const o of [{ url: "postgres://nowhere.invalid/x", enabled: false }, { url: undefined }]) {
    const a = createLeader(o);
    const b = createLeader({ ...o, role: "standby" });
    let promoted = 0;
    a.onPromote(() => void promoted++);
    await a.start();
    await b.start();
    await a.demote();
    expect([a.role(), a.isLeader(), b.isLeader(), promoted]).toEqual(["single", true, true, 1]);
  }
});

describe.skipIf(!URL)("leader lock (real Postgres)", () => {
  it("two instances: exactly one leads, and a standby never contests", async () => {
    const a = mk();
    const b = mk();
    const s = mk({ role: "standby" });
    await Promise.all([a.start(), b.start(), s.start()]);
    await new Promise((r) => setTimeout(r, 4 * FAST));
    expect([a, b].filter((l) => l.isLeader())).toHaveLength(1);
    expect(s.role()).toBe("standby");
    expect(a.role() === "leader" || b.role() === "leader").toBe(true);
  });

  it("leader connection killed: it steps down at once and a leader is back within seconds", async () => {
    const a = mk();
    await a.start();
    const b = mk();
    const demoted = new Promise<void>((r) => a.onDemote(r));
    await b.start();
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
    const admin = new Client({ connectionString: URL });
    await admin.connect();
    const started = Date.now();
    await admin.query("select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and ((classid::bigint << 32) | objid::bigint) = $1::bigint and granted", [LEADER_LOCK_KEY]);
    await admin.end();
    await demoted;
    // Both keep contesting, so either may win the race; what matters is that exactly one does, quickly.
    await waitFor(() => a.isLeader() || b.isLeader(), 4000);
    expect(Date.now() - started).toBeLessThan(4000);
    expect([a, b].filter((l) => l.isLeader())).toHaveLength(1);
  });

  it("SIGUSR1/SIGUSR2: demote hands over and stays out; promote contests again", async () => {
    const a = mk();
    const b = mk({ role: "standby" });
    let demotions = 0;
    a.onDemote(() => void demotions++);
    await Promise.all([a.start(), b.start()]);
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
    await a.demote();
    expect([a.isLeader(), demotions]).toEqual([false, 1]);
    await new Promise((r) => setTimeout(r, 4 * FAST));
    expect([a.isLeader(), b.isLeader()]).toEqual([false, false]); // nobody contests until told to
    await b.promote();
    await waitFor(() => b.isLeader());
    await a.promote();
    await new Promise((r) => setTimeout(r, 4 * FAST));
    expect([a.isLeader(), b.isLeader()]).toEqual([false, true]); // a contests but b holds it
  });

  it("a standby server refuses runner sockets and owner writes, and a demotion drops runner sockets with 1013", async () => {
    const leader = mk();
    const { db, close } = await openPglite();
    const { app } = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, leader });
    try {
      await leader.start();
      await app.listen({ host: "127.0.0.1", port: 0 });
      const port = (app.server.address() as { port: number }).port;
      const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
      const cookie = `bm_session=${setup.cookies.find((c) => c.name === "bm_session")!.value}`;
      const companyId = (await app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "Co" } })).json().company.id as string;
      const token = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/runner`, headers: { cookie } })).json().token as string;
      expect((await app.inject({ method: "GET", url: "/api/health" })).json().role).toBe("leader");

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runner/connect`, { headers: { authorization: `Bearer ${token}` } });
      await new Promise((r) => ws.on("open", r));
      const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      await leader.demote(); // what SIGUSR1 runs
      expect(await closed).toBe(1013);

      const retry = new WebSocket(`ws://127.0.0.1:${port}/api/runner/connect`, { headers: { authorization: `Bearer ${token}` } });
      expect(await new Promise<number>((r) => retry.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0)))).toBe(503);
      expect((await app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "Two" } })).statusCode).toBe(503);
      expect((await app.inject({ method: "GET", url: `/api/runner/env`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(503);
      expect((await app.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(503);
      // BOS-1436: check bundles live only in the leader's folder, so a standby refuses their downloads too.
      expect((await app.inject({ method: "GET", url: `/api/check-bundles/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(503);
      expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode).toBe(200); // reads stay open
      expect((await app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: "wrong wrong wrong" } })).statusCode).toBe(401); // login works
      const h = (await app.inject({ method: "GET", url: "/api/health" })).json();
      expect(h.role).toBe("standby");
      expect((await app.inject({ method: "GET", url: "/api/ready" })).json().role).toBe("standby");

      await leader.promote(); // what SIGUSR2 runs
      expect((await app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "Two" } })).statusCode).toBeLessThan(300);
    } finally {
      await app.close();
      await close();
    }
  });

  describe("migrate step", () => {
    const folder = (n: number, sql = "select 1;") => {
      const dir = mkdtempSync(path.join(tmpdir(), "bm-mig-"));
      mkdirSync(path.join(dir, "meta"));
      const entries = Array.from({ length: n }, (_, i) => ({ idx: i, version: "7", when: 1_700_000_000_000 + i * 1000, tag: `000${i}_t`, breakpoints: true }));
      writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
      entries.forEach((e) => writeFileSync(path.join(dir, `${e.tag}.sql`), i0(e.idx) ? sql : "select 1;"));
      return dir;
    };
    const i0 = (i: number) => i === 0;
    const reset = async () => {
      const c = new Client({ connectionString: URL });
      await c.connect();
      await c.query("drop schema if exists drizzle cascade");
      await c.end();
    };

    it("a second migrate waits on the lock and fails at its timeout; afterwards migrating works", async () => {
      await reset();
      const slow = folder(1, "select pg_sleep(1.5);");
      const first = runMigrations(URL!, { folder: slow });
      await new Promise((r) => setTimeout(r, 400));
      await expect(runMigrations(URL!, { folder: slow, lockTimeoutMs: 300 })).rejects.toThrow(/migrate lock/);
      await first;
      await runMigrations(URL!, { folder: slow, lockTimeoutMs: 300 }); // nothing pending, lock free
      expect(MIGRATE_LOCK_KEY).not.toBe(LEADER_LOCK_KEY);
    });

    it("the server refuses an OLDER database and accepts a NEWER one", async () => {
      await reset();
      await expect(assertMigrated(URL!, folder(1))).rejects.toThrow(/older than this server/); // nothing applied yet
      await runMigrations(URL!, { folder: folder(1) });
      await assertMigrated(URL!, folder(1));
      await expect(assertMigrated(URL!, folder(2))).rejects.toThrow(/older than this server/);
      await runMigrations(URL!, { folder: folder(2) });
      await assertMigrated(URL!, folder(1)); // rollback case: database newer than the image
      await reset();
    });
  });
});
