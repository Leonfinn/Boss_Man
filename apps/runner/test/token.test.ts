// BOS-322: the runner's own token never sits in a form an agent session can read.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runnerToken } from "../src/token.js";

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

  it("takes a token from the environment and deletes the variable, so a session can't read it from /proc", () => {
    const env = { BOSSMAN_RUNNER_TOKEN: "from-env" };
    expect(runnerToken(env)).toEqual({ token: "from-env", fromEnv: true });
    expect(env).not.toHaveProperty("BOSSMAN_RUNNER_TOKEN");
  });

  it("prefers the file over the environment when both are set", () => {
    expect(runnerToken({ BOSSMAN_RUNNER_TOKEN_FILE: tokenFile("from-file"), BOSSMAN_RUNNER_TOKEN: "from-env" })).toEqual({ token: "from-file", fromEnv: false });
  });

  it("reports no token when neither is set", () => {
    expect(runnerToken({})).toEqual({ token: undefined, fromEnv: false });
  });
});
