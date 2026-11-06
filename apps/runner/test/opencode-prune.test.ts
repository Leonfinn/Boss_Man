import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keepDaysFrom, opencodeDataHomes, pruneOpencodeSessions } from "../src/opencode-prune.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode-db.mjs");
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12);

/** A data home with an opencode.db and the fake's sessions, ages in days. */
function dataHome(root: string, name: string, ages: Record<string, number>) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "opencode"), { recursive: true });
  writeFileSync(path.join(dir, "opencode", "opencode.db"), "");
  writeFileSync(path.join(dir, "opencode", "sessions.json"), JSON.stringify(Object.entries(ages).map(([id, age]) => ({ id, time_updated: NOW - age * DAY }))));
  return dir;
}
const left = (dir: string) => (JSON.parse(readFileSync(path.join(dir, "opencode", "sessions.json"), "utf8")) as Array<{ id: string }>).map((s) => s.id).sort();
const calls = (dir: string) => readFileSync(path.join(dir, "opencode", "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "bm-oc-prune-"));
  const bin = path.join(root, "opencode");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  return { root, bin };
}

describe("OpenCode session prune (BOS-616)", () => {
  it("deletes sessions older than the limit, oldest first, in batches, and keeps live and recent ones", async () => {
    const { root, bin } = setup();
    const main = dataHome(root, "main", { ses_old1: 40, ses_old2: 30, ses_old3: 20, ses_live: 50, ses_new: 2, ses_edge: 13.9 });
    const logs: string[] = [];
    const opts = { keepDays: 14, batch: 2, dataHomes: [main], activeSessionIds: () => ["ses_live"], bin, now: NOW, env: { PATH: process.env.PATH }, log: (m: string) => logs.push(m) };

    expect(await pruneOpencodeSessions(opts)).toMatchObject({ databases: 1, deleted: 2, failed: 0 });
    // Oldest first, and the live one is skipped without using up a batch place.
    expect(left(main)).toEqual(["ses_edge", "ses_live", "ses_new", "ses_old3"]);
    expect(await pruneOpencodeSessions(opts)).toMatchObject({ databases: 1, deleted: 1, failed: 0 });
    expect(left(main)).toEqual(["ses_edge", "ses_live", "ses_new"]);
    // Nothing left to do: a pass only lists.
    expect(await pruneOpencodeSessions(opts)).toMatchObject({ databases: 1, deleted: 0, failed: 0 });
    expect(calls(main).at(-1)?.[0]).toBe("db");
    expect(calls(main).filter((c) => c[0] === "session").map((c) => c[2])).toEqual(["ses_old1", "ses_old2", "ses_old3"]);
    expect(logs).toEqual([]);
  });

  it("covers every fenced agent's home, skips homes without a database, and keeps going past a failed delete", async () => {
    const { root, bin } = setup();
    const main = dataHome(root, "main", { ses_a: 30 });
    const agents = path.join(root, "agents");
    const agentHome = dataHome(path.join(agents, "agent-1", ".local"), "share", { ses_b: 30, ses_c: 31 });
    mkdirSync(path.join(agents, "agent-2", ".local", "share"), { recursive: true }); // never ran OpenCode
    const homes = opencodeDataHomes({ XDG_DATA_HOME: main }, agents);
    expect(homes).toEqual([main, agentHome, path.join(agents, "agent-2", ".local", "share")]);

    const logs: string[] = [];
    const r = await pruneOpencodeSessions({ keepDays: 14, dataHomes: homes, bin, now: NOW, env: { PATH: process.env.PATH, FAKE_OPENCODE_FAIL: "ses_c" }, log: (m) => logs.push(m) });
    expect(r).toMatchObject({ databases: 2, deleted: 2, failed: 1 });
    expect([left(main), left(agentHome)]).toEqual([[], ["ses_c"]]);
    expect(logs.join("\n")).toMatch(/couldn't delete ses_c: Session not found/);
  });

  it("does nothing when turned off, without OpenCode, or when listing fails", async () => {
    const { root, bin } = setup();
    const main = dataHome(root, "main", { ses_a: 30 });
    const logs: string[] = [];
    expect(await pruneOpencodeSessions({ keepDays: 0, dataHomes: [main], bin, now: NOW })).toMatchObject({ databases: 0, deleted: 0, failed: 0 });
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], bin: path.join(root, "no-such-opencode"), now: NOW, log: (m) => logs.push(m) })).toMatchObject({ databases: 1, deleted: 0, failed: 0 });
    expect(logs).toEqual([]);
    expect(await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], bin, now: NOW, env: { PATH: process.env.PATH, FAKE_OPENCODE_LIST_FAIL: "1" }, log: (m) => logs.push(m) })).toMatchObject({ databases: 1, deleted: 0, failed: 1 });
    expect(logs.join("\n")).toMatch(/couldn't list old sessions .*database is locked/);
    expect(left(main)).toEqual(["ses_a"]);
  });

  it("gives the space back: one VACUUM while OpenCode is idle, then small incremental steps", async () => {
    const { root, bin } = setup();
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
    const busy = await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], bin, now: NOW, env, whileOpencodeIdle: async () => null, log: (m) => logs.push(m) });
    expect(busy).toMatchObject({ converted: 0, reclaimedBytes: 0, failed: 0 });
    // Not enough free disk for the VACUUM: skipped, and said so.
    await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], bin, now: NOW, env, whileOpencodeIdle: idle, freeBytes: () => 1024, log: (m) => logs.push(m) });
    expect(held).toEqual([]);
    expect(logs.join("\n")).toMatch(/needs one VACUUM to give space back, but only 0.0 GB is free/);
    expect(pages()).toBe(before);

    const first = await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], bin, now: NOW, env, whileOpencodeIdle: idle, freeBytes: () => 1024 ** 4, log: (m) => logs.push(m) });
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
    const steps = await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], bin, now: NOW, env, whileOpencodeIdle: idle, stepPages: 500, maxSteps: 3 });
    expect(held).toEqual(["on", "off"]);
    // 3 steps of 500 pages, plus the odd pointer-map page that goes with them.
    expect(steps).toMatchObject({ converted: 0 });
    expect(grown - pages()).toBeGreaterThanOrEqual(1500);
    expect(grown - pages()).toBeLessThan(1520);
    expect(steps.reclaimedBytes).toBe((grown - pages()) * 4096);
    await pruneOpencodeSessions({ keepDays: 14, dataHomes: [main], bin, now: NOW, env, stepPages: 100_000 });
    expect(Object.values(db.prepare("pragma freelist_count").get()!)[0]).toBe(0);
    db.close();
  });

  it("reads the retention setting, falling back to 14 days", () => {
    expect([keepDaysFrom(undefined), keepDaysFrom(""), keepDaysFrom("0"), keepDaysFrom("30"), keepDaysFrom("-3"), keepDaysFrom("2w")]).toEqual([14, 14, 0, 30, 14, 14]);
  });
});
