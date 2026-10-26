import { describe, expect, it } from "vitest";
import { commandOf, evaluatePermission, recommendedVerdict, SCRATCH_RULE } from "../src/policy.js";

const exec = (command: string) => ({ title: command, kind: "execute", rawInput: { command } });

describe("the /tmp-only switch", () => {
  it("allows commands that only work in /tmp when on, and still asks when off", () => {
    for (const c of ["rm -rf /tmp/fp2", "mkdir -p /tmp/a && cp -r src /tmp/a", "cd /tmp/x && find . -delete"]) {
      expect(evaluatePermission(exec(c), [SCRATCH_RULE])).toEqual({ outcome: "allow", rule: SCRATCH_RULE.name });
    }
    expect(evaluatePermission(exec("rm -rf /tmp/fp2"), []).outcome).toBe("owner");
  });

  it("never covers anything outside /tmp, pushes, the network or programs it can't see into", () => {
    for (const c of ["rm -rf /srv/x", "cd /tmp && rm -rf ../home", "rm -rf /tmp/a; rm -rf ~/b", "tee /tmp/x /etc/y", "cd /tmp/a && git push --force", "cd /tmp && curl -o x http://a", "cd /tmp && bash -c 'rm -rf /'", "cd /tmp && docker system prune -a", "cd /tmp && zfs destroy tank/apps"]) {
      expect(evaluatePermission(exec(c), [SCRATCH_RULE]).rule).not.toBe(SCRATCH_RULE.name);
    }
  });
});

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

  it("treats a shell command asked about as kind other like any shell command", () => {
    const other = (command: string) => ({ title: command, kind: "other", rawInput: { command } });
    expect(evaluatePermission(other("cd /tmp/opencode/bm && git grep -n brief"), [])).toEqual({ outcome: "allow", rule: "Other shell commands" });
    expect(evaluatePermission(other("git push origin main"), []).outcome).toBe("owner");
    expect(evaluatePermission({ title: "mcp__scrapling__get", kind: "other", rawInput: { url: "https://example.com" } }, []).outcome).toBe("owner");
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
    // rm -rf inside a sed script is text being edited, not run; inside bash -c it runs.
    expect(recommendedVerdict(exec(`sed "s|trap 'rm -rf \\"\\$t\\"' EXIT|:|" a.sh > /tmp/x.sh && bash /tmp/x.sh`))).toBe("allow");
    expect(recommendedVerdict(exec("git commit -m 'stop rm -rf in scripts'"))).toBe("allow");
    expect(recommendedVerdict(exec("bash -c 'rm -rf /'"))).toBe("deny");
    expect(recommendedVerdict(exec("eval \"rm -rf $d\""))).toBe("deny");
  });
});

describe("home-network guard", () => {
  const tool = (title: string, rawInput: unknown, kind = "other") => ({ title, kind, rawInput });
  const allowAll = [{ name: "Allow every crawl4ai tool", match: { titlePattern: "^mcp__crawl4ai__" }, outcome: "allow" as const }];

  it("denies tool-server and fetch calls aimed at private addresses, before any rule", () => {
    for (const url of ["http://192.168.68.1/", "http://192.168.68.67:3101/api", "https://10.0.0.5", "http://127.0.0.1:8080", "http://localhost", "http://truenas/", "http://nas.local", "http://172.20.1.1", "http://169.254.169.254/latest", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:192.168.68.1]/", "http://3232252929/", "http://0xC0A84401/", "http://100.64.0.1"]) {
      expect(evaluatePermission(tool("mcp__crawl4ai__md", { url }), allowAll), url).toMatchObject({ outcome: "deny" });
    }
    expect(evaluatePermission(tool("mcp__crawl4ai__crawl", { urls: ["https://example.com", "http://192.168.68.1"] }), allowAll).outcome).toBe("deny");
    expect(evaluatePermission(tool("WebFetch", { url: "http://192.168.68.1" }, "fetch"), []).outcome).toBe("deny");
    expect(evaluatePermission(tool("mcp__scrapling__get", { url: "not a url http://" }), allowAll).outcome).not.toBe("deny");
  });

  it("leaves public addresses and Boss Man's own tools to the rules", () => {
    expect(evaluatePermission(tool("mcp__crawl4ai__md", { url: "https://docs.truenas.com/scale/" }), allowAll).outcome).toBe("allow");
    expect(evaluatePermission(tool("mcp__crawl4ai__md", { url: "http://172.32.0.1" }), allowAll).outcome).toBe("allow");
    expect(evaluatePermission(tool("mcp__bossman__wiki_read", { url: "http://localhost" }), []).outcome).toBe("allow");
    expect(evaluatePermission(exec("curl http://192.168.68.1"), []).outcome).toBe("allow");
  });
});
