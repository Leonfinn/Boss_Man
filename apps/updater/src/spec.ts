// The colour spec (design section 5, "No compose, no host files"): the server colour's create body is built from DATA here, plus
// the install's own values from the configuration. It never copies an inspect result (that would carry the old image's defaults,
// the old Hostname, BOSSMAN_COLOUR/ROLE, aliases and compose's labels). It sets only what the install defines; Cmd, Entrypoint,
// WorkingDir, User and Healthcheck come from the new image because the body leaves them unset.
// The template is numbered by `installLayout`: a release that needs a different layout than LAYOUT is refused, or updates the
// updater first (section 8).
import { UpdaterError, type Config, type SwapConfig } from "./config.js";

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
export const colourName = (c: Colour) => `server-${c}`;
export const frontAlias = (c: Colour) => `server-${c}-front`;

export type SwapReady = Config & { swap: SwapConfig };

const splitLabel = (cfg: Config): [string, string] => {
  const [k = "", v = ""] = cfg.installLabel.split("=", 2);
  return [k, v];
};

export type ColourParams = { colour: Colour; image: string; version: string; digest: string; role: "standby" | "auto" };

/** The create body for one server colour. The per-move override list (design section 5) is exactly: image, name/hostname, colour + role env, labels; aliases are set by `colourNetworks`. */
export function colourSpec(cfg: SwapReady, p: ColourParams) {
  const [lk, lv] = splitLabel(cfg);
  const name = colourName(p.colour);
  return {
    Image: p.image,
    Hostname: name,
    Env: [...cfg.swap.serverEnv, `BOSSMAN_COLOUR=${p.colour}`, `BOSSMAN_ROLE=${p.role}`],
    Labels: { [lk]: lv, [LABEL_MANAGED]: "1", [LABEL_COLOUR]: p.colour, [LABEL_RELEASE]: p.version, [LABEL_DIGEST]: p.digest },
    StopTimeout: cfg.swap.stopGraceSeconds,
    HostConfig: {
      Mounts: cfg.swap.serverMounts.map((m) => ({ Type: "volume", Source: m.source, Target: m.target, ReadOnly: m.readOnly })),
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

/** Refuses a release that needs a layout this updater does not build (the caller may update itself first when the release is newer). */
export function checkLayout(installLayout: number | null): void {
  if (installLayout !== null && installLayout > LAYOUT) {
    throw new UpdaterError("layout_newer", "This release needs an install-file change. Follow the release notes; the updater changed nothing.");
  }
}
