// BOS-1932: workspace.secretScan, the runner's whole-tree secrets pass over main, on a real bare origin. It fetches first
// (so a key pushed elsewhere is seen), runs the installed scanner (BOSSMAN_SCAN_SCRIPT) over git objects, and its answer
// names kind, file, line and commit but never the value. Without a scanner or a repo it says why instead of failing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const SCANNER = fileURLToPath(new URL("../../../scripts/scan-added-lines.mjs", import.meta.url));
// Made up, joined at run time so this file holds no key-shaped line.
const FAKE = ["tskey", "auth", "kAbCdEf1CNTRL-0123456789abcdef"].join("-");

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const project = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function setup(env: Record<string, string | undefined>) {
  const bare = tmp("bm-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-seed-");
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const ws = new Workspaces(tmp("bm-ws-root-"), { ...process.env, BOSSMAN_TICKET_COPIES: "worktree", ...env });
  await ws.ensure({ projectId: project, ticketId: A, repoUrl: bare, baseRef: "main" });
  return { ws, seed };
}

describe("the whole-tree secrets pass on the runner (BOS-1932)", () => {
  it("fetches main, finds a key pushed after the copy was made, and names file, line and commit, never the value", async () => {
    const { ws, seed } = await setup({ BOSSMAN_SCAN_SCRIPT: SCANNER });
    const clean = await ws.secretScan(project, "main");
    expect(clean.findings).toEqual([]);
    expect(clean.scanned).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(path.join(seed, "guide.md"), `step 1\nTS_AUTHKEY=${FAKE}\n`);
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "docs");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const added = git(seed, "rev-parse", "HEAD");

    const r = await ws.secretScan(project, "main");
    expect(r.scanned).toBe(added);
    expect(r.files).toBe(2);
    expect(r.findings).toEqual([{ kind: "tailscale-key", file: "guide.md", line: 2, commit: added, fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/), length: FAKE.length }]);
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });

  it("says why when there is nothing to scan: no scanner installed, no repo copy, no such branch", async () => {
    const without = await setup({ BOSSMAN_SCAN_SCRIPT: undefined });
    expect((await without.ws.secretScan(project, "main")).reason).toMatch(/no secrets scanner installed/);

    const { ws } = await setup({ BOSSMAN_SCAN_SCRIPT: SCANNER });
    const other = await ws.secretScan("22222222-2222-4222-8222-222222222222", "main");
    expect(other).toMatchObject({ scanned: null, findings: [] });
    expect(other.reason).toMatch(/no copy of that project's repo/);
    expect((await ws.secretScan(project, "nope")).reason).toMatch(/no branch "nope"/);
  });
});
