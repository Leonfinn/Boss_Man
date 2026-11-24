import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardImageOf, runnerImageOf, type LauncherConfig } from "../src/spec.js";
import { parseReleaseCurrent, releaseReader } from "../src/release-current.js";

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const base = { runner: `registry.example.com/acme/boss-man-runner@sha256:${D1}`, netguard: `registry.example.com/acme/boss-man-netguard@sha256:${D1}` };
const dirs: string[] = [];
const fileWith = (text: string) => {
  const d = mkdtempSync(path.join(tmpdir(), "bm-relcur-"));
  dirs.push(d);
  const f = path.join(d, "release-current");
  writeFileSync(f, text);
  return f;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("release-current (BOS-1227)", () => {
  it("takes digests of the configured repositories", () => {
    const got = parseReleaseCurrent(JSON.stringify({ runner: `registry.example.com/acme/boss-man-runner@sha256:${D2}`, netguard: `registry.example.com/acme/boss-man-netguard@sha256:${D2}` }), base);
    expect(got).toEqual({ runner: `registry.example.com/acme/boss-man-runner@sha256:${D2}`, netguard: `registry.example.com/acme/boss-man-netguard@sha256:${D2}` });
  });
  it("ignores a tag, another repository, junk, and any file when no environment image is set", () => {
    expect(parseReleaseCurrent(JSON.stringify({ runner: "registry.example.com/acme/boss-man-runner:latest" }), base)).toEqual({});
    expect(parseReleaseCurrent(JSON.stringify({ runner: `evil.example.net/x/boss-man-runner@sha256:${D2}` }), base)).toEqual({});
    expect(parseReleaseCurrent("not json", base)).toEqual({});
    expect(parseReleaseCurrent("[]", base)).toEqual({});
    expect(parseReleaseCurrent(JSON.stringify({ runner: base.runner }), {})).toEqual({});
  });
  it("is re-read at every call, so a new file takes effect with no restart", () => {
    const f = fileWith(JSON.stringify({ runner: `registry.example.com/acme/boss-man-runner@sha256:${D2}` }));
    const cfg = { runnerImage: base.runner, netguardImage: base.netguard, release: releaseReader(f, base) } as LauncherConfig;
    expect(runnerImageOf(cfg)).toContain(D2);
    expect(guardImageOf(cfg)).toBe(base.netguard);
    writeFileSync(f, JSON.stringify({ runner: base.runner }));
    expect(runnerImageOf(cfg)).toBe(base.runner);
  });
  it("falls back to the environment image when the file is missing, and says so once when it is unsafe", () => {
    const logs: string[] = [];
    const missing = releaseReader(path.join(tmpdir(), "bm-no-such-release-current"), base, (m) => logs.push(m));
    expect(missing()).toEqual({});
    expect(logs).toEqual([]);
    const bad = releaseReader(fileWith(JSON.stringify({ runner: "x:latest" })), base, (m) => logs.push(m));
    bad();
    bad();
    expect(logs).toHaveLength(1);
  });
});
