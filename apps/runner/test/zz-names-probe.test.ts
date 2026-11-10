// BOS-1067 probe, must not merge: names the tests that fail in a fenced check job.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BASE_ENV_KEYS } from "../src/session-manager.js";

it.skipIf(process.env.NAMES_PROBE_INNER === "1")("names failing tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "names-"));
  const outFile = join(dir, "r.json");
  const r = spawnSync("npx", ["vitest", "related", "--run", "src/session-manager.ts", "src/workspace.ts", "--reporter=json", `--outputFile.json=${outFile}`], { encoding: "utf8", env: { ...process.env, NAMES_PROBE_INNER: "1", BOSSMAN_VITEST_NO_SLOT: "1", CHECK_ALL_FORCE: "1" }, maxBuffer: 1 << 28 });
  let names = "unparsed: " + (r.stdout ?? "").slice(0, 200) + " ERR " + (r.stderr ?? "").slice(-200);
  try {
    const j = JSON.parse(readFileSync(outFile, "utf8"));
    names = j.testResults.flatMap((f: any) => (f.assertionResults.length ? f.assertionResults.filter((a: any) => a.status === "failed").map((a: any) => `${a.fullName} :: ${String(a.failureMessages[0]).split("\n")[0].slice(0, 160)}`) : f.status === "failed" ? [`FILE ${f.name} :: ${String(f.message).slice(0, 160)}`] : [])).join(" || ");
  } catch {}
  expect(BASE_ENV_KEYS.length).toBeGreaterThan(0);
  expect(`NAMES[${names}]`).toBe("");
}, 280_000);
