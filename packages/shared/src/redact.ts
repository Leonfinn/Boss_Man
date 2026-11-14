// One secret redactor for the whole of Boss Man (BOS-1368 security review). It was written for an
// error line in the server; the runner now has to clean tool input, tool output and reasoning before
// they leave it, because those carry what agents read and run (a `cat .env`, an API key printed by a
// command). Both the runner and the server import this same list, so a secret is caught wherever the
// text is kept: in a run event, in the trace, and in an error line. Order matters: specific tokens
// first, so a broad rule never eats the part that names it.

/** What must never leave the server (or the runner) in a stored or shown line. */
export const REDACTIONS: Array<[RegExp, string]> = [
  [/bm_run_[A-Za-z0-9_-]+/g, "bm_run_[redacted]"],
  [/bmr_[A-Za-z0-9_-]+/g, "bmr_[redacted]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]"],
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, "sk-[redacted]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "gh[redacted]"],
  [/([?&](?:token|key|secret|password|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]"],
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*=)[^\s&"']+/gi, "$1[redacted]"],
  [/("(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|cookie)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2"],
  [/\b(bm_session=)[^;\s"'&]+/gi, "$1[redacted]"],
  [/\b(cookie\s*[:=]\s*)[^\n]+/gi, "$1[redacted]"],
  [/Failed query:[\s\S]*/gi, "Failed query [redacted]"],
  [/(\/\/[^/:@\s]+:)[^@\s/]+@/g, "$1[redacted]@"],
  // Tool output (not just an error line) carries shapes an error never did (security review BOS-1368).
  // A PEM private key block, whole, however many lines it has.
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1[redacted]$2"],
  // A JWT: three base64url parts, always starting `eyJ`.
  [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "eyJ[redacted]"],
  // A YAML or .env line like `password: x` or `api_key = "x"` (the `=`/`:` shapes the rule above misses).
  [/^(\s*[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|auth[_-]?token)[A-Za-z0-9_.-]*\s*[:=]\s*).+$/gim, "$1[redacted]"],
  // Basic auth, which carries the password base64'd after the scheme word.
  [/\b(Basic)\s+[A-Za-z0-9+/]+=*/gi, "$1 [redacted]"],
];

/** Redact the secrets a line of tool output, reasoning or an error may carry. */
export function redact(s: string): string {
  let out = s;
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}
