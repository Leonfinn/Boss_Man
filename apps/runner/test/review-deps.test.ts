// BOS-693: a review copy comes with its packages installed from the shared pnpm store, so a reviewer can run the
// ticket's tests in place instead of building a /tmp clone. The install runs the branch's unreviewed lockfile, so it
// runs like a check job: fenced where the runner can fence, its own HOME (gone afterwards), never a store of its own.
// A stub `pnpm` on PATH records what it was run with; nothing here touches the network.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { levelFor, probeLandlock, type FenceLevel } from "../src/fence.js";
import { Workspaces } from "../src/workspace.js";

const level = levelFor(probeLandlock().abi).level;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const ids = { project: "11111111-1111-4111-8111-111111111111", ticket: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

/** A remote with (or without) a pnpm lockfile, a stub pnpm running `body`, and a Workspaces wired like the runner's. */
function setup(opts: { lockfile?: boolean; body?: string; fence?: { level: FenceLevel; pnpmStore?: string } | null } = {}) {
  const remote = mkdtempSync(path.join(tmpdir(), "bm-rd-remote-"));
  git(remote, "init", "-q", "-b", "main");
  writeFileSync(path.join(remote, "package.json"), '{ "name": "x", "private": true }\n');
  if (opts.lockfile !== false) writeFileSync(path.join(remote, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(remote, ".gitignore"), "node_modules\n");
  git(remote, "add", ".");
  git(remote, "commit", "-qm", "init");
  const bin = mkdtempSync(path.join(tmpdir(), "bm-rd-bin-"));
  const body = opts.body ?? 'mkdir -p node_modules; printf "cwd=%s\\nstore=%s\\nhome=%s\\nci=%s\\nargs=%s\\n" "$PWD" "$npm_config_store_dir" "$HOME" "$CI" "$*" > node_modules/.stub';
  writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, "pnpm"), 0o755);
  const root = mkdtempSync(path.join(tmpdir(), "bm-rd-root-"));
  const store = path.join(root, ".pnpm-store");
  const fence = opts.fence === null ? undefined : (opts.fence ?? { level: "unavailable" as FenceLevel, pnpmStore: store });
  const ws = new Workspaces(root, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, undefined, `${store}-gate`, fence);
  const spec = { projectId: ids.project, ticketId: ids.ticket, repoUrl: remote, baseRef: "main" };
  return { root, store, ws, spec, remote };
}

const stubLog = (dir: string) => readFileSync(path.join(dir, "node_modules", ".stub"), "utf8");
const homes = (root: string) => (existsSync(path.join(root, "check-jobs-home")) ? readdirSync(path.join(root, "check-jobs-home")) : []);

describe("a review copy's packages (BOS-693)", () => {
  it("installs in the review copy from the shared store, with a HOME of its own that goes afterwards, and keeps node_modules for the next round", async () => {
    const { root, store, ws, spec } = setup();
    await ws.ensure(spec);
    const copy = await ws.ensureReview({ ...spec, review: true });
    expect(await ws.installReviewDeps(spec)).toEqual({ installed: true, detail: "installed" });
    const log = stubLog(copy.path);
    expect(log).toContain(`cwd=${copy.path}`);
    expect(log).toContain(`store=${store}\n`);
    expect(log).not.toContain(`${store}-gate`);
    expect(log).toContain(`home=${path.join(root, "check-jobs-home")}/`);
    expect(log).toContain("ci=1");
    expect(log).toContain("args=install --frozen-lockfile --prefer-offline");
    expect(homes(root)).toEqual([]);
    // The next review round resets the copy but keeps the ignored node_modules, so pnpm only tops it up.
    await ws.ensureReview({ ...spec, review: true });
    expect(existsSync(path.join(copy.path, "node_modules", ".stub"))).toBe(true);
  });

  it("installs the branch's lockfile, not the base's, so a changed dependency is picked up (BOS-713)", async () => {
    // The stub records the lockfile pnpm was pointed at, so the test can see which one the install would read.
    const body = "mkdir -p node_modules; cat pnpm-lock.yaml > node_modules/.stub";
    const { ws, spec } = setup({ body });
    const dev = await ws.ensure(spec);
    // The author changes the lockfile on the ticket's work (a new dependency, a new version).
    writeFileSync(path.join(dev.path, "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n");
    git(dev.path, "add", "pnpm-lock.yaml");
    git(dev.path, "commit", "-qm", "bump lockfile");
    const copy = await ws.ensureReview({ ...spec, review: true });
    // The copy carries the branch's lockfile, not main's (9.0).
    expect(readFileSync(path.join(copy.path, "pnpm-lock.yaml"), "utf8")).toBe("lockfileVersion: '9.1'\n");
    expect(await ws.installReviewDeps(spec)).toEqual({ installed: true, detail: "installed" });
    expect(stubLog(copy.path)).toBe("lockfileVersion: '9.1'\n");
  });

  it("does nothing for a project without a pnpm lockfile", async () => {
    const { ws, spec } = setup({ lockfile: false });
    await ws.ensure(spec);
    const copy = await ws.ensureReview({ ...spec, review: true });
    expect(await ws.installReviewDeps(spec)).toEqual({ installed: false, detail: "not a pnpm project" });
    expect(existsSync(path.join(copy.path, "node_modules"))).toBe(false);
  });

  it("never starts a store of its own: with no shared store it doesn't install", async () => {
    const { ws, spec } = setup({ fence: null });
    await ws.ensure(spec);
    const copy = await ws.ensureReview({ ...spec, review: true });
    expect(await ws.installReviewDeps(spec)).toEqual({ installed: false, detail: "this runner has no shared pnpm store" });
    expect(existsSync(path.join(copy.path, "node_modules"))).toBe(false);
  });

  it("reports a failed install instead of throwing, and cleans up its HOME", async () => {
    const { root, ws, spec } = setup({ body: 'echo "ERR_PNPM_OUTDATED_LOCKFILE broken lockfile" >&2; exit 1' });
    await ws.ensure(spec);
    await ws.ensureReview({ ...spec, review: true });
    const r = await ws.installReviewDeps(spec);
    expect(r.installed).toBe(false);
    expect(r.detail).toMatch(/^exit 1: .*ERR_PNPM_OUTDATED_LOCKFILE/);
    expect(homes(root)).toEqual([]);
  });

  it("kills a hung install (and its children) at the time limit", async () => {
    const { root, ws, spec } = setup({ body: "sleep 30 & wait" });
    await ws.ensure(spec);
    await ws.ensureReview({ ...spec, review: true });
    const started = Date.now();
    const r = await ws.installReviewDeps(spec, 300);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.installed).toBe(false);
    expect(r.detail).toMatch(/^timed out after/);
    expect(homes(root)).toEqual([]);
  });

  it("runs one install at a time per review copy (the code and security reviewers share it)", async () => {
    const { ws, spec } = setup({ body: 'mkdir -p node_modules; if ! mkdir node_modules/.busy 2>/dev/null; then echo overlap > node_modules/.overlap; fi; sleep 0.3; rmdir node_modules/.busy' });
    await ws.ensure(spec);
    const copy = await ws.ensureReview({ ...spec, review: true });
    const [a, b] = await Promise.all([ws.installReviewDeps(spec), ws.installReviewDeps(spec)]);
    expect([a.installed, b.installed]).toEqual([true, true]);
    expect(existsSync(path.join(copy.path, "node_modules", ".overlap"))).toBe(false);
  });
});

describe.skipIf(level === "unavailable")("a review copy's install is fenced (BOS-693)", () => {
  it("can't read a secret outside the review copy", async () => {
    // A check job on a runner older than BOS-1095 gets a HOME that was never created: make it, or use the temp folder.
    let secretBase = process.env.HOME ?? tmpdir();
    try { mkdirSync(secretBase, { recursive: true }); } catch { secretBase = tmpdir(); }
    const secretDir = mkdtempSync(path.join(secretBase, ".bm-rd-secret-"));
    writeFileSync(path.join(secretDir, "token"), "TOPSECRET");
    const root0 = mkdtempSync(path.join(tmpdir(), "bm-rd-store-"));
    const store = path.join(root0, "store");
    mkdirSync(store);
    const { ws, spec } = setup({ body: `mkdir -p node_modules; cat ${secretDir}/token > node_modules/.stub 2>&1; echo done >> node_modules/.stub`, fence: { level, pnpmStore: store } });
    await ws.ensure(spec);
    const copy = await ws.ensureReview({ ...spec, review: true });
    await ws.installReviewDeps(spec);
    const log = stubLog(copy.path);
    expect(log).toContain("done");
    expect(log).not.toContain("TOPSECRET");
  });
});
