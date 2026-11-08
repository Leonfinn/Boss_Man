import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostFactsService } from "../src/services/host-facts.js";
import { COVERED_NOTE, netguardAllowReport } from "../src/services/netguard-allow.js";

// BOS-770: the owner's BOSSMAN_NETGUARD_ALLOW entries are shown, and the ones Boss Man covers anyway are marked.
// The addresses are made-up examples.

const ENV_AT = "2026-11-08T18:00:00Z";
const env = (lines: string[][]) => ({ envFound: true, lines, reportedAt: ENV_AT });

describe("netguardAllowReport", () => {
  it("marks a lone entry that a project's git host covers: the line can go", () => {
    const r = netguardAllowReport({ launcher: { mode: "auto", allow: ["Git.Example.lan:3000"] }, env: env([["Git.Example.lan:3000"]]), toolServers: [], gitHosts: ["git.example.lan:3000"] });
    expect(r.entries).toEqual([{ entry: "Git.Example.lan:3000", coveredBy: ["git host"], note: COVERED_NOTE }]);
    expect(r.lineCanGo).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("keeps an entry nothing covers, and marks only the covered one", () => {
    const r = netguardAllowReport({ launcher: { mode: "enforce", allow: ["git.example.lan:3000", "penpot.example.lan:9001"] }, env: env([["git.example.lan:3000", "penpot.example.lan:9001"]]), toolServers: ["git.example.lan:3000"], gitHosts: ["git.example.lan:3000"] });
    expect(r.mode).toBe("enforce");
    expect(r.entries![0]).toMatchObject({ coveredBy: ["tool server", "git host"] });
    expect(r.entries![0]!.note).toMatch(/Already allowed by Boss Man \(a tool server and a git host\); this entry can go/);
    expect(r.entries![1]).toEqual({ entry: "penpot.example.lan:9001", coveredBy: [], note: null });
    expect(r.lineCanGo).toBe(false);
  });

  it("flags a variable set on more than one line, naming the entries the earlier lines lose", () => {
    // The BOS-580 story: a stopgap line below the Penpot line hides it.
    const r = netguardAllowReport({ launcher: { mode: "auto", allow: ["git.example.lan:3000"] }, env: env([["penpot.example.lan:9001", "git.example.lan:3000"], ["git.example.lan:3000"]]), toolServers: [], gitHosts: ["git.example.lan:3000"] });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("set on 2 lines in .env, and only the last one counts");
    expect(r.warnings[0]).toContain("ignored: penpot.example.lan:9001.");
    expect(r.warnings[0]).not.toContain("git.example.lan:3000");
  });

  it("says when the launcher's list differs from .env now (it reads .env only when recreated)", () => {
    const r = netguardAllowReport({ launcher: { mode: "auto", allow: ["a.example.lan:1"] }, env: env([["b.example.lan:2"]]), toolServers: [], gitHosts: [] });
    expect(r.warnings).toEqual([expect.stringContaining("different list from the one in .env")]);
    // Order and repeats don't count as a difference.
    expect(netguardAllowReport({ launcher: { mode: "auto", allow: ["a.example.lan:1", "b.example.lan:2"] }, env: env([["b.example.lan:2", "a.example.lan:1", "b.example.lan:2"]]), toolServers: [], gitHosts: [] }).warnings).toEqual([]);
    // No .env file on the host: nothing to compare.
    expect(netguardAllowReport({ launcher: { mode: "auto", allow: ["a.example.lan:1"] }, env: { envFound: false, lines: [], reportedAt: ENV_AT }, toolServers: [], gitHosts: [] }).warnings).toEqual([]);
  });

  it("works without a launcher (no list in use) and without a host report", () => {
    const noLauncher = netguardAllowReport({ launcher: null, env: env([["a.example.lan:1"], ["b.example.lan:2"]]), toolServers: [], gitHosts: [] });
    expect(noLauncher).toMatchObject({ mode: null, entries: null, lineCanGo: false });
    expect(noLauncher.warnings).toEqual([expect.stringContaining("set on 2 lines")]);
    const noHost = netguardAllowReport({ launcher: { mode: "auto", allow: [] }, env: null, toolServers: [], gitHosts: [] });
    expect(noHost).toMatchObject({ entries: [], lineCanGo: false, env: null, warnings: [] });
  });
});

describe("hostFactsService.netguardEnv", () => {
  let dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs = [];
  });
  async function withHost(host: unknown): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "bm-ngallow-"));
    dirs.push(dir);
    await mkdir(path.join(dir, "outbox"), { recursive: true });
    await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify(host));
    return dir;
  }
  const base = { version: 1, name: "nas01", writtenAt: ENV_AT, ownership: [] };

  it("reads the .env lines the host reported, with when", async () => {
    const dir = await withHost({ ...base, netguardEnv: { envFound: true, lines: [["git.example.lan:3000"], []] } });
    expect(await hostFactsService({ dir }).netguardEnv()).toEqual({ envFound: true, lines: [["git.example.lan:3000"], []], reportedAt: ENV_AT });
  });

  it("drops a section in the wrong shape (anything not host:port) but keeps the rest of the record", async () => {
    const dir = await withHost({ ...base, login: "leon", netguardEnv: { envFound: true, lines: [["password=hunter2"]] } });
    const svc = hostFactsService({ dir });
    expect(await svc.netguardEnv()).toBeNull();
    expect((await svc.hosts())[0]).toMatchObject({ name: "nas01", login: "leon" });
  });

  it("is null for an older deployer that doesn't report it", async () => {
    expect(await hostFactsService({ dir: await withHost(base) }).netguardEnv()).toBeNull();
  });
});
