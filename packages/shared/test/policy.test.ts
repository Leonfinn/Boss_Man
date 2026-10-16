import { describe, expect, it } from "vitest";
import { commandOf, evaluatePermission, recommendedVerdict } from "../src/policy.js";

const exec = (command: string) => ({ title: command, kind: "execute", rawInput: { command } });

describe("evaluatePermission defaults", () => {
  it("allows Boss Man's own MCP tools for Claude and Codex naming", () => {
    expect(evaluatePermission({ title: "mcp__bossman__create_ticket", kind: "other", rawInput: {} }, []).outcome).toBe("allow");
    expect(evaluatePermission({ title: "mcp.bossman.create_ticket", kind: "execute", rawInput: {} }, []).outcome).toBe("allow");
  });

  it("sends destructive commands to the owner", () => {
    for (const c of ["rm -rf /srv/precious", "rm -fr build", "sudo mkfs.ext4 /dev/sda1", "docker system prune -a", "git push origin main --force", "zfs destroy tank/apps"]) {
      expect(evaluatePermission(exec(c), [])).toMatchObject({ outcome: "owner" });
    }
  });

  it("sends pushing and publishing to the owner", () => {
    expect(evaluatePermission(exec("npm publish"), []).outcome).toBe("owner");
    expect(evaluatePermission(exec("git push origin feature"), []).outcome).toBe("owner");
  });

  it("allows ordinary work and workspace edits", () => {
    expect(evaluatePermission(exec("echo spike > spike.txt"), []).outcome).toBe("allow");
    expect(evaluatePermission({ title: "Edit src/a.ts", kind: "edit", rawInput: {} }, []).outcome).toBe("allow");
  });

  it("falls through to the owner for unknown kinds", () => {
    expect(evaluatePermission({ title: "Delete file", kind: "delete", rawInput: {} }, [])).toEqual({ outcome: "owner", rule: "No rule matched" });
  });

  it("company rules win over defaults, first match first", () => {
    const rules = [
      { name: "Homelab may restart containers", match: { commandPattern: String.raw`^docker\s+restart\b` }, outcome: "allow" as const },
      { name: "No curl", match: { commandPattern: String.raw`\bcurl\b` }, outcome: "deny" as const },
    ];
    expect(evaluatePermission(exec("docker restart web"), rules)).toEqual({ outcome: "allow", rule: "Homelab may restart containers" });
    expect(evaluatePermission(exec("curl https://example.com"), rules).outcome).toBe("deny");
  });

  it("ignores a rule with a broken pattern instead of crashing", () => {
    const rules = [{ name: "broken", match: { commandPattern: "(" }, outcome: "deny" as const }];
    expect(evaluatePermission(exec("echo hi"), rules).outcome).toBe("allow");
  });
});

describe("helpers", () => {
  it("reads commands as strings or argv arrays", () => {
    expect(commandOf({ command: "ls -la" })).toBe("ls -la");
    expect(commandOf({ cmd: ["git", "status"] })).toBe("git status");
    expect(commandOf(null)).toBeNull();
  });
  it("recommends refusing destructive commands", () => {
    expect(recommendedVerdict(exec("rm -rf /"))).toBe("deny");
    expect(recommendedVerdict(exec("git push origin x"))).toBe("allow");
  });
});
