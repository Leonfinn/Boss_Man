// The colour spec (design section 5, "No compose, no host files"): the server colour's create body is built from DATA here, plus
// the install's own values from the configuration. It never copies an inspect result (that would carry the old image's defaults,
// the old Hostname, BOSSMAN_COLOUR/ROLE, aliases and compose's labels). It sets only what the install defines; Cmd, Entrypoint,
// WorkingDir, User and Healthcheck come from the new image because the body leaves them unset.
// The template is numbered by `installLayout`: a release that needs a different layout than LAYOUT is refused, or updates the
// updater first (section 8).
import { UpdaterError, type Config, type SwapConfig } from "./config.js";
import { projectName } from "./names.js";

/** The layout this code builds. release.json's installLayout above it means "this release needs an install-file change". */
export const LAYOUT = 1;

export type Colour = "blue" | "green";
export const otherColour = (c: Colour): Colour => (c === "blue" ? "green" : "blue");

export const LABEL_MANAGED = "com.bossman.managed";
export const LABEL_COLOUR = "com.bossman.colour";
export const LABEL_RELEASE = "com.bossman.release";
/** The release's server digest the colour was made from (so a move to the standby's release can be told from a replay). */
export const LABEL_DIGEST = "com.bossman.digest";
export const LABEL_ROLE_UPDATER = "com.bossman.updater";

/** The name that holds traffic: the colour with this alias on the front network is the live one. */
export const LIVE_ALIAS = "server-live";
/**
 * BOS-2804: the name a colour is made under. With a name project (UPDATER_NAME_PROJECT, set by the image install's compose file from
 * COMPOSE_PROJECT_NAME) it is `<project>-server-<colour>`, so two installs on one Docker host never share a container name; without
 * it, the old fixed `server-<colour>`. An existing container is found by label, whatever it is called (see `colourRef` in swap.ts).
 */
export const colourName = (c: Colour, project: string | null = null) => projectName(project, `server-${c}`);
export const frontAlias = (c: Colour) => `server-${c}-front`;

export type SwapReady = Config & { swap: SwapConfig };

const splitLabel = (cfg: Config): [string, string] => {
  const [k = "", v = ""] = cfg.installLabel.split("=", 2);
  return [k, v];
};

export type ColourParams = { colour: Colour; image: string; version: string; digest: string; role: "standby" | "auto" };

/**
 * BOS-2713: the one-button install. The server reaches the updater over the updater's own private network and reads its key from
 * the key folder, read-only. Returns the server's mount of that folder (the install's own volume for it) or null when the install
 * does not define one, in which case the colour gets no link and says so on the Updates panel.
 */
export function updaterLink(cfg: SwapReady): { mount: { Type: "volume"; Source: string; Target: string; ReadOnly: true }; env: string[] } | null {
  const dir = cfg.keyFile.replace(/\/[^/]*$/, "");
  const m = cfg.swap.selfMounts.find((x) => x.target === dir);
  if (!m) return null;
  return { mount: { Type: "volume", Source: m.source, Target: m.target, ReadOnly: true }, env: [`BOSSMAN_UPDATER_URL=http://${cfg.swap.selfName}:${cfg.port}`, `BOSSMAN_UPDATER_KEY_FILE=${cfg.keyFile}`] };
}

/** The create body for one server colour. The per-move override list (design section 5) is exactly: image, name/hostname, colour + role env, labels; aliases are set by `colourNetworks`. */
export function colourSpec(cfg: SwapReady, p: ColourParams) {
  const [lk, lv] = splitLabel(cfg);
  const name = colourName(p.colour, cfg.swap.nameProject);
  const link = updaterLink(cfg);
  return {
    Image: p.image,
    Hostname: name,
    // BOS-2663: the server learns it is an image install, which repository its releases come from and which release it is, so it can
    // look for a newer one by itself. A source install is not started by the updater, so it never gets these three.
    Env: [...cfg.swap.serverEnv, `BOSSMAN_COLOUR=${p.colour}`, `BOSSMAN_ROLE=${p.role}`, "BOSSMAN_IMAGE_INSTALL=1", `BOSSMAN_RELEASE_REPO=${cfg.repo}`, `BOSSMAN_VERSION=${p.version}`, ...(link?.env ?? [])],
    Labels: { [lk]: lv, [LABEL_MANAGED]: "1", [LABEL_COLOUR]: p.colour, [LABEL_RELEASE]: p.version, [LABEL_DIGEST]: p.digest },
    StopTimeout: cfg.swap.stopGraceSeconds,
    HostConfig: {
      Mounts: [...cfg.swap.serverMounts.map((m) => ({ Type: "volume", Source: m.source, Target: m.target, ReadOnly: m.readOnly })), ...(link ? [link.mount] : [])],
      NetworkMode: cfg.network,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Devices: [],
      RestartPolicy: { Name: "unless-stopped" },
      Memory: cfg.swap.serverMemory,
      MemoryReservation: cfg.swap.serverMemoryReserved,
      OomScoreAdj: -500,
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  };
}

export type NetworkJoin = { network: string; aliases: string[] };

/** The networks a colour joins besides the default one it is created on. `live` adds the alias the proxy dials. */
export function colourNetworks(cfg: SwapReady, colour: Colour, live: boolean): NetworkJoin[] {
  return [
    { network: cfg.swap.launcherNetwork, aliases: [] },
    // BOS-2713: the updater's own network, so the server can ask it to install a release (no alias: the updater has its own name there).
    ...(updaterLink(cfg) ? [{ network: cfg.swap.selfNetwork, aliases: [] as string[] }] : []),
    { network: cfg.swap.frontNetwork, aliases: live ? [frontAlias(colour), LIVE_ALIAS] : [frontAlias(colour)] },
  ];
}

/** The migrate one-shot: the new server image's own `node dist/migrate.js`, database settings only. */
export function migrateSpec(cfg: SwapReady, image: string, version: string) {
  const [lk, lv] = splitLabel(cfg);
  const dbEnv = cfg.swap.serverEnv.filter((e) => /^(DATABASE_URL|BOSSMAN_DATABASE_PASSWORD_FILE)=/.test(e));
  const dbMounts = cfg.swap.serverMounts.filter((m) => /db/.test(m.source) || m.target.startsWith("/run/db"));
  return {
    Image: image,
    Cmd: ["node", "dist/migrate.js"],
    Env: dbEnv,
    Labels: { [lk]: lv, "com.bossman.migrate": version },
    HostConfig: {
      Mounts: dbMounts.map((m) => ({ Type: "volume", Source: m.source, Target: m.target, ReadOnly: true })),
      NetworkMode: cfg.network,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Devices: [],
      RestartPolicy: { Name: "no" },
    },
  };
}

/** The next updater (section 8): the same settings, the new image and version, root only to learn the socket's group (startup.ts). */
export function updaterSpec(cfg: SwapReady, image: string, version: string, digest: string) {
  const [lk, lv] = splitLabel(cfg);
  const env = { ...cfg.rawEnv, UPDATER_CURRENT_VERSION: version, UPDATER_IS_NEXT: "1" };
  return {
    Image: image,
    User: "0:0",
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: { [lk]: lv, [LABEL_ROLE_UPDATER]: version, [LABEL_DIGEST]: digest },
    HostConfig: {
      Binds: [`${cfg.swap.socketHostPath}:/var/run/docker.sock`],
      Mounts: cfg.swap.selfMounts.map((m) => ({ Type: "volume", Source: m.source, Target: m.target, ReadOnly: m.readOnly })),
      NetworkMode: cfg.swap.selfNetwork,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: ["SETUID", "SETGID"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Devices: [],
      RestartPolicy: { Name: "unless-stopped" },
      Memory: 256 * 1024 * 1024,
      PidsLimit: 128,
    },
  };
}

export const LABEL_HELPER = "com.bossman.helper";
/** Where the launcher sees the updater's state folder (read-only), and the file in it (release-current.ts in the launcher). */
export const RELEASE_FILE_NAME = "release-current.json";
export const RELEASE_FILE_IN_LAUNCHER = "/run/release/release-current.json";

export type HelperRelease = { version: string; launcher: string; runner: string; netguard: string; /** digests only: sha256:... */ };

/**
 * BOS-2804: what ties the launcher's work to this install. The pack volume is the one compose declares and the updater fills (so a
 * runner reads the pack the updater installed, not a second `boss-man-claude-pack`); the install label goes on every runner, guard and
 * pack installer the launcher makes, so removing an install by label removes them too. BOSSMAN_STACK is not set here: it would change
 * the names and labels the launcher adopts its running runners by.
 */
export const launcherInstallEnv = (cfg: SwapReady): string[] => [`BOSSMAN_CLAUDE_PACK_VOLUME=${cfg.packVolume}`, `BOSSMAN_INSTALL_LABEL=${cfg.installLabel}`];

/**
 * The launcher (BOS-1227): created from data like the colours, never copied from the running one. The image is the release's launcher
 * digest; BOSSMAN_RUNNER_IMAGE and BOSSMAN_NETGUARD_IMAGE are the release's digests, so a launcher that starts without the
 * `release-current` file still starts the release's runners. Root only to join the socket's group, then uid 1000 (apps/launcher/src/startup.ts).
 */
export function launcherSpec(cfg: SwapReady, r: HelperRelease) {
  const h = cfg.swap.helpers;
  if (!h) throw new UpdaterError("config", "The install does not define the launcher's settings (UPDATER_LAUNCHER_MOUNTS).");
  const [lk, lv] = splitLabel(cfg);
  return {
    Image: `${cfg.registry}/boss-man-launcher@${r.launcher}`,
    User: "0:0",
    Env: [...h.launcherEnv, `BOSSMAN_RUNNER_IMAGE=${cfg.registry}/boss-man-runner@${r.runner}`, `BOSSMAN_NETGUARD_IMAGE=${cfg.registry}/boss-man-netguard@${r.netguard}`, `BOSSMAN_RELEASE_FILE=${RELEASE_FILE_IN_LAUNCHER}`, ...launcherInstallEnv(cfg)],
    Labels: { [lk]: lv, [LABEL_HELPER]: "launcher", [LABEL_RELEASE]: r.version, [LABEL_DIGEST]: r.launcher },
    Healthcheck: { Test: ["CMD", "node", "dist/check.js"], Interval: 5_000_000_000, Timeout: 5_000_000_000, Retries: 2, StartPeriod: 5_000_000_000 },
    HostConfig: {
      Binds: [`${cfg.swap.socketHostPath}:/var/run/docker.sock`],
      Mounts: h.launcherMounts.map((m) => ({ Type: "volume", Source: m.source, Target: m.target, ReadOnly: m.readOnly })),
      NetworkMode: cfg.swap.launcherNetwork,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: ["SETUID", "SETGID"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Devices: [],
      RestartPolicy: { Name: "unless-stopped" },
      Memory: h.launcherMemory,
      PidsLimit: 64,
    },
  };
}

/**
 * The guard check (BOS-1227): the new guard image run once on its own, printing the ruleset it would load for a made-up address.
 * No capability, no network of its own beyond the install's, nothing mounted: it proves the image starts and its script runs. Loading
 * the rules in a runner's namespace happens at the next guard start, which stays fail-closed (a guard that does not load removes its runner).
 */
export function guardCheckSpec(cfg: SwapReady, image: string, version: string) {
  const [lk, lv] = splitLabel(cfg);
  return {
    Image: image,
    Cmd: ["--print"],
    Env: ["NETGUARD_ALLOW=192.0.2.1:3100"],
    Labels: { [lk]: lv, "com.bossman.guardcheck": version },
    HostConfig: {
      NetworkMode: cfg.network,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Devices: [],
      RestartPolicy: { Name: "no" },
      Memory: 64 * 1024 * 1024,
      PidsLimit: 32,
    },
  };
}

/** Refuses a release that needs a layout this updater does not build (the caller may update itself first when the release is newer). */
export function checkLayout(installLayout: number | null): void {
  if (installLayout !== null && installLayout > LAYOUT) {
    throw new UpdaterError("layout_newer", "This release needs an install-file change. Follow the release notes; the updater changed nothing.");
  }
}
