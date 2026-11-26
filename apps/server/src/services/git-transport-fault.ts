// BOS-1860: whether a failed merge step was only the network between the runner and the git host (a push or fetch
// that never reached it, or got a 5xx/408/429 back), as opposed to the git host refusing it. Only the first is worth
// a retry by itself: a refused push (clash, non-fast-forward, protected branch, missing permission) fails the same
// way again. git's exit codes don't separate the two (128 for every fatal, auth included; 1 for a rejected push),
// and the runner's error carries only git's stderr in its message, so this reads the text. Refusals are checked
// first: a message showing any refusal is never a transport fault, and unknown text isn't either.

/** git and the git host refusing the step: never retried by itself. */
const REFUSED: RegExp[] = [
  /!\s*\[(remote )?rejected\]/i,
  /non-fast-forward/i,
  /\(fetch first\)/i,
  /\(stale info\)/i,
  /protected branch/i,
  /hook declined/i,
  /refusing to allow/i,
  /without [`']?workflows?[`']? (scope|permission)/i,
  /authentication failed/i,
  /permission denied/i,
  /permission to \S+ denied/i,
  /repository not found/i,
  /could not read username/i,
  /invalid username or password/i,
  // A 4xx other than 408 (timeout) and 429 (rate limit) is the host saying no.
  /returned error: 4(?!08|29)\d\d/i,
  /\bHTTP 4(?!08|29)\d\d\b/,
  // Boss Man's own refusals before a push (runner workspace.ts).
  /secrets scan found something/i,
  /isn't the one this ticket's merge prepared/i,
];

/** The connection to the git host failing: worth one retry after a short wait. */
const TRANSPORT: RegExp[] = [
  /unable to access '[^']*'/i,
  /could not resolve host(name)?/i,
  /failed to connect to/i,
  /connection (timed out|reset|refused)/i,
  /operation timed out/i,
  /empty reply from server/i,
  /gnutls_handshake\(\) failed|gnutls recv error|SSL_ERROR_SYSCALL|SSL_read|SSL_connect|TLS connect error/i,
  /HTTP\/2 stream \d+ was not closed cleanly/i,
  /RPC failed; (HTTP (5\d\d|408|429)|curl \d+)/i,
  /returned error: (5\d\d|408|429)/i,
  /the remote end hung up unexpectedly/i,
  /early EOF/i,
  /ssh: connect to host/i,
  /kex_exchange_identification/i,
  /network is unreachable/i,
  /temporary failure in name resolution/i,
  // BOS-2696: the git host's 5xx sent in the push's side channel (BOS-2559, BOS-2601).
  // The runner's error puts its own prefix on the first line ("Couldn't push the merge to main: remote: ..."), so no ^.
  /\bremote:\s+(internal server error|bad gateway|service unavailable|gateway time-?out)\b/i,
];

/** The git host's own 5xx wording, as GitHub sends it over the push's side channel ("remote: Internal Server Error"). */
const HOST_5XX = String.raw`internal server error|bad gateway|service unavailable|gateway time-?out`;

/**
 * BOS-2696: the git host failing inside a push it had already accepted. GitHub then sends
 * "remote: Internal Server Error" lines and git reports the ref as " ! [remote rejected] main -> main (Internal Server
 * Error)". The "[remote rejected]" there is the host's 500, not a refusal, so such a ref line is dropped before the
 * refusal check; any other refusal in the same message (another ref, a hook, a protected branch) still wins.
 */
const HOST_5XX_REF_LINE = new RegExp(String.raw`^.*!\s*\[remote rejected\][^\n]*\((${HOST_5XX})\)[^\S\n]*$`, "gim");

/** True when the message is a network or HTTP failure to the git host and shows no refusal (BOS-1860). */
export function isGitTransportFault(message: string | null | undefined): boolean {
  const text = String(message ?? "");
  if (!text) return false;
  const rest = text.replace(HOST_5XX_REF_LINE, "");
  if (REFUSED.some((re) => re.test(rest))) return false;
  return rest !== text || TRANSPORT.some((re) => re.test(text));
}

/** The stale-note reason while the retry waits (shown as "after this was written, <reason>, N min ago"). */
export const GIT_RETRY_NOTE = "Boss Man is retrying the merge after a push/fetch failure to the git host; nothing to do";
/** The stale-note reason once the retry failed too and the merge card went to the CEO. */
export const GIT_RETRY_CARD_NOTE = "the merge couldn't reach the git host twice; a merge card is with the CEO";
