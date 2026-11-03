// BOS-322: the runner's own token never sits in a form an agent session can read.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runnerToken, safeRunnerToken } from "../src/token.js";

function tokenFile(contents: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "bm-token-")), "runner_token");
  writeFileSync(file, contents);
  return file;
}

describe("the runner's own token", () => {
  it("reads the file and leaves the environment alone", () => {
    const env = { BOSSMAN_RUNNER_TOKEN_FILE: tokenFile("from-file\n") };
    expect(runnerToken(env)).toEqual({ token: "from-file", fromEnv: false });
  });

  it("takes a token from the environment, deletes the variable and says so, because /proc still holds it", () => {
    const env = { BOSSMAN_RUNNER_TOKEN: "from-env" };
    expect(runnerToken(env)).toEqual({ token: "from-env", fromEnv: true });
    expect(env).not.toHaveProperty("BOSSMAN_RUNNER_TOKEN");
  });

  it("refuses to start on an environment token, so a session can't read it from /proc (BOS-322)", () => {
    // The fix: an env token is in /proc/<pid>/environ for the runner's life and a fence that lets a
    // session's tools run can't take that away, so the runner refuses instead of warning. Old code
    // warned and carried on, so this fails on it.
    expect(() => safeRunnerToken({ BOSSMAN_RUNNER_TOKEN: "from-env" })).toThrow(/BOSSMAN_RUNNER_TOKEN_FILE/);
  });

  it("starts on a file token", () => {
    expect(safeRunnerToken({ BOSSMAN_RUNNER_TOKEN_FILE: tokenFile("from-file\n") })).toBe("from-file");
  });

  it("refuses to start with no token at all", () => {
    expect(() => safeRunnerToken({})).toThrow(/BOSSMAN_RUNNER_TOKEN_FILE/);
  });

  it("keeps the environment's token readable in /proc after the variable is deleted, so the fence must shut /proc", () => {
    // The child deletes its own copy, then sleeps; its /proc/PID/environ still holds the original block.
    const child = spawn(process.execPath, ["-e", "delete process.env.PROBE_TOKEN; if (process.env.PROBE_TOKEN !== undefined) process.exit(1); setTimeout(() => {}, 30_000);"], { env: { ...process.env, PROBE_TOKEN: "still-readable" }, stdio: "ignore" });
    try {
      const deadline = Date.now() + 5_000;
      let environ = "";
      while (!environ.includes("PROBE_TOKEN=still-readable") && Date.now() < deadline) environ = readFileSync(`/proc/${child.pid}/environ`, "utf8");
      expect(environ).toContain("PROBE_TOKEN=still-readable");
    } finally {
      child.kill();
    }
  });

  it("refuses to start when the file setting and the plain token are both set, because the plain one is still readable in /proc (BOS-394)", () => {
    // BOS-394: the file used to win silently and the plain copy stayed in /proc/<pid>/environ. Old
    // code started on the file, so this fails on it.
    const env = { BOSSMAN_RUNNER_TOKEN_FILE: tokenFile("from-file"), BOSSMAN_RUNNER_TOKEN: "from-env" };
    expect(() => safeRunnerToken(env)).toThrow(/BOSSMAN_RUNNER_TOKEN_FILE/);
    expect(env).not.toHaveProperty("BOSSMAN_RUNNER_TOKEN");
  });

  it("clears the plain token when the file setting wins, so the runner's own copy is not handed on", () => {
    const env = { BOSSMAN_RUNNER_TOKEN_FILE: tokenFile("from-file"), BOSSMAN_RUNNER_TOKEN: "from-env" };
    expect(runnerToken(env)).toEqual({ token: "from-file", fromEnv: true });
    expect(env).not.toHaveProperty("BOSSMAN_RUNNER_TOKEN");
  });

  it("reports no token when neither is set", () => {
    expect(runnerToken({})).toEqual({ token: undefined, fromEnv: false });
  });
});
