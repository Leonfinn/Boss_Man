// The updater container's entry point. 941a: it can verify a release, download it and install the Claude pack, and stops at
// "ready to swap". No compose service starts it on a real install until 941b adds the swap.
import { loadConfig, UpdaterError } from "./config.js";
import { dockerClient, socketTransport } from "./docker.js";
import { recover } from "./move.js";
import { createServer } from "./server.js";
import { dropToUnprivileged, readKey } from "./startup.js";
import { stateStore } from "./state.js";

const log = (m: string) => console.log(`[updater] ${m}`);

async function main() {
  const cfg = loadConfig();
  log(dropToUnprivileged(cfg.dockerSock));
  const key = readKey(cfg.keyFile);
  const docker = dockerClient(socketTransport(cfg.dockerSock), { installLabel: cfg.installLabel, volume: cfg.packVolume, network: cfg.network });
  const state = stateStore(cfg.stateDir);
  await recover({ cfg, docker, state });
  const { server } = createServer({ cfg, docker, state }, key);
  server.listen(cfg.port, "0.0.0.0", () => log(`listening on ${cfg.port}, running release ${cfg.currentVersion}`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error(`[updater] ${e instanceof UpdaterError ? e.message : `could not start: ${String((e as Error)?.message ?? e)}`}`);
  process.exit(1);
});
