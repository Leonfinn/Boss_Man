// Where a project's repo lives, and how to reach its host's API (R59).

export type GitHostKind = "github" | "gitea";
export type RepoAddress = { kind: GitHostKind | null; origin: string; owner: string; repo: string };

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./];

/** A LAN host plain http is allowed for: a private-range IPv4 address, localhost, or a .local/.lan name. */
export function isLanHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return PRIVATE_V4.some((r) => r.test(h) && /^\d+\.\d+\.\d+\.\d+$/.test(h)) || h === "localhost" || h.endsWith(".local") || h.endsWith(".lan");
}

/** https, ssh and local paths anywhere; plain http only to a LAN host, such as a Gitea at http://192.0.2.10:3003. */
export function repoUrlAllowed(u: string): boolean {
  if (/^(https:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(u)) return true;
  if (!u.startsWith("http://")) return false;
  try {
    return isLanHost(new URL(u).hostname);
  } catch {
    return false;
  }
}

/**
 * The host's web address and the repo's owner and name, from an https, http or ssh address.
 * The owner and name are the last two path parts, so a Gitea served under a sub-path still
 * works. An ssh address gives https on the same host as a guess; the owner can correct it.
 */
export function parseRepoUrl(u: string): RepoAddress | null {
  let origin: string;
  let pathname: string;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(u);
  try {
    if (scp) {
      origin = `https://${scp[1]}`;
      pathname = `/${scp[2]}`;
    } else {
      const url = new URL(u);
      if (url.protocol === "ssh:") origin = `https://${url.hostname}`;
      else if (url.protocol === "https:" || url.protocol === "http:") origin = url.origin;
      else return null;
      pathname = url.pathname;
    }
  } catch {
    return null;
  }
  const parts = pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts.slice(-2) as [string, string];
  const prefix = scp || u.startsWith("ssh://") ? "" : parts.slice(0, -2).map((p) => `/${p}`).join("");
  const host = new URL(origin).hostname.toLowerCase();
  return { kind: host === "github.com" || host === "www.github.com" ? "github" : null, origin: `${origin}${prefix}`, owner, repo };
}

/** The API base for a host: GitHub's public API, or Gitea's /api/v1 under the web address. */
export function apiBaseFor(kind: GitHostKind, origin: string): string {
  return kind === "github" ? "https://api.github.com" : `${origin.replace(/\/$/, "")}/api/v1`;
}
