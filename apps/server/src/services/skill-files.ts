// Fingerprints and the "contains a script" rule for a skill's files (BOS-86, BOS-87 section 1).
import { createHash } from "node:crypto";
import type { SkillFile } from "./skills.js";

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** sha256 of each file's bytes, and of the whole set (paths and file hashes, sorted by path). */
export function hashFiles(files: SkillFile[]) {
  const fileHashes: Record<string, string> = {};
  for (const f of files) fileHashes[f.path] = sha256(Buffer.from(f.content, "base64"));
  const bundleHash = sha256(
    Object.keys(fileHashes)
      .sort()
      .map((p) => `${p}\0${fileHashes[p]}\n`)
      .join(""),
  );
  return { fileHashes, bundleHash };
}

// What "contains a script" means (BOS-87 standard, section 1), decided by content, never by a name. The system decides, not the CEO.
// Only SKILL.md can be instructions; every other file counts as a script, whatever it is called. SKILL.md counts too
// when it holds anything an agent could run. When unsure, review.
const SHELL_CMD = /^\s*(?:[$>#]\s+)?(?:sudo\s+)?(?:curl|wget|sh|bash|zsh|fish|ksh|dash|npx|npm|pnpm|yarn|pip3?|pipx|uv|uvx|python[\d.]*|node|deno|bun|ruby|perl|php|lua|awk|sed|powershell|pwsh|cmd|eval|exec|chmod|chown|rm|nc|ncat|git\s+clone|docker|kubectl|ssh|scp|source|\.\/\S+)\b(?=\s|$)/i;
const MAKE_CMD = /^\s*(?:[$>]\s+)?make(?:\s+[\w.-]+)?\s*$/i;
const INLINE_RUN = /\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b|\$\(|`[^`\n]*\b(?:curl|wget)\s[^`\n]*`|\b(?:curl|wget)\s+(?:-\S+\s+)*https?:\/\//i;

/** Does this instructions text hold a code block, a #! line, or a line an agent could run? */
function runnableText(text: string): boolean {
  if (text.startsWith("#!")) return true;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) return true; // any fenced block
    if (/^( {4}|\t)\S/.test(line)) return true; // an indented block
    if (/^#!/.test(line) || SHELL_CMD.test(line) || MAKE_CMD.test(line) || INLINE_RUN.test(line)) return true;
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
