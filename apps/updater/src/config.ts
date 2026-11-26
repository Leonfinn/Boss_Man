// What the updater is told when the install is made, from its environment (images.env and the compose file, 941b).
// None of it can be changed by a request: the one instruction names a release and nothing else (design section 2).
import path from "node:path";

/** A refusal or failure with a stable code and a sentence an owner can read. Nothing in `message` is a secret. */
export class UpdaterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Arch = "amd64" | "arm64";

/** What setup defines for the server colours and the next updater (design section 5, "the colour spec"): the install's own values. */
export type SwapConfig = {
  frontNetwork: string;
  launcherNetwork: string;
  /** The database container the backup runs in. */
  dbContainer: string;
  /** KEY=value pairs the install sets for a server colour (never a secret value: files are mounted, not passed). */
  serverEnv: string[];
  /** Named volumes a colour mounts. */
  serverMounts: { source: string; target: string; readOnly: boolean }[];
  /** Named volumes the next updater mounts (its state and key folders). */
  selfMounts: { source: string; target: string; readOnly: boolean }[];
  /** The updater's own private network (the server calls it there). */
  selfNetwork: string;
  /** This updater's own container name (the next updater takes it over at the hand-over). */
  selfName: string;
  /** The Docker socket's path on the host, for the next updater's one bind. */
  socketHostPath: string;
  serverMemory: number;
  serverMemoryReserved: number;
  /** The colour-spec layout this updater builds. A release with a higher installLayout is refused (or updates the updater first). */
  layout: number;
  readySeconds: number;
  handoverSeconds: number;
  soakSeconds: number;
  soakCheckSeconds: number;
  pollSeconds: number;
  soakPollSeconds: number;
  stopGraceSeconds: number;
  handoverCallSeconds: number;
  backupsKeep: number;
  /** BOS-1227 (941c): the launcher and the first start. Null when the install does not define the launcher's spec. */
  helpers: HelpersConfig | null;
};

/** What setup defines for the launcher (design section 5, "The whole release moves"): the same pattern as the server colour's values. */
export type HelpersConfig = {
  launcherName: string;
  /** KEY=value lines for the launcher (never BOSSMAN_RUNNER_IMAGE / BOSSMAN_NETGUARD_IMAGE: the updater sets those from the release). */
  launcherEnv: string[];
  /** Named volumes the launcher mounts (data, its key folder, the updater's state folder read-only for `release-current`). */
  launcherMounts: { source: string; target: string; readOnly: boolean }[];
  /** Where the updater reaches the launcher, and the file holding the key it sends. */
  launcherUrl: string;
  launcherKeyFile: string;
  launcherMemory: number;
  /** How long a launcher move waits for "a run is starting" to clear, and how often it asks. */
  busyWaitSeconds: number;
  busyPollSeconds: number;
  launcherReadySeconds: number;
  /** First start: the release this install file was made from (digests, no signature check: the install file is the trust). */
  first: { server: string; launcher: string; runner: string; netguard: string } | null;
  dbReadySeconds: number;
};

export type Config = {
  /** Present when the install defines the swap's names (compose profile `bluegreen`); without it a move stops at ready-to-swap. */
  swap: SwapConfig | null;
  /** The UPDATER_* settings this updater started with: the next updater is given the same ones (section 8). */
  rawEnv: Record<string, string>;
  /** The GitHub repository whose workflow signs releases, `<owner>/<name>`. */
  repo: string;
  /** The registry prefix this install pulls from, e.g. ghcr.io/example. Must be listed in the signed release.json. */
  registry: string;
  /** Where GitHub releases are read from. Only a test changes the default. */
  githubBase: string;
  /** Hosts a release download may be redirected to. Anything else is refused. */
  allowedHosts: string[];
  keyFile: string;
  stateDir: string;
  port: number;
  dockerSock: string;
  /** `key=value`: every container this updater touches carries it, and it refuses any that does not. */
  installLabel: string;
  /** The release the install runs now; a move to an older one is refused. */
  currentVersion: string;
  arch: Arch;
  /** The named volume holding the Claude pack, and the network the pack installer joins to reach npm. */
  packVolume: string;
  network: string;
  /** Prefix of the names of containers the updater creates. */
  namePrefix: string;
  /** TUF mirror for the Sigstore trusted root; unset = the library's default (the public mirror). */
  tufMirror?: string;
  maxReleaseBytes: number;
  fetchTimeoutMs: number;
  packTimeoutMs: number;
};

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REGISTRY_RE = /^[a-z0-9.-]+(:[0-9]+)?\/[a-z0-9._/-]+$/;
const LABEL_RE = /^[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const DEFAULT_ALLOWED_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

export function hostArch(nodeArch: string = process.arch): Arch {
  if (nodeArch === "x64") return "amd64";
  if (nodeArch === "arm64") return "arm64";
  throw new UpdaterError("unsupported_arch", `This machine's processor (${nodeArch}) is not supported: Boss Man publishes amd64 and arm64 images.`);
}

/** Reads the configuration; a missing or malformed value stops the updater at start-up with the name of the setting. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const need = (name: string, re: RegExp, what: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new UpdaterError("config", `${name} is not set (${what}).`);
    if (!re.test(v)) throw new UpdaterError("config", `${name} is not valid (${what}).`);
    return v;
  };
  const num = (name: string, dflt: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new UpdaterError("config", `${name} must be a whole number above zero.`);
    return n;
  };
  const repo = need("UPDATER_REPO", REPO_RE, "the GitHub repository, like owner/name");
  const registry = need("UPDATER_REGISTRY", REGISTRY_RE, "the registry and namespace, like ghcr.io/example").toLowerCase();
  const installLabel = need("UPDATER_INSTALL_LABEL", LABEL_RE, "key=value carried by this install's containers");
  const currentVersion = need("UPDATER_CURRENT_VERSION", /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/, "the release this install runs, like 0.1.0-beta.1");
  const githubBase = (env["UPDATER_GITHUB_BASE"]?.trim() || "https://github.com").replace(/\/$/, "");
  const extraHosts = (env["UPDATER_ALLOWED_HOSTS"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const stateDir = env["UPDATER_STATE_DIR"]?.trim() || "/state";
  const lines = (name: string): string[] => (env[name] ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const mounts = (name: string) =>
    lines(name).map((l) => {
      const [source = "", target = "", mode] = l.split(":");
      if (!NAME_RE.test(source) || !/^\/[A-Za-z0-9_./-]+$/.test(target) || (mode !== undefined && mode !== "ro")) throw new UpdaterError("config", `${name} has a line that is not volume:/path or volume:/path:ro.`);
      return { source, target, readOnly: mode === "ro" };
    });
  let swap: SwapConfig | null = null;
  if (env["UPDATER_FRONT_NETWORK"]?.trim()) {
    const serverEnv = lines("UPDATER_SPEC_ENV");
    for (const l of serverEnv) {
      if (!/^[A-Z][A-Z0-9_]*=/.test(l)) throw new UpdaterError("config", "UPDATER_SPEC_ENV has a line that is not KEY=value.");
      if (/^BOSSMAN_(IMAGE_INSTALL|RELEASE_REPO|VERSION)=/.test(l)) throw new UpdaterError("config", "UPDATER_SPEC_ENV must not set BOSSMAN_IMAGE_INSTALL, BOSSMAN_RELEASE_REPO or BOSSMAN_VERSION: the updater sets them for each colour from the release it makes.");
      if (/^BOSSMAN_(COLOUR|ROLE)=/.test(l)) throw new UpdaterError("config", "UPDATER_SPEC_ENV must not set BOSSMAN_COLOUR or BOSSMAN_ROLE: the updater sets them for each colour.");
    }
    swap = {
      frontNetwork: need("UPDATER_FRONT_NETWORK", NAME_RE, "the private network the proxy and the colours share"),
      launcherNetwork: need("UPDATER_LAUNCHER_NETWORK", NAME_RE, "the network the server shares with the launcher"),
      dbContainer: need("UPDATER_DB_CONTAINER", NAME_RE, "the database container's name"),
      serverEnv,
      serverMounts: mounts("UPDATER_SPEC_MOUNTS"),
      selfMounts: mounts("UPDATER_SELF_MOUNTS"),
      selfNetwork: need("UPDATER_SELF_NETWORK", NAME_RE, "the updater's own network"),
      selfName: env["UPDATER_SELF_NAME"]?.trim() || "updater",
      socketHostPath: env["UPDATER_DOCKER_SOCK_HOST"]?.trim() || "/var/run/docker.sock",
      serverMemory: Number(env["UPDATER_SERVER_MEMORY"] || 0) || 0,
      serverMemoryReserved: Number(env["UPDATER_SERVER_MEMORY_RESERVED"] || 0) || 0,
      layout: num("UPDATER_LAYOUT", 1),
      readySeconds: num("UPDATER_READY_SECONDS", 120),
      handoverSeconds: num("UPDATER_HANDOVER_SECONDS", 30),
      soakSeconds: num("UPDATER_SOAK_SECONDS", 900),
      soakCheckSeconds: num("UPDATER_SOAK_CHECK_SECONDS", 60),
      pollSeconds: num("UPDATER_POLL_SECONDS", 2),
      soakPollSeconds: num("UPDATER_SOAK_POLL_SECONDS", 10),
      stopGraceSeconds: num("UPDATER_STOP_GRACE_SECONDS", 60),
      handoverCallSeconds: num("UPDATER_HANDOVER_CALL_SECONDS", 60),
      backupsKeep: num("UPDATER_BACKUPS_KEEP", 3),
      helpers: null,
    };
    if (lines("UPDATER_LAUNCHER_MOUNTS").length > 0) {
      const launcherEnv = lines("UPDATER_LAUNCHER_ENV");
      for (const l of launcherEnv) {
        if (!/^[A-Z][A-Z0-9_]*=/.test(l)) throw new UpdaterError("config", "UPDATER_LAUNCHER_ENV has a line that is not KEY=value.");
        if (/^BOSSMAN_(RUNNER|NETGUARD)_IMAGE=/.test(l)) throw new UpdaterError("config", "UPDATER_LAUNCHER_ENV must not set the runner or guard image: the updater sets them from the release.");
      }
      const dg = (name: string) => {
        const v = env[name]?.trim();
        if (v && !/^sha256:[0-9a-f]{64}$/.test(v)) throw new UpdaterError("config", `${name} must be sha256: followed by 64 lower-case hex characters.`);
        return v;
      };
      const f = { server: dg("UPDATER_FIRST_SERVER_DIGEST"), launcher: dg("UPDATER_FIRST_LAUNCHER_DIGEST"), runner: dg("UPDATER_FIRST_RUNNER_DIGEST"), netguard: dg("UPDATER_FIRST_NETGUARD_DIGEST") };
      swap.helpers = {
        launcherName: env["UPDATER_LAUNCHER_NAME"]?.trim() || "launcher",
        launcherEnv,
        launcherMounts: mounts("UPDATER_LAUNCHER_MOUNTS"),
        launcherUrl: (env["UPDATER_LAUNCHER_URL"]?.trim() || "http://launcher:3105").replace(/\/$/, ""),
        launcherKeyFile: env["UPDATER_LAUNCHER_KEY_FILE"]?.trim() || "/run/launcher/key",
        launcherMemory: Number(env["UPDATER_LAUNCHER_MEMORY"] || 0) || 128 * 1024 * 1024,
        busyWaitSeconds: num("UPDATER_BUSY_WAIT_SECONDS", 600),
        busyPollSeconds: num("UPDATER_BUSY_POLL_SECONDS", 10),
        launcherReadySeconds: num("UPDATER_LAUNCHER_READY_SECONDS", 60),
        first: f.server && f.launcher && f.runner && f.netguard ? { server: f.server, launcher: f.launcher, runner: f.runner, netguard: f.netguard } : null,
        dbReadySeconds: num("UPDATER_DB_READY_SECONDS", 120),
      };
    }
  }
  return {
    swap,
    rawEnv: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[0].startsWith("UPDATER_") && typeof e[1] === "string")),
    repo,
    registry,
    githubBase,
    allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...extraHosts],
    keyFile: env["UPDATER_KEY_FILE"]?.trim() || "/run/updater/key",
    stateDir: path.resolve(stateDir),
    port: num("UPDATER_PORT", 3106),
    dockerSock: env["UPDATER_DOCKER_SOCK"]?.trim() || "/var/run/docker.sock",
    installLabel,
    currentVersion,
    arch: hostArch(env["UPDATER_ARCH"]?.trim() === "amd64" ? "x64" : env["UPDATER_ARCH"]?.trim() || process.arch),
    packVolume: need("UPDATER_PACK_VOLUME", NAME_RE, "the named volume holding the Claude pack"),
    network: need("UPDATER_NETWORK", NAME_RE, "the network the pack installer joins"),
    namePrefix: need("UPDATER_NAME_PREFIX", NAME_RE, "the start of the names of containers the updater creates"),
    tufMirror: env["UPDATER_TUF_MIRROR"]?.trim() || undefined,
    maxReleaseBytes: num("UPDATER_MAX_RELEASE_BYTES", 256 * 1024),
    fetchTimeoutMs: num("UPDATER_FETCH_TIMEOUT_MS", 30_000),
    packTimeoutMs: num("UPDATER_PACK_TIMEOUT_MS", 15 * 60_000),
  };
}
