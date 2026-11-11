// `docker compose run --rm setup` (BOS-974): makes the secrets a pull-only install needs, inside a volume, with nothing on the host.
// Safe to run twice: a file that exists is never touched, because a new master key would make every stored secret unreadable.
import { chownSync, closeSync, constants, existsSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** The user the server runs as; it must be able to read what it is given. */
const SERVER_UID = 1000;

export type SetupResult = { created: string[]; kept: string[] };

/** The database's own user (the postgres image). It may read the password file, and nothing else in the install. */
const DB_GID = 999;

type Chown = (f: string, uid: number, gid: number) => void;

/** Writes `body` to `file` only if it doesn't exist. O_EXCL means two setups at once can't both win. */
function writeOnce(file: string, body: string, chown: Chown, mode: number, gid: number): boolean {
  if (existsSync(file)) return false;
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  chown(file, SERVER_UID, gid);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const r = runSetup(process.env.BOSSMAN_CONFIG_DIR ?? "/config", process.env.BOSSMAN_DB_SECRET_DIR ?? "/db-secret");
    for (const f of r.created) console.log(`Created ${f}`);
    for (const f of r.kept) console.log(`Kept ${f} (already there; not changed)`);
    console.log("Setup is done. Back up the config volume: without master.key, stored secrets cannot be read.");
  } catch (err) {
    console.error(`Setup failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
