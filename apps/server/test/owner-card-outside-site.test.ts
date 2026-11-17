import { describe, expect, it } from "vitest";
import { leftoverCheckerTag } from "@boss-man/shared";
import { checkAsk } from "../src/services/decisions.js";
import { lintOwnerSteps, outsideSiteKeys, SCREEN_DIFFERENT_OPTION, siteKey } from "../src/services/steps.js";

// R19: a step on someone else's website says where its clicks came from (seen: image / not seen: doc, date).

const NOW = new Date("2026-11-12T12:00:00Z");
const IMG = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const SERVER = "boss.example.net";
const DOC = "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/";
const all = (steps: string[], f: Parameters<typeof lintOwnerSteps>[1] = {}) =>
  lintOwnerSteps(steps, { serverHost: SERVER, now: NOW, ...(f as object) }).refuse.filter((x) => x.rule === "R19");
// The R19 seen / not seen checks; the opening-checkpoint finding (R19c) has its own tests below.
const lint = (steps: string[], f: Parameters<typeof lintOwnerSteps>[1] = {}) => all(steps, f).filter((x) => !/checkpoint/.test(x.problem));
const checkpoint = (steps: string[], f: Parameters<typeof lintOwnerSteps>[1] = { options: [SCREEN_DIFFERENT_OPTION] }) => all(steps, f).filter((x) => /checkpoint/.test(x.problem));
const NOT_SEEN = `(not seen: ${DOC}, 2026-11-10)`;

describe("R19: steps on outside websites", () => {
  it("refuses an outside URL step with no seen / not seen mark, and says what to add", () => {
    const r = lint(["Open https://dash.cloudflare.com/profile/api-tokens and press Create Token."]);
    expect(r).toHaveLength(1);
    expect(r[0]!.problem).toContain("seen: <ticket image id>");
    expect(r[0]!.problem).toContain("not seen: <doc URL>, <YYYY-MM-DD>");
    expect(r[0]!.problem).toContain(SCREEN_DIFFERENT_OPTION);
  });

  it("refuses a vendor named in words, with no URL", () => {
    expect(lint(["In the Cloudflare dashboard, open My Profile, then API Tokens."])).toHaveLength(1);
    expect(lint(["Go to your GitHub settings and create a token."])).toHaveLength(1);
  });

  it("accepts a fresh seen image, and refuses an unknown or old one", () => {
    const step = [`Open https://dash.cloudflare.com/profile/api-tokens (seen: ${IMG}) and press Create Token.`];
    expect(lint(step)).toEqual([]); // no image dates given: form only
    expect(lint(step, { images: { [IMG]: "2026-11-01T00:00:00Z" } })).toEqual([]);
    expect(lint(step, { images: {} })[0]!.problem).toContain("not an image attached");
    const old = lint(step, { images: { [IMG]: "2026-09-01T00:00:00Z" } });
    expect(old).toHaveLength(1);
    expect(old[0]!.problem).toContain("days old");
  });

  it("a not seen step needs a doc URL and a real past date, and the card needs the 'screen looks different' option", () => {
    const step = [`Open https://dash.cloudflare.com/profile/api-tokens (not seen: ${DOC}, 2026-11-12) and press Create Token.`];
    expect(lint(step)).toEqual([]); // no options given: card check skipped
    expect(lint(step, { options: ["Done"] })).toHaveLength(1);
    expect(lint(step, { options: ["Done", SCREEN_DIFFERENT_OPTION] })).toEqual([]);
    expect(lint(step, { options: ["Done", "my screen looks different, will send a shot"] })).toEqual([]);
    expect(lint([`Open https://dash.cloudflare.com (not seen: ${DOC}, 2027-05-01).`], { options: [SCREEN_DIFFERENT_OPTION] })).toHaveLength(1);
  });

  it("a stale seen image counts as not seen, so the card also needs the option", () => {
    const step = [`Open https://dash.cloudflare.com (seen: ${IMG}).`];
    const f = { images: { [IMG]: "2026-09-01T00:00:00Z" }, options: ["Done", SCREEN_DIFFERENT_OPTION] };
    expect(lint(step, f)).toHaveLength(1); // the step itself must be rewritten as not seen
  });

  it("leaves Boss Man's own screens, own-host links and commands alone", () => {
    expect(lint(["Open Settings → Secrets and press Save."])).toEqual([]);
    expect(lint([`Open https://${SERVER}/settings and look at the page.`])).toEqual([]);
    expect(lint(["Open http://192.168.1.20:3100/settings and look."])).toEqual([]);
    expect(lint(["Open http://localhost:3100/ and look."])).toEqual([]);
    expect(lint(["Check that the page loads at https://boss.example.net/."])).toEqual([]);
  });

  it("works through checkAsk: refused without the mark, goes through with it and the option", () => {
    const base = { triedFirst: "Checked the docs; an agent has no login to the owner's Cloudflare account.", ownerMustDo: true, serverHost: SERVER };
    const bad = checkAsk({ ...base, steps: ["Open https://dash.cloudflare.com/profile/api-tokens and press Create Token."], options: ["Done"] });
    expect(bad.error).toContain("doesn't say where its clicks came from");
    const ok = checkAsk({ ...base, steps: [`Open https://dash.cloudflare.com ${NOT_SEEN}. You should see "holidayhours" listed.`, `Open https://dash.cloudflare.com/profile/api-tokens ${NOT_SEEN} and press Create Token.`], options: ["Done", SCREEN_DIFFERENT_OPTION] });
    expect(ok.error).toBeNull();
  });

  // BOS-1665: the owner's steps leave checkAsk without any checker tag, and the source of each step is kept beside them.
  it("takes every checker tag out of the owner's steps once, and keeps the source of each step", () => {
    const base = { triedFirst: "Checked the docs; an agent has no login to the owner's Cloudflare account.", ownerMustDo: true, serverHost: SERVER, options: ["Done", SCREEN_DIFFERENT_OPTION], images: { [IMG]: "2026-11-10T08:00:00Z" } };
    const ok = checkAsk({ ...base, steps: [`Open https://dash.cloudflare.com (seen: ${IMG}). You should see "holidayhours" listed.`, `Open https://dash.cloudflare.com/profile/api-tokens ${NOT_SEEN} and press Create Token.`, "Open Settings → Secrets and press Save."] });
    expect(ok.error).toBeNull();
    for (const s of ok.steps!) expect(leftoverCheckerTag(s), s).toBeUndefined();
    expect(ok.steps![0]).toContain('You should see "holidayhours" listed.');
    expect(ok.stepSources).toEqual([{ kind: "seen", imageId: IMG, takenAt: "2026-11-10" }, { kind: "notSeen", url: DOC, date: "2026-11-10" }, null]);
  });
});

// R19b: once a site's docs have misled the owner, a `not seen` step there needs their screenshot for 30 days.
describe("R19b: a site whose docs misled the owner needs a screenshot", () => {
  const OPT = { options: ["Done", SCREEN_DIFFERENT_OPTION] };
  const notSeenStep = `Open https://dash.cloudflare.com/profile/api-tokens ${NOT_SEEN} and press Create Token.`;
  const seenStep = `Open https://dash.cloudflare.com/profile/api-tokens (seen: ${IMG}) and press Create Token.`;
  const mismatch = { mismatchedSites: { cloudflare: "2026-11-10T09:00:00Z" } };

  it("the Cloudflare case: a recorded mismatch refuses not seen, and a fresh seen image passes", () => {
    const refused = lint([notSeenStep], { ...OPT, ...mismatch });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.problem).toContain("ask the owner for one screenshot of their starting page first");
    expect(refused[0]!.problem).toContain("2026-11-10");
    // The refusal is the same for a vendor named in words, and for a different host of the same vendor.
    expect(lint(["In the Cloudflare dashboard open API Tokens (not seen: " + DOC + ", 2026-11-10)."], { ...OPT, ...mismatch })).toHaveLength(1);
    expect(lint([`Open https://api.cloudflare.com/x ${NOT_SEEN}.`], { ...OPT, ...mismatch })).toHaveLength(1);
    expect(lint([seenStep], { ...OPT, ...mismatch, images: { [IMG]: "2026-11-11T00:00:00Z" } })).toEqual([]);
  });

  it("a site with no record, or another vendor, still passes on not seen (R19 unchanged)", () => {
    expect(lint([notSeenStep], OPT)).toEqual([]);
    expect(lint([`Open https://github.com/settings/tokens ${NOT_SEEN}.`], { ...OPT, ...mismatch })).toEqual([]);
  });

  it("a stale screenshot does not get round it, and the record lapses after 30 days", () => {
    const stale = lint([seenStep], { ...OPT, ...mismatch, images: { [IMG]: "2026-09-01T00:00:00Z" } });
    expect(stale).toHaveLength(1);
    expect(stale[0]!.problem).toContain("ask the owner for one screenshot of their starting page first");
    expect(lint([notSeenStep], { ...OPT, mismatchedSites: { cloudflare: "2026-10-01T09:00:00Z" } })).toEqual([]);
  });

  it("keys one vendor the same however it is written", () => {
    expect(siteKey("dash.cloudflare.com")).toBe("cloudflare");
    expect(siteKey("Cloudflare")).toBe("cloudflare");
    expect(siteKey("console.aws.amazon.com")).toBe("aws");
    expect(siteKey("AWS console")).toBe("aws");
    expect(siteKey("portal.example.co.uk")).toBe("example");
    expect(outsideSiteKeys(`Open https://dash.cloudflare.com and then GitHub ${NOT_SEEN}`, SERVER).sort()).toEqual(["cloudflare", "github"]);
  });
});

// R19c: a card with outside-site steps opens with a checkpoint that names something concrete.
describe("R19c: the opening checkpoint", () => {
  const step2 = `Open https://dash.cloudflare.com/profile/api-tokens ${NOT_SEEN} and press Create Token.`;
  const good = `Open https://dash.cloudflare.com ${NOT_SEEN}. You should see "holidayhours" listed.`;

  it("refuses a card that goes straight to the clicks", () => {
    const r = checkpoint([step2]);
    expect(r).toHaveLength(1);
    expect(r[0]!.problem).toContain("must open with a checkpoint");
  });

  it("refuses a checkpoint that names nothing concrete", () => {
    for (const vague of ["You should see your account.", "You should see the dashboard.", "Check that your project is listed."]) {
      const r = checkpoint([`Open https://dash.cloudflare.com ${NOT_SEEN}. ${vague}`, step2]);
      expect(r, vague).toHaveLength(1);
      expect(r[0]!.problem).toContain("names nothing concrete");
    }
    // The URL the step opens is not "something the owner will see".
    expect(checkpoint([`Open https://dash.cloudflare.com ${NOT_SEEN}. You should see your account.`, step2])).toHaveLength(1);
  });

  it("accepts a quoted, backticked or domain name, and 'Check that … is listed'", () => {
    expect(checkpoint([good, step2])).toEqual([]);
    expect(checkpoint([`Open https://dash.cloudflare.com ${NOT_SEEN}. You should see \`holidayhours\` listed.`, step2])).toEqual([]);
    expect(checkpoint([`Open https://dash.cloudflare.com ${NOT_SEEN}. Check that example.com is listed.`, step2])).toEqual([]);
  });

  it("needs the stop option, and only applies when the card has outside-site steps and its options are known", () => {
    expect(checkpoint([good, step2], { options: ["Done"] })[0]!.problem).toContain("no stop");
    expect(checkpoint(["Open Settings → Secrets and press Save."])).toEqual([]);
    expect(checkpoint([step2], {})).toEqual([]);
  });
});
