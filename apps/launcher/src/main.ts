// Boss Man's runner launcher (R55). Configured only by its own environment:
//   BOSSMAN_DATA           host folder for company data, mounted at the same path here
//   BOSSMAN_RUNNER_NETWORK the compose network runners join (default boss-man_default)
//   BOSSMAN_RUNNER_URL     where runners reach the server (default ws://server:3100/api/runner/connect)
//   BOSSMAN_RUNNER_MEMORY  memory limit per runner, e.g. 4g
//   BOSSMAN_RUNNER_PIDS    process and thread limit per runner (default 4096)
//   BOSSMAN_LAUNCHER_KEY_FILE  the key the server sends; made on first start if missing
// `node dist/main.js recreate-all` puts every runner on the current image (scripts/update-runner.sh).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dockerClient } from "./docker.js";
import { launcher, launcherServer } from "./launcher.js";
import { parseMemory, parsePids, type LauncherConfig } from "./spec.js";

const env = process.env;
const dataRoot = env.BOSSMAN_DATA;
if (!dataRoot || !path.isAbsolute(dataRoot)) {
  console.error("Set BOSSMAN_DATA to an absolute host folder, mounted at the same path in this container.");
  process.exit(1);
}
const cfg: LauncherConfig = {
  dataRoot,
  network: env.BOSSMAN_RUNNER_NETWORK ?? "boss-man_default",
  serverUrl: env.BOSSMAN_RUNNER_URL ?? "ws://server:3100/api/runner/connect",
  memoryBytes: parseMemory(env.BOSSMAN_RUNNER_MEMORY),
  pidsLimit: parsePids(env.BOSSMAN_RUNNER_PIDS),
};
const api = launcher(cfg, dockerClient(env.DOCKER_SOCKET ?? "/var/run/docker.sock"));

if (process.argv[2] === "recreate-all") {
  const done = await api.recreateAll();
  console.log(done.length ? `Recreated: ${done.join(", ")}` : "No runners to recreate.");
  process.exit(0);
}

const keyFile = env.BOSSMAN_LAUNCHER_KEY_FILE ?? "/run/launcher/key";
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
const key = Buffer.from(readFileSync(keyFile, "utf8").trim());
if (key.length < 32) {
  console.error(`The key in ${keyFile} is too short.`);
  process.exit(1);
}

const server = launcherServer(api, key);
server.listen(Number(env.PORT ?? 3105), "0.0.0.0", () => console.log(JSON.stringify({ at: new Date().toISOString(), msg: "launcher listening", network: cfg.network })));
// The network guard (BOS-324) must be in the runner's namespace: check at start and every 5 seconds.
const reconcile = () =>
  api.reconcileGuards().then(
    (fixed) => fixed.length && console.log(JSON.stringify({ at: new Date().toISOString(), msg: "network guard started again", companies: fixed })),
    (err: unknown) => console.error(JSON.stringify({ at: new Date().toISOString(), msg: "network guard check failed", error: String((err as Error)?.message ?? err) })),
  );
void reconcile();
setInterval(() => void reconcile(), 5_000).unref();
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
