// BOS-979: the secrets and private-details scan is the runner's own installed copy, run before the branch's check command.
// The branch can't switch it off, and the owner's list never reaches the command (not in its environment, not in its tree).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

const SCANNER = fileURLToPath(new URL("../../../scripts/scan-added-lines.mjs", import.meta.url));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const projectId = "22222222-2222-4222-8222-222222222222";
// Built at run time so this file holds no secret-looking literal.
const fakeToken = "gh" + "p_" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5";
const listedIp = ["192", "0", "2", "77"].join(".");

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A shared repo whose origin/main is the base, and a commit on top of it that adds `content` to notes.txt. */
function setup(content: string | Record<string, string | Buffer>) {
  const bare = tmp("bm-scan-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-scan-seed-");
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "a.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const root = tmp("bm-scan-root-");
  mkdirSync(path.join(root, "repos"), { recursive: true });
  const repo = path.join(root, "repos", `${projectId}.git`);
  git(root, "clone", "-q", "--bare", bare, repo);
  git(repo, "update-ref", "refs/remotes/origin/main", "refs/heads/main");
  const files = typeof content === "string" ? { "notes.txt": content } : content;
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(seed, name), data);
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "work");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/work");
  git(repo, "fetch", "-q", bare, "work:refs/heads/work");
  return { root, commit: git(seed, "rev-parse", "HEAD") };
}

const job = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const probe = 'printf "ran list=[%s] file=[%s]" "$BOSSMAN_SCAN_DENYLIST" "$BOSSMAN_SCAN_DENYLIST_FILE"';

describe("runner-owned scan before the check command", () => {
  it("blocks a planted fake key and never runs the branch's command", async () => {
    const { root, commit } = setup(`token ${fakeToken}\n`);
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER });
    const r = await ws.runCommitCheck({ projectId, jobId: job(1), commit }, probe, 60_000);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("BLOCKED github-token at notes.txt:1");
    expect(r.output).not.toContain("ran list");
    expect(r.output).not.toContain(fakeToken.slice(8, 24));
  });

  it("blocks a planted listed IP without echoing it, and the command never sees the list", async () => {
    const { root, commit } = setup(`host is ${listedIp}\n`);
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER });
    const r = await ws.runCommitCheck({ projectId, jobId: job(2), commit }, probe, 60_000, { scanList: `ip\t${listedIp}` });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("BLOCKED a listed private detail was found in this change");
    expect(r.output).not.toContain("notes.txt");
    expect(r.output).not.toContain("listed-private");
    expect(r.output).not.toContain(listedIp);
  });

  it("passes a made-up example, runs the command, and hands it neither the list nor a list file", async () => {
    const { root, commit } = setup("host is 192.168.1.50 or myserver.example.com\n");
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER });
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("bm-scan-") && existsSync(path.join(tmpdir(), n, "list")));
    const r = await ws.runCommitCheck({ projectId, jobId: job(3), commit }, probe, 60_000, { scanList: `ip\t${listedIp}` });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("ran list=[] file=[]");
    expect(r.output).not.toContain(listedIp);
    // The list file is gone when the scan ends.
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("bm-scan-") && existsSync(path.join(tmpdir(), n, "list")));
    expect(after).toEqual(before);
  });

  it("still runs the secret rules with an empty list", async () => {
    const { root, commit } = setup(`x ${fakeToken}\n`);
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER });
    const r = await ws.runCommitCheck({ projectId, jobId: job(4), commit }, "echo ran", 60_000, { scanList: "" });
    expect(r.ok).toBe(false);
  });

  it("a branch that carries its own weakened scripts/scan-added-lines.mjs is still scanned by the runner's copy", async () => {
    const { root, commit } = setup(`x ${fakeToken}\n`);
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER });
    // The branch's own scripts don't matter: the command is never reached.
    const r = await ws.runCommitCheck({ projectId, jobId: job(5), commit }, "node scripts/scan-added-lines.mjs || true; echo COMMAND-REACHED", 60_000);
    expect(r.ok).toBe(false);
    expect(r.output).not.toContain("COMMAND-REACHED");
  });

  // BOS-1043 point 1: lines git would show only as "Binary files differ" are still scanned.
  it("blocks a key and a listed IP in a file the branch's .gitattributes marks -diff", async () => {
    const { root, commit } = setup({ ".gitattributes": "*.ts -diff\n", "x.ts": `const t = "${fakeToken}"; // ${listedIp}\n` });
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER });
    const r = await ws.runCommitCheck({ projectId, jobId: job(7), commit }, "echo COMMAND-REACHED", 60_000, { scanList: `ip\t${listedIp}` });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("BLOCKED github-token at x.ts:1");
    expect(r.output).toContain("BLOCKED a listed private detail was found in this change");
    const listedLine = r.output.split("\n").find((l) => l.includes("a listed private detail was found"));
    expect(listedLine).not.toContain("x.ts");
    expect(r.output).not.toContain("listed-private");
    expect(r.output).not.toContain("COMMAND-REACHED");
  });

  it("blocks a key in a file that holds a NUL byte (a UTF-16 config)", async () => {
    const { root, commit } = setup({ "conf.txt": Buffer.from(`\0a\0\nkey = ${fakeToken}\n`) });
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER });
    const r = await ws.runCommitCheck({ projectId, jobId: job(8), commit }, "echo COMMAND-REACHED", 60_000);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("BLOCKED github-token at conf.txt:2");
  });

  it("blocks a key on a NUL-carrying line of an image-named file", async () => {
    const { root, commit } = setup({ "x.png": Buffer.from(`\0${fakeToken}\0\n`) });
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER });
    const r = await ws.runCommitCheck({ projectId, jobId: job(9), commit }, "echo COMMAND-REACHED", 60_000);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("BLOCKED github-token at x.png:1");
  });

  // BOS-1043 point 2: the list is never written to a file.
  it("never writes the owner's list to a file under the temp folder while the scan runs", async () => {
    const { root, commit } = setup("host is 192.168.1.50\n");
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER });
    const seen = new Set<string>();
    const poll = setInterval(() => {
      for (const n of readdirSync(tmpdir())) if (n.startsWith("bm-scan-")) seen.add(n);
    }, 2);
    const r = await ws.runCommitCheck({ projectId, jobId: job(10), commit }, "echo ran", 60_000, { scanList: `ip\t${listedIp}` });
    clearInterval(poll);
    expect(r.ok).toBe(true);
    // Only dirs of this test file's own repos are named bm-scan-origin/seed/root; a scan scratch dir would be a bare bm-scan-XXXXXX.
    const scratch = [...seen].filter((n) => !/^bm-scan-(origin|seed|root)-/.test(n));
    expect(scratch).toEqual([]);
    // And the list still reaches the scanner: a listed IP is found.
    const bad = setup(`host ${listedIp}\n`);
    const r2 = await new Workspaces(bad.root, { ...process.env, BOSSMAN_SCAN_SCRIPT: SCANNER }).runCommitCheck({ projectId, jobId: job(11), commit: bad.commit }, "echo ran", 60_000, { scanList: `ip\t${listedIp}` });
    expect(r2.output).toContain("BLOCKED a listed private detail was found in this change");
    expect(r2.output).not.toContain("listed-private");
  });

  it("a runner without the scanner installed runs the command as before", async () => {
    const { root, commit } = setup(`x ${fakeToken}\n`);
    const env = { ...process.env };
    delete env.BOSSMAN_SCAN_SCRIPT;
    const r = await new Workspaces(root, env).runCommitCheck({ projectId, jobId: job(6), commit }, "echo ran", 60_000);
    expect(r.ok).toBe(true);
  });
});
