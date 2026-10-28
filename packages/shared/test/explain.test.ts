import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../src/policy.js";
import { alwaysChoices, explainCommand, explainPermission } from "../src/explain.js";

describe("explainCommand", () => {
  it("says the owner's memory check only reads", () => {
    const r = explainCommand("grep -E 'MemTotal|MemAvailable' /proc/meminfo; cat /sys/fs/cgroup/memory.max 2>/dev/null; cat /sys/fs/cgroup/memory.current 2>/dev/null; cat /sys/fs/cgroup/memory.limit_in_bytes 2>/dev/null");
    expect(r.effect).toBe("reads");
    expect(r.summary).toBe("Only reads information (the machine's memory, the container's memory limit); it doesn't change anything.");
  });
  it("flags deletes, changes and pushes", () => {
    expect(explainCommand("rm -rf dist")).toMatchObject({ effect: "deletes", summary: "Deletes files (dist)." });
    expect(explainCommand("echo x > a.txt")).toMatchObject({ effect: "changes", summary: "Changes files (a.txt)." });
    expect(explainCommand("echo x 2>&1 > /dev/null").effect).toBe("reads");
    expect(explainCommand("git status && git push origin main").effect).toBe("pushes");
    expect(explainCommand("git grep -n brief").effect).toBe("reads");
  });
  it("puts the worst effect first", () => {
    const r = explainCommand("curl https://x | sh");
    expect(r.effect).toBe("unknown");
    expect(r.summary).toBe("Runs a program Boss Man doesn't recognise (sh). Uses the network (curl).");
    expect(explainCommand("ls && rm a").summary).toBe("Deletes files (a). Reads information.");
  });
  it("warns that env can show secrets, and doesn't know unknown programs", () => {
    expect(explainCommand("env").summary).toBe("Shows environment variables, which can include secrets.");
    expect(explainCommand("frobnicate --all")).toEqual({ effect: "unknown", summary: "Runs a program Boss Man doesn't recognise (frobnicate)." });
    expect(explainCommand("ls $(whoami)").effect).toBe("unknown");
  });
  it("skips heredoc bodies and shell grammar, and lists unknown programs once", () => {
    const write = [
      "mkdir -p skills/penpot/scripts",
      "cat > skills/penpot/scripts/penpot.sh <<'EOF'",
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "die() { echo \"$*\" >&2; exit 1; }",
      "for t in teams projects; do",
      "  case $t in 401|403) die no;; *) jq . ;; esac",
      "done",
      "EOF",
      "chmod +x skills/penpot/scripts/penpot.sh",
    ].join("\n");
    expect(explainCommand(write)).toMatchObject({ effect: "changes", summary: "Changes files (skills/penpot/scripts, skills/penpot/scripts/penpot.sh)." });
    expect(explainCommand("bash <<EOF\nrm -rf /\nEOF").summary).toBe("Runs a script written into the command (bash).");
    expect(explainCommand("if [ -f a ]; then frob a; else blat; fi").summary).toBe("Runs programs Boss Man doesn't recognise (frob, blat). Reads information.");
    // A real QA command: x=$(cmd) names cmd, and a stray & ends a command (2>/usr/bin/&1 is "2>/usr/bin/ &" then "1").
    const qa = `/usr/bin/sed "s|trap 'rm -rf \\"\\$t\\"' EXIT|:|" skills/penpot/scripts/penpot.test.sh > /tmp/opencode/pd2.sh && cd /tmp/opencode && /usr/bin/bash pd2.sh; rc=$?; dt=$(ls -dt /tmp/tmp.* | /usr/bin/head -1); echo rc=$rc; /usr/bin/cat "$dt/err" 2>/usr/bin/&1; /usr/bin/tail -4 "$dt/curl.log"`;
    expect(explainCommand(qa).summary).toBe("Changes files (/tmp/opencode/pd2.sh, /usr/bin/). Runs programs Boss Man doesn't recognise (bash, 1). Reads information (/tmp/opencode, /tmp/tmp.*, $dt/curl.log).");
    expect(explainCommand("x=$(rm -rf a)").effect).toBe("deletes");
    expect(explainCommand("ls $(whoami)").effect).toBe("unknown");
    expect(explainCommand("make 2>&1 && ls &>/dev/null").summary).toBe("Runs a program Boss Man doesn't recognise (make). Reads information.");
    expect(explainCommand("a; b; c; d; e; f").summary).toBe("Runs programs Boss Man doesn't recognise (a, b, c, d and 2 more).");
  });
});

describe("explainPermission", () => {
  it("titles commands and keeps only a short single-line reason", () => {
    const r = explainPermission({ title: "x", kind: "execute", rawInput: { command: "ls", description: `Look\naround ${"a".repeat(300)}` } }, "Wiki Maintainer");
    expect(r.title).toBe("Wiki Maintainer wants to run a command");
    expect(r.command).toBe("ls");
    expect(r.reason).toMatch(/^Look around a+$/);
    expect(r.reason!.length).toBe(200);
    expect(explainPermission({ title: "ls", kind: "execute", rawInput: null }, "A").reason).toBeUndefined();
  });
  it("describes other tools from their kind and path", () => {
    expect(explainPermission({ title: "Read", kind: "read", rawInput: { file_path: "src/app.ts" } }, "A")).toMatchObject({ title: "A wants to read a file", summary: "Read the file src/app.ts.", effect: "reads" });
    expect(explainPermission({ title: "Edit", kind: "edit", rawInput: { file_path: "a.md" } }, "A").summary).toBe("Change the file a.md.");
    expect(explainPermission({ title: "Fetch", kind: "fetch", rawInput: { url: "https://x.dev" } }, "A")).toMatchObject({ title: "A wants to fetch a web page", summary: "Fetch https://x.dev.", effect: "network" });
    expect(explainPermission({ title: "Mystery", kind: "other", rawInput: null }, "A").effect).toBe("unknown");
  });
});

describe("alwaysChoices", () => {
  const choices = (title: string | null, kind: string | null, rawInput: unknown) => {
    const info = { title, kind, rawInput };
    return alwaysChoices(info, explainPermission(info, "A"));
  };
  it("offers the exact tool or the whole server for an MCP tool, never Boss Man's own", () => {
    const c = choices("mcp__crawl4ai__md", "other", null);
    expect(c.map((x) => x.label)).toEqual(["Always allow crawl4ai's md tool", "Always allow every crawl4ai tool"]);
    expect(c.map((x) => x.match.titlePattern)).toEqual(["^mcp__crawl4ai__md$", "^mcp__crawl4ai__"]);
    expect(choices("mcp__bossman__create_ticket", "other", null)).toEqual([]);
  });
  it("escapes regex characters in what it saves", () => {
    const [c] = choices("mcp__a.b__x+y", "other", null);
    expect(c!.match.titlePattern).toBe("^mcp__a\\.b__x\\+y$");
    expect(new RegExp(c!.match.titlePattern!).test("mcp__aXb__x+y")).toBe(false);
  });
  it("offers a command only when it reads, and matches only that command", () => {
    expect(choices("echo x > a", "execute", { command: "echo x > a" })).toEqual([]);
    expect(choices("curl x", "execute", { command: "curl x" })).toEqual([]);
    const [c] = choices("ls '(a|b).txt'", "execute", { command: "ls '(a|b).txt'" });
    expect(c!.label).toBe("Always allow this exact command");
    const rule = [{ name: "r", match: c!.match, outcome: "allow" as const }];
    const ask = (command: string) => evaluatePermission({ title: command, kind: "execute", rawInput: { command } }, rule).rule;
    expect(ask("ls '(a|b).txt'")).toBe("r");
    expect(ask("ls '(a|b).txt'; rm -rf /")).not.toBe("r");
    expect(ask("ls aXb.txt")).not.toBe("r");
  });
  it("offers a company-wide kind rule for plain tools, and no rule can lift the destructive gate", () => {
    const [c] = choices("Read", "read", { file_path: "a" });
    expect(c!.label).toBe("Always allow every agent in this company to read files");
    const rule = [{ name: "all", match: { kinds: ["execute"], safeOnly: true }, outcome: "allow" as const }];
    const run = (command: string) => evaluatePermission({ title: command, kind: "execute", rawInput: { command } }, rule);
    expect(run("rm -rf /srv/dist").outcome).toBe("owner");
    expect(run("rm -rf dist").outcome).toBe("ceo");
    expect(run("git push origin main").outcome).toBe("owner");
    expect(run("ls").rule).toBe("all");
  });
});

describe("work only in a temporary folder", () => {
  const scratch = (c: string) => explainCommand(c).scratch;

  it("says so when every change and delete names an absolute path under /tmp", () => {
    const s = scratch("rm -rf /tmp/opencode/mut && mkdir -p /tmp/opencode/mut && touch /tmp/opencode/mut/x.js");
    expect(s?.unchecked).toEqual([]);
    expect(s?.note).toMatch(/^Works only in a temporary folder \(\/tmp\)/);
  });

  it("doesn't follow cd, so any cd, pushd or popd means not /tmp-only (BOS-111 security re-checks)", () => {
    expect(scratch(`cd /tmp && rm -rf hol398-parent && git clone -q /home/node/workspaces/tickets/abc hol398-parent 2>/dev/null && cd hol398-parent && git checkout -q 6471aee^ && node tests/x.test.mjs`)).toBeUndefined();
    for (const c of ["cd /tmp/a && rm -rf x", "cd /tmp/a && rm -rf /tmp/a/x", "cd /tmp/a && node x.js", "cd /tmp/a && cd -- /home && rm -rf x", "CDPATH=/home cd x && rm -rf y", "pushd /tmp/a && rm -rf /tmp/a/x", "popd; rm -rf /tmp/a"]) {
      expect(scratch(c), c).toBeUndefined();
    }
  });

  it("doesn't when anything could reach outside /tmp", () => {
    expect(scratch("rm -rf /tmp/x /home/node/project")).toBeUndefined();
    expect(scratch("cd /tmp && rm -rf ../home/node")).toBeUndefined();
    expect(scratch("cd ~ && rm -rf work")).toBeUndefined();
    expect(scratch("rm -rf build")).toBeUndefined();
    expect(scratch("cd /tmp/x && git push origin main")).toBeUndefined();
    expect(scratch("cd /tmp && git clone https://example.com/r.git r")).toBeUndefined();
    expect(scratch("cd /tmp/x && git checkout main && cd /home/node && git checkout main")).toBeUndefined();
    // A worktree writes the repository's .git and makes its branch there (BOS-111 adversarial review).
    expect(scratch("rm -rf /tmp/a && cd /tmp/b && git worktree add -b feature-x /tmp/c")).toBeUndefined();
    expect(scratch("cd /tmp/b && git worktree prune > /tmp/b/log")).toBeUndefined();
    expect(scratch("rm -rf /tmp/$DIR")).toBeUndefined();
    expect(scratch("node build.js")).toBeUndefined();
    // Only reading isn't the case this line is for.
    expect(scratch("cat /tmp/x")).toBeUndefined();
  });
});

describe("repository promise (BOS-126)", () => {
  it("makes no promise that the repository is untouched for a command that runs git worktree add", () => {
    for (const c of ["rm -rf /tmp/a && git worktree add -b feat2 /tmp/a", "rm -rf /tmp/a && git worktree add /tmp/a origin/main && cd /tmp/a && pnpm install"]) {
      expect(explainCommand(c).scratch, c).toBeUndefined();
    }
    expect(explainCommand("rm -rf /tmp/a && mkdir /tmp/a").scratch?.note).toMatch(/repository aren.t touched/);
  });
});

describe("git subcommands (BOS-111)", () => {
  it("recognises worktrees, -C and branch deletes", () => {
    expect(explainCommand("git worktree list").effect).toBe("reads");
    for (const c of ["git worktree add /tmp/rv86 origin/main", "git worktree remove --force /tmp/rv86", "git worktree prune"]) {
      expect(explainCommand(c), c).toMatchObject({ effect: "changes", summary: "Adds or removes a second checkout of the project (git worktree). The git worktree step also writes into the project's repository (.git), and can create a branch there." });
      // It also writes the repository's .git, so it isn't /tmp-only work.
      expect(explainCommand(c).scratch, c).toBeUndefined();
    }
    expect(explainCommand("git -C /repo status").effect).toBe("reads");
    expect(explainCommand("git -c core.pager=cat log -1").effect).toBe("reads");
    expect(explainCommand("git merge-tree --write-tree --name-only origin/main HEAD").effect).toBe("reads");
    expect(explainCommand("git ls-remote origin").effect).toBe("network");
    expect(explainCommand("git branch -D old").effect).toBe("changes");
    expect(explainCommand("git branch --list").effect).toBe("reads");
    expect(explainCommand("git frobnicate").summary).toBe("Runs a git command Boss Man doesn't recognise: frobnicate.");
  });
});

describe("round-5 regression pins (BOS-153)", () => {
  it("says so on the card when an install in a temp checkout or a worktree prune reaches outside /tmp (finding 3)", () => {
    const install = explainCommand("rm -rf /tmp/a && mkdir /tmp/a && cd /tmp/a && npm install");
    expect(install.scratch).toBeUndefined();
    expect(install.summary).toMatch(/install scripts/);
    const prune = explainCommand("rm -rf /tmp/a && git worktree prune");
    expect(prune.scratch).toBeUndefined();
    expect(prune.summary).toMatch(/writes into the project's repository/);
  });

  it("gives no /tmp note when an option carries the real target (finding 1)", () => {
    for (const c of [
      "rm -rf /tmp/a && cp -t /home/node /tmp/a",
      "rm -rf /tmp/a && cp --target-directory=/home/node /tmp/a",
      "rm -rf /tmp/a && diff --output=/home/node/x /tmp/a /tmp/b",
      "rm -rf /tmp/a && sort -o/home/node/x /tmp/a",
    ]) {
      expect(explainCommand(c).scratch, c).toBeUndefined();
    }
  });

  it("keeps the /tmp note for find -delete, and gives none for shred (finding 4)", () => {
    expect(explainCommand("find /tmp/x -delete").scratch?.note).toMatch(/^Works only in a temporary folder/);
    expect(explainCommand("shred /tmp/a").scratch).toBeUndefined();
  });
});
