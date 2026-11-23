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

export type Config = {
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
  return {
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
