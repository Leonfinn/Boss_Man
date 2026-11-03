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

  it("prefers the file over the environment when both are set, and leaves the variable untouched", () => {
    const env = { BOSSMAN_RUNNER_TOKEN_FILE: tokenFile("from-file"), BOSSMAN_RUNNER_TOKEN: "from-env" };
    expect(runnerToken(env)).toEqual({ token: "from-file", fromEnv: false });
    expect(env.BOSSMAN_RUNNER_TOKEN).toBe("from-env");
  });

  it("reports no token when neither is set", () => {
    expect(runnerToken({})).toEqual({ token: undefined, fromEnv: false });
  });
});
