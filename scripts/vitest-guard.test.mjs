import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LIGHT_MAX_FILES, LIGHT_NEED_BYTES, REFUSAL, decide, lightBlocker, parseArgs, slotCommand } from "./vitest-guard.mjs";

const agent = { CLAUDECODE: "1" };

test("agent session: a whole-package run is refused", () => {
  assert.equal(decide(["run"], agent), "refuse");
  assert.equal(decide([], agent), "refuse");
  assert.equal(decide(["run", "--reporter", "dot"], agent), "refuse");
  assert.equal(decide(["run", "-t", "some name"], agent), "refuse");
  assert.equal(decide(["--run"], { BOSSMAN_AGENT_SESSION: "1" }), "refuse");
});

test("agent session: vitest related over app.ts, main.ts or mcp.ts is refused", () => {
  for (const f of ["src/app.ts", "src/main.ts", "src/mcp.ts", "app.ts"]) assert.equal(decide(["related", "--run", f], agent), "refuse", f);
  assert.equal(decide(["related", "--run", "src/foo.ts", "src/app.ts"], agent), "refuse");
  assert.equal(decide(["related", "--run"], agent), "refuse");
});

test("agent session: named test files are allowed, queued behind the check lock", () => {
  assert.equal(decide(["run", "test/a.test.ts"], agent), "slot");
  assert.equal(decide(["run", "--reporter", "dot", "test/a.test.ts", "test/b.test.ts"], agent), "slot");
  assert.equal(decide(["test/a.test.ts"], agent), "slot");
  assert.equal(decide(["related", "--run", "src/foo.ts"], agent), "slot");
  assert.equal(decide(["run", "--changed"], agent), "slot");
  assert.equal(decide(["run", "test/a.test.ts"], { ...agent, BOSSMAN_VITEST_NO_SLOT: "1" }), "allow");
});

test("agent session: other commands and --help are allowed", () => {
  assert.equal(decide(["list"], agent), "allow");
  assert.equal(decide(["--help"], agent), "allow");
});

test("the merge gate, check-all's own runs, the force override and humans are unaffected", () => {
  for (const env of [{}, { ...agent, BOSSMAN_MERGE_CHECK: "1" }, { ...agent, BOSSMAN_CHECK_CHILD: "1" }, { ...agent, CHECK_ALL_FORCE: "1" }]) {
    assert.equal(decide(["run"], env), "allow", JSON.stringify(env));
    assert.equal(decide(["related", "--run", "src/app.ts"], env), "allow", JSON.stringify(env));
    assert.equal(decide(["run", "test/a.test.ts"], env), "allow", JSON.stringify(env));
  }
});

test("parseArgs skips option values", () => {
  assert.deepEqual(parseArgs(["run", "-c", "x.ts", "a.test.ts"]).files, ["a.test.ts"]);
  assert.equal(parseArgs(["related", "src/a.ts"]).command, "related");
});

test("slotCommand quotes every argument", () => {
  assert.equal(slotCommand("/a b", "/n", "/v.mjs", ["run", "it's.test.ts"]), `cd '/a b' && '/n' '/v.mjs' 'run' 'it'\\''s.test.ts'`);
});

// End to end through a stub "vitest" that loads the guard the way a config does.
test("guardVitest: refuses with the message, and runs named files inside the check slot", () => {
  const dir = mkdtempSync(join(tmpdir(), "vg-"));
  try {
    const guard = join(import.meta.dirname, "vitest-guard.mjs");
    const stub = join(dir, "vitest.mjs");
    writeFileSync(stub, `import { guardVitest } from ${JSON.stringify(guard)};\nguardVitest();\nconsole.log("RAN " + process.argv.slice(2).join(" "));\n`);
    const run = (args, env) =>
      spawnSync(process.execPath, [stub, ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...env },
      });
    const refused = run(["run"], agent);
    assert.equal(refused.status, 2);
    assert.ok(refused.stderr.includes(REFUSAL));
    assert.ok(!refused.stdout.includes("RAN"));
    // Gate and force override: runs.
    assert.match(run(["run"], { ...agent, BOSSMAN_MERGE_CHECK: "1" }).stdout, /RAN run/);
    assert.match(run(["run"], { ...agent, CHECK_ALL_FORCE: "1" }).stdout, /RAN run/);
    // Named files go through check-all.sh's slot (its lock and proof files are private to this test); the stub runs inside it with the child marker.
    // a.test.ts does not exist, so it is a filter, not a file: no quick lane, and the run says why before it waits.
    const named = run(["run", "a.test.ts"], { ...agent, CHECK_ALL_LOCK: join(dir, "lock"), CHECK_ALL_PAIR_PROOF: join(dir, "proof"), BOSSMAN_CHECK_STORE: "off" });
    assert.equal(named.status, 0, named.stdout + named.stderr);
    assert.match(named.stdout, /RAN run a\.test\.ts/);
    assert.match(named.stderr, /vitest-guard: this run waits in the merge gate's check line because "a\.test\.ts" is not a test file path/);
    assert.match(named.stderr, /To run now instead: name at most 3 test files by path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lightBlocker: only a one-off run of 1 to 3 existing test files takes the quick lane", () => {
  const files = new Set(["/w/test/a.test.ts", "/w/test/b.spec.mjs", "/w/test/c.test.tsx", "/w/test/d.test.ts", "/w/src/x.ts"]);
  const isFile = (p) => files.has(p);
  const lb = (args) => lightBlocker(args, "/w", isFile);
  assert.equal(lb(["run", "test/a.test.ts"]), "");
  assert.equal(lb(["test/a.test.ts", "test/b.spec.mjs", "test/c.test.tsx"]), "");
  assert.equal(lb(["run", "--reporter", "dot", "-t", "some name", "/w/test/a.test.ts"]), "");
  assert.match(lb(["run", "test/a.test.ts", "test/b.spec.mjs", "test/c.test.tsx", "test/d.test.ts"]), /names 4 files/);
  assert.equal(LIGHT_MAX_FILES, 3);
  assert.match(lb(["run", "a"]), /"a" is not a test file path/); // a bare word is a filter
  assert.match(lb(["run", "test/missing.test.ts"]), /not a test file path/);
  assert.match(lb(["run", "src/x.ts"]), /not a test file path/);
  assert.match(lb(["related", "--run", "src/x.ts"]), /`vitest related`/);
  assert.match(lb(["watch", "test/a.test.ts"]), /`vitest watch`/);
  assert.match(lb(["run", "--changed", "test/a.test.ts"]), /--changed/);
  assert.match(lb(["run", "--maxWorkers", "4", "test/a.test.ts"]), /worker count/);
  assert.match(lb(["run", "--maxWorkers=4", "test/a.test.ts"]), /worker count/);
});

// The quick lane end to end: a stub "vitest" in a package folder with a real test file. Places and the check line use private locks.
test("guardVitest: a one-file run goes at once with one worker; low memory or busy places send it to the line, saying why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vg-"));
  const holders = [];
  try {
    const guard = join(import.meta.dirname, "vitest-guard.mjs");
    const pkg = join(dir, "pkg");
    mkdirSync(join(pkg, "test"), { recursive: true });
    writeFileSync(join(pkg, "test", "a.test.ts"), "");
    const stub = join(dir, "vitest.mjs");
    writeFileSync(
      stub,
      `import { guardVitest } from ${JSON.stringify(guard)};\nguardVitest();\nconsole.log("RAN " + process.argv.slice(2).join(" ") + " workers=" + (process.env.BOSSMAN_TEST_WORKERS ?? "-") + " light=" + (process.env.BOSSMAN_VITEST_LIGHT ?? "-") + " child=" + (process.env.BOSSMAN_CHECK_CHILD ?? "-"));\n`,
    );
    const lock = join(dir, "lock");
    const base = { ...agent, CHECK_ALL_LOCK: lock, CHECK_ALL_PAIR_PROOF: join(dir, "proof"), BOSSMAN_CHECK_STORE: "off" };
    const plenty = String(LIGHT_NEED_BYTES + 1024 ** 3);
    const run = (env) =>
      new Promise((done) => {
        const c = spawn(process.execPath, [stub, "run", "test/a.test.ts"], { cwd: pkg, env: { PATH: process.env.PATH, ...env } });
        let stdout = "";
        let stderr = "";
        c.stdout.on("data", (d) => (stdout += d));
        c.stderr.on("data", (d) => (stderr += d));
        c.on("close", (status) => done({ status, stdout, stderr }));
      });

    // Room on the runner: runs straight away in a quick place, one worker, not through check-all.
    const quick = await run({ ...base, BOSSMAN_CHECK_FREE_MEMORY: plenty });
    assert.equal(quick.status, 0, quick.stdout + quick.stderr);
    assert.match(quick.stdout, /RAN run test\/a\.test\.ts workers=1 light=1 child=-/);
    assert.ok(!quick.stderr.includes("check line"), quick.stderr);

    // Too little free memory: the line, with the reason first.
    const low = await run({ ...base, BOSSMAN_CHECK_FREE_MEMORY: String(1024 ** 3) });
    assert.equal(low.status, 0, low.stdout + low.stderr);
    assert.match(low.stdout, /RAN run test\/a\.test\.ts workers=- light=- child=1/);
    assert.match(low.stderr, /because the runner has 1\.0 GB free and a quick run needs 6\.5 GB/);

    // Both places held by other runs: it says it is waiting, then goes to the line after the (shortened) wait.
    for (const k of [1, 2]) {
      // One process holds the lock (exec keeps the pid), so killing it frees the place and leaves nothing behind.
      const h = spawn("bash", ["-c", 'exec 9>"$1"; flock 9; exec sleep 60', "holder", `${lock}.light.${k}`], { stdio: "ignore" });
      holders.push(h);
    }
    // Wait for the event, not a fixed sleep: both places are taken when flock -n can't get them (deadline 20 s).
    const deadline = Date.now() + 20_000;
    const taken = (k) => spawnSync("flock", ["-n", `${lock}.light.${k}`, "true"]).status !== 0;
    while (!(taken(1) && taken(2))) {
      assert.ok(Date.now() < deadline, "the holders never took both places");
      await new Promise((r) => setTimeout(r, 50));
    }
    const busy = await run({ ...base, BOSSMAN_CHECK_FREE_MEMORY: plenty, BOSSMAN_VITEST_LIGHT_WAIT: "0" });
    assert.equal(busy.status, 0, busy.stdout + busy.stderr);
    assert.match(busy.stdout, /child=1/);
    assert.match(busy.stderr, /because both quick-run places stayed busy/);
  } finally {
    for (const h of holders) h.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
