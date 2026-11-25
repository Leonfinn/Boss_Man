// BOS-2528: runs the updater's real helper move (apps/updater/src/helpers.ts moveHelpers) against the real Docker daemon, from
// inside the running updater container, so it has the updater's own settings, socket, networks and state folder. It is fed to node
// on standard input by scripts/helper-move-live.sh (the image holds only the compiled code under /app/dist):
//   docker exec -i -e MOVE_VERSION=... -e MOVE_LAUNCHER=sha256:... -e MOVE_RUNNER=... -e MOVE_NETGUARD=... updater node --input-type=module - < scripts/helper-move-live.mjs
// It prints one JSON line: what moveHelpers returned, the helpers record it left in the state, and what release-current says now.
// It prints no environment and no key. It never pulls: the images named by the digests must already be on this host.
const dist = "file:///app/dist/";
const { loadConfig } = await import(`${dist}config.js`);
const { dockerClient, socketTransport } = await import(`${dist}docker.js`);
const { moveHelpers, readReleaseCurrent } = await import(`${dist}helpers.js`);
const { stateStore } = await import(`${dist}state.js`);

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const cfg = loadConfig();
const sw = cfg.swap;
if (!sw || !sw.helpers) throw new Error("this updater has no helper settings (UPDATER_LAUNCHER_MOUNTS)");
const docker = dockerClient(socketTransport(cfg.dockerSock), {
  installLabel: cfg.installLabel,
  volume: cfg.packVolume,
  network: cfg.network,
  networks: [cfg.network, sw.frontNetwork, sw.launcherNetwork, sw.selfNetwork],
  volumes: [...sw.serverMounts, ...sw.selfMounts].map((m) => m.source),
  socketBind: `${sw.socketHostPath}:/var/run/docker.sock`,
  launcherVolumes: sw.helpers.launcherMounts.map((m) => m.source),
});
const state = stateStore(cfg.stateDir);
state.load();
const image = (name, digest) => ({ name, digest: need(digest), platformDigest: need(digest) });
const release = {
  version: need("MOVE_VERSION"),
  commit: "ci",
  registries: [cfg.registry],
  images: {
    "boss-man-launcher": image("boss-man-launcher", "MOVE_LAUNCHER"),
    "boss-man-runner": image("boss-man-runner", "MOVE_RUNNER"),
    "boss-man-netguard": image("boss-man-netguard", "MOVE_NETGUARD"),
  },
  missing: [],
  packHash: null,
  installLayout: null,
};
const result = await moveHelpers({ cfg, docker, state }, release);
console.log(JSON.stringify({ result, helpers: state.get().helpers, releaseCurrent: readReleaseCurrent(cfg) }));
