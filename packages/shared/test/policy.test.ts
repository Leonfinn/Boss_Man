import { describe, expect, it } from "vitest";
import { cleanupScope, explainCommand, tempCleanup } from "../src/explain.js";
import { commandOf, evaluatePermission, isBossmanCall, isBossmanTool, recommendedVerdict, SCRATCH_RULE, TEMP_CLEANUP_RULE, WORKING_COPY_RULE } from "../src/policy.js";

const exec = (command: string) => ({ title: command, kind: "execute", rawInput: { command } });

describe("the /tmp-only switch", () => {
  it("allows commands that only work in /tmp when on, and still asks when off", () => {
    for (const c of ["rm -rf /tmp/fp2", "mkdir -p /tmp/a && cp -r src /tmp/a", "find /tmp/x -delete"]) {
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

  it("allows Boss Man's own tools in each harness's spelling (BOS-292)", () => {
    for (const title of ["bossman_set_ticket_state", "Tool: bossman/wiki", "bossman: decisions", "Bossman - wiki", "mcp:bossman:wiki", " mcp__Bossman__wiki"]) {
      expect(evaluatePermission({ title, kind: "other", rawInput: {} }, []).outcome, title).toBe("allow");
      expect(isBossmanTool(title), title).toBe(true);
    }
  });

  it("still asks about other tools, including lookalike server names (BOS-292)", () => {
    for (const title of ["mcp__other__wiki", "bossmanager_x", "mcp__bossman2__x", "mcp__other__bossman__x", "Tool: other/bossman_x", "bossman", null]) {
      expect(evaluatePermission({ title, kind: "other", rawInput: {} }, []).outcome, String(title)).toBe("owner");
    }
  });

  it("sends destructive commands to the owner", () => {
    for (const c of ["rm -rf /srv/precious", "rm -fr ../build", "rm --recursive --force /home/node", "rm -v -r /srv/x", "rm /srv/x -rf", "find /srv -delete", "find /srv -type f -exec rm {} +", "sudo mkfs.ext4 /dev/sda1", "docker system prune -a", "git push origin main --force", "zfs destroy tank/apps"]) {
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
    // A push is judged by where it goes (BOS-208): its own ticket branch is Allow, anything else is Deny.
    const ticket = "11111111-2222-4333-8444-555555555555";
    expect(recommendedVerdict(exec(`git push origin bossman/${ticket}`))).toBe("allow");
    for (const c of ["git push origin main", "git push", "git push origin HEAD", "git push -f origin x", "git push origin :x", `git push origin +bossman/${ticket}`, "git push --mirror origin"]) {
      expect(recommendedVerdict(exec(c)), c).toBe("deny");
    }
    expect(recommendedVerdict(exec(`git status && git push origin bossman/${ticket}`))).toBe("deny");
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
      "rm -rf /tmp/rv86 /tmp/rv86-install.log && git worktree add /tmp/rv86 origin/main && cd /tmp/rv86 && pnpm install > /tmp/rv86-install.log 2>&1",
      "rm -rf /tmp/rv86 && git worktree add /tmp/rv86 origin/main && cd /tmp/rv86 && pnpm install > /tmp/rv86 2>&1",
      "rm -rf /tmp/a /tmp/b.log 2>/dev/null",
      "rm -rf -- /tmp/.hidden-dir",
      "rm -rf /tmp/wt /tmp/wt-logs && git worktree add -b bos-111 /tmp/wt origin/main 2>&1 && mkdir -p /tmp/wt-logs",
      "rm -rf /tmp/wt; git worktree list",
      "rm -rf /tmp/x2 /tmp/x2.log && mkdir /tmp/x2 && cd /tmp/x2 && pnpm install --frozen-lockfile >> /tmp/x2.log 2>&1; echo done",
      "rm -rf /tmp/a; rm -f /tmp/b && echo x > /tmp/b",
      // A `;` between chains does not break it: each write stays in the && chain of its own delete.
      "rm -rf /tmp/a && mkdir /tmp/a; rm -rf /tmp/b && mkdir /tmp/b",
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
      // remove follows a symlink at /tmp/lnk and deletes the folder it points to (BOS-111 security review).
      "rm -rf /tmp/a; git worktree remove --force /tmp/lnk",
      "rm -rf /tmp/a; git worktree remove /tmp/lnk",
      // -B resets a branch that already exists.
      "rm -rf /tmp/a; git worktree add -B main /tmp/b origin/main",
      "rm -rf /tmp/a; git worktree add --force /tmp/b",
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
      // Writes must go to a /tmp entry this command has just deleted: any other could be a shortcut link (BOS-111 adversarial review).
      "rm -rf /tmp/a && git worktree add -b x /tmp/lnk",
      "rm -rf /tmp/a && cd /tmp/lnk && pnpm install",
      "rm -rf /tmp/a && mkdir -p /tmp/lnk/sub",
      "rm -rf /tmp/a && mkdir -p /tmp/a/sub",
      // A redirect to a plain /tmp/NAME goes to the CEO since adversarial round 14 (see below); a deeper path still doesn't.
      "rm -rf /tmp/a && echo x >> /tmp/a/b",
      // The delete may have failed, or runs alongside, so the name may still be a link.
      "rm -rf /tmp/lnk; git worktree add -b x /tmp/lnk",
      "rm -rf /tmp/lnk || git worktree add -b x /tmp/lnk",
      "false || rm -rf /tmp/lnk && git worktree add -b x /tmp/lnk",
      "rm -rf /tmp/lnk & git worktree add -b x /tmp/lnk",
      "rm -rf /tmp/lnk | git worktree add -b x /tmp/lnk",
      "rm -rf /tmp/lnk\ngit worktree add -b x /tmp/lnk",
      "rm -ri /tmp/lnk && git worktree add -b x /tmp/lnk",
      "rm --interactive=always -rf /tmp/lnk && cd /tmp/lnk && pnpm install",
      // If the cd fails, the install runs in the project.
      "rm -rf /tmp/a && cd /tmp/a; pnpm install",
      "rm -rf /tmp/a && cd /tmp/a || pnpm install",
      "rm -rf /tmp/a && mkdir /tmp/a && cd /tmp/a && true || pnpm install",
      // The cleared name is only cleared until the chain breaks.
      "rm -rf /tmp/a; true; cd /tmp/a && pnpm install",
      // A failed rm short-circuits the write after it, so a `;` chain cannot borrow another chain's delete (BOS-120 round 3).
      "rm -rf /tmp/a && mkdir /tmp/a; mkdir /tmp/b",
      "rm -rf /tmp/a; rm -rf /tmp/b && mkdir /tmp/a",
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
    for (const c of ["rm -rf node_modules dist", "rm -rf apps/web/dist/", "pnpm build && rm -rf coverage 2>/dev/null"]) expect(recommendedVerdict(exec(c)), c).toBe("allow");
    for (const c of ["rm -rf src", "rm -rf apps/web/src", "rm -rf node_modules src", "find . -name '*.ts' -delete", "rm -rf ~/x", "rm -rf /home/node/x", "rm -rf $DIR", "rm -rf *", "rm -rf ../x", "rm -rf .git", "rm -rf a/../../b", "cd .. && rm -rf x", "cd /tmp/x && rm -rf build", "rm -rf /tmp", "docker system prune -a", "git push --force origin x", "shred a.txt", "zfs destroy tank/a"]) expect(recommendedVerdict(exec(c)), c).toBe("deny");
  });

  it("doesn't follow any cd (BOS-111 security re-checks)", () => {
    // A cd that failed (any separator but &&), took an option or went back (cd -, cd --, -P, -L, -e),
    // used CDPATH, or a pushd/popd: Boss Man doesn't work out where these land, so none is /tmp-only.
    const unsure = ["cd /tmp/missing; rm -rf ../x", "cd /tmp/missing\nrm -rf ../x", "cd /tmp/missing || rm -rf ../x", "cd /tmp/missing | rm -rf ../x", "cd /tmp/missing & rm -rf ../x", "cd /tmp/a && true; rm -rf ../x", "true || cd /tmp/a && rm -rf ../x", "cd /tmp/missing; rm -rf build",
      "cd /tmp/a && rm -rf ../x", "cd /tmp/a && rm -rf x", "cd /tmp/a && cd -- /home && rm -rf x", "cd /tmp/a && cd - && rm -rf x", "cd /tmp/a && cd -P /home && rm -rf x", "cd /tmp/a && cd -L .. && rm -rf x", "cd /tmp/a && cd -e /home && rm -rf x", "cd /tmp/a && CDPATH=/home cd x && rm -rf y", "pushd /tmp/a && popd && rm -rf x", "cd /tmp/a && pushd /home && rm -rf x"];
    for (const c of unsure) {
      expect(recommendedVerdict(exec(c)), c).toBe("deny");
      expect(explainCommand(c).scratch, c).toBeUndefined();
      expect(evaluatePermission(exec(c), [SCRATCH_RULE]).rule, c).not.toBe(SCRATCH_RULE.name);
    }
    // Absolute /tmp deletes need no cd: still Allow, still the CEO's.
    expect(recommendedVerdict(exec("rm -rf /tmp/a"))).toBe("allow");
    expect(explainCommand("rm -rf /tmp/a").scratch).toBeDefined();
    expect(evaluatePermission(exec("rm -rf /tmp/a"), []).outcome).toBe("ceo");
  });
});

describe("working-copy cleanup (BOS-120)", () => {
  const route = (c: string) => evaluatePermission(exec(c), []);
  it("sends deletes of plain relative paths in the working copy to the CEO", () => {
    for (const [c, files, tmp] of [
      ["rm -f test/zz-probe.test.ts", ["test/zz-probe.test.ts"], []],
      ["rm -rf dist apps/web/dist/", ["dist", "apps/web/dist/"], []],
      ["rm -rf .turbo node_modules/.cache", [".turbo", "node_modules/.cache"], []],
      ["rm -rf dist /tmp/x", ["dist"], ["/tmp/x"]],
      ["rm -rf /tmp/x; rm -f test/zz-probe.test.ts 2>/dev/null; git status", ["test/zz-probe.test.ts"], ["/tmp/x"]],
      ["rm -rf -- coverage && echo done", ["coverage"], []],
      ["rm -rf build >/dev/null 2>&1; ls", ["build"], []],
      ["rm -rf a.gitignore .github/x .gitmodules", ["a.gitignore", ".github/x", ".gitmodules"], []],
      // A /tmp entry deleted on its own earlier in the && chain may still be written to.
      ["rm -rf /tmp/x && rm -rf dist && mkdir /tmp/x", ["dist"], ["/tmp/x"]],
    ] as const) {
      expect(route(c), c).toEqual({ outcome: "ceo", rule: WORKING_COPY_RULE });
      expect(cleanupScope(c), c).toEqual({ workingCopy: files, tmp });
      // Not temp cleanup: the server checks the run has a checkout before it recommends Allow.
      expect(tempCleanup(c), c).toBe(false);
    }
  });

  it("keeps path tricks and anything not provably in the working copy with the owner", () => {
    for (const c of [
      // Leaving the copy, or its root.
      "rm -rf ..", "rm -rf ../x", "rm -rf a/../../b", "rm -rf a/..", "rm -rf ./x", "rm -rf .", "rm -rf ./", "rm -rf a/./b",
      "rm -rf /home/node/x", "rm -rf //x", "rm -rf /tmp/a/b", "rm -rf ~/x", "rm -rf ~", "rm -rf -- -x", "rm -rf -x",
      // The repository itself, at any depth and in any case.
      "rm -rf .git", "rm -rf .git/", "rm -rf .git/hooks", "rm -rf a/.git/x", "rm -rf a/.git", "rm -rf .GIT", "rm -rf .Git/objects",
      // A cd anywhere: the paths would no longer be relative to the checkout.
      "cd a && rm -rf b", "cd /tmp/x && rm -rf b", "rm -rf b; cd ..", "rm -rf b && cd /tmp/x && pnpm install", "cd && rm -rf b",
      // Anything the shell expands, quotes or escapes.
      "rm -rf *", "rm -rf dist/*", "rm -rf a?", "rm -rf [ab]", "rm -rf {a,b}", "rm -rf $X", "rm -rf ${X}", "rm -rf $(echo x)", "rm -rf `echo x`",
      "rm -rf 'dist'", 'rm -rf "dist"', "rm -rf di\\st", "rm -rf a\\ b", "rm -rf a#b", "rm -rf a!b", "rm -rf a(b)",
      // Another command hiding behind the delete.
      "rm -rf dist\r\nrm -rf /home/node", "rm -rf dist\nrm -rf /home/node", "rm -rf dist & rm -rf /home", "rm -rf dist; rm -rf /home",
      "rm dist -rf", "rm -rf dist > src/index.ts", "rm -rf dist >> README.md", "rm -rf dist 2> x.log",
      "rm() { command rm -rf /home; }; rm -rf dist", "function rm { :; }; rm -rf dist", "alias rm='rm -rf /home'; rm -rf dist", "PATH=/tmp/bin:$PATH rm -rf dist",
      "rm -rf dist && git push origin main", "rm -rf dist && npm publish", "sudo rm -rf dist", "xargs rm -rf dist", "rm -rf --files0-from=list dist",
      // Tools that follow symlinks, move or overwrite, or run code Boss Man can't read: not on the safe list.
      "rm -rf dist; cp -r src /tmp/x", "rm -rf dist; cp -L a b", "rm -rf dist; rsync -a --delete x/ y/", "rm -rf dist; tar xf a.tar", "rm -rf dist; find -L . -name x",
      "rm -rf dist; ln -s /home/node dist", "rm -rf dist; mv src /tmp/x", "rm -rf dist && npx vitest run", "rm -rf dist && pnpm test", "rm -rf dist; sh x.sh",
      "rm -rf dist; node -e x", "rm -rf dist; git clean -fdx", "rm -rf dist; git checkout -- .", "rm -rf dist; mkdir src/x", "rm -rf dist; touch x",
      "rm -rf dist; git -C /home/node/repo status", "rm -rf dist; git worktree add /home/node/wt",
      // Security Reviewer, round 2: a write through a link at /tmp/lnk. A working-copy delete never clears a /tmp write,
      // and neither does a delete that mixes /tmp and working-copy paths.
      "rm -rf dist && git worktree add -b x /tmp/lnk", "mkdir -p /tmp/lnk/sub; rm -rf dist", "echo x >/tmp/lnk; rm -rf dist",
      "rm -rf dist && mkdir -p /tmp/lnk", "rm -rf dist && echo x >/tmp/lnk", "rm -rf /tmp/lnk dist && mkdir /tmp/lnk", "rm -rf /tmp/lnk; rm -rf dist; mkdir /tmp/lnk",
    ]) {
      expect(route(c).rule, c).not.toBe(WORKING_COPY_RULE);
      expect(route(c).rule, c).not.toBe(TEMP_CLEANUP_RULE);
      expect(cleanupScope(c), c).toBeNull();
    }
  });

  it("only reads a command written as one string: an argv array runs without a shell", () => {
    expect(evaluatePermission({ title: "rm", kind: "execute", rawInput: { command: ["rm", "-rf", "dist"] } }, []).rule).not.toBe(WORKING_COPY_RULE);
  });

  it("still sends the owner's example card to the owner: it runs project code beside the delete", () => {
    // The card behind this ticket (BOS-116's probe). npx vitest and pnpm typecheck run the project's own code; widening the safe list is a separate decision.
    const c = 'cp /tmp/bos116-probe.test.ts test/zz-probe.test.ts && npx vitest run test/zz-probe.test.ts 2>&1 | grep -E "^\\s*[+-] *allow" ; rm -f test/zz-probe.test.ts; pnpm typecheck 2>&1 | tail -3';
    expect(route(c).rule).not.toBe(WORKING_COPY_RULE);
  });

  it("lets the company's own rules win", () => {
    const mine = [{ name: "Owner sees every rm", match: { commandPattern: "\\brm\\b" }, outcome: "owner" as const }];
    expect(evaluatePermission(exec("rm -rf dist"), mine).outcome).toBe("owner");
  });
});

describe("temp-file cleanup, round-4 regressions (BOS-126)", () => {
  const route = (c: string) => evaluatePermission(exec(c), []);
  const OWNER = { outcome: "owner", rule: "Destructive commands go to the owner" };

  it("keeps a shortcut link at /tmp/NAME with the owner: worktree add, mkdir and installs write through it", () => {
    for (const c of [
      "rm -rf /tmp/a && git worktree add -b feat2 /tmp/lnk2",
      "rm -rf /tmp/a && mkdir -p /tmp/lnk/sub",
      "rm -rf /tmp/a && cd /tmp/lnk && pnpm install",
      "rm -rf /tmp/a && cd /tmp/lnk && npm ci",
      "rm -rf /tmp/a && git worktree remove --force /tmp/lnk",
    ]) {
      expect(tempCleanup(c), c).toBe(false);
      expect(route(c), c).toEqual(OWNER);
    }
  });

  it("still sends the ticket's example to the CEO with Allow, and the unprovable ones to the owner with Deny", () => {
    const example = "rm -rf /tmp/rv86 /tmp/rv86-install.log && git worktree add /tmp/rv86 origin/main && cd /tmp/rv86 && pnpm install > /tmp/rv86-install.log 2>&1";
    expect(tempCleanup(example)).toBe(true);
    expect(route(example)).toEqual({ outcome: "ceo", rule: TEMP_CLEANUP_RULE });
    expect(recommendedVerdict(exec(example))).toBe("allow");
    for (const c of ["rm -rf /tmp/../home", "rm -rf /tmp/$X", "rm -rf /tmp /home", "rm -rf /tmp/a /home/node/x"]) {
      expect(route(c), c).toEqual(OWNER);
      expect(recommendedVerdict(exec(c)), c).toBe("deny");
    }
    for (const c of ["rm -rf /tmp/*", "rm -rf /tmp/[ab]", "rm -rf /tmp/rv8?"]) expect(route(c), c).toEqual(OWNER);
  });

  // Found in the BOS-126 run: a glob inside /tmp was recommended Allow, because the command counted as /tmp-only work.
  for (const c of ["rm -rf /tmp/*", "rm -rf /tmp/[ab]", "rm -rf /tmp/rv8?", "rm -rf /tmp/{a,b}"]) {
    it(`recommends Deny for a glob in /tmp, which would wipe other agents' checkouts: ${c}`, () => {
      expect(recommendedVerdict(exec(c)), c).toBe("deny");
    });
  }

  // "rm /tmp/a -rf" is a plain /tmp cleanup; routing it to the owner is a deliberately conservative side effect of the widened pattern.
  it("pins the widened destructive pattern: flags after the file, and find -delete, go to the owner with Deny", () => {
    for (const c of ["rm file -rf", "rm a.txt -rf", "rm /tmp/a -rf", "find . -name x -delete", "find /tmp -name x -delete"]) {
      expect(route(c), c).toEqual(OWNER);
      expect(tempCleanup(c), c).toBe(false);
    }
    for (const c of ["rm file -rf", "find . -name x -delete"]) expect(recommendedVerdict(exec(c)), c).toBe("deny");
  });
});

describe("temp-file cleanup, round-5 fixes (BOS-111)", () => {
  const route = (c: string) => evaluatePermission(exec(c), []);

  it("gives no /tmp note when an option could carry the real target", () => {
    for (const c of [
      "rm -rf /tmp/a && cp -t /home/node /tmp/a",
      "rm -rf /tmp/a && cp --target-directory=/home/node /tmp/a",
      "rm -rf /tmp/a && diff --output=/home/node/x /tmp/a /tmp/b",
      "rm -rf /tmp/a && sort -o/home/node/x /tmp/a",
      "rm -rf /tmp/a && sort -o /home/node/x /tmp/a",
      "rm -rf /tmp/a && touch --some-new-option=/home/x /tmp/a",
      "rm -rf /tmp/a && find /tmp/b -fprint /home/x",
      "rm -rf /tmp/a && git log --output=/home/x",
      "rm -rf /tmp/a && git -C /home/x status",
      // Words the shell rebuilds: a quote glued to text, a variable, an escape.
      "rm -rf /tmp/a && sort '-'o/home/x /tmp/a",
      "rm -rf /tmp/a && sort $OPT /tmp/a",
      "rm -rf /tmp/a && sort \\-o/home/x /tmp/a",
      // Programs whose plain words can write elsewhere.
      "rm -rf /tmp/a && sed -n 'w /home/x' /tmp/b",
      "rm -rf /tmp/a && uniq /tmp/b /home/x",
      "rm -rf /tmp/a && trap 'cp /tmp/b /home/x' EXIT",
    ]) {
      expect(explainCommand(c).scratch, c).toBeUndefined();
      expect(evaluatePermission(exec(c), [SCRATCH_RULE]).rule, c).not.toBe(SCRATCH_RULE.name);
      expect(recommendedVerdict(exec(c)), c).not.toBe("allow");
    }
  });

  it("keeps the note for listed options", () => {
    for (const c of ["rm -rf /tmp/a", "rm -rf /tmp/a && mkdir -p /tmp/a/b && cp -r /tmp/c /tmp/a/b", "rm -rf /tmp/a && ls -la /tmp && cat /tmp/b > /tmp/a.log 2>&1", "find /tmp/x -name '*.log' -delete"]) {
      expect(explainCommand(c).scratch, c).toBeDefined();
    }
  });

  it("gives no /tmp note to a command that sets a variable (security round 11)", () => {
    for (const c of [
      "export PATH=/tmp/x && ls /tmp",
      "PATH=/tmp/x ls /tmp",
      "PATH=/tmp/x:/usr/bin; ls /tmp",
      "unset PATH && rm -rf /tmp/a",
      "read -r PATH < /tmp/p && ls /tmp",
      "set -a && PATH=/tmp/x && ls /tmp",
      "X=1",
      "X=1 rm -rf /tmp/a",
      "declare PATH=/tmp/x && ls /tmp",
      // The same with a /tmp write, which the note needs: these got it before the fix.
      "export PATH=/tmp/x && rm -rf /tmp/a",
      "PATH=/tmp/x:/usr/bin; rm -rf /tmp/a",
      "read -r PATH < /tmp/p && rm -rf /tmp/a",
      "set -a && PATH=/tmp/x && rm -rf /tmp/a",
    ]) {
      expect(explainCommand(c).scratch, c).toBeUndefined();
      expect(evaluatePermission(exec(c), [SCRATCH_RULE]).rule, c).not.toBe(SCRATCH_RULE.name);
    }
    expect(explainCommand("rm -rf /tmp/a").scratch).toBeDefined();
    expect(evaluatePermission(exec("rm -rf /tmp/a"), [SCRATCH_RULE]).rule).toBe(SCRATCH_RULE.name);
  });

  it("gives the /tmp note only when a segment starts with a listed program's bare name (security round 12)", () => {
    for (const c of [
      "rm -rf /tmp/a && X+=/tmp/ls /tmp/evil",
      "PATH+=:/tmp/ls && rm -rf /tmp/a",
      "X+=1 rm -rf /tmp/a",
      "X[0]=/tmp/x ls /tmp && rm -rf /tmp/a",
      "rm -rf /tmp/a && ./x /tmp/a",
      "rm -rf /tmp/a && /tmp/x /tmp/a",
      "/bin/rm -rf /tmp/a",
    ]) {
      expect(explainCommand(c).scratch, c).toBeUndefined();
      expect(evaluatePermission(exec(c), [SCRATCH_RULE]).rule, c).not.toBe(SCRATCH_RULE.name);
    }
    for (const c of ["rm -rf /tmp/a", "rm -rf /tmp/a && ls /tmp"]) {
      expect(explainCommand(c).scratch, c).toBeDefined();
      expect(evaluatePermission(exec(c), [SCRATCH_RULE]).rule, c).toBe(SCRATCH_RULE.name);
    }
  });

  it("checks every part's redirect targets for the /tmp note, deletes included (security round 14)", () => {
    for (const c of [
      "rm /tmp/a >/home/node/.bashrc",
      "rm -f /tmp/a 2>/home/node/x",
      "rm -v /tmp/a >>/home/node/x",
      "ls /tmp &>/home/x",
      "rm -rf /tmp/a 3>/home/x",
      "rm -rf /tmp/a >|/home/x",
      "rm -rf /tmp/a >&/home/x",
      "rm -rf /tmp/a <>/home/x",
      "rm -rf /tmp/a>/home/x",
      "rm -rf /tmp/a > /tmp",
      "rm -rf /tmp/a 2> /tmp/../home/x",
    ]) {
      expect(explainCommand(c).scratch, c).toBeUndefined();
      expect(tempCleanup(c), c).toBe(false);
      // rm without -r/-f isn't destructive, so those keep the ordinary Allow every file change gets; with them it's Deny.
      if (/rm -\w*[rf]/.test(c)) expect(recommendedVerdict(exec(c)), c).toBe("deny");
      expect(evaluatePermission(exec(c), [SCRATCH_RULE]).rule, c).not.toBe(SCRATCH_RULE.name);
    }
    for (const c of ["rm -rf /tmp/a 2>/dev/null", "ls /tmp > /tmp/x.log", "rm -rf /tmp/a 2>&1 >/dev/null"]) {
      expect(explainCommand(c).scratch, c).toBeDefined();
      expect(evaluatePermission(exec(c), [SCRATCH_RULE]).rule, c).toBe(SCRATCH_RULE.name);
    }
  });

  it("sends the ticket's own command to the CEO with Allow, its install log not deleted first (adversarial round 14)", () => {
    const own = "rm -rf /tmp/rv86 && git worktree add /tmp/rv86 origin/main && cd /tmp/rv86 && pnpm install > /tmp/rv86-install.log 2>&1";
    for (const c of [
      own,
      "rm -rf /tmp/a /tmp/a.log && ls /tmp > /tmp/a.log 2>&1",
      "rm -rf /tmp/a && ls /tmp > /tmp/a.log 2>&1",
      "rm -rf /tmp/a && cd /tmp/a && pnpm install",
      "rm -rf /tmp/a && cd /tmp/a && pnpm install > /tmp/a.log 2>&1",
    ]) {
      expect(route(c), c).toEqual({ outcome: "ceo", rule: TEMP_CLEANUP_RULE });
      expect(recommendedVerdict(exec(c)), c).toBe("allow");
    }
    expect(explainCommand(own).scratch).toBeUndefined();
    expect(evaluatePermission(exec(own), [SCRATCH_RULE]).rule).toBe(TEMP_CLEANUP_RULE);
    for (const c of [
      "rm -rf /tmp/a && cd /tmp/a && pnpm install > /tmp/a/b.log 2>&1",
      "rm -rf /tmp/a && cd /tmp/a && pnpm install > /home/x 2>&1",
      "rm -rf /tmp/a && ls /tmp > /tmp 2>&1",
      "rm -rf /tmp/a && mkdir /tmp/b",
    ]) {
      expect(tempCleanup(c), c).toBe(false);
      expect(route(c).outcome, c).toBe("owner");
    }
  });

  it("recommends Deny for shred even in /tmp", () => {
    for (const c of ["shred /tmp/a", "shred -u /tmp/a", "rm -rf /tmp/a && shred /tmp/b"]) expect(recommendedVerdict(exec(c)), c).toBe("deny");
    expect(recommendedVerdict(exec("find /tmp/x -delete"))).toBe("allow");
  });

  it("no longer counts git worktree prune as temp cleanup", () => {
    for (const c of ["rm -rf /tmp/rv86 &>/dev/null; git worktree prune", "rm -rf /tmp/wt; git worktree prune; git worktree list"]) {
      expect(tempCleanup(c), c).toBe(false);
      expect(route(c).outcome, c).toBe("owner");
    }
  });

  it("says on the card when a cleanup also runs install scripts or writes the repository", () => {
    const s = explainCommand("rm -rf /tmp/rv86 && git worktree add /tmp/rv86 origin/main && cd /tmp/rv86 && pnpm install > /tmp/rv86.log 2>&1").summary;
    expect(s).toMatch(/writes into the project's repository/);
    expect(s).toMatch(/install scripts/);
    expect(explainCommand("rm -rf /tmp/a").summary).not.toMatch(/install scripts|repository/);
  });
});

describe("temp-file cleanup, round-5 regression pins (BOS-153)", () => {
  const route = (c: string) => evaluatePermission(exec(c), []);

  it("pins the route of a command whose only delete is a /tmp entry (finding 2)", () => {
    // Checked out into the same /tmp entry first, the install log is a plain temp cleanup: CEO first, Allow.
    const c = "rm -rf /tmp/a && mkdir /tmp/a && cd /tmp/a && pnpm install > /tmp/a.log 2>&1";
    expect(route(c)).toEqual({ outcome: "ceo", rule: TEMP_CLEANUP_RULE });
    expect(recommendedVerdict(exec(c))).toBe("allow");
    // Known limit: an install outside the checkout still goes to the owner. It must stay off the CEO route either way.
    const bare = "rm -rf /tmp/a && pnpm install > /tmp/a.log 2>&1";
    expect(route(bare).outcome).toBe("owner");
    expect(tempCleanup(bare)).toBe(false);
  });

  // Fails today: the plan says a command whose only delete is in /tmp is never recommended Deny. The fix is tracked in follow-up ticket cd2c2730 (and BOS-165); remove `.fails` when it lands.
  it.fails("never recommends Deny for an install that logs into /tmp (finding 2, known gap)", () => {
    expect(recommendedVerdict(exec("rm -rf /tmp/a && pnpm install > /tmp/a.log 2>&1"))).not.toBe("deny");
  });

  it("keeps the /tmp-only rule from allowing an install in a temp checkout or git worktree prune (finding 3)", () => {
    for (const c of ["rm -rf /tmp/a && mkdir /tmp/a && cd /tmp/a && npm install", "rm -rf /tmp/a && git worktree prune"]) {
      expect(explainCommand(c).scratch, c).toBeUndefined();
      expect(evaluatePermission(exec(c), [SCRATCH_RULE]).rule, c).not.toBe(SCRATCH_RULE.name);
    }
    expect(tempCleanup("rm -rf /tmp/a && git worktree prune")).toBe(false);
    expect(route("rm -rf /tmp/a && git worktree prune").outcome).toBe("owner");
  });

  it("pins the verdict for shred and find -delete (finding 4)", () => {
    expect(recommendedVerdict(exec("shred /tmp/a"))).toBe("deny");
    expect(recommendedVerdict(exec("find /tmp/x -delete"))).toBe("allow");
  });
});

describe("company rules and Boss Man's own tools (BOS-292)", () => {
  // The live company rule that caught every request from about 01:00 UTC on 1 Nov.
  const toCeo = [{ name: "All agent permission requests go to the CEO first", match: { kinds: ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"] }, outcome: "ceo" as const }];
  const tool = (title: string) => ({ title, kind: "other", rawInput: {} });

  it("a catch-all company rule that routes to the CEO doesn't catch Boss Man's own tools", () => {
    for (const t of ["mcp__bossman__ticket_reply", "mcp__bossman__decisions", "mcp__bossman__set_ticket_state", "mcp__bossman__wiki"]) {
      expect(evaluatePermission(tool(t), toCeo), t).toEqual({ outcome: "allow", rule: "Boss Man's own tools" });
    }
  });

  it("the same company rule still catches other tools and commands", () => {
    expect(evaluatePermission(tool("mcp__other__thing"), toCeo).outcome).toBe("ceo");
    expect(evaluatePermission({ title: "git status", kind: "execute", rawInput: { command: "git status" } }, toCeo).outcome).toBe("ceo");
  });

  it("a company rule can still deny a Boss Man tool", () => {
    const deny = [{ name: "No wiki writes", match: { titlePattern: "^mcp__bossman__wiki$" }, outcome: "deny" as const }];
    expect(evaluatePermission(tool("mcp__bossman__wiki"), deny)).toEqual({ outcome: "deny", rule: "No wiki writes" });
  });

  it("a command titled like a Boss Man tool is still checked as a command (security review)", () => {
    const exec = (cmd: string) => ({ title: cmd, kind: "execute", rawInput: { command: cmd } });
    const cases = [
      exec("bossman_x; rm -rf /srv/precious"),
      exec("bossman.sh && git push --force origin main"),
      exec("Bossman - x; docker system prune -a"),
      // OpenCode-style: an agent-written description as the title, the real command in rawInput.
      { title: "bossman: wiki", kind: "execute", rawInput: { command: "rm -rf /srv/x" } },
      // kind "other" with a command is still a command.
      { title: "bossman_x", kind: "other", rawInput: { command: "rm -rf /srv/x" } },
    ];
    for (const info of cases) {
      expect(isBossmanCall(info), info.title).toBe(false);
      expect(evaluatePermission(info, []).outcome, info.title).toBe("owner");
      expect(evaluatePermission(info, toCeo).outcome, info.title).toBe("ceo");
    }
    // A Boss Man title on an edit, delete, move or fetch isn't a board tool either.
    for (const kind of ["edit", "delete", "move", "fetch"]) expect(isBossmanCall({ title: "mcp__bossman__wiki", kind, rawInput: {} }), kind).toBe(false);
    expect(isBossmanCall(tool("mcp__bossman__wiki"))).toBe(true);
  });

  it("a company allow rule that matches a Boss Man tool is honoured", () => {
    const allow = [{ name: "Wiki is fine", match: { titlePattern: "^mcp__bossman__wiki$" }, outcome: "allow" as const }, ...toCeo];
    expect(evaluatePermission(tool("mcp__bossman__wiki"), allow)).toEqual({ outcome: "allow", rule: "Wiki is fine" });
  });
});
