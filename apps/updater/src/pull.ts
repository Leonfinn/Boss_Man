// Pulls an image by digest from this install's registry, with retries, and reads the digest back (design section 3).
// Nothing here chooses WHICH image: the references come from the verified release.json.
import { UpdaterError, type Arch } from "./config.js";
import { DockerError, type Docker } from "./docker.js";
import { DIGEST_RE } from "./schema.js";

export type PullOptions = { retries?: number; delaysMs?: number[]; sleep?: (ms: number) => Promise<void>; arch: Arch };

/** 5 tries, growing delays (registries rate-limit). The delays are injected so tests never wait. */
export const DEFAULT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

export const imageRef = (registry: string, name: string, digest: string) => `${registry}/${name}@${digest}`;

export async function pullByDigest(docker: Docker, registry: string, name: string, digest: string, opts: PullOptions): Promise<void> {
  if (!DIGEST_RE.test(digest)) throw new UpdaterError("bad_release", `${name} has no valid digest.`);
  const ref = imageRef(registry, name, digest);
  const tries = opts.retries ?? 5;
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      await docker.pull(ref);
      last = undefined;
      break;
    } catch (e) {
      last = e;
      // A refusal from the allow-list or a missing image will not get better by waiting.
      if (e instanceof UpdaterError || (e instanceof DockerError && /not found|manifest unknown|unauthorized|denied/i.test(e.message))) break;
      if (attempt < tries) await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
    }
  }
  if (last) throw new UpdaterError("pull_failed", `The updater could not download ${name} from the registry (${last instanceof Error ? last.message : "unknown error"}). Nothing was changed; try again later.`);
  // Read the digest back: pulling by digest is self-checking, and this proves the daemon holds exactly that content.
  const info = await docker.imageInfo(ref);
  const holds = info?.RepoDigests?.some((d) => d === ref) ?? false;
  if (!info || !holds) {
    if (info) await docker.removeImage(info.Id).catch(() => undefined);
    throw new UpdaterError("digest_mismatch", `After downloading ${name}, the registry's copy did not have the digest the signed release names, so it was deleted and the update was stopped. Nothing was changed.`);
  }
  if (info.Architecture && info.Architecture !== opts.arch) {
    await docker.removeImage(info.Id).catch(() => undefined);
    throw new UpdaterError("digest_mismatch", `After downloading ${name}, the image was built for ${info.Architecture}, not this machine (${opts.arch}), so it was deleted and the update was stopped. Nothing was changed.`);
  }
}
