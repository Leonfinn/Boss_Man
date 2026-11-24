// The compose healthcheck (BOS-1892): `node dist/check.js` exits 0 when the launcher can open Docker's socket and
// write its data folder, otherwise 1 with the fix on stderr (`docker inspect` shows it), so `docker compose ps` says "unhealthy".
import path from "node:path";
import { checkSetup } from "./selfcheck.js";
import { dropToUnprivileged } from "./startup.js";

const dataRoot = process.env.BOSSMAN_DATA;
if (!dataRoot || !path.isAbsolute(dataRoot)) {
  console.error("Set BOSSMAN_DATA to an absolute host folder, mounted at the same path in this container.");
  process.exit(1);
}
// BOS-1227: the image install starts the launcher as root with only SETUID and SETGID, and a health check run by Docker inside it is
// root too, with no right to open the socket or the data folder (no DAC_OVERRIDE). Check as the user the launcher really runs as.
try {
  dropToUnprivileged(process.env.DOCKER_SOCKET ?? "/var/run/docker.sock");
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
}
const problems = checkSetup({ dataRoot, socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
for (const p of problems) console.error(p.message);
process.exit(problems.length ? 1 : 0);
