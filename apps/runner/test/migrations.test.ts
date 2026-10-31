// BOS-219: two branches that both add 0075 can't both land, so a ticket checks its migration
// numbers against the default branch and the other open branches. Read-only on the bare clone.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNameStatus, numberOf } from "../src/migrations.js";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const ids = { project: "11111111-1111-4111-8111-111111111111", t: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const DR = "apps/server/drizzle";

function writeMigration(dir: string, n: number, name: string, when: number) {
  const tag = `${String(n).padStart(4, "0")}_${name}`;
  mkdirSync(path.join(dir, DR, "meta"), { recursive: true });
  writeFileSync(path.join(dir, DR, `${tag}.sql`), `-- ${tag}\n`);
  const jp = path.join(dir, DR, "meta", "_journal.json");
  const journal = (() => {
    try {
      return JSON.parse(execFileSync("cat", [jp], { encoding: "utf8" }));
    } catch {
      return { version: "7", dialect: "postgresql", entries: [] };
    }
  })();
  journal.entries.push({ idx: journal.entries.length, version: "7", when, tag, breakpoints: true });
  writeFileSync(jp, JSON.stringify(journal));
}

/** A bare origin whose main already has migrations 0001 and 0002. */
function origin() {
  const bare = mkdtempSync(path.join(tmpdir(), "bm-mig-origin-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(path.join(tmpdir(), "bm-mig-seed-"));
  git(seed, "clone", "-q", bare, ".");
  writeMigration(seed, 1, "init", 1000);
  writeMigration(seed, 2, "add_user", 2000);
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { url: bare, seed };
}

/** A branch on origin holding another agent's open work (not merged to main). */
function otherBranch(o: ReturnType<typeof origin>, branch: string, n: number, name: string, when: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-mig-other-"));
  git(dir, "clone", "-q", "-b", "main", o.url, ".");
  writeMigration(dir, n, name, when);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "other work");
  git(dir, "push", "-q", "origin", `HEAD:${branch}`);
}

async function ticket(n: number, name: string, when: number, base = "main") {
  const o = origin();
  const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-mig-ws-")));
  const spec = { projectId: ids.project, ticketId: ids.t, repoUrl: o.url, baseRef: base };
  const w = await ws.ensure(spec);
  writeMigration(w.path, n, name, when);
  git(w.path, "add", ".");
  git(w.path, "commit", "-qm", "ticket work");
  return { o, ws, spec, w };
}

describe("checking a ticket's migration numbers (BOS-219)", () => {
  it("says nothing is needed when the number is free", async () => {
    const { o, ws, spec } = await ticket(3, "new_table", 3000);
    otherBranch(o, "bossman/other", 4, "other", 4000);
    expect(await ws.migrations(spec, "main", ["bossman/other"])).toEqual({ needed: false, reason: "No other branch uses this ticket's migration numbers." });
  });

  it("names the clash and the next free number when main already took it", async () => {
    const { o, ws, spec } = await ticket(3, "mine", 3000);
    const dir = mkdtempSync(path.join(tmpdir(), "bm-mig-main-"));
    git(dir, "clone", "-q", o.url, ".");
    writeMigration(dir, 3, "theirs", 3100);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "main took 0003");
    git(dir, "push", "-q", "origin", "HEAD:main");
    const r = await ws.migrations(spec, "main", []);
    expect(r).toMatchObject({ needed: true, number: 3 });
    if (!r.needed) return;
    expect(r.why.join(" ")).toContain("0003_mine");
    expect(r.why.join(" ")).toContain("0003_theirs");
    expect(r.next).toBe(4);
  });

  it("catches a clash with another open branch that main doesn't have yet", async () => {
    const { o, ws, spec } = await ticket(4, "mine", 4000);
    otherBranch(o, "bossman/other", 4, "theirs", 4100);
    const r = await ws.migrations(spec, "main", ["bossman/other"]);
    expect(r).toMatchObject({ needed: true, number: 4, next: 5 });
  });

  it("counts another branch's numbers when picking the next free one", async () => {
    const { o, ws, spec } = await ticket(3, "mine", 3000);
    otherBranch(o, "bossman/other", 3, "theirs", 3100);
    otherBranch(o, "bossman/third", 4, "third", 3200);
    const r = await ws.migrations(spec, "main", ["bossman/other", "bossman/third"]);
    expect(r).toMatchObject({ needed: true, number: 3, next: 5 });
  });

  it("only merged main into the branch: no new migration, so nothing to warn about", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-mig-ws-")));
    const spec = { projectId: ids.project, ticketId: ids.t, repoUrl: o.url, baseRef: "main" };
    const w = await ws.ensure(spec);
    writeFileSync(path.join(w.path, "docs.md"), "words\n");
    git(w.path, "add", ".");
    git(w.path, "commit", "-qm", "docs only");
    expect(await ws.migrations(spec, "main", [])).toEqual({ needed: false, reason: "This ticket adds no migration, so no number is at risk." });
  });

  it("says it couldn't tell, rather than failing, for a branch or repo it can't read", async () => {
    const { ws, spec } = await ticket(3, "mine", 3000);
    const noBranch = await ws.migrations({ ...spec, ticketId: ids.other }, "main", []);
    expect(noBranch).toMatchObject({ needed: null });
    const noRepo = await ws.migrations({ ...spec, projectId: "00000000-0000-4000-8000-000000000000" }, "main", []);
    expect(noRepo).toMatchObject({ needed: null });
  });
});

describe("reading git's name-status output", () => {
  it("splits paths, and a rename's two paths, correctly", () => {
    const out = ["A", `${DR}/0003_a.sql`, "M", "x.txt", "R100", "old.sql", "new.sql", ""].join("\0");
    expect(parseNameStatus(out)).toEqual([
      { status: "A", path: `${DR}/0003_a.sql` },
      { status: "M", path: "x.txt" },
      { status: "R", path: "old.sql" },
    ]);
    expect(numberOf(`${DR}/0007_b.sql`)).toBe(7);
    expect(numberOf("README.md")).toBeNull();
  });
});
