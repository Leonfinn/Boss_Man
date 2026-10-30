// A small in-memory ring of recent server errors, so the CEO can see what the server has been
// complaining about from its chat and runs (BOS-224). Fed by app.log.error. Secrets are redacted
// before a line is kept: the owner and agents read this through the server_status tool.

const MAX = 200;

/** What must never leave the server in an error line. Order matters: specific tokens first. */
const REDACTIONS: Array<[RegExp, string]> = [
  [/bm_run_[A-Za-z0-9_-]+/g, "bm_run_[redacted]"],
  [/bmr_[A-Za-z0-9_-]+/g, "bmr_[redacted]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]"],
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, "sk-[redacted]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "gh[redacted]"],
  [/([?&](?:token|key|secret|password|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]"],
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*=)[^\s&"']+/gi, "$1[redacted]"],
  [/(\/\/[^/:@\s]+:)[^@\s/]+@/g, "$1[redacted]@"],
];

/** Redact the secrets an error line may carry. Exported so tests can check it directly. */
export function redact(s: string): string {
  let out = s;
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

export type ErrorBuffer = {
  push: (line: string) => void;
  recent: (n?: number) => string[];
};

/** Turn a logged argument (a string, an Error, or a context object) into one line. */
export function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function createErrorBuffer(max = MAX): ErrorBuffer {
  const lines: string[] = [];
  return {
    push(line: string) {
      const clean = redact(String(line)).trim();
      if (!clean) return;
      lines.push(clean);
      if (lines.length > max) lines.splice(0, lines.length - max);
    },
    recent(n = 50) {
      return lines.slice(-Math.max(0, n));
    },
  };
}
