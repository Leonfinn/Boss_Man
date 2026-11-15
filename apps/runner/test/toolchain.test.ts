// BOS-1570: the toolchain fingerprint the runner and the check worker both send in hello.
import { describe, expect, it } from "vitest";
import { toolchainDifferences } from "@boss-man/shared";
import { firstVersion, fingerprintOf, osRelease, readToolchain } from "../src/toolchain.js";

const ANSWERS: Record<string, string> = {
  pnpm: "10.28.0\n",
  git: "git version 2.39.5\n",
  shellcheck: "ShellCheck - shell script analysis tool\nversion: 0.9.0\n",
  rg: "ripgrep 13.0.0\n",
  jq: "jq-1.6\n",
  "docker --version": "Docker version 29.9.3, build abc\n",
  "docker compose version": "Docker Compose version v5.7.0\n",
  actionlint: "1.7.12\ninstalled by building from source\n",
  chromium: "Chromium 131.0.6778.204 built on Debian\n",
};
const run = async (cmd: string, args: string[]) => {
  const key = cmd === "docker" ? `docker ${args.join(" ")}` : cmd;
  if (!(key in ANSWERS)) throw new Error("not installed");
  return ANSWERS[key]!;
};

describe("toolchain fingerprint", () => {
  it("reads the first dotted number out of each tool's output", () => {
    expect(firstVersion("jq-1.6")).toBe("1.6");
    expect(firstVersion("ShellCheck\nversion: 0.9.0")).toBe("0.9.0");
    expect(firstVersion("nothing")).toBeNull();
  });

  it("is the same for two machines with the same tools, in any order", async () => {
    const a = await readToolchain({ run, nodeVersion: "22.11.0", os: "debian-12" });
    const b = await readToolchain({ run, nodeVersion: "22.11.0", os: "debian-12" });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf({ a: "1", b: "2" })).toBe(fingerprintOf({ b: "2", a: "1" }));
    expect(a.tools).toMatchObject({ node: "22.11.0", os: "debian-12", pnpm: "10.28.0", git: "2.39.5", shellcheck: "0.9.0", ripgrep: "13.0.0", jq: "1.6", "docker-cli": "29.9.3", "docker-compose": "5.7.0", actionlint: "1.7.12" });
  });

  it("changes when a tool changes or goes missing, but not when only the browser differs", async () => {
    const base = await readToolchain({ run, nodeVersion: "22.11.0", os: "debian-12" });
    expect((await readToolchain({ run, nodeVersion: "22.12.0", os: "debian-12" })).fingerprint).not.toBe(base.fingerprint);
    const noGit = await readToolchain({ run: (c, a) => (c === "git" ? Promise.reject(new Error("gone")) : run(c, a)), nodeVersion: "22.11.0", os: "debian-12" });
    expect(noGit.fingerprint).not.toBe(base.fingerprint);
    const noBrowser = await readToolchain({ run: (c, a) => (c === "chromium" ? Promise.reject(new Error("gone")) : run(c, a)), nodeVersion: "22.11.0", os: "debian-12" });
    expect(noBrowser.tools.chromium).toBeUndefined();
    expect(noBrowser.fingerprint).toBe(base.fingerprint);
    expect(toolchainDifferences(noGit.tools, base.tools)).toEqual(["git missing here, 2.39.5 on your runner"]);
  });

  it("reads the OS release, and copes with no file", () => {
    expect(osRelease(() => 'ID=debian\nVERSION_ID="12"\n')).toBe("debian-12");
    expect(osRelease(() => { throw new Error("no file"); })).toBeNull();
  });
});
