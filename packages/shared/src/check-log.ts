// What a failed check's log says about the failure (BOS-1220): the step that failed and the first failing test,
// so a bounce can name them instead of only an exit code. check-all and check-quick print one "FAIL  <step>"
// line per failed step at column 0; vitest prints "FAIL  <file> > <suite> > <test>" (indented in a step's output).

import { redactForModel } from "./second-opinion.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const TEST_LINE = /^\s*(?:FAIL|×)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*(?:>|›)\s*(.+?)\s*$/;
const STEP_LINE = /^FAIL {1,2}(\S.*?)\s*$/;

// A suite that failed to load prints "FAIL  <file> [ <file> ]" with no test name.
const FILE_LINE = /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*(?:\[.*)?$/;

export type CheckLogFacts = { steps: string[]; test: string | null; files: string[] };

export function checkLogFacts(output: string): CheckLogFacts {
  const steps: string[] = [];
  const files: string[] = [];
  let test: string | null = null;
  const addFile = (f: string) => {
    if (!files.includes(f)) files.push(f.slice(0, 200));
  };
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const t = TEST_LINE.exec(line);
    if (t) {
      test ??= `${t[1]} > ${t[2]}`.slice(0, 300);
      addFile(t[1]!);
      continue;
    }
    const f = FILE_LINE.exec(line);
    if (f) addFile(f[1]!);
    const s = STEP_LINE.exec(line);
    if (s && !steps.includes(s[1]!)) steps.push(s[1]!.slice(0, 200));
  }
  return { steps, test, files };
}

/** BOS-2304: "3 failed test files: a.test.ts; b.test.ts; c.test.ts" (the count first), or "" when no test file is named. */
export function failedFilesSentence(files: string[], max = 20): string {
  if (!files.length) return "";
  const shown = files.slice(0, max).join("; ");
  const more = files.length > max ? `; and ${files.length - max} more` : "";
  return `${files.length} failed test file${files.length > 1 ? "s" : ""}: ${shown}${more}`;
}

/** "N failed test files: ...; the step "x" failed; first failing test: y", or "" when the log names none of them. */
export function checkFailureFacts(output: string): string {
  const f = checkLogFacts(output);
  const parts: string[] = [];
  const files = failedFilesSentence(f.files);
  if (files) parts.push(files);
  if (f.steps.length) parts.push(`step${f.steps.length > 1 ? "s" : ""} that failed: ${f.steps.map((s) => `"${s}"`).join("; ")}`);
  if (f.test) parts.push(`first failing test: ${f.test}`);
  return parts.join(". ");
}

// "error\b" with no boundary before it, so AssertionError and TypeError count; "errors" (as in "0 errors") does not.
const ERROR_LINE = /(?:error\b|\bERR_[A-Z_]+|\bfatal\b|\bfailed\b|\bexception\b|\btimed out\b|\bTraceback\b)/i;

/**
 * BOS-1723: one line that says what went wrong, for a list of failed checks: the first failing test, else the first
 * failed step, else the first error-looking line, else null. Cut to 300 characters.
 */
export function firstFailingLine(output: string): string | null {
  const f = checkLogFacts(output);
  if (f.test) return f.test;
  if (f.steps.length) return `step "${f.steps[0]}" failed`;
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line && ERROR_LINE.test(line)) return line.slice(0, 300);
  }
  return null;
}

/** BOS-1723: the log's failing lines (failing tests, failed steps, error-looking lines), in order, at most `max` of them. */
export function failingLines(output: string, max = 15): string[] {
  const out: string[] = [];
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || !(TEST_LINE.test(line) || STEP_LINE.test(line) || ERROR_LINE.test(line))) continue;
    const kept = line.trim().slice(0, 300);
    if (!out.includes(kept)) out.push(kept);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A log tail is the last 8 KB, and a failing step's FAIL line is often long gone by then. The runner puts the facts it
 * saw in the whole log in front of the tail when the tail no longer shows them.
 */
export function withCheckFacts(fullOutput: string, limit = 8192): string {
  const tail = fullOutput.slice(-limit);
  const all = checkLogFacts(fullOutput);
  const seen = checkLogFacts(tail);
  const missing = all.steps.some((s) => !seen.steps.includes(s)) || all.files.some((f) => !seen.files.includes(f)) || (all.test !== null && seen.test === null);
  if (!missing) return tail;
  const header = `[Earlier in the log: ${checkFailureFacts(fullOutput)}]\n`.slice(0, 2000);
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

/** BOS-1923: one finished step of a check (its name and seconds), read from the check's output as it streams. */
export type CheckStage = { name: string; seconds: number };
export const MAX_CHECK_STAGES = 60;

/**
 * Reads a check's per-step times from its output, for a record kept even when the check passes. A full check prints
 * "check-all: step NAME took Ns" (exact). check-quick prints "PASS  label" / "FAIL  label" per step with no time, so its
 * seconds are the gap since the previous step line (or since the slot was taken). `full` is true once any check-all step
 * line was seen, i.e. the full check ran after the quick one. Feed it chunks with a clock reading; it keeps no log text.
 */
export function createStageTracker(startMs: number) {
  const stages: CheckStage[] = [];
  let full = false;
  let mark = startMs;
  let partial = "";
  const add = (name: string, seconds: number) => {
    if (stages.length < MAX_CHECK_STAGES) stages.push({ name: name.slice(0, 60), seconds });
  };
  const line = (l: string, nowMs: number) => {
    const full1 = /^check-all: step ([A-Za-z0-9:._-]+) took (\d+)s/.exec(l);
    if (full1) {
      full = true;
      add(full1[1]!, Number(full1[2]));
      mark = nowMs;
      return;
    }
    if (l.includes("check-all: slot taken, running the checks")) {
      mark = nowMs; // time spent waiting for the runner's own check slot is not a step
      return;
    }
    const quick = /^(PASS|FAIL)  (.{1,80}?)(?: \(exit \d+\))?\s*$/.exec(l);
    if (quick) {
      add(quick[2]!, Math.max(0, Math.round((nowMs - mark) / 1000)));
      mark = nowMs;
    }
  };
  return {
    feed(chunk: string, nowMs: number) {
      const parts = (partial + chunk).split("\n");
      partial = (parts.pop() ?? "").slice(-300);
      for (const p of parts) line(p.replace(/\r$/, "").replace(/\u001b\[[0-9;]*m/g, ""), nowMs);
    },
    result: () => ({ stages: [...stages], full }),
  };
}
