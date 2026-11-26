import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// BOS-2272: every command the website's install guide tells a new user to run must also be a command in the repo's
// install docs on the same commit. A command changed in docs/ but not on the site fails here, naming the guide line,
// the command and the doc it is missing from. Prose is not compared, only the command lines of "Run ..." code blocks.
//
// BOS-2735 stops two things reviewers missed by eye coming back into the install commands:
//  - a value the text already knows, written as a placeholder (`<owner>/<repo>` on 26 Nov). A placeholder is allowed
//    only if it is on PLACEHOLDERS below: a value only the reader can know.
//  - "repeat with ..." prose just after a command. Say it as a command block instead, or the reader's copy is wrong.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const guide = "apps/site/src/guides/install-boss-man.md";
const docFiles = ["docs/35-install-from-images.md", "docs/00-first-time-install.md"];

// The site names the real repository; the docs may name it too or use a placeholder. Both sides compare as REPO_URL.
const SITE_REPO = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+?(?:\.git)?(?=[/\s]|$)/g;
const DOC_REPO = /<repo-https-url>|https:\/\/github\.com\/(?:<owner>\/<repo>|[^/\s]+\/[^/\s]+?(?:\.git)?(?=[/\s]|$))/g;
const norm = (s: string, repo: RegExp) => s.trim().replace(repo, "REPO_URL").replace(/\s+/g, " ");

// Placeholders allowed in an install command: each is a value only the reader knows. The name is what decides, so
// `<host-ip>`, `<your BOSSMAN_HOST_PORT, 3100 unless you changed it>` and `<your docker hub account>` all pass.
// `<this machine>` is not a placeholder: it is a URL in prose, and no install command needs it.
const PLACEHOLDERS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^host-ip$/, reason: "the machine's address on the reader's own network" },
  { pattern: /^your\b/i, reason: "a value the reader picks (port, account) and the text explains" },
  { pattern: /^namespace$/, reason: "the reader's own Docker Hub namespace, only when they move the images there" },
  { pattern: /^repo-https-url$|^repo-ssh-url$/, reason: "the reader's own copy of the repo (private or mirrored)" },
];
const PLACEHOLDER = /<([^<>]+)>/g;

export function badPlaceholders(cmd: string): string[] {
  return [...cmd.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((name) => !PLACEHOLDERS.some((p) => p.pattern.test(name)));
}

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

export function commandLines(text: string): { line: number; cmd: string }[] {
  const out: { line: number; cmd: string }[] = [];
  let inFence = false;
  text.split("\n").forEach((raw, i) => {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    else if (inFence && raw.trim()) out.push({ line: i + 1, cmd: raw.trim() });
  });
  return out;
}

// Prose within three lines after a "Run" code block that tells the reader to change a command by hand.
const REPEAT = /\b(?:repeat with|run it again with|in place of)\b/i;

export function repeatProse(text: string): { line: number; text: string }[] {
  const lines = text.split("\n");
  const out: { line: number; text: string }[] = [];
  let inRun = false;
  let afterRun = -1;
  let inFence = false;
  lines.forEach((raw, i) => {
    const fence = raw.match(/^\s*```(.*)$/);
    if (fence) {
      if (inFence) {
        inFence = false;
        if (inRun) afterRun = i;
        inRun = false;
      } else {
        inFence = true;
        inRun = /^sh\s+Run\b/.test(fence[1].trim());
      }
      return;
    }
    if (afterRun >= 0 && i > afterRun && i <= afterRun + 3 && !inFence && REPEAT.test(raw)) {
      out.push({ line: i + 1, text: raw.trim() });
    }
  });
  return out;
}

const files = [{ file: guide, guide: true }, ...docFiles.map((file) => ({ file, guide: false }))];

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

describe("no known value is left as a placeholder, and no command is changed by hand", () => {
  for (const { file } of files) {
    const text = readFileSync(path.join(root, file), "utf8");

    it(`${file}: every placeholder in a command is one the reader fills in`, () => {
      const bad = commandLines(text)
        .map(({ line, cmd }) => ({ line, names: badPlaceholders(cmd) }))
        .filter(({ names }) => names.length > 0)
        .map(({ line, names }) => `${file}:${line}: <${names.join(">, <")}> is not on the allowlist: use the value the text already knows, or add a named placeholder with a reason`);
      expect(bad, bad.join("\n")).toEqual([]);
    });

    it(`${file}: no prose after a Run block says to change the command`, () => {
      const bad = repeatProse(text).map(({ line, text: prose }) => `${file}:${line}: "${prose}" - give it as its own command block instead`);
      expect(bad, bad.join("\n")).toEqual([]);
    });
  }

  it("placeholder rule: a known value in <...> fails, an allowlisted one passes", () => {
    expect(badPlaceholders("git clone <owner>/<repo> $B/src")).toEqual(["owner", "repo"]);
    expect(badPlaceholders("git clone <repo-ssh-url> $B/src")).toEqual([]);
    expect(badPlaceholders("BOSSMAN_BIND=<host-ip>")).toEqual([]);
    expect(badPlaceholders("curl -sS http://<host-ip>:<your BOSSMAN_HOST_PORT, 3100 unless you changed it>/api/health")).toEqual([]);
    // On docs/35 and the guide as BOS-2734 left them, the signature check names the repo, so the rule passes.
    const sigDoc = "```\ncosign verify-blob --bundle images.env.sigstore.json --certificate-identity https://github.com/Leonfinn/Boss_Man/.github/workflows/release.yml@refs/heads/main images.env\n```\n";
    expect(commandLines(sigDoc).flatMap(({ cmd }) => badPlaceholders(cmd))).toEqual([]);
    // Before BOS-2734 the guide's signature check read `<owner>/<repo>`, so the rule failed on it.
    const before = readFileSync(path.join(root, guide), "utf8").replaceAll("Leonfinn/Boss_Man", "<owner>/<repo>");
    expect(badPlaceholders(before).length).toBeGreaterThan(0);
  });

  it("repeat rule: 'repeat with' after a Run block fails, a plain sentence passes", () => {
    const fails = "```sh Run on the host\ncurl -sS http://x/api/health\n```\n\nRepeat with `curl -sS http://y/api/health` when the port is 3100.\n";
    expect(repeatProse(fails).map((r) => r.line)).toEqual([5]);
    const passes = "```sh Run on the host\ncurl -sS http://x/api/health\n```\n\nA good answer is a short line of JSON.\n";
    expect(repeatProse(passes)).toEqual([]);
  });
});
