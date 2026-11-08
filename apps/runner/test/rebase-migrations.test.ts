// BOS-690 (DR-037 fix 2): the merge gate renumbers a clashing migration itself. Real git, a real
// bare origin; the merge goes through Workspaces exactly as the gate does.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore a plain .mjs script without types
import { lintJournal, lintSnapshots } from "../../../scripts/lint-migrations.mjs";
import { mergeSnapshots } from "../src/migrations.js";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const DR = "apps/server/drizzle";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const tid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

type Snap = { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown> }> };
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file: string, v: unknown) => writeFileSync(file, JSON.stringify(v, null, 2));

/** Adds migration `num` to a work folder: SQL, a snapshot chained to the newest one, a journal entry. `edit` changes the schema. */
function addMigration(dir: string, num: number, name: string, when: number, edit: (s: Snap) => void) {
  const meta = path.join(dir, DR, "meta");
  mkdirSync(meta, { recursive: true });
  const jp = path.join(meta, "_journal.json");
  let journal: { version: string; dialect: string; entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> };
  try {
    journal = readJson(jp);
  } catch {
    journal = { version: "7", dialect: "postgresql", entries: [] };
  }
  const prev = journal.entries.at(-1);
  const prevSnap: Snap = prev ? readJson(path.join(meta, `${prev.tag.slice(0, 4)}_snapshot.json`)) : { id: "00000000-0000-0000-0000-000000000000", prevId: "", tables: { "public.t": { columns: { id: { name: "id", type: "uuid" } } } } };
  const snap: Snap = JSON.parse(JSON.stringify(prevSnap));
  snap.prevId = prevSnap.id;
  snap.id = `${sha1(`${name}${num}`).slice(0, 8)}-0000-4000-8000-000000000000`;
  edit(snap);
  const tag = `${String(num).padStart(4, "0")}_${name}`;
  writeFileSync(path.join(dir, DR, `${tag}.sql`), `-- ${tag}\nALTER TABLE t ADD COLUMN ${name} text;\n`);
  writeJson(path.join(meta, `${String(num).padStart(4, "0")}_snapshot.json`), snap);
  journal.entries.push({ idx: num, version: "7", when, tag, breakpoints: true });
  writeJson(jp, journal);
}
const addColumn = (name: string, type = "text") => (s: Snap) => void (s.tables["public.t"]!.columns[name] = { name, type });

function origin() {
  const bare = mkdtempSync(path.join(tmpdir(), "bm-rb-origin-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(path.join(tmpdir(), "bm-rb-seed-"));
  git(seed, "clone", "-q", bare, ".");
  addMigration(seed, 1, "init", 1000, () => undefined);
  addMigration(seed, 2, "second", 2000, addColumn("second"));
  writeFileSync(path.join(seed, "app.txt"), "one\ntwo\nthree\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { url: bare };
}

/** A ticket branch with its own commit. */
async function ticket(ws: Workspaces, o: { url: string }, n: number, work: (dir: string) => void) {
  const spec = { projectId: PROJECT, ticketId: tid(n), repoUrl: o.url, baseRef: "main" };
  const w = await ws.ensure(spec);
  work(w.path);
  git(w.path, "add", ".");
  git(w.path, "commit", "-qm", "ticket work");
  return spec;
}

function mainCheckout(o: { url: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-rb-main-"));
  git(dir, "clone", "-q", "-b", "main", o.url, ".");
  return dir;
}
const sqlOf = (dir: string, tag: string) => readFileSync(path.join(dir, DR, `${tag}.sql`), "utf8");

/** The lint's journal + snapshot-chain checks on a checkout. */
function lintTree(dir: string) {
  const journal = readJson(path.join(dir, DR, "meta", "_journal.json"));
  const snaps = new Map<string, unknown>();
  for (const e of journal.entries) snaps.set(`${e.tag.slice(0, 4)}_snapshot.json`, readJson(path.join(dir, DR, "meta", `${e.tag.slice(0, 4)}_snapshot.json`)));
  return [...lintJournal(journal), ...lintSnapshots(journal, snaps)];
}

describe("the merge gate renumbers a clashing migration (BOS-690)", () => {
  it("(a) two branches on the same number: the first merges, the second lands as the next one with no send-back", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => addMigration(d, 3, "alpha", 3000, addColumn("alpha")));
    const two = await ticket(ws, o, 2, (d) => addMigration(d, 3, "beta", 3100, addColumn("beta")));
    expect((await ws.merge(one, "main", "m1")).status).toBe("merged");
    const r = await ws.merge(two, "main", "m2");
    expect(r).toMatchObject({ status: "merged", renamed: [{ from: "0003_beta", to: "0004_beta" }] });
    const main = mainCheckout(o);
    expect(readJson(path.join(main, DR, "meta", "_journal.json")).entries.map((e: { tag: string }) => e.tag)).toEqual(["0001_init", "0002_second", "0003_alpha", "0004_beta"]);
    expect(lintTree(main)).toEqual([]);
    const last = readJson(path.join(main, DR, "meta", "0004_snapshot.json"));
    // Both columns are in the newest snapshot: drizzle-kit would generate nothing for a schema holding both.
    expect(Object.keys(last.tables["public.t"].columns).sort()).toEqual(["alpha", "beta", "id", "second"]);
  });

  it("(b) three branches in a row all land, numbered 0003, 0004, 0005", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const specs = [];
    for (const [i, name] of ["aa", "bb", "cc"].entries()) specs.push(await ticket(ws, o, i + 1, (d) => addMigration(d, 3, name, 3000 + i, addColumn(name))));
    const results = [];
    for (const s of specs) results.push(await ws.merge(s, "main", "m"));
    expect(results.map((r) => r.status)).toEqual(["merged", "merged", "merged"]);
    const main = mainCheckout(o);
    expect(readJson(path.join(main, DR, "meta", "_journal.json")).entries.map((e: { tag: string }) => e.tag).slice(2)).toEqual(["0003_aa", "0004_bb", "0005_cc"]);
    expect(lintTree(main)).toEqual([]);
  });

  it("(c) both change the same column differently: sent back as before", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => addMigration(d, 3, "alpha", 3000, addColumn("shared", "text")));
    const two = await ticket(ws, o, 2, (d) => addMigration(d, 3, "beta", 3100, addColumn("shared", "integer")));
    await ws.merge(one, "main", "m1");
    const r = await ws.merge(two, "main", "m2");
    expect(r.status).toBe("conflicts");
  });

  it("(d) a real code clash beside the journal clash: sent back", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => {
      addMigration(d, 3, "alpha", 3000, addColumn("alpha"));
      writeFileSync(path.join(d, "app.txt"), "one\nTWO-A\nthree\n");
    });
    const two = await ticket(ws, o, 2, (d) => {
      addMigration(d, 3, "beta", 3100, addColumn("beta"));
      writeFileSync(path.join(d, "app.txt"), "one\nTWO-B\nthree\n");
    });
    await ws.merge(one, "main", "m1");
    const r = await ws.merge(two, "main", "m2");
    expect(r.status).toBe("conflicts");
    expect((r as { files: string[] }).files).toContain("app.txt");
  });

  it("(e) prepare and finish build the same tree", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => addMigration(d, 3, "alpha", 3000, addColumn("alpha")));
    const two = await ticket(ws, o, 2, (d) => addMigration(d, 3, "beta", 3100, addColumn("beta")));
    await ws.merge(one, "main", "m1");
    const prep = await ws.merge(two, "main", "m2", {}, null, { phase: "prepare" });
    expect(prep).toMatchObject({ status: "prepared", renamed: [{ from: "0003_beta", to: "0004_beta" }] });
    if (prep.status !== "prepared") return;
    const fin = await ws.merge(two, "main", "m2", {}, null, { phase: "finish", commit: prep.commit, tree: prep.tree });
    expect(fin).toMatchObject({ status: "merged", commit: prep.commit });
    expect(git(o.url, "rev-parse", "main^{tree}")).toBe(prep.tree);
  });

  it("(f) an old `when` is lifted above main's newest and the SQL stays byte-identical", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => addMigration(d, 3, "alpha", 9000, addColumn("alpha")));
    const two = await ticket(ws, o, 2, (d) => addMigration(d, 3, "beta", 3100, addColumn("beta")));
    const branchSql = git(ws.ticketDir(tid(2)), "rev-parse", `HEAD:${DR}/0003_beta.sql`);
    await ws.merge(one, "main", "m1");
    await ws.merge(two, "main", "m2");
    const main = mainCheckout(o);
    const entries = readJson(path.join(main, DR, "meta", "_journal.json")).entries as Array<{ tag: string; when: number }>;
    expect(entries.at(-1)).toMatchObject({ tag: "0004_beta" });
    expect(entries.at(-1)!.when).toBeGreaterThan(9000);
    expect(git(main, "rev-parse", `HEAD:${DR}/0004_beta.sql`)).toBe(branchSql);
    expect(sqlOf(main, "0004_beta")).toBe("-- 0003_beta\nALTER TABLE t ADD COLUMN beta text;\n");
    expect(lintTree(main)).toEqual([]);
  });

  it("(g) clash() no longer reports a journal-only conflict, but still reports a real one", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => addMigration(d, 3, "alpha", 3000, addColumn("alpha")));
    const two = await ticket(ws, o, 2, (d) => addMigration(d, 3, "beta", 3100, addColumn("beta")));
    const three = await ticket(ws, o, 3, (d) => {
      addMigration(d, 3, "gamma", 3200, addColumn("gamma"));
      writeFileSync(path.join(d, "app.txt"), "one\nTWO-C\nthree\n");
    });
    const four = await ticket(ws, o, 4, (d) => writeFileSync(path.join(d, "app.txt"), "one\nTWO-D\nthree\n"));
    await ws.merge(one, "main", "m1");
    expect(await ws.clash(two, "main")).toEqual({ clashes: false, files: [] });
    await ws.merge(four, "main", "m4");
    expect((await ws.clash(three, "main")).clashes).toBe(true);
  });

  it("two new migrations in one branch move together, in order", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => addMigration(d, 3, "alpha", 3000, addColumn("alpha")));
    const two = await ticket(ws, o, 2, (d) => {
      addMigration(d, 3, "beta", 3100, addColumn("beta"));
      addMigration(d, 4, "beta_two", 3200, addColumn("beta2"));
    });
    await ws.merge(one, "main", "m1");
    const r = await ws.merge(two, "main", "m2");
    expect(r).toMatchObject({ status: "merged", renamed: [{ from: "0003_beta", to: "0004_beta" }, { from: "0004_beta_two", to: "0005_beta_two" }] });
    const main = mainCheckout(o);
    expect(lintTree(main)).toEqual([]);
    expect(Object.keys(readJson(path.join(main, DR, "meta", "0005_snapshot.json")).tables["public.t"].columns).sort()).toEqual(["alpha", "beta", "beta2", "id", "second"]);
  });

  it("a branch with no migration merges untouched, with no rename", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => addMigration(d, 3, "alpha", 3000, addColumn("alpha")));
    const two = await ticket(ws, o, 2, (d) => writeFileSync(path.join(d, "other.txt"), "x\n"));
    await ws.merge(one, "main", "m1");
    const r = await ws.merge(two, "main", "m2");
    expect(r.status).toBe("merged");
    expect((r as { renamed?: unknown }).renamed).toBeUndefined();
  });

  it("a branch that edits an existing migration is refused, not rebuilt", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => addMigration(d, 3, "alpha", 3000, addColumn("alpha")));
    const two = await ticket(ws, o, 2, (d) => {
      addMigration(d, 3, "beta", 3100, addColumn("beta"));
      writeFileSync(path.join(d, DR, "0002_second.sql"), "-- edited\n");
    });
    await ws.merge(one, "main", "m1");
    expect((await ws.merge(two, "main", "m2")).status).toBe("conflicts");
  });
});

describe("scripts/rebase-migrations.mjs", () => {
  it("shows the renames the gate would make, and refuses what the gate refuses", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-rb-ws-")));
    const one = await ticket(ws, o, 1, (d) => addMigration(d, 3, "alpha", 3000, addColumn("alpha")));
    const two = await ticket(ws, o, 2, (d) => addMigration(d, 3, "beta", 3100, addColumn("beta")));
    await ws.merge(one, "main", "m1");
    const clone = mkdtempSync(path.join(tmpdir(), "bm-rb-script-"));
    git(clone, "clone", "-q", o.url, ".");
    git(clone, "fetch", "-q", ws.repoDir(PROJECT), `refs/heads/bossman/${two.ticketId}:refs/heads/work`);
    const script = path.resolve(__dirname, "../../../scripts/rebase-migrations.mjs");
    const out = execFileSync("node", [script, "work", "origin/main"], { cwd: clone, encoding: "utf8" });
    expect(out).toContain("0003_beta -> 0004_beta");
  });
});

describe("mergeSnapshots", () => {
  const base = { id: "b", tables: { t: { columns: { a: { type: "x" } } } } };
  it("takes a change from one side and keeps both sides' additions", () => {
    const ours = { id: "o", tables: { t: { columns: { a: { type: "x" }, b: { type: "y" } } } } };
    const theirs = { id: "t", tables: { t: { columns: { a: { type: "x" }, c: { type: "z" } } } } };
    expect((mergeSnapshots(base, ours, theirs) as typeof base).tables.t.columns).toEqual({ a: { type: "x" }, c: { type: "z" }, b: { type: "y" } });
  });
  it("throws when both sides change the same column differently", () => {
    const ours = { id: "o", tables: { t: { columns: { a: { type: "y" } } } } };
    const theirs = { id: "t", tables: { t: { columns: { a: { type: "z" } } } } };
    expect(() => mergeSnapshots(base, ours, theirs)).toThrow();
  });
});
