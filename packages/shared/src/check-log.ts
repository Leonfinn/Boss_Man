// What a failed check's log says about the failure (BOS-1220): the step that failed and the first failing test,
// so a bounce can name them instead of only an exit code. check-all and check-quick print one "FAIL  <step>"
// line per failed step at column 0; vitest prints "FAIL  <file> > <suite> > <test>" (indented in a step's output).

import { redactForModel } from "./second-opinion.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const TEST_LINE = /^\s*(?:FAIL|×)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*(?:>|›)\s*(.+?)\s*$/;
const STEP_LINE = /^FAIL {1,2}(\S.*?)\s*$/;

export type CheckLogFacts = { steps: string[]; test: string | null };

export function checkLogFacts(output: string): CheckLogFacts {
  const steps: string[] = [];
  let test: string | null = null;
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const t = TEST_LINE.exec(line);
    if (t) {
      test ??= `${t[1]} > ${t[2]}`.slice(0, 300);
      continue;
    }
    const s = STEP_LINE.exec(line);
    if (s && !steps.includes(s[1]!)) steps.push(s[1]!.slice(0, 200));
  }
  return { steps, test };
}

/** "the step "x" failed; first failing test: y", or "" when the log names neither. */
export function checkFailureFacts(output: string): string {
  const f = checkLogFacts(output);
  const parts: string[] = [];
  if (f.steps.length) parts.push(`step${f.steps.length > 1 ? "s" : ""} that failed: ${f.steps.map((s) => `"${s}"`).join("; ")}`);
  if (f.test) parts.push(`first failing test: ${f.test}`);
  return parts.join(". ");
}

/**
 * A log tail is the last 8 KB, and a failing step's FAIL line is often long gone by then. The runner puts the facts it
 * saw in the whole log in front of the tail when the tail no longer shows them.
 */
export function withCheckFacts(fullOutput: string, limit = 8192): string {
  const tail = fullOutput.slice(-limit);
  const all = checkLogFacts(fullOutput);
  const seen = checkLogFacts(tail);
  const missing = all.steps.some((s) => !seen.steps.includes(s)) || (all.test !== null && seen.test === null);
  if (!missing) return tail;
  const header = `[Earlier in the log: ${checkFailureFacts(fullOutput)}]\n`.slice(0, 1200);
  return header + fullOutput.slice(-(limit - header.length));
}

/** The full log of a failed check is kept (BOS-1228) up to this size; the first part and the last part stay, the middle goes. */
export const FULL_LOG_MAX = 1_500_000;
export const FULL_LOG_HEAD =256_000;
/** How long a kept full log stays readable. */
export const FULL_LOG_RETENTION_DAYS = 14;

/** Cuts a log to the cap (head + tail with a marker) and removes secrets from what is kept. Redaction runs on the kept text only. */
export function prepareFullLog(raw: string, max = FULL_LOG_MAX): { log: string; truncated: boolean } {
  let log = raw;
  let truncated = false;
  if (log.length > max) {
    const head = Math.min(FULL_LOG_HEAD, Math.floor(max / 6));
    const marker = `\n[... ${log.length - max} characters cut from the middle of the log ...]\n`;
    log = log.slice(0, head) + marker + log.slice(log.length - (max - head - marker.length));
    truncated = true;
  }
  return { log: redactForModel(log), truncated };
}

/** The sentence a bounce adds so the author's agent can open the whole log. */
export function fullLogPointer(jobId: string, ticketId: string, bytes: number | null): string {
  const size = bytes ? ` (${Math.max(1, Math.round(bytes / 1024))} KB, kept ${FULL_LOG_RETENTION_DAYS} days)` : "";
  return `Full log${size}: call the tickets tool with action check_log, ticketId ${ticketId} and jobId ${jobId}; it returns the log in parts of 40000 characters (pass offset to read on).`;
}

/** The plain sentence a bounce uses for a check that ended without a normal failure (never "exit code undefined"). */
export function checkFailureSentence(v: { exitCode?: number | null; timedOut?: boolean; output?: string; reason?: string | null }): string {
  const facts = checkFailureFacts(v.output ?? "");
  const more = facts ? `; ${facts}` : "";
  if (v.timedOut) return `timed out${facts ? ` (${facts})` : ""}`;
  if (typeof v.exitCode === "number") return `failed (exit code ${v.exitCode}${more})`;
  return `was stopped before it reported${v.reason ? `: ${v.reason}` : ""}${facts ? ` (${facts})` : ""}`;
}
