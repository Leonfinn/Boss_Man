import { describe, expect, it } from "vitest";
import { lintOwnerSteps } from "../src/services/steps.js";

// R32 (BOS-2730): a step on an outside site, vendor image or host tool says "confirmed on <host kind>, <date>" or "not yet confirmed".

const NOW = new Date("2026-11-26T12:00:00Z");
const lint = (steps: string[]) => lintOwnerSteps(steps, { serverHost: "boss.example.net", now: NOW }).refuse.filter((x) => x.rule === "R32");
const OPEN = "Open https://dash.cloudflare.com/profile/api-tokens and press Create Token.";

describe("R32: outside steps say whether they were confirmed", () => {
  it("refuses an outside URL step with neither marker, naming the fix", () => {
    const r = lint([OPEN]);
    expect(r).toHaveLength(1);
    expect(r[0]!.step).toBe(1);
    expect(r[0]!.problem).toContain("confirmed on <host kind>, <date>");
    expect(r[0]!.problem).toContain("not yet confirmed");
  });

  it("refuses a vendor named in words, and a registry-qualified vendor image", () => {
    expect(lint(["In the Cloudflare dashboard, open My Profile, then API Tokens."])).toHaveLength(1);
    expect(lint(["Pull ghcr.io/example-org/example-app:1.2 on the host and note its tag."])).toHaveLength(1);
  });

  it("accepts 'not yet confirmed', in any case", () => {
    expect(lint([`${OPEN} Not yet confirmed.`])).toEqual([]);
    expect(lint([`${OPEN} (not yet confirmed: read from the docs)`])).toEqual([]);
  });

  it("accepts 'confirmed on <host kind>, <date>' in each date form it can read", () => {
    for (const d of ["2026-11-20", "20 Nov 2026", "20 November 2026", "Nov 20, 2026", "November 20th, 2026", "26 Nov 2026"]) {
      expect(lint([`${OPEN} Confirmed on a Cloudflare free account, ${d}.`]), d).toEqual([]);
    }
  });

  it("refuses a 'confirmed on' with no readable date, an ambiguous one, a future one, or no host kind", () => {
    for (const tail of ["Confirmed on a free account.", "Confirmed on a free account, last week.", "Confirmed on a free account, 11/20/2026.", "Confirmed on a free account, 2027-03-01.", "Confirmed on, 2026-11-20."]) {
      const r = lint([`${OPEN} ${tail}`]);
      expect(r, tail).toHaveLength(1);
    }
    expect(lint([`${OPEN} Confirmed on a free account.`])[0]!.problem).toContain("no readable date");
  });

  it("does not take 'not confirmed on …, <date>' as a confirmation", () => {
    expect(lint([`${OPEN} Not confirmed on a free account, 2026-11-20.`])).toHaveLength(1);
  });

  it("leaves Boss Man's own paths, host tokens and ordinary steps alone", () => {
    expect(lint(["Open Settings → Server and runner → Updates and press Build and update runners."])).toEqual([]);
    expect(lint(["Open https://boss.example.net/settings and press Save."])).toEqual([]);
    expect(lint(["Run `cd {{host.paths.src}} && git pull` in a terminal on the host."])).toEqual([]);
    expect(lint(["Press Done when the update has finished."])).toEqual([]);
  });

  it("checks each step: a marker in one step doesn't cover another", () => {
    const r = lint([`${OPEN} Not yet confirmed.`, "Then open your GitHub settings and create a token."]);
    expect(r.map((x) => x.step)).toEqual([2]);
  });

  it("is overridable, like the other judgement rules", async () => {
    const { NOT_OVERRIDABLE } = await import("../src/services/steps.js");
    expect(NOT_OVERRIDABLE.has("R32")).toBe(false);
  });
});
