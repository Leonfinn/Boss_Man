// Downloads release.json and its signature for one version from this install's GitHub repository, then checks them (design
// section 3). The URL is built from the install's configuration and the version; the instruction cannot name another place.
import path from "node:path";
import { UpdaterError, type Config } from "./config.js";
import { parseRelease, type Release } from "./schema.js";
import { verifyRelease, type VerifyFn } from "./verify.js";

export type Fetch = typeof fetch;

const MAX_REDIRECTS = 5;

/**
 * GET with a size cap, a timeout, and no redirect off the allowed GitHub hosts. Redirects are followed by hand so each hop is
 * checked: a release asset is served from a GitHub download host, never from anywhere else.
 */
export async function fetchLimited(url: string, cfg: Pick<Config, "allowedHosts" | "maxReleaseBytes" | "fetchTimeoutMs">, doFetch: Fetch = fetch): Promise<Buffer> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (!cfg.allowedHosts.includes(u.hostname)) throw new UpdaterError("fetch_host", `The download was refused because it points at ${u.hostname}, which is not a GitHub download host.`);
    let res: Response;
    try {
      res = await doFetch(current, { redirect: "manual", signal: AbortSignal.timeout(cfg.fetchTimeoutMs), headers: { "user-agent": "boss-man-updater" } });
    } catch {
      throw new UpdaterError("fetch_failed", "The updater could not download the release from GitHub (no answer in time). Nothing was changed; try again later.");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new UpdaterError("fetch_failed", "GitHub answered a download with a redirect and no address.");
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status === 404) throw new UpdaterError("release_not_found", "GitHub has no such release, or it has no signed release.json.");
    if (res.status !== 200) throw new UpdaterError("fetch_failed", `GitHub answered ${res.status} for the release download. Nothing was changed; try again later.`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > cfg.maxReleaseBytes) throw new UpdaterError("fetch_size", "The release file is larger than this updater accepts, so it was refused.");
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch {
        throw new UpdaterError("fetch_failed", "The download from GitHub broke off. Nothing was changed; try again later.");
      }
      if (step.done) break;
      total += step.value.length;
      if (total > cfg.maxReleaseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpdaterError("fetch_size", "The release file is larger than this updater accepts, so it was refused.");
      }
      chunks.push(Buffer.from(step.value));
    }
    return Buffer.concat(chunks);
  }
  throw new UpdaterError("fetch_failed", "GitHub redirected the download too many times.");
}

export type ReleaseDeps = { fetch?: Fetch; verifyFn?: VerifyFn };

/** Download, verify the signature with the pinned identity, then check the contents. Returns the checked release. */
export async function getVerifiedRelease(cfg: Config, version: string, deps: ReleaseDeps = {}): Promise<Release> {
  const base = `${cfg.githubBase}/${cfg.repo}/releases/download/v${version}`;
  const data = await fetchLimited(`${base}/release.json`, cfg, deps.fetch);
  const sig = await fetchLimited(`${base}/release.json.sigstore.json`, cfg, deps.fetch);
  let bundle: unknown;
  try {
    bundle = JSON.parse(sig.toString("utf8"));
  } catch {
    throw new UpdaterError("not_signed", "The signature file is not readable, so the release was refused.");
  }
  await verifyRelease({ repo: cfg.repo, data, bundle, tufCachePath: path.join(cfg.stateDir, "tuf"), tufMirrorURL: cfg.tufMirror }, deps.verifyFn);
  let json: unknown;
  try {
    json = JSON.parse(data.toString("utf8"));
  } catch {
    throw new UpdaterError("bad_release", "release.json is not usable: it is not JSON.");
  }
  return parseRelease(json, { version, registry: cfg.registry, arch: cfg.arch });
}
