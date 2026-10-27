import { describe, expect, it } from "vitest";
import { tempCleanup } from "../src/explain.js";
import { commandOf, evaluatePermission, recommendedVerdict, SCRATCH_RULE, TEMP_CLEANUP_RULE } from "../src/policy.js";

const exec = (command: string) => ({ title: command, kind: "execute", rawInput: { command } });

describe("the /tmp-only switch", () => {
  it("allows commands that only work in /tmp when on, and still asks when off", () => {
    for (const c of ["rm -rf /tmp/fp2", "mkdir -p /tmp/a && cp -r src /tmp/a", "cd /tmp/x && find . -delete"]) {
      expect(evaluatePermission(exec(c), [SCRATCH_RULE])).toEqual({ outcome: "allow", rule: SCRATCH_RULE.name });
    }
    expect(evaluatePermission(exec("rm -rf /tmp/fp2"), []).outcome).toBe("ceo");
    expect(evaluatePermission(exec("rm -rf /tmp/fp2/x"), []).outcome).toBe("owner");
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
    for (const c of ["rm -rf /srv/precious", "rm -fr build", "rm --recursive --force /home/node", "rm -v -r /srv/x", "rm /srv/x -rf", "find /srv -delete", "find /srv -type f -exec rm {} +", "sudo mkfs.ext4 /dev/sda1", "docker system prune -a", "git push origin main --force", "zfs destroy tank/apps"]) {
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

describe("temp-file cleanup (BOS-111)", () => {
  const route = (c: string) => evaluatePermission(exec(c), []);
  it("sends deletes of entries directly in /tmp to the CEO, recommended Allow", () => {
    for (const c of [
      "rm -rf /tmp/rv86 && git worktree add /tmp/rv86 origin/main && cd /tmp/rv86 && pnpm install > /tmp/rv86-install.log 2>&1",
      "rm -rf /tmp/a /tmp/b.log 2>/dev/null",
      "rm -rf -- /tmp/.hidden-dir",
      "rm -rf /tmp/rv86 &>/dev/null; git worktree prune",
      "rm -rf /tmp/wt && git worktree add -b bos-111 /tmp/wt origin/main 2>&1 && mkdir -p /tmp/wt-logs/a",
      "git worktree remove --force /tmp/wt; rm -rf /tmp/wt; git worktree list",
      "rm -rf /tmp/x && cd /tmp/x2 && pnpm install --frozen-lockfile >> /tmp/x2.log 2>&1; echo done",
    ]) {
      expect(route(c), c).toEqual({ outcome: "ceo", rule: TEMP_CLEANUP_RULE });
      expect(recommendedVerdict(exec(c)), c).toBe("allow");
    }
  });

  it("keeps anything not provably temp-only with the owner", () => {
    for (const c of [
      "rm -rf /tmp",
      "rm -rf /tmp/",
      "rm -rf /tmp/.",
      "rm -rf /tmp/..",
      "rm -rf /tmp/../home",
      "rm -rf /tmp/a/../../home",
      "rm -rf /tmp/$X",
      "rm -rf /tmp/${X}",
      "rm -rf /tmp/*",
      "rm -rf /tmp/rv8?",
      "rm -rf /tmp/[ab]",
      "rm -rf /tmp/{a,..}",
      'rm -rf "/tmp/a"',
      "rm -rf /tmp/a\\ /home",
      "rm -rf /tmp/a/b",
      "rm -rf /tmp /home",
      "rm -rf /tmp/a ~/x",
      "rm -rf /tmp/a ~",
      "rm -rf /tmp/a home",
      "rm -rf /tmp/a $(echo /home)",
      "rm -rf /tmp/a `echo /home`",
      "rm -rf /tmp/a > /home/node/.bashrc",
      "rm -rf /tmp/a; rm -rf /home",
      "cd /tmp && rm -rf a",
      'bash -c "rm -rf /home"; rm -rf /tmp/a',
      "eval 'rm -rf /home' && rm -rf /tmp/a",
      "rm -rf /tmp/a\nbash <<EOF\nrm -rf /home\nEOF",
      "(rm -rf /home); rm -rf /tmp/a",
      "rm() { command rm -rf /home; }; rm -rf /tmp/a",
      "function rm { :; }; rm -rf /tmp/a",
      "alias rm='rm -rf /home'; rm -rf /tmp/a",
      "PATH=/tmp/bin:$PATH rm -rf /tmp/a",
      "export PATH=/tmp/bin; rm -rf /tmp/a",
      "rm -rf /tmp/a && git push origin main",
      "rm -rf /tmp/a && npm publish",
      "rm -rf /tmp/a && shred /home/x",
      "rm -rf /tmp/a && dd if=/dev/zero of=/dev/sda",
      "sudo rm -rf /tmp/a",
      "xargs rm -rf /tmp/a",
      "rm -rf --files0-from=/home/list /tmp/a",
      // A second delete spelled in a way the old DESTRUCTIVE missed (CEO review of 52549fc).
      "rm -rf /tmp/a; rm --recursive /home/node",
      "rm -rf /tmp/a; rm --force /home/node/x",
      "rm -rf /tmp/a; rm -v -r /home/node",
      "rm -rf /tmp/a; rm /home/node -rf",
      "rm -rf /tmp/a && rm -R /home",
      "rm -rf /tmp/a; find /home -delete",
      "rm -rf /tmp/a; find /home -exec rm {} +",
      "rm -rf /tmp/a; truncate -s0 /home/x",
      "rm -rf /tmp/a; ls /home | xargs rm",
      "rm -rf /tmp/a; rm /home/node/x",
      "rm -rf /tmp/a; unlink /home/node/x",
      "rm -rf /tmp/a; rsync -a --delete /tmp/empty/ /home/node/",
      "rm -rf /tmp/a; git clean -fdx",
      "rm -rf /tmp/a; python3 -c 'import shutil; shutil.rmtree(\"/home\")'",
      "rm -rf /tmp/a & rm -rf /home",
      // Spellings no word list sees, and changes that aren't deletes (Security Reviewer, 4129e12): only an allow-list stops them.
      'rm -rf /tmp/a; "r"m -rf /home/node',
      "rm -rf /tmp/a; r\\m -rf /home/node",
      "rm -rf /tmp/a\nx=r; ${x}m -rf /home/node",
      "rm -rf /tmp/a; mv /home/node/repo /tmp/b && rm -rf /tmp/b",
      "rm -rf /tmp/a; python3 -c 'import os; os.remove(\"/home/node/x\")'",
      "rm -rf /tmp/a; : > /home/node/.bashrc",
      "rm -rf /tmp/a; cp /dev/null /home/node/x",
      "rm -rf /tmp/a; dd of=/home/node/x",
      "rm -rf /tmp/a; echo x > /home/node/.bashrc",
      "rm -rf /tmp/a; echo x >| /home/node/.bashrc",
      "rm -rf /tmp/a; echo x >& /home/node/x",
      "rm -rf /tmp/a; echo x >> /tmp/a/b",
      "rm -rf /tmp/a; echo x 2>&1x",
      "rm -rf /tmp/a; sed -i d /home/node/x",
      "rm -rf /tmp/a; tee /home/node/x",
      "rm -rf /tmp/a; touch /home/node/x",
      "rm -rf /tmp/a; ln -sf /home/node /tmp/b",
      "rm -rf /tmp/a; sh /tmp/x.sh",
      "rm -rf /tmp/a; node -e x",
      "rm -rf /tmp/a; curl -o /tmp/x.json https://example.com/x",
      "rm -rf /tmp/a; /bin/rm -rf /home/node",
      "rm -rf /tmp/a; command rm -rf /home/node",
      "rm -rf /tmp/a; X=1 echo hi",
      "rm -rf /tmp/a; git worktree remove /home/node/wt",
      "rm -rf /tmp/a; git worktree remove /tmp/a/b",
      "rm -rf /tmp/a; git worktree add /home/node/wt",
      "rm -rf /tmp/a; git worktree add --orphan /tmp/b",
      "rm -rf /tmp/a; git -c core.fsmonitor=/tmp/x status",
      "rm -rf /tmp/a; git -C /home/node/repo worktree add /tmp/b",
      "rm -rf /tmp/a; git clean -fdx /tmp/b",
      "rm -rf /tmp/a; git checkout -- .",
      "rm -rf /tmp/a; pnpm install",
      "rm -rf /tmp/a; cd /home/node/repo && pnpm install",
      "rm -rf /tmp/a; cd /tmp/b && pnpm install --dir=/home/node/repo",
      "rm -rf /tmp/a; cd /tmp/b && pnpm install -C /home/node/repo",
      "rm -rf /tmp/a; cd /tmp/b && pnpm run build",
      "rm -rf /tmp/a; mkdir /tmp/a/../../home/x",
      "rm -rf /tmp/a; mkdir -m 777 /tmp/b",
      "rm -rf /tmp/a\r\nrm -rf /home/node",
    ]) {
      expect(route(c).rule, c).not.toBe(TEMP_CLEANUP_RULE);
      expect(tempCleanup(c), c).toBe(false);
    }
    // A plain rm without -r/-f never asked anyone, and still doesn't.
    expect(route("rm /tmp/a").outcome).toBe("allow");
  });

  it("lets the company's own rules win", () => {
    expect(route("rm -rf /tmp/a")).toEqual({ outcome: "ceo", rule: TEMP_CLEANUP_RULE });
    const mine = [{ name: "Owner sees every rm", match: { commandPattern: "\\brm\\b" }, outcome: "owner" as const }];
    expect(evaluatePermission(exec("rm -rf /tmp/a"), mine).outcome).toBe("owner");
  });

  it("doesn't recommend Deny just because a command deletes files", () => {
    for (const c of ["rm -rf node_modules dist", "rm -rf apps/web/dist/", "pnpm build && rm -rf coverage 2>/dev/null", "cd /tmp/x && rm -rf build"]) expect(recommendedVerdict(exec(c)), c).toBe("allow");
    for (const c of ["rm -rf src", "rm -rf apps/web/src", "rm -rf node_modules src", "find . -name '*.ts' -delete", "rm -rf ~/x", "rm -rf /home/node/x", "rm -rf $DIR", "rm -rf *", "rm -rf ../x", "rm -rf .git", "rm -rf a/../../b", "cd .. && rm -rf x", "rm -rf /tmp", "docker system prune -a", "git push --force origin x", "shred a.txt", "zfs destroy tank/a"]) expect(recommendedVerdict(exec(c)), c).toBe("deny");
  });
});
