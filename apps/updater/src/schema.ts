// The two things the updater reads and checks strictly: the one instruction (design section 2) and the signed
// release.json (section 3). Anything that is not exactly what we expect is refused with a plain sentence.
import { UpdaterError, type Arch } from "./config.js";

export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** The Claude pack folder name: the first 24 hex characters of the lockfile's sha256 (apps/runner/src/claude-pack.ts). */
export const PACK_HASH_RE = /^[0-9a-f]{24}$/;
export const IMAGE_NAMES = ["boss-man-server", "boss-man-launcher", "boss-man-netguard", "boss-man-runner", "boss-man-updater"] as const;
export type ImageName = (typeof IMAGE_NAMES)[number];

export type Instruction = { version: string; serverDigest: string };

/** The whole instruction: exactly `version` and `serverDigest`, nothing else (no image, registry, URL, env, mount or command). */
export function parseInstruction(body: unknown): Instruction {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new UpdaterError("bad_request", "The instruction must be a JSON object.");
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("version") || !keys.includes("serverDigest")) throw new UpdaterError("bad_request", "The instruction must have exactly version and serverDigest.");
  const { version, serverDigest } = body as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION_RE.test(version)) throw new UpdaterError("bad_request", "version is not a release number like 0.1.0 or 0.1.0-beta.2.");
  if (typeof serverDigest !== "string" || !DIGEST_RE.test(serverDigest)) throw new UpdaterError("bad_request", "serverDigest must be sha256: followed by 64 lower-case hex characters.");
  return { version, serverDigest };
}

/** Compares two release numbers; a pre-release is older than its release (0.1.0-beta.1 < 0.1.0). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { nums: core.split(".").map(Number), pre: pre === undefined ? null : pre.split(".") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^[0-9]+$/.test(p);
    const qn = /^[0-9]+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export type ReleaseImage = { name: ImageName; digest: string; platformDigest: string };
export type Release = {
  version: string;
  commit: string;
  registries: string[];
  images: Record<string, ReleaseImage>;
  /** Image names a full release should list but this file does not (an older release.json has no updater image). */
  missing: ImageName[];
  /** The Claude pack folder hash this release's runner image installs. Absent in a release.json from before 941a. */
  packHash: string | null;
  /** The number of the colour-spec layout the swap (941b) builds. Absent in older files. */
  installLayout: number | null;
};

const bad = (msg: string): never => {
  throw new UpdaterError("bad_release", `release.json is not usable: ${msg}`);
};

/**
 * Checks a release.json that has already passed the signature check. `expectVersion` is what was asked for, `registry` is this
 * install's prefix and `arch` this machine's: every image must have a digest for that architecture. Old files (no packHash or
 * installLayout) still parse; the caller decides whether it can move to one.
 */
export function parseRelease(json: unknown, expect: { version: string; registry: string; arch: Arch }): Release {
  if (!json || typeof json !== "object" || Array.isArray(json)) return bad("it is not a JSON object.");
  const r = json as Record<string, unknown>;
  if (r["schema"] !== 1) return bad(`its schema is ${JSON.stringify(r["schema"])}, this updater reads schema 1.`);
  if (r["version"] !== expect.version) return bad(`it is for release ${JSON.stringify(r["version"])}, not ${expect.version}.`);
  if (typeof r["commit"] !== "string" || !/^[0-9a-f]{40}$/.test(r["commit"])) return bad("its commit is not a 40-character id.");
  const registries = r["registries"];
  if (!Array.isArray(registries) || registries.length === 0 || !registries.every((x) => typeof x === "string")) return bad("it lists no registries.");
  if (!(registries as string[]).includes(expect.registry)) return bad(`it is not published to this install's registry (${expect.registry}).`);
  const list = r["images"];
  if (!Array.isArray(list) || list.length === 0) return bad("it lists no images.");
  const images: Record<string, ReleaseImage> = {};
  for (const raw of list) {
    if (!raw || typeof raw !== "object") return bad("an image entry is not an object.");
    const e = raw as Record<string, unknown>;
    const name = e["name"];
    if (typeof name !== "string" || !(IMAGE_NAMES as readonly string[]).includes(name)) return bad(`it lists an image this updater does not know (${JSON.stringify(name)}).`);
    if (images[name]) return bad(`${name} is listed twice.`);
    if (typeof e["digest"] !== "string" || !DIGEST_RE.test(e["digest"])) return bad(`${name} has no valid digest.`);
    const platforms = e["platforms"];
    const pd = platforms && typeof platforms === "object" ? (platforms as Record<string, unknown>)[`linux/${expect.arch}`] : undefined;
    if (typeof pd !== "string" || !DIGEST_RE.test(pd)) return bad(`${name} has no image for this machine's architecture (linux/${expect.arch}).`);
    images[name] = { name: name as ImageName, digest: e["digest"], platformDigest: pd };
  }
  const packHash = r["packHash"];
  if (packHash !== undefined && (typeof packHash !== "string" || !PACK_HASH_RE.test(packHash))) return bad("its packHash is not a 24-character hex hash.");
  const layout = r["installLayout"];
  if (layout !== undefined && (!Number.isInteger(layout) || (layout as number) < 1)) return bad("its installLayout is not a whole number.");
  return {
    version: expect.version,
    commit: r["commit"],
    registries: registries as string[],
    images,
    missing: IMAGE_NAMES.filter((n) => !images[n]),
    packHash: (packHash as string | undefined) ?? null,
    installLayout: (layout as number | undefined) ?? null,
  };
}
