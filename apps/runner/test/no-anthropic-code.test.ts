// DR-050, BOS-972: the runner image must hold no Anthropic code, so it can be published. This test
// reads the image's own sources (the Dockerfile and the runner package.json) and fails if any
// @anthropic-ai package, a `claude` install, or a CLAUDE_CODE_EXECUTABLE default creeps back in.
// It fails on the old sources (which installed Claude Code and pulled claude-agent-acp with the
// Anthropic SDK) and passes on the new ones. The real built image is checked in CI's `images` job.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** The Dockerfile's live instruction lines: a comment can mention Anthropic without installing it. */
const instructions = dockerfile
  .split("\n")
  .map((l) => l.trimEnd())
  .filter((l) => l.trim() && !l.trimStart().startsWith("#"));

describe("the runner image holds no Anthropic code (DR-050)", () => {
  it("installs no @anthropic-ai package in the Dockerfile", () => {
    const hits = instructions.filter((l) => /@anthropic-ai\//.test(l));
    expect(hits).toEqual([]);
  });

  it("sets no CLAUDE_CODE_EXECUTABLE default: the runner sets it from the ready pack", () => {
    // `ENV CLAUDE_CODE_EXECUTABLE=...` or `ARG CLAUDE_CODE_VERSION` would point at a baked-in install.
    const hits = instructions.filter((l) => /CLAUDE_CODE_EXECUTABLE\s*=/.test(l));
    expect(hits).toEqual([]);
    expect(instructions.filter((l) => /ARG\s+CLAUDE_CODE_VERSION/.test(l))).toEqual([]);
  });

  it("still installs OpenCode, which is not Anthropic code", () => {
    expect(instructions.some((l) => /opencode-ai@/.test(l))).toBe(true);
  });

  it("copies the pinned Claude pack source for the installer to read", () => {
    expect(instructions.some((l) => /^COPY .*apps\/runner\/claude-pack/.test(l))).toBe(true);
  });

  it("creates the pack volume mount point owned by node, before USER node, so a fresh volume is writable (BOS-972)", () => {
    // Docker copies a path's ownership into a new named volume only when the path exists in the image.
    // Without this, a fresh volume mounts root-owned and the installer (uid 1000) fails with EACCES.
    const made = instructions.findIndex((l) => /^RUN .*mkdir -p \/opt\/bossman-claude\b/.test(l) && /chown node:node \/opt\/bossman-claude\b/.test(l));
    expect(made, "the Dockerfile must mkdir -p /opt/bossman-claude and chown node:node it").toBeGreaterThanOrEqual(0);
    const userNode = instructions.findIndex((l) => /^USER node\b/.test(l));
    expect(userNode).toBeGreaterThan(made);
  });

  it("has no Claude adapter or Anthropic package in the runner's dependencies", () => {
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(all).filter((k) => k.startsWith("@anthropic-ai/") || k === "@agentclientprotocol/claude-agent-acp")).toEqual([]);
  });
});
