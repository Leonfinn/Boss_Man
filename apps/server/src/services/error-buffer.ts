// A small in-memory ring of recent server errors, so the CEO can see what the server has been
// complaining about from its chat and runs (BOS-224). Fed by app.log.error. Only the logged
// message is kept: never an Error's message, stack, query or params, because those can carry
// another company's data (security review round 1). Secrets are still redacted before a line is
// kept: the owner and agents read this through the server_status tool.

const MAX = 200;
const MAX_MESSAGE = 500;

/** What must never leave the server in an error line. Order matters: specific tokens first. */
const REDACTIONS: Array<[RegExp, string]> = [
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
];

/** Redact the secrets an error line may carry. Exported so tests can check it directly. */
export function redact(s: string): string {
  let out = s;
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

/** One kept error: when it happened, and the message the code logged with it. */
export type ErrorEntry = { at: string; message: string };

export type ErrorBuffer = {
  push: (message: string) => void;
  recent: (n?: number) => ErrorEntry[];
  count: () => number;
};

/**
 * The safe message of a pino log call. Fastify logs as `error(contextOrError, message, ...values)`,
 * so only string arguments are used. An Error's message is never used: drizzle's
 * DrizzleQueryError carries the query and its parameters there, which may belong to any company.
 * When the call has no message we keep the error's class name only.
 */
export function logMessage(args: unknown[]): string | null {
  const strings = args.filter((a): a is string => typeof a === "string");
  if (strings.length) return strings.join(" ");
  const first = args[0];
  if (first instanceof Error) return first.name || "Error";
  return null;
}

export function createErrorBuffer(max = MAX, now: () => Date = () => new Date()) {
  const lines: ErrorEntry[] = [];
  return {
    push(message: string) {
      const text = redact(String(message)).replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
      if (!text) return;
      lines.push({ at: now().toISOString(), message: text });
      if (lines.length > max) lines.splice(0, lines.length - max);
    },
    recent(n = 50) {
      return lines.slice(-Math.max(0, n));
    },
    count() {
      return lines.length;
    },
  };
}
