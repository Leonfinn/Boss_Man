import { constants } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSetup, dataAdvice, explainError, socketAdvice, type CheckFs } from "../src/selfcheck.js";

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

// BOS-2134 (background lane): the two advice builders take their facts as arguments and return text,
// so each branch they can take is pinned here without touching the disk.
describe("launcher self-check advice (BOS-2134)", () => {
  const socketPath = "/var/run/docker.sock";
  const dataDir = "/srv/example/data/companies";

  describe("socketAdvice", () => {
    it("says the socket is missing and how to mount it", () => {
      expect(socketAdvice(socketPath, err("ENOENT"))).toBe(
        `There is no Docker socket at ${socketPath} inside the launcher. Check that docker-compose.yml still mounts /var/run/docker.sock into the launcher, and that Docker is running on the host, then run: docker compose up -d`,
      );
    });

    it("names the socket's own group number when it could be read", () => {
      expect(socketAdvice(socketPath, err("EACCES"), 998)).toBe(
        `The launcher is not allowed to use the Docker socket at ${socketPath}: its group does not match. Set BOSSMAN_DOCKER_GID=998 in .env (the socket's group number), then run: docker compose up -d`,
      );
    });

    it("tells the owner how to find the group number when it could not be read", () => {
      expect(socketAdvice(socketPath, err("EPERM"))).toBe(
        `The launcher is not allowed to use the Docker socket at ${socketPath}: its group does not match. Set BOSSMAN_DOCKER_GID=the number printed by: stat -c %g /var/run/docker.sock in .env (the socket's group number), then run: docker compose up -d`,
      );
    });
  });

  describe("dataAdvice", () => {
    it("says the data folder is missing and names BOSSMAN_DATA", () => {
      expect(dataAdvice(dataDir, err("ENOENT"))).toBe(
        `The data folder ${dataDir} does not exist inside the launcher. Set BOSSMAN_DATA in .env to an absolute folder on the host and create its companies folder, then run: docker compose up -d`,
      );
    });

    it("names the folder's owner and the chown when it belongs to root", () => {
      expect(dataAdvice(dataDir, err("EACCES"), { uid: 0, gid: 0 })).toBe(
        `The launcher (uid 1000) can't write ${dataDir} (it belongs to uid 0, gid 0). If BOSSMAN_DATA is missing from .env, Docker made the default folder as root: set BOSSMAN_DATA to your folder. On the host run: sudo chown -R 1000:1000 <your BOSSMAN_DATA folder>, then docker compose up -d`,
      );
    });

    it("leaves out the owner line when the folder could not be inspected", () => {
      const text = dataAdvice(dataDir, err("EACCES"));
      expect(text).toBe(
        `The launcher (uid 1000) can't write ${dataDir}. If BOSSMAN_DATA is missing from .env, Docker made the default folder as root: set BOSSMAN_DATA to your folder. On the host run: sudo chown -R 1000:1000 <your BOSSMAN_DATA folder>, then docker compose up -d`,
      );
      expect(text).not.toContain("it belongs to");
    });

    it("says the mount is read-only when that is the cause", () => {
      expect(dataAdvice(dataDir, err("EROFS"), { uid: 0, gid: 0 })).toBe(
        `The launcher (uid 1000) can't write ${dataDir} (it belongs to uid 0, gid 0). It is mounted read-only: remove any ':ro' on that mount. If BOSSMAN_DATA is missing from .env, Docker made the default folder as root: set BOSSMAN_DATA to your folder. On the host run: sudo chown -R 1000:1000 <your BOSSMAN_DATA folder>, then docker compose up -d`,
      );
    });
  });
});
