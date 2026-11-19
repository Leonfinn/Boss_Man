// The compose healthcheck (BOS-1892): `node dist/check.js` exits 0 when the launcher can open Docker's socket and
// write its data folder, otherwise 1 with the fix on stderr (`docker inspect` shows it), so `docker compose ps` says "unhealthy".
import path from "node:path";
import { checkSetup } from "./selfcheck.js";

const dataRoot = process.env.BOSSMAN_DATA;
if (!dataRoot || !path.isAbsolute(dataRoot)) {
  console.error("Set BOSSMAN_DATA to an absolute host folder, mounted at the same path in this container.");
  process.exit(1);
}
const problems = checkSetup({ dataRoot, socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
for (const p of problems) console.error(p.message);
process.exit(problems.length ? 1 : 0);
