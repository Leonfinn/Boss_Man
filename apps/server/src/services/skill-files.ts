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

// What "contains a script" means (BOS-87 standard, section 1). The system decides, not the CEO.
const TEXT_DOC = /\.(md|markdown|txt)$/i;
// A fenced block in the instructions in a language an agent can run.
const RUN_LANG = /^(sh|bash|zsh|shell|console|terminal|cmd|bat|powershell|ps1|pwsh|python|python3|py|js|javascript|node|ts|typescript|ruby|rb|perl|php)$/i;
const RUN_CUE = /\b(run|runs|running|execute|executes|executing|invoke|call|launch|exec)\b/i;

/** The files that make a skill "contain a script": executable or interpreted files, and instruction files with a code block the agent is told to run. */
export function scriptFilesOf(files: SkillFile[]): string[] {
  const found: string[] = [];
  for (const f of files) {
    const bytes = Buffer.from(f.content, "base64");
    // Only plain documents (.md, .markdown, .txt) can be instructions; every other file, whatever it is called or however it is cased, counts as a script.
    if (!TEXT_DOC.test(f.path) || bytes.includes(0) || bytes.subarray(0, 2).toString("latin1") === "#!") {
      found.push(f.path);
      continue;
    }
    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(lines[i]!);
      if (!m) continue;
      // Only an opening fence: skip to the closing one afterwards.
      const tagged = m[2]!;
      const before = lines.slice(Math.max(0, i - 3), i).join(" ");
      if ((tagged && RUN_LANG.test(tagged)) || (!tagged && RUN_CUE.test(before))) {
        found.push(f.path);
        break;
      }
      const close = lines.findIndex((l, k) => k > i && l.trim().startsWith(m[1]!));
      if (close < 0) break;
      i = close;
    }
  }
  return found;
}

