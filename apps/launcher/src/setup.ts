// `docker compose run --rm setup` (BOS-974): makes the secrets a pull-only install needs, inside a volume, with nothing on the host.
// Safe to run twice: a file that exists is never touched, because a new master key would make every stored secret unreadable.
import { chownSync, closeSync, constants, existsSync, linkSync, openSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { socketModeProblem } from "./startup.js";

/** The user the server runs as; it must be able to read what it is given. */
const SERVER_UID = 1000;

export type SetupResult = { created: string[]; kept: string[] };

/** The database's own user (the postgres image). It may read the password file, and nothing else in the install. */
const DB_GID = 999;

type Chown = (f: string, uid: number, gid: number) => void;

/**
 * Writes `body` to `file` only if it doesn't exist (or is empty, the mark of a crashed earlier run).
 * The file is made complete under a temporary name (O_EXCL, so two setups at once can't both win the temp file), given its owner,
 * then moved into place with a link that fails if `file` appeared meanwhile. A crash or full disk therefore never leaves a
 * half-made key under the real name: at worst a stray `.tmp` file, which the next run removes.
 */
function writeOnce(file: string, body: string, chown: Chown, mode: number, gid: number): boolean {
  if (existsSync(file)) {
    if (statSync(file).size > 0) return false;
    unlinkSync(file); // empty = never finished; a key that was never used can be made again
  }
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  let fd: number;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    // Link first, chown after: once the temp file belongs to uid 1000 a root without DAC_OVERRIDE may not hard-link it
    // (kernel protected_hardlinks, seen on the arm64 CI runner).
    try {
      linkSync(tmp, file); // never replaces an existing file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      chown(file, SERVER_UID, gid);
    } catch (err) {
      rmSync(file, { force: true }); // never leave a key the server can't read
      throw err;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

/**
 * The master key goes in `dir` (the server mounts it, nothing else does). The database password goes in its own folder `dbDir`,
 * shared by the server and the database, so the third-party database image never sees the master key (BOS-974 security review F1).
 */
export function runSetup(dir: string, dbDir: string, chown: Chown = chownSync, rand: (n: number) => Buffer = randomBytes): SetupResult {
  for (const d of [dir, dbDir]) if (!existsSync(d) || !statSync(d).isDirectory()) throw new Error(`${d} is not a folder; the setup service must mount the volume there.`);
  const result: SetupResult = { created: [], kept: [] };
  const files: [string, string, () => string, number, number][] = [
    // Same shape as `openssl rand -base64 32`, which docs and the server already expect. Server only (0400).
    ["master.key", dir, () => `${rand(32).toString("base64")}\n`, 0o400, SERVER_UID],
    // Hex only, so it needs no escaping in the database address. The database's group may read it too (0440): its start-up
    // script reads the file again after it drops to its own user.
    ["db_password", dbDir, () => `${rand(24).toString("hex")}\n`, 0o440, DB_GID],
  ];
  for (const [name, where, make, mode, gid] of files) (writeOnce(path.join(where, name), make(), chown, mode, gid) ? result.created : result.kept).push(name);
  return result;
}

/**
 * Optional: if the Docker socket is mounted into setup at `socket` (it is not, by default: root in this container should not get it),
 * say now whether its group can read and write it, rather than at the launcher's first start. Returns the problem, or null.
 */
export function checkSocket(socket: string | undefined, stat: (p: string) => { mode: number } = statSync): string | null {
  if (!socket || !existsSync(socket)) return null;
  return socketModeProblem(socket, stat(socket));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const problem = checkSocket(process.env.BOSSMAN_SETUP_SOCKET);
    if (problem) throw new Error(problem);
    const r = runSetup(process.env.BOSSMAN_CONFIG_DIR ?? "/config", process.env.BOSSMAN_DB_SECRET_DIR ?? "/db-secret");
    for (const f of r.created) console.log(`Created ${f}`);
    for (const f of r.kept) console.log(`Kept ${f} (already there; not changed)`);
    console.log("Setup is done. Back up the config volume: without master.key, stored secrets cannot be read.");
  } catch (err) {
    console.error(`Setup failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
