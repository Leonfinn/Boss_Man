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
