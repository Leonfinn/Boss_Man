import { describe, expect, it } from "vitest";
import { judgePermission } from "../src/index.js";

// BOS-2245: a write target is read with a self-set variable replaced only for `$NAME` and `${NAME}`.
// Any other `${NAME...}` form is run by the shell, so the real path differs and the target is unknown.
const OWN = "0a294937-f4cc-47a1-926e-00ff4883b5c6";
const ROOT = "/home/node/workspaces";
const judge = (cmd: string) => judgePermission("It writes a file.", cmd, OWN, "-p", ROOT);

describe("write targets: parameter expansion is not a plain variable (BOS-2245)", () => {
  it.each([
    'R=/tmp/x; echo hi > "$R"',
    'R=/tmp/x; echo hi > "${R}"',
    "R=/tmp/x; echo hi > $R",
    "R=/tmp/x; touch ${R}",
  ])("%s is read as its typed-out form", (cmd) => {
    expect(judge(cmd).verdict).toBe("allow");
  });
  it.each([
    'R=/tmp/x; echo hi > "${R/tmp/etc}"',
    'R=/tmp/x; echo hi > "${R%/x}/../etc/y"',
    'R=/tmp/x; echo hi > "${R#/tmp}"',
    'R=/tmp/x; echo hi > "${R:+/etc/y}"',
    'R=/tmp/x; echo hi > "${R:-/etc/y}"',
    'R=/tmp/x; echo hi > "${R:0:2}etc"',
    'R=/tmp/x; echo hi > "${R//tmp/etc}"',
    'R=/tmp/x; echo hi > "${R%%/x}/../etc/y"',
    'R=/tmp/x; echo hi > "${R##/tmp}"',
    'R=/tmp/x; echo hi > "${R^^}"',
    'R=/tmp/x; echo hi > "${R/a/b}"',
    'R=/tmp/x; echo hi > "${R"',
    "R=/tmp/x; touch ${R/tmp/etc}",
    'R=/tmp/x; echo hi > "$R_x"',
  ])("%s is denied", (cmd) => {
    expect(judge(cmd).verdict).not.toBe("allow");
  });
});
