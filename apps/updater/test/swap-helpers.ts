// Shared set-up for the swap tests: a signed-release host, a FakeDaemon with a live blue colour, and the updater's dependencies.
import { dockerClient } from "../src/docker.js";
import { newGate } from "../src/selfupdate.js";
import type { SwapReady } from "../src/spec.js";
import { stateStore } from "../src/state.js";
import { FakeDaemon, NEW_COMMIT, swapConfig } from "./fake-daemon.js";
import { fixture, sha, startFileServer } from "./helpers.js";

export const closers: (() => Promise<void>)[] = [];
export const closeAll = async () => {
  for (const c of closers.splice(0)) await c();
};

export const D_SERVER = sha("7");
export const HASH = "0123456789abcdef01234567";
export const rel = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  version: "0.2.0",
  commit: NEW_COMMIT,
  registries: ["ghcr.io/leonfinn"],
  images: ["boss-man-server", "boss-man-launcher", "boss-man-netguard", "boss-man-runner", "boss-man-updater"].map((name, i) => ({ name, digest: name === "boss-man-server" ? D_SERVER : sha(String(i)), platforms: { "linux/arm64": sha("2"), "linux/amd64": sha("1") } })),
  packHash: HASH,
  installLayout: 1,
  ...over,
});
export const ins = (over: Record<string, unknown> = {}) => ({ version: "0.2.0", serverDigest: D_SERVER, ...over });

export async function setup(opts: { release?: object; cfg?: Record<string, string>; version?: string; live?: boolean } = {}) {
  const version = opts.version ?? "0.2.0";
  const files: Record<string, Buffer | string> = {
    [`/Leonfinn/Boss_Man/releases/download/v${version}/release.json`]: JSON.stringify(opts.release ?? rel({ version })),
    [`/Leonfinn/Boss_Man/releases/download/v${version}/release.json.sigstore.json`]: fixture("release.json.sigstore.json"),
  };
  const gh = await startFileServer(files);
  closers.push(gh.close);
  const cfg = swapConfig({ UPDATER_GITHUB_BASE: gh.base, UPDATER_ALLOWED_HOSTS: "127.0.0.1", ...opts.cfg });
  const daemon = new FakeDaemon();
  daemon.addPlain("test-db");
  if (opts.live !== false) daemon.addLive("blue", "0.0.9");
  const sw = cfg.swap!;
  const docker = dockerClient(daemon.transport, {
    installLabel: cfg.installLabel,
    volume: cfg.packVolume,
    network: cfg.network,
    networks: [cfg.network, sw.frontNetwork, sw.launcherNetwork, sw.selfNetwork],
    volumes: [...sw.serverMounts, ...sw.selfMounts].map((m) => m.source),
    socketBind: `${sw.socketHostPath}:/var/run/docker.sock`,
  });
  const state = stateStore(cfg.stateDir);
  state.load();
  const gate = newGate();
  const deps = { cfg, docker, state, gate, clock: daemon.clock, probe: daemon.probe, release: { verifyFn: async () => undefined }, pull: { sleep: async () => undefined }, pack: { sleep: async () => undefined } };
  return { cfg: cfg as SwapReady, daemon, docker, state, deps, gate };
}
