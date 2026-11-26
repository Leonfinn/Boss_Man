// DR-076 A (BOS-2554): every path that offers the owner a server or runner update, or sends one by itself, must ask
// the owner hold first, so a failed update's diagnosis is never contradicted by a card recommending a retry. This
// test lists those paths in self-deploy.ts. A new call site fails here until it is added to the list below with the
// way it respects the hold (and the hold check is really there).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pickupWords } from "../src/services/owner-holds.js";

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

// BOS-2609: who is diagnosing a held update, said only once their run has started. A card keeps its words once
// raised, so `live` false gets the form that stays true (ticket and agent, no claim that work is under way).
describe("pickupWords: who is diagnosing the failure", () => {
  const at = (hhmm: string) => new Date(`2026-11-26T${hhmm}:00Z`);
  const pickup = (over: Partial<{ ticketId: string | null; ref: string | null; agent: string | null; startedAt: Date | null; wokenAt: Date | null }> = {}) => ({
    ticketId: "6f1c2b3a-0000-4000-8000-000000000019",
    ref: "APP-19",
    agent: "Nova",
    startedAt: null,
    wokenAt: null,
    ...over,
  });

  it("says nobody is assigned, with and without a woken time", () => {
    expect(pickupWords(pickup({ ticketId: null, ref: null, agent: null }))).toBe(
      "Not picked up yet: nobody is assigned to diagnose it.",
    );
    expect(pickupWords(pickup({ ticketId: null, ref: null, agent: null, wokenAt: at("09:05") }))).toBe(
      "Not picked up yet: nobody is assigned to diagnose it; the CEO was woken at 09:05 UTC.",
    );
  });

  it("uses the card form, which stays true, when not read live", () => {
    expect(pickupWords(pickup({ startedAt: at("09:05") }), false)).toBe("The diagnosis is APP-19, assigned to Nova.");
    expect(pickupWords(pickup({ startedAt: at("09:05") }), false)).not.toMatch(/being looked into/i);
  });

  it("says it is being looked into only once a run has started, with the time in UTC", () => {
    expect(pickupWords(pickup({ startedAt: at("09:05") }))).toBe(
      "Being looked into by Nova on APP-19 (started 09:05 UTC).",
    );
  });

  it("says assigned but not picked up, with and without a woken time, and never claims work is under way", () => {
    const plain = pickupWords(pickup());
    expect(plain).toBe("Not picked up yet: Nova assigned (APP-19).");
    expect(plain).not.toMatch(/being looked into/i);
    const woken = pickupWords(pickup({ wokenAt: at("09:05") }));
    expect(woken).toBe("Not picked up yet: Nova woken at 09:05 UTC (APP-19).");
    expect(woken).not.toMatch(/being looked into/i);
  });
});
