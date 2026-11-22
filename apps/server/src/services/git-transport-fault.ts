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
];

/** True when the message is a network or HTTP failure to the git host and shows no refusal (BOS-1860). */
export function isGitTransportFault(message: string | null | undefined): boolean {
  const text = String(message ?? "");
  if (!text) return false;
  if (REFUSED.some((re) => re.test(text))) return false;
  return TRANSPORT.some((re) => re.test(text));
}

/** The stale-note reason while the retry waits (shown as "after this was written, <reason>, N min ago"). */
export const GIT_RETRY_NOTE = "Boss Man is retrying the merge after a push/fetch failure to the git host; nothing to do";
/** The stale-note reason once the retry failed too and the merge card went to the CEO. */
export const GIT_RETRY_CARD_NOTE = "the merge couldn't reach the git host twice; a merge card is with the CEO";
