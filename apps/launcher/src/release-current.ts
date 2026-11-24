// BOS-1227 (941c): the `release-current` file. The updater writes it once a server move is done and soaked; the launcher reads it at every
// runner create and guard start, so new runners and guards run the release the server runs, with no launcher restart and no change to the
// launcher's own environment. A missing, unreadable or unsafe file means "use the environment image", exactly as before.
import { readFileSync } from "node:fs";

export interface ReleaseCurrent {
  runner?: string;
  netguard?: string;
}

const DIGEST_REF = /^[a-z0-9][a-z0-9./_-]{0,200}@sha256:[0-9a-f]{64}$/;
const repoOf = (ref: string) => ref.split("@")[0]!.split(":")[0]!;

/**
 * One image ref from the file, or undefined. It must be pinned by digest and name the same repository as the environment image
 * (`base`), so a stray or planted file cannot make the launcher start an image from somewhere else. With no environment image
 * (a build install) the file is ignored.
 */
export function acceptRef(value: unknown, base: string | undefined): string | undefined {
  if (typeof value !== "string" || !base) return undefined;
  if (!DIGEST_REF.test(value)) return undefined;
  return repoOf(value) === repoOf(base) ? value : undefined;
}

/** Parses the file's text; anything that is not the expected shape gives {}. */
export function parseReleaseCurrent(text: string, base: { runner?: string; netguard?: string }): ReleaseCurrent {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const runner = acceptRef(o.runner, base.runner);
  const netguard = acceptRef(o.netguard, base.netguard);
  return { ...(runner ? { runner } : {}), ...(netguard ? { netguard } : {}) };
}

/** A reader for `cfg.release`: re-reads the file at each call; a failure to read is {} (and logged once per change of reason). */
export function releaseReader(file: string | undefined, base: { runner?: string; netguard?: string }, log: (msg: string) => void = () => undefined): () => ReleaseCurrent {
  let lastProblem = "";
  return () => {
    if (!file) return {};
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return {};
      const problem = `release-current unreadable (${code ?? "error"})`;
      if (problem !== lastProblem) log(problem);
      lastProblem = problem;
      return {};
    }
    const got = parseReleaseCurrent(text, base);
    const problem = Object.keys(got).length === 0 && text.trim() ? "release-current ignored: not a digest of the configured images" : "";
    if (problem && problem !== lastProblem) log(problem);
    lastProblem = problem;
    return got;
  };
}
