import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keepDaysFrom, opencodeDataHomes, pruneOpencodeSessions } from "../src/opencode-prune.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode-db.mjs");
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12);

/**
 * A data home with the fake's sessions, ages in days, and a real SQLite opencode.db holding the
 * same session rows (made-up ones), so the backup has something to copy and count.
 */
function dataHome(root: string, name: string, ages: Record<string, number>, opts: { noSessionTable?: boolean } = {}) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "opencode"), { recursive: true });
  const sessions = Object.entries(ages).map(([id, age]) => ({ id, time_updated: NOW - age * DAY }));
  const db = new DatabaseSync(path.join(dir, "opencode", "opencode.db"));
  if (!opts.noSessionTable) {
    db.exec("create table session (id text primary key, time_updated integer not null)");
    const ins = db.prepare("insert into session (id, time_updated) values (?, ?)");
    for (const s of sessions) ins.run(s.id, s.time_updated);
  }
  db.close();
  writeFileSync(path.join(dir, "opencode", "sessions.json"), JSON.stringify(sessions));
  return dir;
}
const left = (dir: string) => (JSON.parse(readFileSync(path.join(dir, "opencode", "sessions.json"), "utf8")) as Array<{ id: string }>).map((s) => s.id).sort();
const calls = (dir: string) => readFileSync(path.join(dir, "opencode", "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
const runs = (dir: string) => readFileSync(path.join(dir, "opencode", "runs.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cwd: string; env: string[] });
const fakeControl = (dir: string, c: { fail?: string; listFail?: boolean }) => writeFileSync(path.join(dir, "opencode", "fake.json"), JSON.stringify(c));
const one = (file: string, sql: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.values(db.prepare(sql).get()!)[0];
  } finally {
    db.close();
  }
};
const backups = (state: string) => (existsSync(path.join(state, "backups")) ? readdirSync(path.join(state, "backups")).sort() : []);

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "bm-oc-prune-"));
  const bin = path.join(root, "opencode");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const stateDir = path.join(root, "runner-data", "opencode-prune");
  return { root, bin, stateDir };
}

describe("OpenCode session prune (BOS-616)", () => {
  it("deletes sessions older than the limit, oldest first, in batches, and keeps live and recent ones", async () => {
    const { root, bin, stateDir } = setup();
    const main = dataHome(root, "main", { ses_old1: 40, ses_old2: 30, ses_old3: 20, ses_live: 50, ses_new: 2, ses_edge: 13.9 });
    const logs: string[] = [];
    const opts = { keepDays: 14, batch: 2, dataHomes: [main], stateDir, activeSessionIds: () => ["ses_live"], bin, now: NOW, env: { PATH: process.env.PATH }, log: (m: string) => logs.push(m) };

    expect(await pruneOpencodeSessions(opts)).toMatchObject({ databases: 1, deleted: 2, failed: 0, backedUp: 1 });
    // Oldest first, and the live one is skipped without using up a batch place.
    expect(left(main)).toEqual(["ses_edge", "ses_live", "ses_new", "ses_old3"]);
    expect(await pruneOpencodeSessions(opts)).toMatchObject({ databases: 1, deleted: 1, failed: 0, backedUp: 0 });
    expect(left(main)).toEqual(["ses_edge", "ses_live", "ses_new"]);
    // Nothing left to do: a pass only lists.
    expect(await pruneOpencodeSessions(opts)).toMatchObject({ databases: 1, deleted: 0, failed: 0 });
    expect(calls(main).at(-1)?.[0]).toBe("db");
    expect(calls(main).filter((c) => c[0] === "session").map((c) => c[2])).toEqual(["ses_old1", "ses_old2", "ses_old3"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/backed up .*main \(6 sessions, .*integrity ok\)/);
  });

  it("backs each database up once before its first delete, checks the copy, and removes it after 7 days", async () => {
    const { root, bin, stateDir } = setup();
    const main = dataHome(root, "main", { ses_a: 30, ses_b: 20, ses_c: 1 });
    const logs: string[] = [];
    const opts = { keepDays: 14, batch: 1, dataHomes: [main], stateDir, bin, now: NOW, env: { PATH: process.env.PATH }, log: (m: string) => logs.push(m) };
    // Nothing old enough: no copy is made.
    expect(await pruneOpencodeSessions({ ...opts, keepDays: 60 })).toMatchObject({ deleted: 0, backedUp: 0 });
    expect(backups(stateDir)).toEqual([]);

    expect(await pruneOpencodeSessions(opts)).toMatchObject({ deleted: 1, backedUp: 1 });
    const [copyName, markerName] = backups(stateDir);
    expect([copyName, markerName].map((n) => path.extname(n!))).toEqual([".db", ".json"]);
    const copy = path.join(stateDir, "backups", copyName!);
    const marker = JSON.parse(readFileSync(path.join(stateDir, "backups", markerName!), "utf8"));
    expect(marker).toMatchObject({ dataHome: main, copy, sessions: 3, at: NOW });
    // The copy restores: it opens, passes integrity_check and holds every session from before the delete.
    expect(one(copy, "pragma integrity_check")).toBe("ok");
    expect(one(copy, "select count(*) from session")).toBe(3);
    // Later passes use the same backup.
    expect(await pruneOpencodeSessions({ ...opts, now: NOW + 6 * DAY })).toMatchObject({ deleted: 1, backedUp: 0 });
    expect(backups(stateDir)).toEqual([copyName, markerName]);
    // After 7 days the copy goes; the marker stays, so no new copy is made.
    await pruneOpencodeSessions({ ...opts, now: NOW + 7 * DAY });
    expect(backups(stateDir)).toEqual([markerName]);
    expect(JSON.parse(readFileSync(path.join(stateDir, "backups", markerName!), "utf8"))).toMatchObject({ removedAt: NOW + 7 * DAY });
    expect(logs.join("\n")).toMatch(/removed the 7-day-old backup/);
  });

  it("deletes nothing when the backup can't be made or fails its check", async () => {
    const { root, bin, stateDir } = setup();
    const logs: string[] = [];
    const env = { PATH: process.env.PATH };
    // Not enough free disk for the copy: nothing deleted, no copy, said so, and tried again next pass.
    const tight = dataHome(root, "tight", { ses_a: 30 });
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [tight], stateDir, bin, now: NOW, env, freeBytes: () => 1024, log: (m) => logs.push(m) })).toMatchObject({ deleted: 0, failed: 1, backedUp: 0 });
    expect(left(tight)).toEqual(["ses_a"]);
    expect(backups(stateDir)).toEqual([]);
    expect(logs.join("\n")).toMatch(/not deleting in .*tight yet: its backup needs/);
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [tight], stateDir, bin, now: NOW, env })).toMatchObject({ deleted: 1, backedUp: 1 });

    // The copy fails its check (here the database has no session table to count): nothing deleted, the half copy removed.
    const bad = dataHome(root, "bad", { ses_b: 30 }, { noSessionTable: true });
    const before = backups(stateDir);
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [bad], stateDir, bin, now: NOW, env, log: (m) => logs.push(m) })).toMatchObject({ deleted: 0, failed: 1, backedUp: 0 });
    expect(left(bad)).toEqual(["ses_b"]);
    expect(logs.join("\n")).toMatch(/not deleting in .*bad: its backup failed \(no such table: session\)/);
    expect(backups(stateDir).filter((n) => !before.includes(n)).map((n) => path.extname(n))).toEqual([".failed"]);
    // Not retried within a day (a bad 20 GB copy is costly), then retried.
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [bad], stateDir, bin, now: NOW + DAY - 1, env })).toMatchObject({ deleted: 0, failed: 1 });
    expect(calls(bad).filter((c) => c[0] === "session")).toEqual([]);
    const db = new DatabaseSync(path.join(bad, "opencode", "opencode.db"));
    db.exec("create table session (id text primary key, time_updated integer not null)");
    db.close();
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [bad], stateDir, bin, now: NOW + DAY, env })).toMatchObject({ deleted: 1, backedUp: 1 });

    // No folder for backups: nothing deleted at all.
    const nowhere = dataHome(root, "nowhere", { ses_c: 30 });
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [nowhere], bin, now: NOW, env, log: (m) => logs.push(m) })).toMatchObject({ databases: 0, deleted: 0 });
    expect(left(nowhere)).toEqual(["ses_c"]);
  });

  it("never starts OpenCode inside an agent home or with the runner's settings, and refuses links there (fence escape)", async () => {
    const { root, bin, stateDir } = setup();
    const agents = path.join(root, "runner-data", "agents");
    const agentHome = path.join(agents, "agent-1");
    const share = dataHome(path.join(agentHome, ".local"), "share", { ses_a: 30 });
    // The agent plants a plugin where OpenCode looks for project config from a cwd in its home.
    const planted = path.join(root, "plugin-ran");
    mkdirSync(path.join(agentHome, ".opencode", "plugin"), { recursive: true });
    writeFileSync(path.join(agentHome, ".opencode", "plugin", "x.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(planted)}, "ran");\n`);
    // The fake does load it when started inside the home, as OpenCode 1.19.3 did in Jane's probe.
    spawnSync(bin, ["db", "select id from session where time_updated < 1 order by time_updated limit 1", "--format", "json"], { cwd: share, env: { PATH: process.env.PATH, XDG_DATA_HOME: share } });
    expect(existsSync(planted)).toBe(true);
    rmSync(planted);

    const env = { PATH: process.env.PATH, HOME: root, BOSSMAN_RUNNER_TOKEN: "secret", BOSSMAN_SERVER_URL: "http://x" };
    const r = await pruneOpencodeSessions({ keepDays: 14, dataHomes: opencodeDataHomes({ XDG_DATA_HOME: path.join(root, "none") }, agents), agentsRoot: agents, stateDir, bin, now: NOW, env });
    expect(r).toMatchObject({ databases: 1, deleted: 1, failed: 0 });
    expect(existsSync(planted)).toBe(false);
    const pruneRuns = runs(share).slice(1); // the first is the control run above
    expect(pruneRuns.length).toBe(2); // list, delete
    for (const run of pruneRuns) {
      expect(run.cwd).toBe(path.join(stateDir, "cwd"));
      expect(run.env.filter((k) => k.startsWith("BOSSMAN_"))).toEqual([]);
      expect(run.env).toContain("XDG_DATA_HOME");
    }

    // A link in the agent's home could point the runner's SQLite at another file: that database is skipped.
    const logs: string[] = [];
    const other = path.join(root, "runner-file");
    writeFileSync(other, "keep me");
    symlinkSync(other, path.join(share, "opencode", "opencode.db-wal"));
    const linked = await pruneOpencodeSessions({ keepDays: 14, dataHomes: [share], agentsRoot: agents, stateDir, bin, now: NOW, env, log: (m) => logs.push(m) });
    expect(linked).toMatchObject({ deleted: 0, failed: 1 });
    expect(logs.join("\n")).toMatch(/skipping .*opencode\.db-wal isn't a regular file/);
    expect(readFileSync(other, "utf8")).toBe("keep me");
    // A linked folder on the way down is refused too.
    const agent2 = path.join(agents, "agent-2");
    mkdirSync(agent2);
    symlinkSync(path.join(agentHome, ".local"), path.join(agent2, ".local"));
    await pruneOpencodeSessions({ keepDays: 14, dataHomes: [path.join(agent2, ".local", "share")], agentsRoot: agents, stateDir, bin, now: NOW, env, log: (m) => logs.push(m) });
    expect(logs.join("\n")).toMatch(/agent-2\/\.local isn't a real folder/);
  });

  it("covers every fenced agent's home, skips homes without a database, and keeps going past a failed delete", async () => {
    const { root, bin, stateDir } = setup();
    const main = dataHome(root, "main", { ses_a: 30 });
    const agents = path.join(root, "agents");
    const agentHome = dataHome(path.join(agents, "agent-1", ".local"), "share", { ses_b: 30, ses_c: 31 });
    mkdirSync(path.join(agents, "agent-2", ".local", "share"), { recursive: true }); // never ran OpenCode
    const homes = opencodeDataHomes({ XDG_DATA_HOME: main }, agents);
    expect(homes).toEqual([main, agentHome, path.join(agents, "agent-2", ".local", "share")]);
    fakeControl(agentHome, { fail: "ses_c" });

    const logs: string[] = [];
    const r = await pruneOpencodeSessions({ keepDays: 14, dataHomes: homes, agentsRoot: agents, stateDir, bin, now: NOW, env: { PATH: process.env.PATH }, log: (m) => logs.push(m) });
    expect(r).toMatchObject({ databases: 2, deleted: 2, failed: 1, backedUp: 2 });
    expect([left(main), left(agentHome)]).toEqual([[], ["ses_c"]]);
    expect(logs.join("\n")).toMatch(/couldn't delete ses_c: Session not found/);
  });

  it("does nothing when turned off, without OpenCode, or when listing fails", async () => {
    const { root, bin, stateDir } = setup();
    const main = dataHome(root, "main", { ses_a: 30 });
    const logs: string[] = [];
    expect(await pruneOpencodeSessions({ keepDays: 0, dataHomes: [main], stateDir, bin, now: NOW })).toMatchObject({ databases: 0, deleted: 0, failed: 0 });
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], stateDir, bin: path.join(root, "no-such-opencode"), now: NOW, log: (m) => logs.push(m) })).toMatchObject({ databases: 1, deleted: 0, failed: 0 });
    expect(logs).toEqual([]);
    fakeControl(main, { listFail: true });
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], stateDir, bin, now: NOW, env: { PATH: process.env.PATH }, log: (m) => logs.push(m) })).toMatchObject({ databases: 1, deleted: 0, failed: 1 });
    expect(logs.join("\n")).toMatch(/couldn't list old sessions .*database is locked/);
    expect(left(main)).toEqual(["ses_a"]);
    expect(backups(stateDir)).toEqual([]);
  });

  it("gives the space back: one VACUUM while OpenCode is idle, then small incremental steps", async () => {
    const { root, bin, stateDir } = setup();
    const main = dataHome(root, "main", {});
    const file = path.join(main, "opencode", "opencode.db");
    // A WAL database like OpenCode's (auto_vacuum off), 2000 rows of 8 KB, three quarters then deleted.
    const db = new DatabaseSync(file);
    db.exec("pragma journal_mode = wal; create table event (id integer primary key, data text not null)");
    const fill = (from: number) => {
      const ins = db.prepare("insert into event (id, data) values (?, ?)");
      db.exec("begin");
      for (let i = from; i < from + 2000; i++) ins.run(i, "x".repeat(8192));
      db.exec("commit");
    };
    fill(0);
    db.exec("delete from event where id % 4 != 0; pragma wal_checkpoint(TRUNCATE)");
    const pages = () => Number(Object.values(db.prepare("pragma page_count").get()!)[0]);
    const before = pages();
    const env = { PATH: process.env.PATH };
    const logs: string[] = [];
    const held: string[] = [];
    const idle = async <T,>(fn: () => Promise<T>) => {
      held.push("on");
      const r = await fn();
      held.push("off");
      return r;
    };

    // A live OpenCode run: nothing happens and it is tried again next pass.
    const busy = await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], stateDir, bin, now: NOW, env, whileOpencodeIdle: async () => null, log: (m) => logs.push(m) });
    expect(busy).toMatchObject({ converted: 0, reclaimedBytes: 0, failed: 0 });
    // Not enough free disk for the VACUUM: skipped, and said so.
    await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], stateDir, bin, now: NOW, env, whileOpencodeIdle: idle, freeBytes: () => 1024, log: (m) => logs.push(m) });
    expect(held).toEqual([]);
    expect(logs.join("\n")).toMatch(/needs one VACUUM to give space back, but only 0.0 GB is free/);
    expect(pages()).toBe(before);

    const first = await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], stateDir, bin, now: NOW, env, whileOpencodeIdle: idle, freeBytes: () => 1024 ** 4, log: (m) => logs.push(m) });
    expect(first).toMatchObject({ converted: 1, failed: 0 });
    expect(held).toEqual(["on", "off"]);
    expect(pages()).toBeLessThan(before / 2);
    expect(first.reclaimedBytes).toBeGreaterThan(10 * 1024 ** 2);
    expect(Object.values(db.prepare("pragma auto_vacuum").get()!)[0]).toBe(2);
    expect(Object.values(db.prepare("select count(*) from event").get()!)[0]).toBe(500); // data kept

    // Converted: freed pages now go back in small steps, with no hold and no VACUUM.
    fill(10_000);
    db.exec("delete from event where id >= 10000");
    const grown = pages();
    const steps = await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], stateDir, bin, now: NOW, env, whileOpencodeIdle: idle, stepPages: 500, maxSteps: 3 });
    expect(held).toEqual(["on", "off"]);
    // 3 steps of 500 pages, plus the odd pointer-map page that goes with them.
    expect(steps).toMatchObject({ converted: 0 });
    expect(grown - pages()).toBeGreaterThanOrEqual(1500);
    expect(grown - pages()).toBeLessThan(1520);
    expect(steps.reclaimedBytes).toBe((grown - pages()) * 4096);
    await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], stateDir, bin, now: NOW, env, stepPages: 100_000 });
    expect(Object.values(db.prepare("pragma freelist_count").get()!)[0]).toBe(0);
    db.close();
  });

  it("kills a VACUUM that holds OpenCode runs past its cap, lets them go, says so once, and waits a day (BOS-622)", async () => {
    const { root, bin, stateDir } = setup();
    const main = dataHome(root, "main", {});
    const file = path.join(main, "opencode", "opencode.db");
    const db = new DatabaseSync(file);
    db.exec("pragma journal_mode = wal; create table event (id integer primary key, data blob not null)");
    db.exec("with recursive c(i) as (select 0 union all select i + 1 from c where i < 999) insert into event select i, randomblob(8192) from c");
    db.exec("delete from event where id % 4 != 0; pragma wal_checkpoint(TRUNCATE)");
    const one = (sql: string) => Object.values(db.prepare(sql).get()!)[0];
    const before = { pages: one("pragma page_count"), rows: one("select count(*) from event"), sum: one("select sum(length(data)) from event") };
    // A stall: another writer holds the lock, so the VACUUM sits in SQLite's busy wait (native code, 10 s).
    const blocker = new DatabaseSync(file);
    blocker.exec("begin immediate");
    const held: string[] = [];
    const idle = async <T,>(fn: () => Promise<T>) => {
      held.push("on");
      try {
        return await fn();
      } finally {
        held.push("off");
      }
    };
    const cuts: Array<{ heldMs: number; bytes: number; agentHome: boolean }> = [];
    const logs: string[] = [];
    const opts = { keepDays: 14, dataHomes: [main], stateDir, bin, now: NOW, env: { PATH: process.env.PATH }, whileOpencodeIdle: idle, freeBytes: () => 1024 ** 4, vacuumTimeoutMs: 1500, onVacuumCut: (c: (typeof cuts)[number]) => cuts.push(c), log: (m: string) => logs.push(m) };

    const t0 = Date.now();
    const r = await pruneOpencodeSessions(opts);
    const took = Date.now() - t0;
    expect(r).toMatchObject({ converted: 0, failed: 1 });
    expect(held).toEqual(["on", "off"]); // released
    expect(took).toBeLessThan(9000); // cut at the cap, not after the full 10 s busy wait (margin for a slow gate's process start)
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.heldMs).toBeGreaterThanOrEqual(1500);
    expect(cuts[0]).toMatchObject({ agentHome: false, bytes: statSync(file).size });
    expect(logs.join("\n")).toMatch(/stopped the VACUUM of .*opencode\.db after \d+ s \(the cap is 0 min\) and let OpenCode runs go again.*Not trying it again for a day/);
    blocker.exec("rollback");
    blocker.close();
    // Nothing changed: same mode, pages and data, and the file passes its check.
    expect([one("pragma auto_vacuum"), one("pragma page_count"), one("select count(*) from event"), one("select sum(length(data)) from event"), one("pragma integrity_check")]).toEqual([0, before.pages, before.rows, before.sum, "ok"]);

    // Within a day it isn't tried again (no hold at all); after a day it is, and goes through.
    expect(await pruneOpencodeSessions({ ...opts, now: NOW + DAY - 1 })).toMatchObject({ converted: 0, failed: 0 });
    expect(held).toEqual(["on", "off"]);
    // The retry runs with a generous cap, not the 1.5 s one that makes the first run stall: the blocker is gone, so the
    // VACUUM finishes on its own, and a loaded merge gate must not cut it. The cap still catches a retry that hangs.
    expect(await pruneOpencodeSessions({ ...opts, vacuumTimeoutMs: 120_000, now: NOW + DAY + 1 })).toMatchObject({ converted: 1, failed: 0 });
    expect(held).toEqual(["on", "off", "on", "off"]);
    expect(cuts).toHaveLength(1);
    db.close();
    const fresh = new DatabaseSync(file, { readOnly: true }); // a connection keeps the auto_vacuum it opened with
    expect(Object.values(fresh.prepare("pragma auto_vacuum").get()!)[0]).toBe(2);
    expect(Object.values(fresh.prepare("select count(*) from event").get()!)[0]).toBe(before.rows);
    fresh.close();
    expect(backups(stateDir).filter((n) => n.endsWith(".vacuum-cut"))).toEqual([]);
  });

  it("an interrupted VACUUM is rolled back: a database killed mid-VACUUM is intact and can be vacuumed later (BOS-622)", async () => {
    const { root, bin, stateDir } = setup();
    const main = dataHome(root, "main", {});
    const file = path.join(main, "opencode", "opencode.db");
    // Made-up data only: 2000 rows of 64 KB in a WAL database, three quarters deleted.
    const db = new DatabaseSync(file);
    db.exec("pragma journal_mode = wal; create table event (id integer primary key, data blob not null)");
    db.exec("with recursive c(i) as (select 0 union all select i + 1 from c where i < 1999) insert into event select i, randomblob(65536) from c");
    db.exec("delete from event where id % 4 != 0; pragma wal_checkpoint(TRUNCATE)");
    const one = (sql: string) => Object.values(db.prepare(sql).get()!)[0];
    const digest = () => one("select group_concat(id || ':' || hex(substr(data, 1, 8)) || ':' || length(data), ',') from (select * from event order by id)");
    const before = { pages: one("pragma page_count"), rows: one("select count(*) from event"), digest: digest() };
    db.close();

    // The same steps as the prune's VACUUM, in a process killed once the VACUUM has written into the WAL.
    const src = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("pragma auto_vacuum = 2"); process.stdout.write("go\\n"); db.exec("vacuum"); process.stdout.write("done\\n");`;
    const child = spawn(process.execPath, ["--no-warnings", "-e", src, file], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    const wal = `${file}-wal`;
    const killedAt = await new Promise<number>((resolve, reject) => {
      const poll = setInterval(() => {
        const size = statSync(wal, { throwIfNoEntry: false })?.size ?? 0;
        if (out.includes("go") && size > 2 * 1024 ** 2) {
          clearInterval(poll);
          child.kill("SIGKILL");
          resolve(size);
        }
        if (out.includes("done")) {
          clearInterval(poll);
          reject(new Error("the VACUUM finished before it could be interrupted: make the test database bigger"));
        }
      }, 2);
    });
    const [, signal] = (await once(child, "close")) as [number | null, string | null];
    expect(signal).toBe("SIGKILL");
    expect(out).not.toContain("done");
    expect(killedAt).toBeGreaterThan(2 * 1024 ** 2); // it was killed with VACUUM pages already in the WAL

    const after = new DatabaseSync(file);
    const get = (sql: string) => Object.values(after.prepare(sql).get()!)[0];
    expect([get("pragma integrity_check"), get("pragma auto_vacuum"), get("pragma page_count"), get("select count(*) from event")]).toEqual(["ok", 0, before.pages, before.rows]);
    expect(get("select group_concat(id || ':' || hex(substr(data, 1, 8)) || ':' || length(data), ',') from (select * from event order by id)")).toBe(before.digest);
    after.close();

    // And the prune's own VACUUM then goes through on it.
    const r = await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], stateDir, bin, now: NOW, env: { PATH: process.env.PATH }, whileOpencodeIdle: (fn) => fn(), freeBytes: () => 1024 ** 4 });
    expect(r).toMatchObject({ converted: 1, failed: 0 });
    const done = new DatabaseSync(file, { readOnly: true });
    expect([Object.values(done.prepare("pragma integrity_check").get()!)[0], Object.values(done.prepare("select count(*) from event").get()!)[0]]).toEqual(["ok", before.rows]);
    expect(Number(Object.values(done.prepare("pragma page_count").get()!)[0])).toBeLessThan(Number(before.pages) / 2);
    done.close();
  });

  it("reads the retention setting, falling back to 14 days", () => {
    const warned: string[] = [];
    const warn = (m: string) => warned.push(m);
    expect([keepDaysFrom(undefined, warn), keepDaysFrom("", warn), keepDaysFrom("0", warn), keepDaysFrom("30", warn), keepDaysFrom("-3", warn), keepDaysFrom("2w", warn)]).toEqual([14, 14, 0, 30, 14, 14]);
    // Junk is said out loud, not quietly replaced.
    expect(warned).toEqual(['BOSSMAN_OPENCODE_SESSION_DAYS="-3" isn\'t a whole number of days: using 14', 'BOSSMAN_OPENCODE_SESSION_DAYS="2w" isn\'t a whole number of days: using 14']);
  });
});
