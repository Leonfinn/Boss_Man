import { describe, expect, it } from "vitest";
import { evaluatePermission } from "../src/policy.js";
import { alwaysChoices, explainCommand, explainPermission, ownerWhy, readPush, removesReservedTmpEntry } from "../src/explain.js";

describe("ownerWhy (BOS-793)", () => {
  it("names the part the destructive-command guard caught", () => {
    const w = ownerWhy("rm -rf $W/old && $W/bin/pg_dump db > $W/out.sql", "Destructive commands go to the owner");
    expect(w).toMatch(/^Sent to you, not the CEO, because the destructive-command guard caught part of it/);
    expect(w).toContain("rm -rf");
  });
  it("says a push is a push, and names a company rule", () => {
    expect(ownerWhy("git push origin main", "Pushing and publishing go to the owner")).toMatch(/pushes to a remote/);
    expect(ownerWhy("ls", "Ask me about ls")).toBe(`Sent to you, not the CEO, because the rule "Ask me about ls" sends it to you.`);
  });
});

describe("$BOSSMAN_SCRATCH script path (BOS-1454)", () => {
  it("gives no owner reason for node $BOSSMAN_SCRATCH/x.mjs, and still gives one for node $S/x.mjs", () => {
    const rule = "Destructive commands go to the owner";
    expect(ownerWhy("node $BOSSMAN_SCRATCH/x.mjs", rule)).not.toMatch(/destructive-command guard caught/);
    expect(ownerWhy("node $S/x.mjs", rule)).toMatch(/destructive-command guard caught/);
  });
});

describe("agent-browser test commands (BOS-752)", () => {
  const S = "/home/node/workspaces/scratch/abc";
  const shapes = [
    `cd ${S} && A=t1 && agent-browser --session $A open http://web:3000`,
    `agent-browser --session "$A" eval "document.querySelector('h1').innerText"`,
    `agent-browser \\\n  --session $A \\\n  get text "heading Hello world"`,
    `agent-browser --session $A snapshot -i\nagent-browser --session $A click "heading Sign in"`,
    `agent-browser --session $A eval "JSON.stringify(document.querySelector(\\"h1\\").textContent) // heading"`,
    `A=t1; agent-browser --session=$A screenshot ${S}/shot.png`,
  ];
  it("never reads a flag, a variable or quoted text as a program, and knows agent-browser", () => {
    for (const c of shapes) {
      const e = explainCommand(c);
      expect(e.summary, c).not.toMatch(/doesn't recognise/);
      expect(e.effect, c).toBe("network");
    }
  });
  it("a continuation fragment that starts with a flag or variable is not a program name", () => {
    for (const c of ["--session $A", "$A open x", 'heading"']) {
      expect(explainCommand(c).summary, c).not.toMatch(/\((?:[^)]*[$"-])/);
    }
  });
});

describe("readPush", () => {
  const ticket = "11111111-2222-4333-8444-555555555555";

  it("names a ticket branch, and other branches plainly", () => {
    expect(readPush(`git push origin bossman/${ticket}`)).toMatchObject({ kind: "ticket", headline: "Pushes to its ticket branch", ticketId: ticket, warnings: [], dangerous: false });
    expect(readPush("git push origin feature/login")).toMatchObject({ kind: "branch", headline: "Pushes to feature/login", dangerous: false });
    expect(readPush("git push --repo=origin feature/login")).toMatchObject({ kind: "branch", headline: "Pushes to feature/login" });
    expect(readPush(`git push origin HEAD:refs/heads/bossman/${ticket}`)).toMatchObject({ kind: "ticket", ticketId: ticket });
    expect(readPush("git -C x status")).toBeNull();
    expect(readPush(`git commit -m "explain git push origin main"`)).toBeNull();
  });

  it("flags main wherever it is written", () => {
    for (const c of ["git push origin main", "git push origin HEAD:main", "git push origin HEAD:refs/heads/main"]) {
      const r = readPush(c);
      expect(r?.dangerous, c).toBe(true);
      expect(r?.warnings.join(" "), c).toContain("Pushes to main");
    }
  });

  it("flags force, delete, every branch/tag, and more than one branch", () => {
    for (const c of ["git push --force origin x", "git push -f origin x", "git push --force-with-lease origin x", "git push origin +x"]) {
      expect(readPush(c)?.warnings.join(" "), c).toContain("Force push");
      expect(readPush(c)?.dangerous, c).toBe(true);
    }
    for (const c of ["git push --delete origin x", "git push -d origin x", "git push origin :x"]) {
      expect(readPush(c)?.warnings.join(" "), c).toContain("Deletes a branch");
      expect(readPush(c)?.dangerous, c).toBe(true);
    }
    for (const c of ["git push --all origin", "git push --mirror origin", "git push --tags origin"]) {
      expect(readPush(c)?.dangerous, c).toBe(true);
    }
    expect(readPush("git push origin main feature")).toMatchObject({ kind: "many", dangerous: true });
    expect(readPush("git push origin main feature")?.warnings.join(" ")).toContain("more than one branch");
  });

  it("flags a push that doesn't name the branch", () => {
    for (const c of ["git push", "git push origin", "git push origin HEAD"]) {
      const r = readPush(c);
      expect(r?.kind, c).toBe("unnamed");
      expect(r?.warnings.join(" "), c).toContain("Branch not named: may push to main");
      expect(r?.dangerous, c).toBe(true);
    }
  });

  it("never calls a form it can't read safe", () => {
    for (const c of [
      "git status && git push origin main",
      "git push origin main; rm -rf /",
      "git push origin main | tee /tmp/log",
      "git push origin main > /tmp/log",
      "sudo git push origin main",
      "git push origin $(cat branch)",
      "git push --receive-pack=evil origin main",
      "git push 'origin' main",
      "git push origin main && git push origin main",
    ]) {
      expect(readPush(c), c).toMatchObject({ kind: "unreadable", headline: "Couldn't read this push, check the exact command", dangerous: true });
    }
  });

  it("does not call a delete of its own ticket branch safe", () => {
    expect(readPush(`git push origin :bossman/${ticket}`)).toMatchObject({ kind: "branch", headline: "Deletes a branch on the remote", dangerous: true });
    expect(readPush("git push origin +main")?.dangerous).toBe(true);
    expect(readPush("git push --mirror origin")?.dangerous).toBe(true);
  });
});

describe("do-nothing sed -i (BOS-680)", () => {
  it("reads sed -i on /dev/null or with no file as changing nothing", () => {
    expect(explainCommand("sed -i 's/a/b/' /dev/null; git status").effect).toBe("reads");
    expect(explainCommand("sed -i 's/a/b/'").effect).toBe("reads");
  });
  it("keeps the edit for w/e scripts, -f and real files", () => {
    for (const c of ["sed -i 's/a/b/w out' /dev/null", "sed -i 's/a/b/e' /dev/null", "sed -i -f s.sed /dev/null", "sed -i 's/a/b/' /dev/null x.txt", "sed -i 's/a/b/' x.txt"]) expect(explainCommand(c).effect).toBe("changes");
  });
});

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
  it("names the file in OpenCode's edit requests (BOS-318)", () => {
    // OpenCode sends its permission metadata as rawInput: { filepath, diff } for an edit, { files: [...] } for a patch.
    expect(explainPermission({ title: "edit", kind: "edit", rawInput: { filepath: "/work/src/a.ts", diff: "@@" } }, "A").summary).toBe("Change the file /work/src/a.ts.");
    expect(explainPermission({ title: "edit", kind: "edit", rawInput: { files: [{ filePath: "/work/a.ts", relativePath: "a.ts" }] } }, "A").summary).toBe("Change the file a.ts.");
    expect(explainPermission({ title: "edit", kind: "edit", rawInput: { files: [{ filePath: "/w/a.ts" }, { filePath: "/w/b.ts" }] } }, "A").summary).toBe("Change 2 files: /w/a.ts, /w/b.ts.");
    expect(explainPermission({ title: "edit", kind: "edit", rawInput: {} }, "A").summary).toBe("Change (no name given).");
  });

  it("keeps the tool name when an mcp tool is given a parentDir argument (BOS-318)", () => {
    const e = explainPermission({ title: "mcp__github__delete_repository", kind: "other", rawInput: { owner: "o", repo: "r", parentDir: "/tmp/screens" } }, "A");
    expect(e.summary).toContain("mcp__github__delete_repository");
    expect(e.summary).not.toContain("folder outside");
    expect(explainPermission({ title: "/etc", kind: "other", rawInput: { parentDir: "/tmp/x" } }, "A").summary).not.toContain("folder outside");
  });

  it("shows OpenCode's external_directory request as a folder outside the checkout (BOS-318)", () => {
    expect(explainPermission({ title: "/tmp/opencode/shots", kind: "other", rawInput: { filepath: "/tmp/opencode/shots/a.png", parentDir: "/tmp/opencode/shots" } }, "A").summary).toBe("Access folder outside checkout: /tmp/opencode/shots.");
    expect(explainPermission({ title: "/tmp/opencode/shots", kind: "other", rawInput: {} }, "A").summary).toBe("Access folder outside checkout: /tmp/opencode/shots.");
    expect(explainPermission({ title: "/tmp/x", kind: "other", rawInput: {} }, "A").effect).toBe("unknown");
  });

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
    expect(explainPermission({ title: "Mystery", kind: "other", rawInput: null }, "A").summary).not.toMatch(/Warning/);
    const copy = explainPermission({ title: "mcp__bossrnan__wiki", kind: "other", rawInput: null }, "A");
    expect(copy.summary).toMatch(/doesn't recognise\. Warning: this name looks like one of Boss Man's own tools/);
  });
});

describe("alwaysChoices", () => {
  const choices = (title: string | null, kind: string | null, rawInput: unknown) => {
    const info = { title, kind, rawInput };
    return alwaysChoices(info, explainPermission(info, "A"));
  };
  it("offers only the exact tool for an MCP tool, never Boss Man's own", () => {
    const c = choices("mcp__crawl4ai__md", "other", null);
    expect(c.map((x) => x.label)).toEqual(["Always allow crawl4ai's md tool"]);
    expect(c.map((x) => x.match.titlePattern)).toEqual(["^mcp__crawl4ai__md$"]);
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
  it("offers no Always choice for file reads or edits (any path, secrets included), and no rule can lift the destructive gate", () => {
    expect(choices("Read", "read", { file_path: "a" })).toEqual([]);
    expect(choices("Read", "read", { file_path: "/root/.ssh/id_rsa" })).toEqual([]);
    expect(choices("Edit", "edit", { file_path: "/etc/passwd" })).toEqual([]);
    expect(choices("WebFetch", "fetch", { url: "https://x.dev" })).toEqual([]);
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
    const s = scratch("rm -rf /tmp/mut && mkdir -p /tmp/mut");
    expect(s?.unchecked).toEqual([]);
    expect(s?.note).toMatch(/^Works only in a temporary folder \(\/tmp\)/);
    // BOS-165: touch follows a link at its target, and a deeper path is never vouched for.
    expect(scratch("rm -rf /tmp/mut && mkdir -p /tmp/mut && touch /tmp/mut/x.js"), "touch at a /tmp path").toBeUndefined();
    expect(scratch("rm -rf /tmp/opencode/mut && mkdir -p /tmp/opencode/mut"), "deeper path").toBeUndefined();
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

describe("removesReservedTmpEntry (BOS-1948)", () => {
  const removes = (c: string) => removesReservedTmpEntry(c);

  it("matches a plain remove of a reserved /tmp entry, whatever the flags or quoting", () => {
    for (const c of [
      "rm /tmp/bossman-check-all.slot.1",
      "rm -rf /tmp/bossman-x",
      "rm -f -- /tmp/bossman-x",
      "rm -f '/tmp/bm-tmp'",
      'rm "/tmp/claude-0"',
      "/bin/rm -rf /tmp/guard-123",
      "rmdir /tmp/tmp.abc123",
      "unlink /tmp/.X11-unix",
      "rm -rf /tmp/BOSSMAN-x",
      "rm -rf $TMPDIR/bossman-x",
    ]) {
      expect(removes(c), c).toBe(true);
    }
  });

  it("still matches a bare reserved name after cd or pushd into /tmp", () => {
    expect(removes("cd /tmp && rm -rf bossman-x")).toBe(true);
    expect(removes("pushd /tmp; rm bossman-x")).toBe(true);
  });

  it("does not match an ordinary remove of a path that is not reserved", () => {
    for (const c of [
      "rm -rf dist",
      "rm /tmp/report.log",
      "rm -rf /tmp/boss-man",
      "rm -rf /tmp/my-bossman-notes",
      "rmdir /tmp/scratch-dir",
      "unlink /tmp/socket.sock",
      "cd /tmp && rm -rf report.log",
      "find /tmp/report -type f | xargs rm",
    ]) {
      expect(removes(c), c).toBe(false);
    }
  });

  it("does not match a read-only command that only mentions a reserved path", () => {
    for (const c of ["ls -la /tmp/bossman-x", "cat /tmp/claude-0/log", "grep -r foo /tmp/bossman-check-all.slot.1", "stat /tmp/bm-tmp"]) {
      expect(removes(c), c).toBe(false);
    }
  });

  it("fails closed on a glob, variable, xargs or bare name that could name a reserved entry", () => {
    for (const c of [
      "rm -rf /tmp/boss*",
      "rm -rf /tmp/$DIR",
      "find /tmp/bossman-x -type f | xargs rm",
      "ls /tmp/bossman-x; rm -rf $DIR",
    ]) {
      expect(removes(c), c).toBe(true);
    }
    // Without a cd into /tmp a bare name is only a name in the current folder.
    expect(removes("rm bossman-x")).toBe(false);
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

  it("gives no /tmp note to find -delete (BOS-165: its root or entries can be links) or shred (finding 4)", () => {
    expect(explainCommand("find /tmp/x -delete").scratch).toBeUndefined();
    expect(explainCommand("shred /tmp/a").scratch).toBeUndefined();
    expect(explainCommand("rm -rf /tmp/a").scratch?.note).toMatch(/^Works only in a temporary folder/);
  });
});
