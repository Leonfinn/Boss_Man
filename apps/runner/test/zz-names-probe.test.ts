// BOS-1067 probe, must not merge: names the tests that fail in a fenced check job.
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { BASE_ENV_KEYS } from "../src/session-manager.js";

it("names failing tests", () => {
  const r = spawnSync("npx", ["vitest", "run", "--reporter=json", "test/session-manager.test.ts"], { encoding: "utf8", env: { ...process.env, BOSSMAN_VITEST_NO_SLOT: "1", CHECK_ALL_FORCE: "1" }, maxBuffer: 1 << 28 });
  const out = r.stdout ?? "";
  const start = out.indexOf("{");
  let names = "unparsed: " + out.slice(0, 300) + " ERR " + (r.stderr ?? "").slice(-300);
  try {
    const j = JSON.parse(out.slice(start));
    names = j.testResults.flatMap((f: any) => f.assertionResults.filter((a: any) => a.status === "failed").map((a: any) => `${a.fullName} :: ${String(a.failureMessages[0]).split("\n")[0].slice(0, 160)}`)).join(" || ");
  } catch {}
  expect(BASE_ENV_KEYS.length).toBeGreaterThan(0);
  expect(`NAMES[${names}]`).toBe("");
}, 280_000);
