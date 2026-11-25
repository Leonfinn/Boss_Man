// DR-076 A (BOS-2554): every path that offers the owner a server or runner update, or sends one by itself, must ask
// the owner hold first, so a failed update's diagnosis is never contradicted by a card recommending a retry. This
// test lists those paths in self-deploy.ts. A new call site fails here until it is added to the list below with the
// way it respects the hold (and the hold check is really there).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../src/services/self-deploy.ts", import.meta.url), "utf8");
const lines = src.split("\n");

/** The enclosing function (a closure `async function x(` or a service method `async x(`) of each line. */
function enclosing(line: number): string {
  for (let i = line; i >= 0; i--) {
    const m = /^\s{2}async function (\w+)\(|^\s{4}async (\w+)\(/.exec(lines[i]!);
    if (m) return m[1] ?? m[2]!;
  }
  return "?";
}

/** Where each call is, as "caller → callee". */
function sites(callee: RegExp): string[] {
  return lines.flatMap((l, i) => (callee.test(l) && !/^\s*(async function|\/\/|\*)/.test(l.trim()) ? [enclosing(i)] : []));
}

/** The body of one closure function, up to the next one at the same depth. */
function body(name: string): string {
  const start = lines.findIndex((l) => new RegExp(`^\\s{2}async function ${name}\\(|^\\s{4}async ${name}\\(`).test(l));
  expect(start, `${name} not found in self-deploy.ts`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^\s{2}async function \w+\(|^\s{4}async \w+\(/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

// caller → how it respects the hold. Keep the reason in words: it is what a reviewer checks.
const RAISE_SERVER: Record<string, string> = {
  sync: "the automatic card: heldFor(server_deploy) returns before raise",
  deployLatest: "the owner's own press: raise() heads the card Held and recommends Not now (holdCardLead)",
};
const RAISE_RUNNER: Record<string, string> = {
  raiseRunner: "the one runner raise: runnerBlocker reports the hold (heldFor(runner_update)); askAnyway cards get the Held lead from raise()",
};
const RAISE_RUNNER_CALLERS: Record<string, string> = {
  releaseRunnerDue: "automatic: raiseRunner without askAnyway, so it waits while held",
  updateRunners: "the owner's press: runnerBlocker queues it while held, before raiseRunner is reached",
};
const SENDS: Record<string, string> = {
  releaseHeldServer: "an owner-approved deploy waiting behind a runner update: returns while heldFor(server_deploy)",
  releaseRunnerDue: "the owner's queued press: returns while runnerBlocker (which reads the hold) says so",
  send: "the owner answered a card: their decision, made on a card that already carried the hold's wording",
  restartServer: "a restart of the live version, not an update: nothing to hold",
};

describe("every update offer path asks the owner hold (DR-076 A)", () => {
  it("lists each call site that raises a server or runner card", () => {
    expect(sites(/\braise\("server",/).sort()).toEqual(Object.keys(RAISE_SERVER).sort());
    expect(sites(/\braise\("runner",/).sort()).toEqual(Object.keys(RAISE_RUNNER).sort());
    expect([...new Set(sites(/\braiseRunner\(/))].sort()).toEqual(Object.keys(RAISE_RUNNER_CALLERS).sort());
  });

  it("lists each call site that sends an update to the host by itself", () => {
    expect([...new Set(sites(/\bwriteRequest\(/))].sort()).toEqual(Object.keys(SENDS).sort());
  });

  it("the guards named above are really there", () => {
    expect(body("sync")).toMatch(/heldFor\(db, "server_deploy"[\s\S]*raise\("server"/);
    expect(body("raise")).toContain("holdCardLead(");
    expect(body("runnerBlocker")).toContain('heldFor(db, "runner_update"');
    expect(body("raiseRunner")).toMatch(/runnerBlocker\(a\)[\s\S]*raise\("runner"/);
    expect(body("releaseHeldServer")).toMatch(/heldFor\(db, "server_deploy"[\s\S]*writeRequest\(/);
    expect(body("releaseRunnerDue")).toMatch(/runnerBlocker\(a\)\) return;[\s\S]*writeRequest\(/);
    expect(body("updateRunners")).toMatch(/runnerBlocker\(a\)[\s\S]*raiseRunner\(/);
  });
});
