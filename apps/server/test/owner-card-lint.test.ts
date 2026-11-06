import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { checkAsk } from "../src/services/decisions.js";
import { lintOwnerSteps, sh, step, type CardLint } from "../src/services/steps.js";

// The owner-step lint (BOS-417, DR-008 Q1): cards with steps for the owner are checked when they are raised.

const TRIED = "Checked the host from the runner; agents have no access to the owner's machine.";
const rules = (steps: string[]) => lintOwnerSteps(steps).refuse.map((f) => `${f.step}:${f.rule}`);
/** Every command block says where and as whom (BOS-427, R6); these tests are about the other rules. */
const H = { host: "nas01", as: "root" as const };

describe("lintOwnerSteps", () => {
  it("refuses a step that points to another document (the 14:45 card)", () => {
    expect(rules(["Follow docs/06 with changes for the new host."])).toEqual(["1:R1"]);
    for (const s of ["See the install guide for the folder.", "The folder is in docs/06-install-truenas.md.", "Do it as before.", "Repeat step 3 of the move runbook.", "Use the commands on the previous card.", "Follow [[engineering/move]]."])
      expect(rules([s]), s).toContain("1:R1");
  });

  it("refuses a variable no step up to there sets (the $BOSSMAN_HOME card)", () => {
    expect(rules([step("Go to the install folder:", sh("cd $BOSSMAN_HOME", H))])).toEqual(["1:R2"]);
    expect(rules([step("Go there:", sh("cd ${BOSSMAN_HOME}/src", H))])).toEqual(["1:R2"]);
    // Unfenced, in a sentence, it is still a command the owner will paste.
    expect(rules(["Run sudo ls $BOSSMAN_HOME on the new host."])).toEqual(["1:R2"]);
    // Set later is set too late.
    expect(rules([step("Go:", sh("cd $DIR", H)), step("Set it:", sh("DIR=/srv/bm", H))])).toEqual(["1:R2"]);
  });

  it("accepts variables the card sets, inline assignments, and shell text that isn't a variable", () => {
    const ok = [
      step("Set the folder:", sh("export DIR=/srv/bm", H)),
      step("Go there:", sh("cd $DIR/src && ls", H)),
      step("Build with a flag set just for this command:", sh("DOCKER_BUILDKIT=1 docker compose build", H)),
      step("Same command, inline:", sh("COMPOSE_FILE=a.yml docker compose ps && echo $COMPOSE_FILE", H)),
      step("Print the second column:", sh("docker ps | awk '{print $2}'", H)),
      step("Count:", sh("for f in a b; do echo $f; done", H)),
      step("Show home, the exit code and a default:", sh('echo "$HOME $? ${PORT:-3100} $(date) $1"', H)),
      step("Ask for it:", sh("read -r NAME && echo $NAME", H)),
      "Open Settings → Server and runner → Updates and press Build and update runners. It costs $5 a month.",
      "Follow the instructions on the screen to sign in.",
    ];
    expect(lintOwnerSteps(ok).refuse).toEqual([]);
  });

  it("refuses a command the owner would have to edit, and an unfilled {{token}}", () => {
    const F = '```sh host="nas01" as="root"\n';
    expect(rules([`Run this:\n\n${F}ssh root@<host-ip>\n\`\`\``])).toEqual(["1:R3"]);
    expect(rules(["Run `scp YOUR_KEY root@nas:/x` on the old host."])).toEqual(["1:R3"]);
    expect(rules([`Run this:\n\n${F}$ ls\n\`\`\``])).toEqual(["1:R3"]);
    expect(rules([`Go there:\n\n${F}cd {{host.srcDir}}\n\`\`\``])).toEqual(["1:R4"]);
  });

  it("only warns about links, several commands in one step, hedging and long cards", () => {
    const r = lintOwnerSteps([
      "Background is on BOS-276; open Settings → Server and runner.",
      step("Check it:", sh("docker ps", H), "Then:", sh("docker logs server-blue", H)),
      step("It should be green by now:", sh("docker ps", H)),
    ]);
    expect(r.refuse).toEqual([]);
    expect(r.warn.map((f) => f.step)).toEqual([1, 2, 3]);
    expect(lintOwnerSteps(Array.from({ length: 13 }, () => "Open Settings.")).warn).toHaveLength(1);
  });
});

describe("R6: where a command runs and as whom (BOS-427)", () => {
  const HOSTS = [
    {
      name: "nas01",
      ownership: [
        { path: "/mnt/bm", owner: "root", group: "root", mode: "755" },
        { path: "/mnt/backups", owner: "root", group: "root", mode: "700" },
        { path: "/mnt/bm/data", owner: "1000", group: "1000", mode: "700" },
      ],
    },
  ];
  const refuse = (steps: string[]) => lintOwnerSteps(steps, HOSTS).refuse.filter((f) => f.rule === "R6");
  const warn = (steps: string[]) => lintOwnerSteps(steps, HOSTS).warn;

  it("refuses a block that names neither host nor account (older cards), even when no host is recorded yet", () => {
    // checkAsk always passes the recorded hosts (an empty array when none is recorded yet), so the presence
    // check runs there; passing no facts at all is a caller that only wanted another rule, and skips R6.
    const f = lintOwnerSteps([step("Go:", sh("cd /mnt/bm/src"))], []).refuse.filter((x) => x.rule === "R6");
    expect(f).toHaveLength(1);
    expect(f[0]!.problem).toMatch(/doesn't say where it runs/);
    // The same card with a host and account passes.
    expect(refuse([step("Go:", sh("cd /mnt/bm/src", { host: "nas01", as: "root" }))])).toEqual([]);
  });

  it("warns, not refuses, on a host Boss Man hasn't recorded, and asks the card to start with a read-only check", () => {
    const f = lintOwnerSteps([step("Go:", sh("cd /mnt/bm", { host: "orange", as: "root" }))], HOSTS);
    expect(f.refuse.filter((x) => x.rule === "R6")).toEqual([]);
    expect(f.warn.some((x) => /hasn't recorded/.test(x.problem))).toBe(true);
  });

  it("refuses a login-run block that reads a folder the login can't read, and passes it once an earlier block staged a copy", () => {
    const read = step("Open the backups folder:", sh("ls -l /mnt/backups", { host: "nas01", as: "login" }));
    const f = refuse([read]);
    expect(f).toHaveLength(1);
    expect(f[0]!.problem).toMatch(/runs as the login on nas01 and reads \/mnt\/backups, which the login can't read/);
    // A root block can read it.
    expect(refuse([step("Open the backups folder:", sh("ls -l /mnt/backups", { host: "nas01", as: "root" }))])).toEqual([]);
    // A sudo command inside a login block reads as root, so it is allowed.
    expect(refuse([step("Look, using sudo:", sh("sudo ls -l /mnt/backups", { host: "nas01", as: "login" }))])).toEqual([]);
    // An earlier step makes a copy for the login (world-unreadable, but readable by its owner), and the listing passes.
    const staged = [step("Copy the backup for your account:", sh("sudo install -o leon -m 700 -D /mnt/backups/bossman.sql.gz /mnt/bm/mine.sql.gz", { host: "nas01", as: "root" })), step("Read your copy:", sh("cat /mnt/bm/mine.sql.gz", { host: "nas01", as: "login" }))];
    expect(refuse(staged)).toEqual([]);
    // The copy has to land in the folder that was opened; a copy elsewhere doesn't make the backups readable.
    const elsewhere = [step("Copy it:", sh("sudo install -o leon -m 700 -D /mnt/backups/bossman.sql.gz /tmp/x", { host: "nas01", as: "root" })), step("Read the backups:", sh("ls /mnt/backups", { host: "nas01", as: "login" }))];
    expect(refuse(elsewhere)).toHaveLength(1);
  });

  it("refuses a login-run copy whose source the login can't read, and doesn't let it unlock a later read", () => {
    const L = { host: "nas01", as: "login" as const };
    // cp/rsync read their source: a login copy out of the root-only backups folder is refused, whether the
    // destination is relative (which the path reader can't place) or an absolute unrecorded path.
    expect(refuse([step("Copy it home:", sh("cp /mnt/backups/bossman.sql.gz ./mine.sql.gz", L))])).toHaveLength(1);
    expect(refuse([step("Copy it home:", sh("cp /mnt/backups/bossman.sql.gz ~/x", L))])).toHaveLength(1);
    expect(refuse([step("Copy it out:", sh("cp -a /mnt/backups/bossman.sql.gz /tmp/x", L))])).toHaveLength(1);
    // The failed copy must not mark the backups folder readable: a later login listing is still refused.
    const failed = [step("Copy it home:", sh("cp /mnt/backups/bossman.sql.gz ./mine.sql.gz", L)), step("Look again:", sh("ls -l /mnt/backups", L))];
    expect(refuse(failed)).toHaveLength(2);
    // A login copy from a folder it can read is allowed, and stages a copy in the destination folder.
    const good = [step("Copy it:", sh("cp /mnt/bm/data/x /mnt/bm/mine.sql.gz", L)), step("Read it:", sh("cat /mnt/bm/mine.sql.gz", L))];
    expect(refuse(good)).toEqual([]);
    // A copy that stays root's (`install -o root`) stages nothing, so a later login read of the root-only folder is still refused.
    const rootCopy = [step("Copy it:", sh("sudo install -o root -m 700 -D /mnt/backups/x /mnt/backups/y", { host: "nas01", as: "root" })), step("Read it:", sh("cat /mnt/backups/y", L))];
    expect(refuse(rootCopy)).toHaveLength(1);
  });

  it("does not refuse a folder an ordinary account owns when the host hasn't recorded the login", () => {
    // The deployer doesn't write the login yet, so when it's unknown a 700 folder owned by uid 1000 could be the
    // login's own home: R6 lets it through rather than guess wrong. A root-owned 700 folder is still refused.
    const NO_LOGIN = [{ name: "nas01", ownership: [{ path: "/home/leon", owner: "1000", group: "1000", mode: "700" }, { path: "/mnt/backups", owner: "root", group: "root", mode: "700" }] }];
    const f = (steps: string[]) => lintOwnerSteps(steps, NO_LOGIN).refuse.filter((x) => x.rule === "R6");
    expect(f([step("Look:", sh("ls /home/leon", { host: "nas01", as: "login" }))])).toEqual([]);
    expect(f([step("Look:", sh("ls /mnt/backups", { host: "nas01", as: "login" }))])).toHaveLength(1);
  });

  it("never makes backups world-readable", () => {
    expect(refuse([step("Make it readable:", sh("chmod 755 /mnt/backups", { host: "nas01", as: "root" }))])).toHaveLength(1);
    expect(refuse([step("Copy it in readable:", sh("install -m 644 /mnt/bm/x /mnt/backups/x", { host: "nas01", as: "root" }))])).toHaveLength(1);
    // A mode that keeps it closed passes.
    expect(refuse([step("Keep it closed:", sh("chmod 700 /mnt/backups", { host: "nas01", as: "root" }))])).toEqual([]);
  });

  it("recognises a private folder by its role, not its name (BOS-541: backups live in the install folder)", () => {
    const ROLES = [
      {
        name: "nas01",
        ownership: [
          { path: "/mnt/bm", owner: "root", group: "root", mode: "700", role: "backups" as const },
          { path: "/mnt/bm/deployer", owner: "root", group: "root", mode: "755", role: "deployer" as const },
          { path: "/srv/boss-man/data", owner: "1000", group: "1000", mode: "700", role: "data" as const },
        ],
      },
    ];
    const f = (steps: string[]) => lintOwnerSteps(steps, ROLES).refuse.filter((x) => x.rule === "R6");
    // The install folder, recorded as holding the backups, is refused however it is named.
    expect(f([step("Open it up:", sh("chmod -R o+r /mnt/bm", { host: "nas01", as: "root" }))])).toHaveLength(1);
    expect(f([step("Open it up:", sh("chmod 755 -R /mnt/bm", { host: "nas01", as: "root" }))])).toHaveLength(1);
    expect(f([step("Copy in:", sh("install -m 644 /mnt/bm/deployer/x /mnt/bm/x", { host: "nas01", as: "root" }))])).toHaveLength(1);
    // The database's files are private too.
    expect(f([step("Open it up:", sh("chmod 755 /srv/boss-man/data", { host: "nas01", as: "root" }))])).toHaveLength(1);
    // The deployer folder alone is not private by role: only the roles the owner wants shut are refused.
    expect(f([step("List it:", sh("chmod 755 /mnt/bm/deployer", { host: "nas01", as: "root" }))])).toEqual([]);
  });

  it("refuses a copy of a private folder's file left open to everyone, even to an unrecorded destination (BOS-541)", () => {
    const ROLES = [{ name: "nas01", ownership: [{ path: "/mnt/bm", owner: "root", group: "root", mode: "700", role: "backups" as const }] }];
    const f = (steps: string[]) => lintOwnerSteps(steps, ROLES).refuse.filter((x) => x.rule === "R6");
    // The review's case: a world-readable copy staged at the owner's home, which has no recorded ownership.
    expect(f([step("Copy it home:", sh("sudo install -o leon -m 644 /mnt/bm/bossman-db.sql.gz /home/leon/", { host: "nas01", as: "root" }))])).toHaveLength(1);
    // A copy by root with NO mode keeps the source's 700 (cp keeps the mode), so it is closed.
    expect(f([step("Copy it:", sh("cp /mnt/bm/bossman-db.sql.gz /tmp/db.sql.gz", { host: "nas01", as: "root" }))])).toEqual([]);
    // A login copy out of a 700 root folder can't read the source, so that is refused by the read check already.
    expect(f([step("Copy it:", sh("cp /mnt/bm/bossman-db.sql.gz /tmp/db.sql.gz", { host: "nas01", as: "login" }))])).toHaveLength(1);
    // A relative destination is still a copy of a backup: the source decides, not where it lands.
    expect(f([step("Copy it:", sh("cp /mnt/bm/bossman-db.sql.gz ./db.sql.gz", { host: "nas01", as: "root" }))])).toEqual([]);
    // A closed copy passes, at a recorded or unrecorded destination.
    expect(f([step("Copy it home:", sh("sudo install -o leon -m 600 /mnt/bm/bossman-db.sql.gz /home/leon/", { host: "nas01", as: "root" }))])).toEqual([]);
    // A copy the login runs with `install -m 600` can't read the 700 source, so the read check refuses it; a root
    // copy with `install -m 600` is closed and passes.
    expect(f([step("Copy it:", sh("sudo install -m 600 /mnt/bm/bossman-db.sql.gz /tmp/db.sql.gz", { host: "nas01", as: "root" }))])).toEqual([]);
    // install with no -m applies the umask (022 default), so it is open and refused.
    expect(f([step("Copy it:", sh("sudo install /mnt/bm/bossman-db.sql.gz /tmp/db.sql.gz", { host: "nas01", as: "root" }))])).toHaveLength(1);
    // A copy out of an ordinary folder is untouched by this rule.
    const ORDINARY = [{ name: "nas01", ownership: [{ path: "/mnt/bm", owner: "root", group: "root", mode: "700", role: "install" as const }] }];
    expect(lintOwnerSteps([step("Copy it:", sh("sudo install -m 644 /mnt/bm/x /tmp/x", { host: "nas01", as: "root" }))], ORDINARY).refuse.filter((x) => x.rule === "R6")).toEqual([]);
  });

  it("warns when a copy step touches a path with no recorded ownership", () => {
    const w = warn([step("Copy it:", sh("cp /mnt/bm/x /srv/somewhere/x", { host: "nas01", as: "root" }))]);
    expect(w.some((f) => f.rule === "warn" && /no recorded ownership/.test(f.problem))).toBe(true);
  });
});

describe("R14: git that writes the checkout runs in a (umask 022 && …) subshell (DR-028, the 6 Nov outage)", () => {
  const r14 = (command: string, where: { host: string; as: "root" | "login" } = H) => lintOwnerSteps([step("Run this:", sh(command, where))]).refuse.filter((f) => f.rule === "R14");

  it("refuses the 6 Nov card's bare pin and rollback, and passes them in the subshell", () => {
    expect(r14("cd /srv/bm/src && git checkout main && git fetch origin && git merge --ff-only abc1234 && git rev-parse HEAD").map((f) => f.problem.split(" ")[2])).toEqual(["checkout", "merge"]);
    expect(r14("cd /srv/bm/src && git checkout abc1234 && scripts/rebuild-live.sh")).toHaveLength(1);
    expect(r14("(umask 022 && cd /srv/bm/src && git checkout main && git fetch origin && git merge --ff-only abc1234 && git rev-parse HEAD)")).toEqual([]);
    expect(r14("(umask 022 && cd /srv/bm/src && git checkout abc1234) && cd /srv/bm/src && scripts/rebuild-live.sh")).toEqual([]);
    expect(r14("(umask 0022; git -C /srv/bm/src pull)")).toEqual([]);
  });

  it("refuses every writing git, however it is spelled, outside the subshell", () => {
    for (const c of [
      "git -C /srv/bm/src checkout main",
      "git -c core.x=y merge --ff-only abc1234",
      "sudo git reset --hard abc1234",
      "env GIT_DIR=/x git pull",
      "/usr/bin/git switch main",
      "git stash pop",
      "git clone https://example.com/bm.git /srv/bm/src",
      "cd /srv/bm/src; git restore apps",
      "(cd /srv/bm/src && git checkout main)", // a subshell without the umask
      "(umask 077 && cd /srv/bm/src && git checkout main)", // the outage's own umask
      "(umask 002 && git checkout main)",
      "echo $(git checkout main)",
      "(umask 022 && cd /srv/bm/src) && git checkout main", // the git is after the subshell closed
    ])
      expect(r14(c).length, c).toBeGreaterThan(0);
    // The login's blocks too: the rule is about the files git writes, not who runs it.
    expect(r14("git checkout main", { host: "nas01", as: "login" })).toHaveLength(1);
    // Inline code in a sentence is pasted too.
    expect(lintOwnerSteps(["Run `git checkout main` in the install folder."]).refuse.map((f) => f.rule)).toContain("R14");
  });

  it("refuses a bare umask, which would stay set in the owner's terminal", () => {
    expect(r14("umask 022")[0]!.problem).toMatch(/sets umask outside a subshell/);
    expect(r14("umask 022 && cd /srv/bm/src && git checkout main")).toHaveLength(2);
    // umask alone only prints the current one.
    expect(r14("umask")).toEqual([]);
  });

  it("passes git that writes nothing, and parentheses inside quotes", () => {
    for (const c of ["cd /srv/bm/src && git fetch origin && git rev-parse HEAD", "git -C /srv/bm/src status", "git log --oneline -5", "git stash list", "git worktree list", "git diff abc1234 def5678"]) expect(r14(c), c).toEqual([]);
    expect(r14(`(umask 022 && cd /srv/bm/src && git merge --ff-only abc1234 && echo "done (ok)") && docker compose exec -T server-blue node -e "fetch('x').then(r=>console.log(r))"`)).toEqual([]);
  });

  it("can't be overridden by the CEO: the fix is always the same subshell", () => {
    const r = checkAsk({ triedFirst: TRIED, steps: [step("Pin it:", sh("cd /srv/bm/src && git checkout main", H))], lintOverride: "The owner's umask is 022 on this host.", byCeo: true });
    expect(r.error).toMatch(/runs git checkout outside a \(umask 022 && …\) subshell/);
  });
});

describe("checkAsk with the lint", () => {
  const bad = ["Follow docs/06 for the folder."];
  it("returns the refusal with the step and the reason", () => {
    const r = checkAsk({ triedFirst: TRIED, ownerMustDo: true, steps: bad });
    expect(r.error).toMatch(/Step 1: points to a doc in docs\/ \("docs\/06"\)/);
    expect(r.error).not.toMatch(/lintOverride/);
  });

  it("lets only the CEO override, with a reason, and keeps what it let through", () => {
    expect(checkAsk({ triedFirst: TRIED, steps: bad, lintOverride: "The doc is right this time." }).error).toMatch(/Only the CEO/);
    expect(checkAsk({ triedFirst: TRIED, steps: bad, lintOverride: "ok", byCeo: true }).error).toMatch(/at least 10/);
    expect(checkAsk({ triedFirst: TRIED, steps: bad, byCeo: true }).error).toMatch(/pass lintOverride/);
    const r = checkAsk({ triedFirst: TRIED, steps: bad, lintOverride: "  The owner asked for the doc  reference. ", byCeo: true });
    expect(r.error).toBeNull();
    expect(r.lint?.override).toEqual({ reason: "The owner asked for the doc reference.", findings: [expect.objectContaining({ step: 1, rule: "R1" })] });
  });

  it("never lets an override through a command that isn't copy-safe", () => {
    const r = checkAsk({ triedFirst: TRIED, steps: ["Run `ssh root@<host-ip>`."], lintOverride: "Urgent, the owner knows the address.", byCeo: true });
    expect(r.error).toMatch(/placeholder/);
  });
});

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
  await ctx?.app.close();
  await ctx?.close();
  if (ctx?.dir) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  // What the host recorded about itself (BOS-427): host nas01, with a root-only backups folder.
  const dir = await mkdtemp(path.join(tmpdir(), "bm-lint-"));
  await mkdir(path.join(dir, "outbox"), { recursive: true });
  await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: "2026-11-05T00:00:00Z", ownership: [{ path: "/mnt/backups", owner: "root", group: "root", mode: "700" }] }));
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", deployerDir: dir });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, close, dir, company, ceo, worker, mcp, clients };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe("raise_decision checks the owner's steps", () => {
  const card = (steps: string[], extra: Record<string, unknown> = {}) => ({ question: "Move Boss Man to the new host?", options: ["Done", "It failed"], recommended: "Done", triedFirst: TRIED, ownerMustDo: true, steps, ...extra });

  it("refuses an agent's card that says follow docs/06 or uses an unset variable, and raises nothing", async () => {
    const c = (ctx = await setup());
    const m = await c.mcp(c.worker.id);
    const doc = await m.callTool({ name: "raise_decision", arguments: card(["Follow docs/06 with changes on the new host."]) });
    expect(isError(doc)).toBe(true);
    expect(textOf(doc)).toMatch(/Step 1: points to a doc/);
    const unset = await m.callTool({ name: "raise_decision", arguments: card([step("Copy the backups:", sh("sudo cp -a $BOSSMAN_HOME/backups /mnt/new", H))]) });
    expect(isError(unset)).toBe(true);
    expect(textOf(unset)).toMatch(/\$BOSSMAN_HOME, which no step up to here sets/);
    // An agent that isn't the CEO can't override.
    const forced = await m.callTool({ name: "raise_decision", arguments: card(["Follow docs/06."], { lintOverride: "I am sure the doc is right." }) });
    expect(textOf(forced)).toMatch(/Only the CEO/);
    expect(await c.db.select().from(decisions)).toHaveLength(0);
  });

  it("raises a good card with its warnings stored, and a CEO override with its reason", async () => {
    const c = (ctx = await setup());
    const w = await c.mcp(c.worker.id);
    const ok = await w.callTool({ name: "raise_decision", arguments: card([step("On the new host, list the containers (background on BOS-276):", sh("DOCKER_HOST=unix:///run/docker.sock docker ps", H))]) });
    expect(isError(ok)).toBe(false);
    const ceo = await c.mcp(c.ceo.id);
    const over = await ceo.callTool({ name: "raise_decision", arguments: card(["Follow docs/06 on the new host."], { question: "Install on the new host?", lintOverride: "The owner asked to be pointed at the guide." }) });
    expect(isError(over)).toBe(false);
    const rows = await c.db.select().from(decisions);
    const lintOf = (q: string) => (rows.find((d) => d.question === q)!.context as { lint?: CardLint }).lint;
    expect(lintOf("Move Boss Man to the new host?")!.warn).toEqual([expect.objectContaining({ step: 1, rule: "warn", problem: expect.stringMatching(/links to a wiki page or ticket/) })]);
    expect(lintOf("Install on the new host?")!.override).toMatchObject({ reason: "The owner asked to be pointed at the guide.", findings: [{ step: 1, rule: "R1" }] });
    // The CEO's list shows both.
    const list = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(list).toMatch(/Boss Man flagged its steps/);
    expect(list).toMatch(/Lint overridden by the CEO: [\s\S]*The owner asked to be pointed at the guide\./);
  });

  it("refuses a card whose login step reads a root-only folder, using the host facts (BOS-427)", async () => {
    const c = (ctx = await setup());
    const m = await c.mcp(c.worker.id);
    const loginRead = await m.callTool({ name: "raise_decision", arguments: card([step("Look at the backups:", sh("ls -l /mnt/backups", { host: "nas01", as: "login" }))]) });
    expect(isError(loginRead)).toBe(true);
    expect(textOf(loginRead)).toMatch(/Step 1: runs as the login on nas01 and reads \/mnt\/backups, which the login can't read/);
    // A root block on the same folder is fine, and reaches the owner.
    const rootRead = await m.callTool({ name: "raise_decision", arguments: card([step("Look at the backups:", sh("ls -l /mnt/backups", { host: "nas01", as: "root" }))], { question: "Check the backups folder?" }) });
    expect(isError(rootRead)).toBe(false);
  });
});
