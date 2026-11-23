// The updater container's entry point: verifies a release, downloads it, installs the Claude pack and (with the install's swap
// settings) swaps the server colours through the Docker API, then updates itself last (design sections 5 and 8).
import { loadConfig, UpdaterError } from "./config.js";
import { dockerClient, socketTransport } from "./docker.js";
import { recover, runMove, type MoveDeps } from "./move.js";
import { callHandover, newGate, OLD_SUFFIX } from "./selfupdate.js";
import { createServer } from "./server.js";
import { dropToUnprivileged, readKey } from "./startup.js";
import { stateStore } from "./state.js";

const log = (m: string) => console.log(`[updater] ${m}`);

async function main() {
  const cfg = loadConfig();
  log(dropToUnprivileged(cfg.dockerSock));
  const key = readKey(cfg.keyFile);
  const sw = cfg.swap;
  const docker = dockerClient(socketTransport(cfg.dockerSock), {
    installLabel: cfg.installLabel,
    volume: cfg.packVolume,
    network: cfg.network,
    networks: sw ? [cfg.network, sw.frontNetwork, sw.launcherNetwork, sw.selfNetwork] : [cfg.network],
    volumes: sw ? [...sw.serverMounts, ...sw.selfMounts].map((m) => m.source) : [],
    socketBind: sw ? `${sw.socketHostPath}:/var/run/docker.sock` : undefined,
  });
  const state = stateStore(cfg.stateDir);
  const gate = newGate();
  const deps: MoveDeps = { cfg, docker, state, gate };
  // This updater was started by the previous one (section 8): pass its own checks (the Docker socket answers, the state volume is
  // readable, the key was read above), then ask the old updater to hand over. If the old one never answers, stop.
  const s = state.load();
  if (sw && cfg.rawEnv["UPDATER_IS_NEXT"] === "1" && s.stage === "updating-updater" && s.nextUpdater) {
    await docker.arch();
    if (!(await callHandover({ ...cfg, swap: sw }, key, s.nextUpdater, (sw.handoverCallSeconds - 10) * 1000))) throw new UpdaterError("handover_refused", "The old updater did not hand over, so this one stopped.");
    state.load();
    log("took over from the previous updater");
  } else if (sw) {
    await docker.remove(`${sw.selfName}${OLD_SUFFIX}`).catch(() => undefined);
  }
  const resumed = await recover(deps);
  const { server, idle } = createServer(deps, key, resumed ?? Promise.resolve());
  server.listen(cfg.port, "0.0.0.0", () => log(`listening on ${cfg.port}, running release ${state.get().currentVersion ?? cfg.currentVersion}`));
  const pending = state.get().pending;
  if (sw && cfg.rawEnv["UPDATER_IS_NEXT"] === "1" && pending && state.get().stage === "idle") {
    // A move that needed this newer updater: carry it on.
    state.begin(pending.version, pending.serverDigest);
    state.update({ pending: null });
    void runMove(deps, pending);
  }
  void idle;
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error(`[updater] ${e instanceof UpdaterError ? e.message : `could not start: ${String((e as Error)?.message ?? e)}`}`);
  process.exit(1);
});
