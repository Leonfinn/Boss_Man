import { constants } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSetup, explainError, type CheckFs } from "../src/selfcheck.js";

const opts = { dataRoot: "/srv/example/data", socketPath: "/var/run/docker.sock" };
const err = (c: string) => Object.assign(new Error(c), { code: c });

/** A fake fs: `deny` maps a path to the error code its access gives. */
function fakeFs(deny: Record<string, string>, stats: Record<string, { uid: number; gid: number }> = {}): CheckFs & { modes: number[] } {
  const modes: number[] = [];
  return {
    modes,
    access: (p, mode) => {
      modes.push(mode);
      if (deny[p]) throw err(deny[p]);
    },
    stat: (p) => stats[p] ?? { uid: 0, gid: 0 },
  };
}

describe("launcher self-check (BOS-1892)", () => {
  it("is fine when both can be used", () => {
    const fs = fakeFs({});
    expect(checkSetup(opts, fs)).toEqual([]);
    expect(fs.modes[0]! & constants.W_OK).toBeTruthy();
  });

  it("names the socket's own group number when the socket is refused", () => {
    const [p] = checkSetup(opts, fakeFs({ "/var/run/docker.sock": "EACCES" }, { "/var/run/docker.sock": { uid: 0, gid: 998 } }));
    expect(p?.what).toBe("socket");
    expect(p?.message).toContain("BOSSMAN_DOCKER_GID=998");
  });

  it("says the socket is missing when it is not mounted", () => {
    const [p] = checkSetup(opts, fakeFs({ "/var/run/docker.sock": "ENOENT" }));
    expect(p?.message).toContain("no Docker socket");
  });

  it("names the chown and BOSSMAN_DATA when the data folder is root's", () => {
    const [p] = checkSetup(opts, fakeFs({ "/srv/example/data/companies": "EACCES" }, { "/srv/example/data/companies": { uid: 0, gid: 0 } }));
    expect(p?.what).toBe("data");
    expect(p?.message).toContain("chown -R 1000:1000");
    expect(p?.message).toContain("uid 0");
    expect(p?.message).toContain("BOSSMAN_DATA");
  });

  it("reports both problems at once", () => {
    expect(checkSetup(opts, fakeFs({ "/var/run/docker.sock": "EACCES", "/srv/example/data/companies": "EACCES" })).map((p) => p.what)).toEqual(["socket", "data"]);
  });

  it("explains a request's permission error, and leaves other errors alone", () => {
    const fs = fakeFs({ "/srv/example/data/companies": "EACCES" });
    expect(explainError(err("EACCES"), opts, fs)).toContain("chown");
    expect(explainError(new Error("boom"), opts, fs)).toBeUndefined();
    // A permission error from somewhere the check finds fine keeps the generic message.
    expect(explainError(err("EACCES"), opts, fakeFs({}))).toBeUndefined();
  });
});
