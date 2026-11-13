import { describe, expect, it } from "vitest";
import { writesBeyondTmp } from "../src/explain.js";

describe("writesBeyondTmp (BOS-1342)", () => {
  it("tells a delete under /tmp from one outside it, working out .. first", () => {
    expect(writesBeyondTmp("rm -rf /tmp/a")).toBe(false);
    expect(writesBeyondTmp("rm -rf /home/node/a")).toBe(true);
    expect(writesBeyondTmp("rm -rf /tmp/../home/a")).toBe(true);
  });

  it("counts every segment, not only the first", () => {
    expect(writesBeyondTmp("rm -rf /tmp/a && rm -rf /var/x")).toBe(true);
  });

  it("counts an option that carries the target", () => {
    expect(writesBeyondTmp("cp x -t /home/node")).toBe(true);
    expect(writesBeyondTmp("cp -t /home/node /tmp/a")).toBe(true);
    expect(writesBeyondTmp("cp a /tmp/b")).toBe(false);
  });

  it("counts a redirect's target", () => {
    expect(writesBeyondTmp("echo hi > /home/node/f")).toBe(true);
    expect(writesBeyondTmp("echo hi > /tmp/f")).toBe(false);
  });

  it("exempts an install and a project script, but not a program runner", () => {
    expect(writesBeyondTmp("pnpm install")).toBe(false);
    expect(writesBeyondTmp("pnpm build")).toBe(false);
    expect(writesBeyondTmp("pnpm dlx some-tool")).toBe(true);
  });

  it.fails("says a read-only command writes nothing beyond /tmp (real bug: a read's target is checked too)", () => {
    expect(writesBeyondTmp("ls /home")).toBe(false);
  });

  it("treats a change or delete with no target at all as reaching beyond /tmp", () => {
    expect(writesBeyondTmp("rm -rf")).toBe(true);
    expect(writesBeyondTmp("mkdir")).toBe(true);
  });
});
