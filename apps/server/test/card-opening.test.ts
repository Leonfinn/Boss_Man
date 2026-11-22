import { describe, expect, it } from "vitest";
import { checkAsk, cardOpeningProblem } from "../src/services/decisions.js";
import { hostFactsService } from "../src/services/host-facts.js";
import { ownerWhere, sh, step, stepPlace } from "../src/services/steps.js";

// BOS-1660: host tokens are filled and checked in every owner-visible field, and a card with steps opens with
// why, where (written by Boss Man from the steps) and minutes. Made-up hosts and paths only.

const TRIED = "Checked the host from the runner; agents have no access to the owner's machine.";
const WHY = "The owner gets the tunnel running again.";
const SERVER = "docker01";
const T = { host: "docker01", as: "login" as const };
const CF = "Open https://dash.cloudflare.com (seen: 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d) and press Create Token.";
const IMG = { "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d": "2026-11-16T08:00:00Z" };
const VALUES = { "paths.src": "/srv/bm/src", "env.file": "/srv/bm/.env" };

describe("host tokens in every owner-visible field (BOS-1660 A)", () => {
  it("fills a token that is only in the question, the options or triedFirst", () => {
    const r = checkAsk({ triedFirst: `${TRIED} Looked in {{host.paths.src}}.`, question: "Edit {{host.env.file}} now?", options: ["Yes, {{host.env.file}} is ready", "No"], hostValues: VALUES });
    expect(r.error).toBeNull();
    expect(r.question).toBe("Edit /srv/bm/.env now?");
    expect(r.options).toEqual(["Yes, /srv/bm/.env is ready", "No"]);
    expect(r.triedFirst).toContain("Looked in /srv/bm/src.");
  });

  it("refuses an unknown token in an option, naming the field", () => {
    const r = checkAsk({ triedFirst: TRIED, question: "Ready?", options: ["Yes", "Use {{host.paths.nope}}"], hostValues: VALUES });
    expect(r.error).toMatch(/^Option 2 uses host facts Boss Man doesn't have: \{\{host\.paths\.nope\}\}/);
  });

  it("refuses a token in the question when the caller has no facts, naming the question", () => {
    const r = checkAsk({ triedFirst: TRIED, question: "Edit {{host.env.file}} now?", options: ["Yes", "No"] });
    expect(r.error).toMatch(/^The question has \{\{host\.env\.file\}\}/);
  });

  it("refuses a token in triedFirst, naming it", () => {
    expect(checkAsk({ triedFirst: `${TRIED} See {{host.paths.src}}.`, question: "Ready?" }).error).toMatch(/^triedFirst has \{\{host\.paths\.src\}\}/);
  });

  it("also refuses a token in the question on a card that has steps", () => {
    const r = checkAsk({ triedFirst: TRIED, why: WHY, minutes: 2, question: "Edit {{host.env.file}} now?", steps: ["Open Settings → Server and runner → This host."] });
    expect(r.error).toMatch(/^The question has/);
  });

  it("valuesFor loads the facts when only the question has a token", async () => {
    const svc = hostFactsService({});
    expect(await svc.valuesFor(["no token"], "plain question", ["A", "B"], "tried")).toBeUndefined();
    expect(await svc.valuesFor(["no token"], "Edit {{host.env.file}}?")).toEqual({});
    expect(await svc.valuesFor(undefined, "q", ["Use {{host.paths.src}}", "No"])).toEqual({});
  });
});

describe("the opening of a card with steps (BOS-1660 B)", () => {
  const steps = ["Open Settings → Server and runner → This host."];

  it("refuses a card with steps and no why, and one with no minutes", () => {
    expect(checkAsk({ triedFirst: TRIED, minutes: 3, steps }).error).toMatch(/why is missing/);
    expect(checkAsk({ triedFirst: TRIED, why: WHY, steps }).error).toMatch(/minutes is missing/);
  });

  it("refuses a why of several lines and minutes that are not a whole number", () => {
    expect(cardOpeningProblem("one\ntwo", 3)).toMatch(/one line/);
    expect(cardOpeningProblem(WHY, 2.5)).toMatch(/whole number/);
    expect(cardOpeningProblem(WHY, 0)).toMatch(/whole number/);
    expect(cardOpeningProblem(WHY, 15)).toBeNull();
  });

  it("needs no opening on a plain question without steps", () => {
    expect(checkAsk({ triedFirst: TRIED, question: "Close it?", options: ["Yes", "No"] }).error).toBeNull();
  });

  it("generates Where from the steps: browser site, terminal host and Settings, grouped", () => {
    const steps = [
      CF,
      "Copy the token it shows, on https://dash.cloudflare.com/profile/api-tokens (seen: 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d).",
      step("Save it:", sh("sudo nano /srv/bm/.env", T)),
      "Open Settings → Server and runner → Updates and press Build and update runners.",
      step("Check it:", sh("docker compose ps", T)),
    ];
    const w = ownerWhere(steps, SERVER);
    expect(w.missing).toEqual([]);
    expect(w.where).toEqual(["Steps 1, 2: Cloudflare, in your browser", "Steps 3, 5: terminal on docker01", "Step 4: Boss Man, in Settings"]);
  });

  it("writes the Where line onto the card result, with why and minutes", () => {
    const r = checkAsk({ triedFirst: TRIED, why: WHY, minutes: 6, steps: ["Open Settings → Server and runner → This host."], serverHost: SERVER, images: IMG });
    expect(r.error).toBeNull();
    expect(r.opening).toEqual({ why: WHY, minutes: 6, where: ["Step 1: Boss Man, in Settings"] });
  });

  it("refuses a step that names no place, saying which one", () => {
    const r = checkAsk({ triedFirst: TRIED, why: WHY, minutes: 3, steps: ["Open Settings → Server and runner → This host.", "Undo it afterwards."] });
    expect(r.error).toMatch(/^Step 2 doesn't say where it happens\. Say where this step happens/);
    expect(stepPlace("Undo it afterwards.", SERVER)).toBeNull();
  });

  it("BOS-2117: accepts a walking owner-menu path that isn't under Settings, refuses one the walker can't follow", () => {
    expect(stepPlace("Open Wiki → tick \"Also search your past answers by meaning\".", SERVER)).toBe("Boss Man, in Wiki");
    expect(stepPlace("Open Wiki → Runs → tick the thing.", SERVER)).toBeNull();
    expect(stepPlace("Open Gadgets → Fizz.", SERVER)).toBeNull();
    expect(stepPlace("Open Settings → Server and runner → This host.", SERVER)).toBe("Boss Man, in Settings");
  });

  it("keeps the lint's own refusal first, before the opening", () => {
    const r = checkAsk({ triedFirst: TRIED, steps: ["Follow docs/06 for the folder."] });
    expect(r.error).toMatch(/R1|document|docs/i);
  });
});
