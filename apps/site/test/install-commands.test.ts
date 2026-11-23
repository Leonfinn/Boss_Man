import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// BOS-2272: every command the website's install guide tells a new user to run must also be a command in the repo's
// install docs on the same commit. A command changed in docs/ but not on the site fails here, naming the guide line,
// the command and the doc it is missing from. Prose is not compared, only the command lines of "Run ..." code blocks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const guide = "apps/site/src/guides/install-boss-man.md";
const docFiles = ["docs/35-install-from-images.md", "docs/00-first-time-install.md"];

// The site names the real repository; the docs use placeholders for it. Both sides compare as REPO_URL.
const SITE_REPO = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+?(?:\.git)?(?=[/\s]|$)/g;
const DOC_REPO = /<repo-https-url>|https:\/\/github\.com\/<owner>\/<repo>/g;
const norm = (s: string, repo: RegExp) => s.trim().replace(repo, "REPO_URL").replace(/\s+/g, " ");

export function guideCommands(text: string): { line: number; cmd: string }[] {
  const out: { line: number; cmd: string }[] = [];
  let inRun = false;
  let inFence = false;
  text.split("\n").forEach((raw, i) => {
    const fence = raw.match(/^\s*```(.*)$/);
    if (fence) {
      inFence = !inFence;
      inRun = inFence && /^sh\s+Run\b/.test(fence[1].trim());
      return;
    }
    if (inRun && raw.trim()) out.push({ line: i + 1, cmd: norm(raw, SITE_REPO) });
  });
  return out;
}

export function docLines(text: string): Map<string, number> {
  const m = new Map<string, number>();
  let inFence = false;
  text.split("\n").forEach((raw, i) => {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    else if (inFence && raw.trim() && !m.has(norm(raw, DOC_REPO))) m.set(norm(raw, DOC_REPO), i + 1);
  });
  return m;
}

describe("install guide commands match the repo docs", () => {
  const cmds = guideCommands(readFileSync(path.join(root, guide), "utf8"));
  const docs = docFiles.map((f) => ({ f, lines: docLines(readFileSync(path.join(root, f), "utf8")) }));

  it("finds the guide's commands", () => {
    expect(cmds.length).toBeGreaterThan(10);
  });

  it("every command is in docs/35 or docs/00", () => {
    const missing = cmds
      .filter((c) => !docs.some((d) => d.lines.has(c.cmd)))
      .map((c) => {
        // Point at the doc line that starts the same way, the one the site should now match.
        const head = c.cmd.split(" ").slice(0, 3).join(" ");
        const near = docs.flatMap((d) => [...d.lines].filter(([l]) => l.startsWith(head)).map(([l, n]) => `${d.f}:${n} says "${l}"`));
        return `${guide}:${c.line}: "${c.cmd}" is not a command in ${docFiles.join(" or ")}. ${near.join("; ") || "No similar doc line."}`;
      });
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("catches a changed command (failure case)", () => {
    const changed = guideCommands("```sh Run here\ndocker compose build server launcher netguard\n```\n");
    expect(docs.some((d) => d.lines.has(changed[0].cmd))).toBe(false);
  });
});
