import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REFUSAL, decide, parseArgs, slotCommand } from "./vitest-guard.mjs";

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
    const named = run(["run", "a.test.ts"], { ...agent, CHECK_ALL_LOCK: join(dir, "lock"), CHECK_ALL_PAIR_PROOF: join(dir, "proof"), BOSSMAN_CHECK_STORE: "off" });
    assert.equal(named.status, 0, named.stdout + named.stderr);
    assert.match(named.stdout, /RAN run a\.test\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
