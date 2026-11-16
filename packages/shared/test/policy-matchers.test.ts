import { describe, expect, it } from "vitest";
import { isDestructive, isPushing, matches, type PermissionInfo, type PolicyMatch } from "../src/policy.js";

const exec = (command: string): PermissionInfo => ({ title: command, kind: "execute", rawInput: { command } });

describe("isDestructive", () => {
  it("catches rm -r/-f, find -delete, mkfs and a forced push", () => {
    for (const c of ["rm -rf /srv/data", "rm -fr build", "rm --recursive --force /srv", "find /srv -delete", "sudo mkfs.ext4 /dev/sda1", "git push origin main --force", "dd if=/dev/zero of=/dev/sda"]) {
      expect(isDestructive(exec(c)), c).toBe(true);
    }
  });

  it("reads an argv array as its words", () => {
    expect(isDestructive({ title: "rm", kind: "execute", rawInput: { command: ["rm", "-rf", "/srv/data"] } })).toBe(true);
    expect(isDestructive({ title: "ls", kind: "execute", rawInput: { command: ["ls", "-la"] } })).toBe(false);
  });

  it("leaves a delete that is only text passed to a data-only program alone", () => {
    expect(isDestructive(exec("git commit -m 'stop rm -rf old stuff'"))).toBe(false);
    expect(isDestructive(exec("echo 'rm -rf /srv'"))).toBe(false);
  });

  it("still sees text that a redirect can turn into a script", () => {
    expect(isDestructive(exec("echo 'rm -rf /srv' >> ~/.bashrc"))).toBe(true);
  });

  it("uses the title only for an execute request, never a read or edit", () => {
    expect(isDestructive({ title: "rm -rf /srv", kind: "execute", rawInput: null })).toBe(true);
    expect(isDestructive({ title: "rm -rf /srv", kind: "read", rawInput: null })).toBe(false);
  });

  it("leaves ordinary commands alone", () => {
    expect(isDestructive(exec("ls -la"))).toBe(false);
    expect(isDestructive(exec("git status"))).toBe(false);
  });
});

describe("isPushing", () => {
  it("catches git push, npm publish and docker push", () => {
    for (const c of ["git push origin feature", "npm publish", "docker push registry.example/app:1"]) {
      expect(isPushing(exec(c)), c).toBe(true);
    }
  });

  it("reads an argv array as its words", () => {
    expect(isPushing({ title: "git", kind: "execute", rawInput: { command: ["git", "push", "origin", "main"] } })).toBe(true);
  });

  it("does not mistake a quoted mention or a read for a push", () => {
    expect(isPushing(exec("echo 'git push'"))).toBe(false);
    expect(isPushing(exec("git status"))).toBe(false);
    expect(isPushing({ title: "git push", kind: "read", rawInput: null })).toBe(false);
  });

  it("uses the title for an execute request with no raw input", () => {
    expect(isPushing({ title: "git push origin main", kind: "execute", rawInput: null })).toBe(true);
  });
});

describe("matches", () => {
  const other = (rawInput: unknown, title = ""): PermissionInfo => ({ title, kind: "other", rawInput });

  it("does not match a rule with no condition", () => {
    expect(matches({}, exec("ls"))).toBe(false);
  });

  it("matches on tool kinds", () => {
    expect(matches({ kinds: ["execute"] }, exec("ls"))).toBe(true);
    expect(matches({ kinds: ["read"] }, exec("ls"))).toBe(false);
    expect(matches({ kinds: ["execute", "read"] }, { title: "read a file", kind: "read", rawInput: {} })).toBe(true);
  });

  it("treats a command with an unknown kind as an execute", () => {
    expect(matches({ kinds: ["execute"] }, other({ command: "ls" }))).toBe(true);
    expect(matches({ kinds: ["other"] }, other({ command: "ls" }))).toBe(false);
    expect(matches({ kinds: ["other"] }, other({ url: "https://example.test" }))).toBe(true);
  });

  it("limits a rule to named agents", () => {
    const rule: PolicyMatch = { kinds: ["execute"], agentIds: ["agent-a", "agent-b"] };
    expect(matches(rule, { ...exec("ls"), agentId: "agent-b" })).toBe(true);
    expect(matches(rule, { ...exec("ls"), agentId: "agent-c" })).toBe(false);
    expect(matches(rule, exec("ls"))).toBe(false);
  });

  it("matches a command pattern against the shell command only", () => {
    expect(matches({ commandPattern: "^git status$" }, exec("git status"))).toBe(true);
    expect(matches({ commandPattern: "^git status$" }, exec("git push"))).toBe(false);
    expect(matches({ commandPattern: "status" }, other({ url: "https://example.test" }, "git status"))).toBe(false);
    expect(matches({ commandPattern: "(" }, exec("git status"))).toBe(false);
  });

  it("matches a title pattern against the title only", () => {
    expect(matches({ titlePattern: "wiki" }, other({ url: "https://example.test" }, "Boss Man wiki"))).toBe(true);
    expect(matches({ titlePattern: "wiki" }, other({ url: "https://example.test" }, "Boss Man board"))).toBe(false);
    expect(matches({ titlePattern: "wiki" }, { ...exec("ls"), title: null })).toBe(false);
  });

  it("respects safeOnly, which never covers a destructive or pushing command", () => {
    const rule: PolicyMatch = { kinds: ["execute"], safeOnly: true };
    expect(matches(rule, exec("ls -la"))).toBe(true);
    expect(matches(rule, exec("rm -rf /srv"))).toBe(false);
    expect(matches(rule, exec("git push origin main"))).toBe(false);
  });

  it("matches destructive and pushing requests only when asked", () => {
    expect(matches({ destructive: true }, exec("rm -rf /srv"))).toBe(true);
    expect(matches({ destructive: true }, exec("ls"))).toBe(false);
    expect(matches({ pushing: true }, exec("git push origin main"))).toBe(true);
    expect(matches({ pushing: true }, exec("ls"))).toBe(false);
  });

  it("matches a call to Boss Man's own tools, and not a shell command with a bossman title", () => {
    expect(matches({ bossmanCall: true }, other({}, "mcp__bossman__wiki"))).toBe(true);
    expect(matches({ bossmanCall: true }, other({ command: "ls" }, "mcp__bossman__wiki"))).toBe(false);
    expect(matches({ bossmanCall: true }, other({}, "mcp__other__wiki"))).toBe(false);
  });

  it("matches a removal of a reserved /tmp entry only", () => {
    const rule: PolicyMatch = { kinds: ["execute"], reservedTmpRemoval: true };
    expect(matches(rule, exec("rm /tmp/bossman-check-all.slot.1"))).toBe(true);
    expect(matches(rule, exec("rm /tmp/my-own-file"))).toBe(false);
  });

  it("matches scratch-only commands only", () => {
    const rule: PolicyMatch = { kinds: ["execute"], scratchOnly: true };
    expect(matches(rule, exec("rm -rf /tmp/scratch"))).toBe(true);
    expect(matches(rule, exec("rm -rf /srv/data"))).toBe(false);
  });
});
