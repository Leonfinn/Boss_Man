import { describe, expect, it } from "vitest";
import { lintOwnerSteps, SCREEN_DIFFERENT_OPTION } from "../src/services/steps.js";
import { checkAsk } from "../src/services/card-check.js";
import { checkOwnerSetup, ownerSetupWriteCheck } from "../src/services/owner-setup-check.js";

const DOC = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/";

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

  it("raise_decision: refused with the rule and both markers, accepted with either (the TrueNAS example)", () => {
    const base = { triedFirst: "Read Cloudflare's docs; an agent has no login to the owner's account.", why: "The owner gets a public address for the app.", minutes: 5, ownerMustDo: true, serverHost: "boss.example.net", options: ["Done", SCREEN_DIFFERENT_OPTION] };
    const open = `You should see "example.com" listed. (not seen: ${DOC}, 2026-11-20)`;
    const step = (tail: string) => [`In Cloudflare's dashboard, add a public hostname ${open}${tail}`];
    const bad = checkAsk({ ...base, steps: step("") });
    expect(bad.error).toContain("confirmed on <host kind>, <date>");
    expect(bad.error).toContain("not yet confirmed");
    expect(checkAsk({ ...base, steps: step(" (confirmed on TrueNAS SCALE, 22 Nov 2026)") }).error).toBeNull();
    expect(checkAsk({ ...base, steps: step(" (not yet confirmed)") }).error).toBeNull();
  });

  it("ownerSetup (set_ticket_state, create_ticket) goes through the same rule", () => {
    const steps = [`In Cloudflare's dashboard, add a public hostname (not seen: ${DOC}, 2026-11-20)`];
    for (const byCeo of [false, true]) {
      const r = ownerSetupWriteCheck(steps, {}, { byCeo });
      expect(r.error, String(byCeo)).toContain("not yet confirmed");
    }
    expect(ownerSetupWriteCheck([`${steps[0]} (not yet confirmed)`], {}, { byCeo: false })).toEqual({ error: null, override: null });
    expect(ownerSetupWriteCheck([`${steps[0]} (confirmed on TrueNAS SCALE, 22 Nov 2026)`], {}, { byCeo: false })).toEqual({ error: null, override: null });
  });

  it("the CEO's lintOverride naming the step lets it through and is stored with the rule; a non-CEO can't", () => {
    const steps = [`In Cloudflare's dashboard, add a public hostname (not seen: ${DOC}, 2026-11-20)`];
    const why = "The owner already did this on their own account.";
    expect(ownerSetupWriteCheck(steps, {}, { byCeo: false, lintOverride: [{ steps: [1], reason: why }] }).error).toMatch(/Only the CEO/);
    const r = ownerSetupWriteCheck(steps, {}, { byCeo: true, lintOverride: [{ steps: [1], reason: why }] });
    expect(r).toEqual({ error: null, override: expect.any(String) });
    expect(JSON.parse((r as { override: string }).override)).toEqual([{ steps: [1], rules: ["R32"], reason: why }]);
    const card = checkAsk({ triedFirst: "Read the docs; no login.", why: "A public address.", minutes: 5, ownerMustDo: true, options: ["Done", SCREEN_DIFFERENT_OPTION], byCeo: true, lintOverride: [{ steps: [1], reason: why }], steps: [`In Cloudflare's dashboard, add a public hostname. You should see "example.com" listed. (not seen: ${DOC}, 2026-11-20)`] });
    expect(card.error).toBeNull();
  });

  it("steps saved before the rule are not re-checked: the move to review and go-live leave them alone", () => {
    // An existing row: an outside step with a not-seen mark and no confirmed marker, as written before R32.
    const old = [`In Cloudflare's dashboard, add a public hostname (not seen: ${DOC}, 2026-11-20)`];
    expect(ownerSetupWriteCheck(old, {}, { byCeo: true, strict: false })).toEqual({ error: null, override: null });
    const live = checkOwnerSetup(old, {}, "raise");
    expect([...live.hard, ...live.soft].filter((f) => f.rule === "R32")).toEqual([]);
    // The same steps written now are refused.
    expect(checkOwnerSetup(old, {}, "write").soft.map((f) => f.rule)).toEqual(["R32"]);
  });

  it("is overridable, like the other judgement rules", async () => {
    const { NOT_OVERRIDABLE } = await import("../src/services/steps.js");
    expect(NOT_OVERRIDABLE.has("R32")).toBe(false);
  });
});
