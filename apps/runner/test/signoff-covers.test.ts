// BOS-734 / DR-038: an owner sign-off carries over only a clean, automatic merge of main.
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkSignoffCovers } from "../src/signoff-covers.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-covers-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV }).trim();
  const write = (f: string, c: string) => writeFileSync(path.join(dir, f), c);
  const commit = (f: string, c: string, msg: string) => {
    write(f, c);
    run("add", "-A");
    run("commit", "-qm", msg);
    return run("rev-parse", "HEAD");
  };
  const gitCode = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile("git", args, { cwd: dir, env: ENV }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout.trim(), stderr })),
    );
  run("init", "-q", "-b", "main");
  commit("a.txt", "one\ntwo\nthree\n", "base");
  run("checkout", "-q", "-b", "ticket");
  const signed = commit("mine.txt", "mine\n", "ticket work");
  run("checkout", "-q", "main");
  return { run, commit, write, gitCode, signed, dir };
}

describe("checkSignoffCovers", () => {
  it("carries a clean automatic merge of main", async () => {
    const r = repo();
    r.commit("other.txt", "x\n", "main moves");
    r.run("checkout", "-q", "ticket");
    r.run("merge", "-q", "--no-edit", "main");
    const out = await checkSignoffCovers(r.gitCode, r.signed, r.run("rev-parse", "HEAD"), "main");
    expect(out).toMatchObject({ covers: true, newCommits: 0, handMerges: 0 });
  });

  it("does not carry a commit of the ticket's own", async () => {
    const r = repo();
    r.run("checkout", "-q", "ticket");
    r.commit("more.txt", "m\n", "more work");
    const out = await checkSignoffCovers(r.gitCode, r.signed, r.run("rev-parse", "HEAD"), "main");
    expect(out).toMatchObject({ covers: false, newCommits: 1 });
  });

  it("does not carry a merge with a hand-made edit", async () => {
    const r = repo();
    r.commit("other.txt", "x\n", "main moves");
    r.run("checkout", "-q", "ticket");
    r.run("merge", "-q", "--no-edit", "--no-commit", "main");
    r.write("sneaky.txt", "new code\n");
    r.run("add", "-A");
    r.run("commit", "-qm", "merge main with a change");
    const out = await checkSignoffCovers(r.gitCode, r.signed, r.run("rev-parse", "HEAD"), "main");
    expect(out).toMatchObject({ covers: false, handMerges: 1 });
  });

  it("does not carry a merge with a clash fixed by hand", async () => {
    const r = repo();
    r.commit("a.txt", "one\nMAIN\nthree\n", "main edits a");
    r.run("checkout", "-q", "ticket");
    r.commit("a.txt", "one\nMINE\nthree\n", "ticket edits a");
    const signed = r.run("rev-parse", "HEAD");
    try {
      r.run("merge", "-q", "--no-edit", "main");
    } catch {
      /* clash expected */
    }
    r.write("a.txt", "one\nBOTH\nthree\n");
    r.run("add", "-A");
    r.run("commit", "-qm", "resolve");
    const out = await checkSignoffCovers(r.gitCode, signed, r.run("rev-parse", "HEAD"), "main");
    expect(out.covers).toBe(false);
  });

  it("does not carry a merge of another unmerged branch", async () => {
    const r = repo();
    r.run("checkout", "-q", "-b", "other");
    r.commit("o.txt", "o\n", "other ticket");
    r.run("checkout", "-q", "ticket");
    r.run("merge", "-q", "--no-edit", "other");
    const out = await checkSignoffCovers(r.gitCode, r.signed, r.run("rev-parse", "HEAD"), "main");
    expect(out.covers).toBe(false);
  });

  it("does not carry when the signed commit was rewritten away", async () => {
    const r = repo();
    r.run("checkout", "-q", "ticket");
    r.run("commit", "-q", "--amend", "-m", "reworded");
    const out = await checkSignoffCovers(r.gitCode, r.signed, r.run("rev-parse", "HEAD"), "main");
    expect(out.covers).toBe(false);
  });

  it("fails closed on an unknown commit", async () => {
    const r = repo();
    const out = await checkSignoffCovers(r.gitCode, "0".repeat(40), r.signed, "main");
    expect(out.covers).toBe(false);
  });
});
