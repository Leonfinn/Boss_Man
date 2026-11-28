// Secret kinds and the clean-up applied before a secret is stored (R13a).
// Spike S2's first real run failed with HTTP 401 because a pasted setup-token
// carried a stray whitespace character, so token kinds lose all whitespace.

export const SECRET_KINDS = [
  "claude_oauth_token",
  "anthropic_api_key",
  "anthropic_admin_key",
  "openai_api_key",
  "ssh_private_key",
  "generic",
] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

const TOKEN_KINDS: ReadonlySet<SecretKind> = new Set([
  "claude_oauth_token",
  "anthropic_api_key",
  "anthropic_admin_key",
  "openai_api_key",
]);

// Expected prefixes. Anthropic's are from their docs and observed tokens; a mismatch
// is reported as a problem rather than silently accepted.
const PREFIXES: Partial<Record<SecretKind, string>> = {
  claude_oauth_token: "sk-ant-oat01-",
  anthropic_api_key: "sk-ant-api",
  anthropic_admin_key: "sk-ant-admin",
  openai_api_key: "sk-",
};

export function normaliseSecret(kind: SecretKind, raw: string): string {
  if (TOKEN_KINDS.has(kind)) return raw.replace(/\s+/g, "");
  if (kind === "ssh_private_key") {
    const unix = raw.replace(/\r\n/g, "\n").trim();
    return unix.endsWith("\n") ? unix : `${unix}\n`;
  }
  return raw.trim();
}

/** The two token kinds that expire on a date the owner knows when they make it (BOS-2825). */
const EXPIRING_KINDS: ReadonlySet<SecretKind> = new Set(["claude_oauth_token", "generic"]);

/**
 * How long a new token of this kind usually lasts, so the form can fill in an end date (BOS-2825):
 * a GitHub/Gitea token made by the wizard lasts 90 days, and a Claude setup-token about a year.
 * A kind that doesn't expire predictably (an API key) has none, and its form leaves the date empty.
 */
export function defaultTokenLifeDays(kind: SecretKind): number | null {
  if (kind === "claude_oauth_token") return 365;
  if (kind === "generic") return 90;
  return null;
}

/** The date a new token of this kind ends on, as YYYY-MM-DD, or null when its kind has no default. */
export function defaultEndsOn(kind: SecretKind, now: Date = new Date()): string | null {
  const days = defaultTokenLifeDays(kind);
  if (days === null) return null;
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A day-only end date, as stored: midnight UTC of that day. Null for anything that isn't a real YYYY-MM-DD date. */
export function parseEndsOn(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const at = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === raw ? at : null;
}

/** A stored date as a day, "25 Feb 2027", for a card or a table. UTC, so a late-evening save can't read as the day before. */
export function endsOnDay(at: Date | string): string {
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export { EXPIRING_KINDS };
export type SecretCheck = { ok: boolean; problems: string[] };

export function checkSecretFormat(kind: SecretKind, value: string): SecretCheck {
  const problems: string[] = [];
  if (value.length === 0) problems.push("The value is empty.");
  if (TOKEN_KINDS.has(kind) && /["'`]/.test(value)) problems.push("The value contains quote characters; paste the token without quotes.");
  const prefix = PREFIXES[kind];
  if (prefix && value.length > 0 && !value.startsWith(prefix)) problems.push(`Expected the value to start with "${prefix}".`);
  if (kind === "ssh_private_key" && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    problems.push("This doesn't look like a private key (no BEGIN … PRIVATE KEY line).");
  }
  return { ok: problems.length === 0, problems };
}

/** Last four characters for display, never more. */
export function secretHint(value: string): string {
  return value.length <= 8 ? "••••" : `••••${value.slice(-4)}`;
}

/**
 * Secrets only the runner daemon may hold: git authentication, in any of the ways git reads it from the
 * environment (a token or credentials, an askpass helper, an ssh command, or the config variables
 * that build a header), plus the forge and package-manager tokens git, Claude Code and other tools push
 * with on their own. The forge/package families match a suffix too (GITHUB_TOKEN_WORK, NPM_TOKEN_LEGACY):
 * the suffix says which repo or registry, so the whole family is withheld (BOS-396). The runner keeps them
 * out of an agent's environment (BOS-322), and a company tool server may not name one as its secret,
 * since that would hand it to the agent's harness as a header (BOS-373).
 */
const DAEMON_ONLY_SECRET = /^(GIT_TOKEN|GIT_USERNAME|GIT_CI_TOKEN|GIT_CI_USERNAME|GIT_PASSWORD|GIT_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_(GLOBAL|SYSTEM|KEY_\d+|VALUE_\d+)|(GH_TOKEN|GH_PAT|GITHUB_TOKEN|GITHUB_PAT|GITLAB_TOKEN|GL_TOKEN|GITEA_TOKEN|CI_JOB_TOKEN|BITBUCKET_TOKEN|ATLASSIAN_API_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN|VERCEL_TOKEN)(_[A-Z0-9_]+)?)$/;

export function isDaemonOnlySecret(name: string): boolean {
  return DAEMON_ONLY_SECRET.test(name);
}

/** Why a tool server may not use a daemon-only secret, as the API and import say it. */
export const DAEMON_ONLY_SECRET_REFUSAL = "That is the git login, which agents may never hold. Give the tool server its own token.";

// Engagement threads and deliverables must never carry credentials (R24). These are the
// shapes of common secrets; a match blocks the message and names what it looked like.
const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ["an Anthropic key or token", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["an OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a password in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/i],
];

/** Returns what a text looks like it contains if it holds a credential, otherwise null. */
export function findCredential(text: string): string | null {
  for (const [what, re] of CREDENTIAL_PATTERNS) if (re.test(text)) return what;
  return null;
}
