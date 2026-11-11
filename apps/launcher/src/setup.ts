// `docker compose run --rm setup` (BOS-974): makes the secrets a pull-only install needs, inside a volume, with nothing on the host.
// Safe to run twice: a file that exists is never touched, because a new master key would make every stored secret unreadable.
import { chownSync, closeSync, constants, existsSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** The user the server runs as; it must be able to read what it is given. */
const SERVER_UID = 1000;

export type SetupResult = { created: string[]; kept: string[] };

/** Writes `body` to `file` only if it doesn't exist: mode 0400, owned by uid 1000. O_EXCL means two setups at once can't both win. */
function writeOnce(file: string, body: string, chown: (f: string, uid: number, gid: number) => void): boolean {
  if (existsSync(file)) return false;
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  chown(file, SERVER_UID, SERVER_UID);
  return true;
}

export function runSetup(dir: string, chown: (f: string, uid: number, gid: number) => void = chownSync, rand: (n: number) => Buffer = randomBytes): SetupResult {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder; the setup service must mount the config volume there.`);
  mkdirSync(dir, { recursive: true });
  const result: SetupResult = { created: [], kept: [] };
  const files: [string, () => string][] = [
    // Same shape as `openssl rand -base64 32`, which docs and the server already expect.
    ["master.key", () => `${rand(32).toString("base64")}\n`],
    // Hex only, so it needs no escaping in the database address.
    ["db_password", () => `${rand(24).toString("hex")}\n`],
  ];
  for (const [name, make] of files) (writeOnce(path.join(dir, name), make(), chown) ? result.created : result.kept).push(name);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const r = runSetup(process.env.BOSSMAN_CONFIG_DIR ?? "/config");
    for (const f of r.created) console.log(`Created ${f}`);
    for (const f of r.kept) console.log(`Kept ${f} (already there; not changed)`);
    console.log("Setup is done. Back up the config volume: without master.key, stored secrets cannot be read.");
  } catch (err) {
    console.error(`Setup failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
