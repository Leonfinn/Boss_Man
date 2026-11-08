// BOS-332: the runner's own git must not run a program named in a config an agent can write.
// Variant matrix: an "agent" plants each key with plain git from its worktree (as the BOS-326 review
// did), pointing it at a program that leaves a marker file. Where cheap, a control row first shows the
// plant is live (plain git runs the program); then the daemon operation runs and the marker must not appear.
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedKey } from "../src/git-config-guard.js";
import { branchFor, safeGitEnv, Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
/** Plain git, as an agent runs it: reads every config, runs whatever it names. */
const agent = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryAgent = (cwd: string, ...args: string[]) => {
  try {
    agent(cwd, ...args);
  } catch {
    // the control only needs the program to have started
  }
};

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ids = { project: "11111111-1111-4111-8111-111111111111", a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

/** A bare origin with one commit, plus a seed clone to push more. */
function origin(text = "line 1\nline 2\nline 3\n") {
  const bare = tmp("bm332-origin-");
  agent(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm332-seed-");
  agent(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "app.txt"), text);
  agent(seed, "add", ".");
  agent(seed, "commit", "-qm", "init");
  agent(seed, "push", "-q", "origin", "HEAD:main");
  const push = (file: string, content: string) => {
    agent(seed, "pull", "-q", "origin", "main");
    writeFileSync(path.join(seed, file), content);
    agent(seed, "add", ".");
    agent(seed, "commit", "-qm", `edit ${file}`);
    agent(seed, "push", "-q", "origin", "HEAD:main");
  };
  return { url: bare, push, main: () => agent(bare, "rev-parse", "main") };
}

/** Programs that leave a marker when run: `pass` passes stdin through (a filter), `cat1` prints its first argument (textconv), `noop` reads nothing. */
function programs() {
  const d = tmp("bm332-evil-");
  const marker = path.join(d, "ran");
  const make = (name: string, body: string) => {
    const p = path.join(d, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${marker}"\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  return { dir: d, marker, pass: make("pass", "exec cat"), cat1: make("cat1", 'cat "$1"'), noop: make("noop", "exit 0"), fail: make("fail", "exit 1"), ran: () => existsSync(marker), reset: () => rmSync(marker, { force: true }) };
}

async function fixture(env: NodeJS.ProcessEnv = process.env) {
  const o = origin();
  const ws = new Workspaces(tmp("bm332-root-"), env);
  const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: o.url, baseRef: "main" };
  const w = await ws.ensure(spec);
  const repo = ws.repoDir(ids.project);
  const p = programs();
  /** The agent sets a key from inside its worktree (from the repo once the worktree is released): it lands in the shared repo's config. */
  const plant = (key: string, value: string) => agent(existsSync(w.path) ? w.path : repo, "config", "--add", key, value);
  const attributes = (line: string) => writeFileSync(path.join(w.path, ".gitattributes"), `${line}\n`);
  const keys = () => agent(repo, "config", "--file", path.join(repo, "config"), "--name-only", "--list").split("\n");
  return { o, ws, spec, w, repo, p, plant, attributes, keys };
}

describe("the config allowlist (BOS-332)", () => {
  it.each([
    ["core.bare", true],
    ["core.repositoryformatversion", true],
    ["remote.origin.url", true],
    ["remote.origin.fetch", true],
    ["remote.shared.url", true],
    ["remote.shared.fetch", true],
    ["remote.shared.pushurl", false],
    ["branch.bossman/x.remote", true],
    ["branch.feature.with.dots.merge", true],
    ["bossman.ticket-aaaa.base", true],
    ["user.name", true],
    ["gc.auto", true],
    ["core.hookspath", false],
    ["core.sshcommand", false],
    ["core.worktree", false],
    ["remote.origin.pushurl", false],
    ["remote.evil.url", false],
    ["url.https://evil/.insteadof", false],
    ["filter.x.clean", false],
    ["diff.external", false],
    ["include.path", false],
    ["includeif.gitdir:/x/.path", false],
    ["extensions.worktreeconfig", false],
    ["bossman.other.base", false],
    ["bossman.ticket-x.clean", false],
    ["credential.helper", false],
    ["http.extraheader", false],
    ["nodot", false],
  ])("%s allowed: %s", (key, ok) => {
    expect(allowedKey(key)).toBe(ok);
  });
});

describe("programs named in the shared repo's config never run in the runner's own git (BOS-332)", () => {
  it("filter.<x>.clean: checkpoint, review copy (snapshot), diff and release", async () => {
    const f = await fixture();
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    f.plant("filter.x.clean", f.p.pass);
    tryAgent(f.w.path, "add", "-A");
    expect(f.p.ran()).toBe(true); // control: the plant is live for plain git
    agent(f.w.path, "reset", "-q");
    f.p.reset();
    f.plant("filter.x.clean", f.p.pass);
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
    f.plant("filter.x.clean", f.p.pass);
    await f.ws.ensureReview(f.spec);
    f.plant("filter.x.clean", f.p.pass);
    expect((await f.ws.diff(f.spec)).files.map((x) => x.path)).toContain("work.txt");
    f.plant("filter.x.clean", f.p.pass);
    expect(await f.ws.release(f.spec)).toEqual({ savedPatch: true });
    expect(f.p.ran()).toBe(false);
    expect(f.keys().some((k) => k.startsWith("filter."))).toBe(false);
  });

  it("filter.<x>.smudge: making a worktree from an existing branch, and resetting a review copy", async () => {
    const f = await fixture();
    f.attributes("*.txt filter=x");
    writeFileSync(path.join(f.w.path, "a.txt"), "a\n");
    agent(f.w.path, "add", "-A");
    agent(f.w.path, "commit", "-qm", "attributes");
    await f.ws.ensureReview(f.spec);
    await f.ws.release(f.spec);
    f.plant("filter.x.smudge", f.p.pass);
    const control = path.join(tmp("bm332-ctl-"), "wt");
    tryAgent(f.repo, "worktree", "add", "-q", "--detach", control, branchFor(ids.a));
    expect(f.p.ran()).toBe(true);
    agent(f.repo, "worktree", "remove", "--force", control);
    f.p.reset();
    f.plant("filter.x.smudge", f.p.pass);
    expect(await f.ws.ensure(f.spec)).toMatchObject({ created: true });
    expect(readFileSync(path.join(f.w.path, "a.txt"), "utf8")).toBe("a\n");
    f.plant("filter.x.smudge", f.p.pass);
    writeFileSync(path.join(f.w.path, "b.txt"), "b\n");
    await f.ws.ensureReview(f.spec);
    expect(f.p.ran()).toBe(false);
  });

  it("filter.<x>.process: checkpoint", async () => {
    const f = await fixture();
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    f.plant("filter.x.process", f.p.pass);
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
    expect(f.p.ran()).toBe(false);
  });

  it("diff.external, diff.<x>.textconv and diff.<x>.command: diff, last turn's diff and release", async () => {
    const f = await fixture();
    f.attributes("* diff=x");
    writeFileSync(path.join(f.w.path, "app.txt"), "changed\n");
    f.plant("diff.external", f.p.noop);
    tryAgent(f.w.path, "diff");
    expect(f.p.ran()).toBe(true);
    f.p.reset();
    const all = () => {
      f.plant("diff.external", f.p.noop);
      f.plant("diff.x.textconv", f.p.cat1);
      f.plant("diff.x.command", f.p.noop);
    };
    all();
    const d = await f.ws.diff(f.spec);
    expect(d.diff).toContain("+changed");
    all();
    await f.ws.checkpoint(f.spec, "after a turn");
    all();
    expect((await f.ws.lastTurnDiff(f.spec)).diff).toContain("+changed");
    all();
    await f.ws.release(f.spec);
    expect(f.p.ran()).toBe(false);
  });

  it("commit.gpgSign with gpg.program: checkpoint and merge", async () => {
    const f = await fixture();
    writeFileSync(path.join(f.w.path, "feature.txt"), "new\n");
    agent(f.w.path, "add", ".");
    f.plant("commit.gpgSign", "true");
    f.plant("gpg.program", f.p.fail);
    tryAgent(f.w.path, "commit", "-qm", "control");
    expect(f.p.ran()).toBe(true);
    f.p.reset();
    agent(f.w.path, "-c", "commit.gpgSign=false", "commit", "-qm", "ticket work");
    writeFileSync(path.join(f.w.path, "more.txt"), "more\n");
    f.plant("commit.gpgSign", "true");
    f.plant("gpg.program", f.p.fail);
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
    rmSync(path.join(f.w.path, "more.txt"));
    f.plant("commit.gpgSign", "true");
    f.plant("gpg.program", f.p.fail);
    expect(await f.ws.merge(f.spec, "main", "Merge")).toMatchObject({ status: "merged" });
    expect(f.p.ran()).toBe(false);
  });

  it("merge.<x>.driver with the repo's info/attributes: merge", async () => {
    const f = await fixture();
    writeFileSync(path.join(f.w.path, "app.txt"), "line 1 ticket\nline 2\nline 3\n");
    agent(f.w.path, "commit", "-qam", "ticket edit");
    f.o.push("app.txt", "line 1\nline 2\nline 3 main\n");
    mkdirSync(path.join(f.repo, "info"), { recursive: true });
    writeFileSync(path.join(f.repo, "info", "attributes"), "* merge=x\n");
    agent(f.repo, "fetch", "-q", f.o.url, "+refs/heads/*:refs/remotes/origin/*");
    f.plant("merge.x.driver", `${f.p.noop} %O %A %B`);
    tryAgent(f.repo, "merge-tree", "--write-tree", "refs/remotes/origin/main", branchFor(ids.a));
    expect(f.p.ran()).toBe(true);
    f.p.reset();
    f.plant("merge.x.driver", `${f.p.noop} %O %A %B`);
    expect(await f.ws.merge(f.spec, "main", "Merge")).toMatchObject({ status: "merged" });
    expect(f.p.ran()).toBe(false);
    expect(agent(f.o.url, "show", "main:app.txt")).toBe("line 1 ticket\nline 2\nline 3 main");
  });

  it("include.path and includeIf pointing at a file in the worktree that names a filter", async () => {
    const f = await fixture();
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    const inc = path.join(f.w.path, "evil.inc");
    writeFileSync(inc, `[filter "x"]\n\tclean = ${f.p.pass}\n`);
    f.plant("include.path", inc);
    tryAgent(f.w.path, "add", "-A");
    expect(f.p.ran()).toBe(true);
    agent(f.w.path, "reset", "-q");
    f.p.reset();
    f.plant("include.path", inc);
    f.plant(`includeIf.gitdir:${f.repo}/.path`, inc);
    f.plant("includeIf.onbranch:**.path", inc);
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
    expect(f.p.ran()).toBe(false);
    expect(f.keys().some((k) => k.startsWith("include"))).toBe(false);
  });

  it("extensions.worktreeConfig with a config.worktree in the worktree's admin folder", async () => {
    const f = await fixture();
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    agent(f.w.path, "config", "core.repositoryformatversion", "1");
    f.plant("extensions.worktreeConfig", "true");
    // core.bare=false too, or the bare repo's core.bare=true makes git treat the worktree as bare.
    writeFileSync(path.join(f.repo, "worktrees", path.basename(f.w.path), "config.worktree"), `[core]\n\tbare = false\n[filter "x"]\n\tclean = ${f.p.pass}\n`);
    tryAgent(f.w.path, "add", "-A");
    expect(f.p.ran()).toBe(true);
    agent(f.w.path, "reset", "-q");
    f.p.reset();
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
    expect(f.p.ran()).toBe(false);
  });

  it.each([
    ["mixed case section and name", (p: string) => `[Filter "x"]\n\tClean = ${p}\n`],
    ["upper case", (p: string) => `[FILTER "x"]\n\tCLEAN = ${p}\n`],
    ["the old [section.sub] form", (p: string) => `[filter.x]\n\tclean = ${p}\n`],
    ["a key on the section's own line", (p: string) => `[filter "x"] clean = ${p}\n`],
    ["a repeated key", (p: string) => `[filter "x"]\n\tclean = ${p}\n[filter "x"]\n\tclean = ${p}\n`],
    ["an empty value and a bare boolean", (p: string) => `[filter "x"]\n\tsmudge =\n\trequired\n\tclean = ${p}\n`],
    ["a quoted value with a continuation", (p: string) => `[filter "x"]\n\tclean = "${p}" \\\n  \n`],
  ])("spelling variant: %s", async (_name, text) => {
    const f = await fixture();
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    appendFileSync(path.join(f.repo, "config"), text(f.p.pass));
    tryAgent(f.w.path, "add", "-A");
    expect(f.p.ran()).toBe(true);
    agent(f.w.path, "reset", "-q");
    f.p.reset();
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
    expect(f.p.ran()).toBe(false);
    expect(f.keys().filter((k) => !allowedKey(k))).toEqual([]);
  });

  it("a ~/.gitconfig in the runner's HOME", async () => {
    const home = tmp("bm332-home-");
    const f = await fixture({ ...process.env, HOME: home });
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    writeFileSync(path.join(home, ".gitconfig"), `[filter "x"]\n\tclean = ${f.p.pass}\n`);
    execFileSync("git", ["add", "-A"], { cwd: f.w.path, env: { ...ENV, HOME: home } });
    expect(f.p.ran()).toBe(true);
    agent(f.w.path, "reset", "-q");
    f.p.reset();
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
    expect(await f.ws.diff(f.spec)).toBeTruthy();
    expect(f.p.ran()).toBe(false);
  });

  it("core.sshCommand, core.askPass, credential.helper and core.gitProxy are removed before a fetch", async () => {
    const f = await fixture();
    f.plant("core.sshCommand", f.p.noop);
    f.plant("core.askPass", f.p.noop);
    f.plant("credential.helper", f.p.noop);
    f.plant("core.gitProxy", f.p.noop);
    f.o.push("app.txt", "moved\n");
    expect(await f.ws.ensure({ ...f.spec, ticketId: ids.b })).toMatchObject({ created: true, baseCommit: f.o.main() });
    expect(f.p.ran()).toBe(false);
    expect(f.keys().filter((k) => /sshcommand|askpass|credential|gitproxy/.test(k))).toEqual([]);
  });

  it("the env layer alone stops the single-name keys (a key planted after the guard's check)", () => {
    const p = programs();
    const repo = tmp("bm332-plain-");
    agent(repo, "init", "-q", "-b", "main");
    agent(repo, "commit", "-q", "--allow-empty", "-m", "x");
    agent(repo, "config", "credential.helper", p.noop);
    agent(repo, "config", "core.askPass", p.noop);
    agent(repo, "config", "core.sshCommand", p.noop);
    agent(repo, "config", "commit.gpgSign", "true");
    agent(repo, "config", "gpg.program", p.fail);
    tryAgent(repo, "commit", "-q", "--allow-empty", "-m", "control");
    expect(p.ran()).toBe(true);
    p.reset();
    const daemon = (args: string[], input?: string) => {
      try {
        execFileSync("git", args, { cwd: repo, input, timeout: 20_000, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: tmp("bm332-h-"), GIT_DIR: path.join(repo, ".git"), ...ENV, ...safeGitEnv() } });
      } catch {
        // failing is fine; running the program is not
      }
    };
    daemon(["credential", "fill"], "protocol=https\nhost=example.invalid\n\n");
    daemon(["ls-remote", "ssh://example.invalid/x"]);
    daemon(["commit-tree", "HEAD^{tree}", "-m", "daemon"]);
    daemon(["commit", "-q", "--allow-empty", "-m", "daemon"]);
    expect(p.ran()).toBe(false);
  });
});

function fakeRepo(pass: string) {
  const fake = tmp("bm332-fake-");
  agent(fake, "init", "-q", "--bare");
  agent(fake, "config", "filter.x.clean", pass);
  return fake;
}

// BOS-323's per-ticket clones: the agent owns the clone's whole .git, config included. Unfenced here
// (fenceCloneGit is off in this suite), which is the `unavailable`-host case the guard has to cover alone.
describe("programs named in a ticket's own clone's config never run in the runner's own git (BOS-332 with BOS-323)", () => {
  const cloneFixture = async () => {
    const f = await fixture({ ...process.env, BOSSMAN_TICKET_COPIES: "clone" });
    const cloneKeys = () => agent(f.w.path, "config", "--file", path.join(f.w.path, ".git", "config"), "--name-only", "--list").split("\n");
    return { ...f, cloneKeys };
  };

  it("filter, diff and signing keys planted in the clone: checkpoint, review copy, diff and release", async () => {
    const f = await cloneFixture();
    expect(lstatSync(path.join(f.w.path, ".git")).isDirectory()).toBe(true);
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    const plantAll = () => {
      f.plant("filter.x.clean", f.p.pass);
      f.plant("diff.external", f.p.noop);
      f.plant("commit.gpgSign", "true");
      f.plant("gpg.program", f.p.noop);
    };
    plantAll();
    expect(f.cloneKeys()).toContain("filter.x.clean"); // the plant lands in the clone, not the shared repo
    tryAgent(f.w.path, "add", "-A");
    expect(f.p.ran()).toBe(true); // control: live for plain git
    agent(f.w.path, "reset", "-q");
    f.p.reset();
    plantAll();
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
    plantAll();
    await f.ws.ensureReview(f.spec);
    plantAll();
    expect((await f.ws.diff(f.spec)).files.map((x) => x.path)).toContain("work.txt");
    // diff ran git in the clone, so its config was cut back to the allowlist (lastTurnDiff below only reads the shared repo).
    expect(f.cloneKeys().some((k) => /^(filter|diff|gpg|commit)\./.test(k))).toBe(false);
    expect(f.cloneKeys()).toEqual(expect.arrayContaining(["remote.origin.url", "remote.shared.url", "remote.shared.fetch"]));
    plantAll();
    expect(await f.ws.lastTurnDiff(f.spec)).toBeTruthy();
    plantAll();
    expect(await f.ws.release(f.spec)).toEqual({ savedPatch: true });
    expect(f.p.ran()).toBe(false);
  });

  // git's ref store reads commondir even when GIT_COMMON_DIR is set, so (as for a worktree) it's refused rather than worked around.
  it("a .git/commondir planted in the clone pointing at a repo the agent made: refused, and nothing runs or lands there", async () => {
    const f = await cloneFixture();
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    const fake = fakeRepo(f.p.pass);
    const planted = path.join(f.w.path, ".git", "commondir");
    writeFileSync(planted, `${fake}\n`);
    await expect(f.ws.checkpoint(f.spec, "after a turn")).rejects.toThrow(/points elsewhere/);
    await expect(f.ws.diff(f.spec)).rejects.toThrow(/points elsewhere/);
    expect(agent(fake, "for-each-ref")).toBe("");
    expect(f.p.ran()).toBe(false);
    // Taken away, it works again and the checkpoint lands in the real repo.
    rmSync(planted);
    const c = await f.ws.checkpoint(f.spec, "after a turn");
    expect(c).not.toBeNull();
    expect(agent(f.repo, "rev-parse", `refs/bossman/checkpoints/${ids.a}/000001`)).toBe(c!.commit);
    expect(f.p.ran()).toBe(false);
  });

  it("a new clone's origin is the recorded address, not one planted in the shared config", async () => {
    const o = origin();
    const ws = new Workspaces(tmp("bm332-root-"), { ...process.env, BOSSMAN_TICKET_COPIES: "clone" });
    await ws.ensure({ projectId: ids.project, ticketId: ids.a, repoUrl: o.url, baseRef: "main" });
    const repo = ws.repoDir(ids.project);
    agent(repo, "config", "remote.origin.url", "https://evil.example/repo.git");
    const b = await ws.ensure({ projectId: ids.project, ticketId: ids.b, repoUrl: o.url, baseRef: "main" });
    expect(agent(b.path, "config", "--get", "remote.origin.url")).toBe(o.url);
  });
});

describe("pointers an agent can rewrite are not followed (BOS-332)", () => {
  it("a worktree's .git file pointed at a repo the agent made", async () => {
    const f = await fixture();
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    const fake = fakeRepo(f.p.pass);
    writeFileSync(path.join(f.w.path, ".git"), `gitdir: ${fake}\n`);
    const c = await f.ws.checkpoint(f.spec, "after a turn");
    expect(c).not.toBeNull();
    expect(agent(f.repo, "rev-parse", `refs/bossman/checkpoints/${ids.a}/000001`)).toBe(c!.commit);
    expect(agent(fake, "for-each-ref")).toBe("");
    expect(f.p.ran()).toBe(false);
  });

  // git's ref store reads commondir even when GIT_COMMON_DIR is set, so this one is refused rather than worked around.
  it("the admin folder's commondir pointed at a repo the agent made: refused, and nothing runs or lands there", async () => {
    const f = await fixture();
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    const fake = fakeRepo(f.p.pass);
    const admin = path.join(f.repo, "worktrees", path.basename(f.w.path));
    writeFileSync(path.join(admin, "commondir"), `${fake}\n`);
    await expect(f.ws.checkpoint(f.spec, "after a turn")).rejects.toThrow(/points elsewhere/);
    await expect(f.ws.diff(f.spec)).rejects.toThrow(/points elsewhere/);
    expect(agent(fake, "for-each-ref")).toBe("");
    expect(f.p.ran()).toBe(false);
    // Put back, it works again.
    writeFileSync(path.join(admin, "commondir"), "../..\n");
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
  });

  it("a folder the runner can't confirm as the repo's worktree is refused, not guessed", async () => {
    const f = await fixture();
    const admin = path.join(f.repo, "worktrees", path.basename(f.w.path));
    writeFileSync(path.join(admin, "gitdir"), "/elsewhere/.git\n");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    await expect(f.ws.checkpoint(f.spec, "after a turn")).rejects.toThrow(/can confirm/);
  });
});

describe("fetches and pushes go to the address the runner recorded (BOS-332)", () => {
  it("ignores a changed remote.origin.url, an added pushurl and a url.insteadOf rewrite", async () => {
    const f = await fixture();
    const other = origin("other\n");
    const otherMain = other.main();
    writeFileSync(path.join(f.w.path, "feature.txt"), "new\n");
    agent(f.w.path, "add", ".");
    agent(f.w.path, "commit", "-qm", "ticket work");
    agent(f.w.path, "config", "remote.origin.url", other.url);
    f.plant("remote.origin.pushurl", other.url);
    f.plant(`url.${other.url}.insteadOf`, f.o.url);
    f.plant(`url.${other.url}.pushInsteadOf`, f.o.url);
    const r = await f.ws.merge(f.spec, "main", "Merge");
    expect(r).toMatchObject({ status: "merged" });
    expect(f.o.main()).toBe((r as { commit: string }).commit);
    expect(other.main()).toBe(otherMain);
    f.o.push("app.txt", "moved\n");
    expect(await f.ws.ensure({ ...f.spec, ticketId: ids.b })).toMatchObject({ baseCommit: f.o.main() });
    expect(other.main()).toBe(otherMain);
  });

  it("a repo cloned before the address was recorded uses its config's single URL, and says so", async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    rmSync(f.ws.repoDir(ids.project).replace(/\.git$/, ".url"));
    writeFileSync(path.join(f.w.path, "feature.txt"), "new\n");
    agent(f.w.path, "add", ".");
    agent(f.w.path, "commit", "-qm", "ticket work");
    expect(await f.ws.merge(f.spec, "main", "Merge")).toMatchObject({ status: "merged" });
    expect(warn.mock.calls.flat().join("\n")).toContain("no recorded address");
  });
});

describe("the guard's own behaviour (BOS-332)", () => {
  it("keeps the allowed keys, logs each removed key by name and not by value", async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.plant("alias.st", "status");
    f.plant("filter.x.clean", `${f.p.pass} --secret-ish-value`);
    agent(f.w.path, "config", "user.name", "Agent");
    agent(f.w.path, "config", `branch.${branchFor(ids.a)}.remote`, "origin");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    await f.ws.checkpoint(f.spec, "after a turn");
    const keys = f.keys();
    for (const k of ["core.bare", "remote.origin.url", "remote.origin.fetch", "user.name", `branch.${branchFor(ids.a)}.remote`, `bossman.ticket-${ids.a}.base`, "core.logallrefupdates"]) expect(keys).toContain(k);
    expect(keys).not.toContain("alias.st");
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("alias.st");
    expect(logged).toContain("filter.x.clean");
    expect(logged).not.toContain("secret-ish-value");
  });

  it("refuses the git call when a key can't be removed, and heals once it can", async () => {
    const f = await fixture();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.attributes("* filter=x");
    writeFileSync(path.join(f.w.path, "work.txt"), "work\n");
    f.plant("filter.x.clean", f.p.pass);
    writeFileSync(path.join(f.repo, "config.lock"), "");
    await expect(f.ws.checkpoint(f.spec, "after a turn")).rejects.toThrow(/Refusing to run git/);
    expect(f.p.ran()).toBe(false);
    rmSync(path.join(f.repo, "config.lock"));
    expect(await f.ws.checkpoint(f.spec, "after a turn")).not.toBeNull();
    expect(f.p.ran()).toBe(false);
  });
});
