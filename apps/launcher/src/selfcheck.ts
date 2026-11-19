// The launcher's check of its own set-up (BOS-1892): can it open Docker's socket and write the data folder?
// Each failure becomes a message that names the fix, so "The launcher failed; see its log" is not all a newcomer gets.
// Used at start, on a failed request, and by the compose healthcheck (dist/check.js).
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export type Problem = { what: "socket" | "data"; message: string };

/** The bits of `fs` the check uses, so a test can fake them. */
export type CheckFs = {
  access: (p: string, mode: number) => void;
  stat: (p: string) => { uid: number; gid: number };
};
export const realFs: CheckFs = { access: (p, mode) => accessSync(p, mode), stat: (p) => statSync(p) };

const code = (err: unknown): string | undefined => (err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : undefined);
const denied = (err: unknown) => ["EACCES", "EPERM", "EROFS"].includes(code(err) ?? "");

/** The fix for a socket the launcher may not open. `gid` is the socket's own group when it could be read. */
export function socketAdvice(socketPath: string, err: unknown, gid?: number): string {
  if (code(err) === "ENOENT") {
    return `There is no Docker socket at ${socketPath} inside the launcher. Check that docker-compose.yml still mounts /var/run/docker.sock into the launcher, and that Docker is running on the host, then run: docker compose up -d`;
  }
  const num = gid === undefined ? "the number printed by: stat -c %g /var/run/docker.sock" : `${gid}`;
  return `The launcher is not allowed to use the Docker socket at ${socketPath}: its group does not match. Set BOSSMAN_DOCKER_GID=${num} in .env (the socket's group number), then run: docker compose up -d`;
}

/** The fix for a data folder the launcher may not write. */
export function dataAdvice(dir: string, err: unknown, owner?: { uid: number; gid: number }): string {
  if (code(err) === "ENOENT") {
    return `The data folder ${dir} does not exist inside the launcher. Set BOSSMAN_DATA in .env to an absolute folder on the host and create its companies folder, then run: docker compose up -d`;
  }
  const who = owner ? ` (it belongs to uid ${owner.uid}, gid ${owner.gid})` : "";
  const ro = code(err) === "EROFS" ? " It is mounted read-only: remove any ':ro' on that mount." : "";
  return `The launcher (uid 1000) can't write ${dir}${who}.${ro} If BOSSMAN_DATA is missing from .env, Docker made the default folder as root: set BOSSMAN_DATA to your folder. On the host run: sudo chown -R 1000:1000 <your BOSSMAN_DATA folder>, then docker compose up -d`;
}

/** Checks the socket and the data folder (its `companies` folder, which is what the launcher mounts). Empty = fine. */
export function checkSetup(opts: { dataRoot: string; socketPath: string }, fs: CheckFs = realFs): Problem[] {
  const out: Problem[] = [];
  try {
    fs.access(opts.socketPath, constants.R_OK | constants.W_OK);
  } catch (err) {
    let gid: number | undefined;
    try {
      gid = fs.stat(opts.socketPath).gid;
    } catch {
      gid = undefined;
    }
    out.push({ what: "socket", message: socketAdvice(opts.socketPath, err, gid) });
  }
  const dir = path.join(opts.dataRoot, "companies");
  try {
    fs.access(dir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (err) {
    let owner: { uid: number; gid: number } | undefined;
    try {
      owner = fs.stat(dir);
    } catch {
      owner = undefined;
    }
    out.push({ what: "data", message: dataAdvice(dir, err, owner) });
  }
  return out;
}

/** Turns an error from a request into a message that names the fix, or undefined when it is not a permission or missing-path error. */
export function explainError(err: unknown, opts: { dataRoot: string; socketPath: string }, fs: CheckFs = realFs): string | undefined {
  const c = code(err);
  if (!denied(err) && c !== "ENOENT") return undefined;
  const found = checkSetup(opts, fs);
  if (found.length) return found.map((p) => p.message).join(" ");
  return undefined;
}
