// Fingerprints and the "contains a script" rule for a skill's files (BOS-86, BOS-87 section 1).
import { createHash } from "node:crypto";
import type { SkillFile } from "./skills.js";

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** sha256 of each file's bytes, and of the whole set (every path and file hash in the list, sorted). */
export function hashFiles(files: SkillFile[]) {
  const fileHashes: Record<string, string> = {};
  for (const f of files) fileHashes[f.path] = sha256(Buffer.from(f.content, "base64"));
  const bundleHash = sha256(
    files
      .map((f) => `${f.path}\0${sha256(Buffer.from(f.content, "base64"))}\n`)
      .sort()
      .join(""),
  );
  return { fileHashes, bundleHash };
}

/** One side of a change to a skill, as the change log shows it. */
export type SkillSide = { name: string; description: string; bundleHash: string; skillMd: string; paths: string[] };

/** The side for a library row (files as stored, base64). */
export const skillSide = (s: { name: string; description: string; files: SkillFile[] }): SkillSide => ({
  name: s.name,
  description: s.description,
  bundleHash: hashFiles(s.files).bundleHash,
  skillMd: Buffer.from(s.files.find((f) => f.path === "SKILL.md")?.content ?? "", "base64").toString("utf8"),
  paths: s.files.map((f) => f.path),
});

/**
 * The activity entry for any change to a skill's bytes (BOS-178, BOS-181), so no skill in the library
 * changes without a trace. The summary (capped at 300) shows the short fingerprints and only the region
 * that differs, so a hidden tail or a description change still shows; detail keeps the full old and new text.
 * `head` says who changed what; it gets the two short fingerprints and " (was <old name>)" when the name changed.
 */
export function skillChangeEntry(skillId: string, before: SkillSide, after: SkillSide, head: (from: string, to: string, was: string) => string, tail: string) {
  const min = Math.min(before.skillMd.length, after.skillMd.length);
  let start = 0;
  while (start < min && before.skillMd[start] === after.skillMd[start]) start++;
  let endBefore = before.skillMd.length;
  let endAfter = after.skillMd.length;
  while (endBefore > start && endAfter > start && before.skillMd[endBefore - 1] === after.skillMd[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const diff = { before: before.skillMd.slice(start, endBefore), after: after.skillMd.slice(start, endAfter) };
  // Keep both ends when it is long: a payload is often added at the end, after harmless opening text.
  const flat = (text: string, max: number) => {
    const one = text.replace(/\s+/g, " ").trim();
    if (one.length <= max) return one;
    const half = Math.max(1, Math.floor((max - 1) / 2));
    return `${one.slice(0, half)}…${one.slice(-half)}`;
  };
  const h = `${head(before.bundleHash.slice(0, 12), after.bundleHash.slice(0, 12), after.name !== before.name ? ` (was ${flat(before.name, 40)})` : "")}.`;
  // Leave room for the head and tail, then share what is left between the two differing sides.
  const room = Math.max(20, 300 - h.length - tail.length - 30);
  const shown = !diff.before && !diff.after ? "The visible text is unchanged." : `Old: "${flat(diff.before, Math.floor(room / 2))}" New: "${flat(diff.after, Math.floor(room / 2))}".`;
  return {
    summary: `${h} ${shown}${tail}`,
    detail: {
      skillId,
      name: { before: before.name, after: after.name },
      description: { before: before.description, after: after.description },
      bundleHash: { before: before.bundleHash, after: after.bundleHash },
      skillMd: { before: before.skillMd, after: after.skillMd },
      changedRegion: diff,
      removedFiles: before.paths.filter((p) => p !== "SKILL.md" && !after.paths.includes(p)),
    },
  };
}

// What "contains a script" means (BOS-87 standard, section 1), decided by content, never by a name. The system decides, not the CEO.
// Only SKILL.md can be instructions; every other file counts as a script, whatever it is called. SKILL.md counts too
// when it holds anything an agent could run. When unsure, review.
const SHELL_CMD = /^\s*(?:[$>#]\s+)?(?:sudo\s+)?(?:curl|wget|sh|bash|zsh|fish|ksh|dash|npx|npm|pnpm|yarn|pip3?|pipx|uv|uvx|python[\d.]*|node|deno|bun|ruby|perl|php|lua|awk|sed|powershell|pwsh|cmd|eval|exec|chmod|chown|rm|nc|ncat|git\s+clone|docker|kubectl|ssh|scp|source|\.\/\S+)\b(?=\s|$)/i;
const MAKE_CMD = /^\s*(?:[$>]\s+)?make(?:\s+[\w.-]+)?\s*$/i;
const INLINE_RUN = /\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b|\$\(|`[^`\n]*\b(?:curl|wget)\s[^`\n]*`|\b(?:curl|wget)\s+(?:-\S+\s+)*https?:\/\//i;
// Inline code, an interpreter one-liner (-e / -c) or eval/exec anywhere in a line: an agent could be told to run it, so review.
const INLINE_CODE = /`[^`\n]+`/;
// A command word followed by an argument anywhere in a line, whatever comes before it (a list marker, "run this:", a sentence). Prose
// that mentions one is reviewed too: when unsure, review. "make" and "source" are left out (everyday words); a line-start "make" is caught above.
const WORD_CMD = /\b(?:sudo|curl|wget|bash|zsh|ksh|npx|npm|pnpm|yarn|pipx?|pip3|uvx?|python[\d.]*|node|deno|bun|ruby|perl|php|lua|powershell|pwsh|eval|exec|chmod|chown|ssh|scp|docker|kubectl|git\s+clone|run\s+make)\s+[-\w./@:~$"'(]/i;
// Prose that points at a terminal, or sends/downloads/runs something at an address.
const TERMINAL = /\b(?:terminal|command[- ]line|command prompt|shell script|powershell|\bcmd\.exe)\b/i;
const URL_ACTION = /https?:\/\/\S+/i;
const ACTION_WORD = /\b(?:send|post|upload|submit|transmit|forward|exfiltrate|download|fetch|pipe|run|execute|install|curl|wget|eval)\b/i;
const ONE_LINER = /\b(?:node|deno|bun|python[\d.]*|ruby|perl|php|lua|powershell|pwsh)\s+(?:-\S+\s+)*-[ecC]\b|\b(?:eval|exec)\s*[(`'"]/i;

/** Characters that are invisible or look like other letters: format characters, combining marks, variation selectors, blank fillers, and a Latin letter mixed with a Cyrillic/Greek/Armenian/Cherokee one in the same word. */
export function hasHiddenChars(text: string): boolean {
  if (/[\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800\u180E\u00AD]/u.test(text)) return true;
  return text.split(/\s+/).some((w) => /[A-Za-z]/.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u.test(w));
}

/** Any letter outside the ordinary Latin alphabet. A command can be spelled entirely in lookalikes (a Cyrillic "ѕср" for "scp") or with a rarer Latin letter (a dotless "ı"), and still read as a normal command, so any such letter means "unsure: review". */
export function hasForeignLetters(text: string): boolean {
  for (const ch of text) if (ch.charCodeAt(0) > 0x7f && /\p{L}/u.test(ch)) return true;
  return false;
}

/** Does this instructions text hold a code block, a #! line, or a line an agent could run? */
function runnableText(text: string): boolean {
  if (text.startsWith("#!")) return true;
  // Invisible format characters (zero-width, bidi) can hide a command from the patterns below: unsure, so review.
  if (hasHiddenChars(text)) return true;
  const normalised = text.normalize("NFKC");
  // Letters from another alphabet (or a dotless "ı") can spell a command the patterns below would not recognise.
  if (hasForeignLetters(normalised)) return true;
  for (const line of normalised.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) return true; // any fenced block
    if (/^( {4}|\t)\S/.test(line)) return true; // an indented block
    if (/^#!/.test(line) || SHELL_CMD.test(line) || MAKE_CMD.test(line) || INLINE_RUN.test(line) || INLINE_CODE.test(line) || WORD_CMD.test(line) || TERMINAL.test(line) || (URL_ACTION.test(line) && ACTION_WORD.test(line)) || ONE_LINER.test(line)) return true;
  }
  return false;
}

/** The files that make a skill "contain a script". */
export function scriptFilesOf(files: SkillFile[]): string[] {
  const found: string[] = [];
  for (const f of files) {
    const bytes = Buffer.from(f.content, "base64");
    if (f.path !== "SKILL.md" || bytes.includes(0) || runnableText(bytes.toString("utf8"))) found.push(f.path);
  }
  return found;
}

/** The first file that isn't readable text (a NUL byte, or bytes that aren't valid UTF-8): such a file can't be reviewed or shown, so a proposal with one is refused. */
export function unreadableFile(files: SkillFile[]): string | null {
  const dec = new TextDecoder("utf-8", { fatal: true });
  for (const f of files) {
    const bytes = Buffer.from(f.content, "base64");
    if (bytes.includes(0)) return f.path;
    try {
      dec.decode(bytes);
    } catch {
      return f.path;
    }
  }
  return null;
}
