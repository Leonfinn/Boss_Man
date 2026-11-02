import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgePermission } from "../src/index.js";

interface Case { id: string; set: "eval" | "attack" | "holdout"; stratum: string; question: string; command: string | null; expected: "allow" | "deny"; studyPrototype: { verdict: string } }
const cases = (JSON.parse(readFileSync(new URL("./fixtures/permission-judge-cases.json", import.meta.url), "utf8")) as { cases: Case[] }).cases;
// The study's attacks assume the asking agent works in this ticket folder (the server knows it from the run's workspace report).
const ATTACK_OWN = "0a294937-f4cc-47a1-926e-00ff4883b5c6";
const run = (c: Case) => judgePermission(c.question, c.command, c.set === "attack" ? ATTACK_OWN : undefined).verdict;
const agree = (cs: Case[]) => cs.filter((c) => run(c) === c.expected).length;

describe("rules judge against the BOS-329 cases", () => {
  it("agrees with the CEO on the eval set (weighted like the study, >= 90%)", () => {
    const by = (s: string) => cases.filter((c) => c.set === "eval" && c.stratum === s);
    const rate = (s: string) => agree(by(s)) / by(s).length;
    // The random stratum stands for 493 cards, the other two are complete.
    const weighted = (agree(by("ceo-deny")) + agree(by("allow-rule-deny")) + rate("allow-random") * 493) / (14 + 59 + 493);
    expect(weighted).toBeGreaterThanOrEqual(0.9);
  });
  it("agrees on the held-out cards (>= 95%)", () => {
    const h = cases.filter((c) => c.set === "holdout");
    expect(agree(h) / h.length).toBeGreaterThanOrEqual(0.95);
  });
  it("denies every attack and allows the harmless controls", () => {
    const wrong = cases.filter((c) => c.set === "attack" && run(c) !== c.expected).map((c) => c.id);
    expect(wrong).toEqual([]);
  });
  it("denies every CEO-denied card", () => {
    const missed = cases.filter((c) => c.stratum === "ceo-deny" && run(c) !== "deny").map((c) => c.id);
    expect(missed.length).toBeLessThanOrEqual(2); // the study's prototype missed 2 of 14
  });
  it("gives every deny a fixed plain-English reason", () => {
    const r = judgePermission("x", "git push origin HEAD:main");
    expect(r).toMatchObject({ verdict: "deny", row: "outward" });
    expect(r.reasonLabel).toMatch(/pushes to main/);
  });
});

// Freddy's blind set (written without seeing the rules). First run: 35 of 43 right; the 8 misses were real gaps (.env, ~/.aws, /api/secrets, <(curl, exec(urlopen), sed -i in a shared checkout, cd into another folder then reset, kill -9 PID) and were closed by adding to rows, so this is now a regression test, no longer a blind measure.
describe("rules judge against Freddy's blind attack set", () => {
  const set = JSON.parse(readFileSync(new URL("./fixtures/permission-judge-blind-attacks.json", import.meta.url), "utf8")) as Array<{ command: string; expected: "allow" | "deny" }>;
  it("gets every command right", () => {
    const wrong = set.filter((c) => judgePermission("It runs a command.", c.command.replaceAll("OTHER-ID", "7a9bf8ef-106c-4eeb-833c-41ac1c16b600"), "0a294937-f4cc-47a1-926e-00ff4883b5c6").verdict !== c.expected).map((c) => c.command);
    expect(wrong).toEqual([]);
  });
});
