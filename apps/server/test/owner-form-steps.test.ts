// DR-057 (BOS-1285): a form step on an owner card carries every value, and another company's values come from the
// server's record or an answered engagement. R18 is tested row by row; the registry is checked against the web forms.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNER_FIELDS, OWNER_FORMS } from "@boss-man/shared";
import { type CompanyFacts, companySlug, fillCompanyFacts, pickTarget } from "../src/services/company-facts.js";
import { checkOwnerSetup, ownerSetupWriteCheck } from "../src/services/owner-setup-check.js";
import { lintOwnerSteps } from "../src/services/steps.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const r18 = (steps: string[]) => lintOwnerSteps(steps).refuse.filter((f) => f.rule === "R18");

// The go-live steps of BOS-619 as the owner got them on card fe62c5f7 (12 Nov), word for word.
const FE62 = [
  "Settings → Access and funding → (the company) → Deploy targets: add the target if it isn't there yet, or press Edit on it.",
  'Tick "After a successful deploy, move tag", enter the tag name (HolidayHours: live-deployed, in the holidayhours project) and press Save. The company\'s runner must be connected when you save.',
  'If the git host protects that tag, allow the Boss Man git token\'s user to update it (open "If the git host protects the tag" under the setting for your host\'s steps).',
];

describe("R18: a step on a registered form gives every value", () => {
  // On main (463ffce8) step 1 alone passes the write check with no finding; only step 2's tag name was caught (R13).
  it("refuses the fe62c5f7 card at its first step, naming each missing field", () => {
    const [f, ...more] = r18(FE62);
    expect(more).toEqual([]);
    expect(f!.step).toBe(1);
    for (const field of ['"Name"', '"Kind"', '"Address"', '"Tag name"', '"In the repo of"']) expect(f!.problem).toContain(field);
    expect(f!.problem).toContain("if it isn't there");
    expect(f!.problem).toContain("Settings → Tools and deploys");
  });

  it("refuses an add step with some values missing, and names only those", () => {
    const [f] = r18(["Open Settings → Tools and deploys and add a deploy target: Name `production`, Kind SSH host."]);
    expect(f!.problem).toContain('"Address"');
    expect(f!.problem).not.toContain('"Name"');
    expect(f!.problem).not.toContain('"Kind"');
  });

  it("refuses an edit that doesn't say which entry", () => {
    const [f] = r18(["Open Settings → Tools and deploys, press Edit on the deploy target, tick \"After a successful deploy, move tag\", set Tag name to `live-deployed` and In the repo of to `web`."]);
    expect(f!.problem).toContain("which entry to edit");
  });

  it("refuses a Settings → … form Boss Man doesn't list", () => {
    const [f] = r18(["Open Settings → Watchdog and fill in the form with your limits."]);
    expect(f!.problem).toContain("a form Boss Man doesn't list");
  });

  it("passes rows that give every value", () => {
    for (const steps of [
      ["Open Settings → Tools and deploys and add a deploy target: Name `production`, Kind SSH host, Address `deploy@203.0.113.5`. Press Add target."],
      ["Open Settings → Tools and deploys and add a deploy target with Name `prod`, set Kind to Git remote and Address to `https://git.example.com/acme/site.git`."],
      // Two steps on the same form are one visit: the second ticks the tag box on the entry the first made.
      [
        "Open Settings → Tools and deploys and add a deploy target: Name `{{company.acme.deployTarget.name}}`, Kind `{{company.acme.deployTarget.kind}}`, Address `{{company.acme.deployTarget.address}}`.",
        'Tick "After a successful deploy, move tag" on the deploy target: Tag name `live-deployed`, In the repo of `web`, then press Add target.',
      ],
      ['Open Settings → Tools and deploys, press Edit on `production` (the deploy target), tick "After a successful deploy, move tag", set Tag name to `live-deployed` and In the repo of to `web`, then press Save.'],
      ["Add a tool server on Settings → Tools and deploys: Server name `scrapling`, Server URL `http://192.0.2.10:30301/mcp`."],
      ["Add a secret on Settings → Secrets: Variable name `GITHUB_TOKEN`, and paste your GitHub token into Value."],
      // Look-only: no add, edit or fill.
      ["Open Settings → Tools and deploys and check the deploy target `production` shows a green tag result."],
      // No form at all.
      ["Open Settings → Server and runner → Updates and press Build and update runners."],
    ]) expect(r18(steps), steps.join(" / ")).toEqual([]);
  });

  it("can be let through by a CEO override, like R17", () => {
    const w = ownerSetupWriteCheck([FE62[0]!], {}, { byCeo: true, lintOverride: "The owner set this target up by hand on 12 Nov already." });
    expect(w.error).toBeNull();
    expect(ownerSetupWriteCheck([FE62[0]!], {}, { byCeo: false }).error).toContain("Deploy targets → Add a deploy target");
  });
});

describe("R18 registry: every required field in a web form is listed", () => {
  /** The labels of every input/select marked `required` in the form that starts at `start`. */
  function requiredLabels(file: string, start: string): string[] {
    const src = readFileSync(`${ROOT}${file}`, "utf8");
    const from = src.indexOf(start);
    expect(from, `${start} in ${file}`).toBeGreaterThanOrEqual(0);
    const form = src.slice(from, src.indexOf("</form>", from));
    const out: string[] = [];
    const text = (raw: string) => (/"([^"]+)"\s*\}?\s*$/.exec(raw.trim())?.[1] ?? raw).replace(/\s+/g, " ").trim();
    // <label htmlFor="x">Text</label> … <input id="x" … required …>
    for (const m of form.matchAll(/<label[^>]*htmlFor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)) {
      const control = new RegExp(String.raw`<(?:input|select|textarea)\b[^>]*\bid="${m[1]}"[^>]*>`).exec(form)?.[0] ?? "";
      if (/\brequired\b/.test(control)) out.push(text(m[2]!));
    }
    // <label …>Text <input … required …> (a label wrapped round its control)
    for (const m of form.matchAll(/<label(?![^>]*htmlFor)[^>]*>\s*([^<{]+?)\s*<(input|select|textarea)\b([^>]*)>/g)) if (/\brequired\b/.test(m[3]!)) out.push(text(m[1]!));
    return out;
  }

  for (const form of OWNER_FORMS) {
    it(`${form.name}: the registry has every required field, and each is a listed field on ${form.screen}`, () => {
      const listed = new Set([...form.required, ...(form.groups ?? []).flatMap((g) => g.fields), ...(form.notChecked ?? [])].map((f) => f.label));
      const required = requiredLabels(form.source.file, form.source.start);
      expect(required.length).toBeGreaterThan(0);
      expect(required.filter((l) => !listed.has(l))).toEqual([]);
      const fields = new Set<string>((OWNER_FIELDS as Record<string, readonly string[]>)[form.screen] ?? []);
      expect([...listed].filter((l) => !fields.has(l))).toEqual([]);
    });
  }

  it("the reader finds a required field it isn't told about (the test can fail)", () => {
    const required = requiredLabels("apps/web/src/pages/settings/Tools.tsx", 'aria-labelledby="deploy-target-form-h"');
    expect(required).toEqual(expect.arrayContaining(["Name", "Address", "Tag name", "In the repo of"]));
  });
});

const ACME = "a0000000-0000-4000-8000-000000000001";
const OWN = "b0000000-0000-4000-8000-000000000002";
const ENG = "c0000000-0000-4000-8000-000000000003";
const facts = (target: CompanyFacts["companies"][number]["target"], engagements: CompanyFacts["engagements"] = {}): CompanyFacts => ({
  own: { id: OWN, name: "Boss Man Co" },
  companies: [{ id: ACME, name: "Acme Holidays", slug: "acme-holidays", target }],
  engagements,
});
const PROD = { name: "production", kind: "SSH host", address: "deploy@203.0.113.5", tagName: null };

describe("company facts: tokens and branches filled from the server's record", () => {
  it("slugs a company name the way the token writes it", () => {
    expect(companySlug("Acme Holidays")).toBe("acme-holidays");
    expect(companySlug("Café  Ünïcode!")).toBe("cafe-unicode");
  });

  it("picks the one target, or the one production target, and says when it can't tell", () => {
    const row = (name: string, isProduction: boolean) => ({ name, kind: "ssh", endpoint: `u@${name}`, isProduction, rules: {} });
    expect(pickTarget([])).toBeNull();
    expect(pickTarget([row("a", false)])).toMatchObject({ name: "a", kind: "SSH host" });
    expect(pickTarget([row("a", false), row("b", true)])).toMatchObject({ name: "b" });
    expect(pickTarget([row("a", true), row("b", true)])).toBe("several");
  });

  const BRANCHES = [
    "[if company.acme-holidays.deployTarget exists] Open Settings → Tools and deploys, press Edit on `{{company.acme-holidays.deployTarget.name}}` (the deploy target), tick \"After a successful deploy, move tag\", set Tag name to `live-deployed` engagement:" + ENG + " and In the repo of to `web`, then press Save.",
    "[if company.acme-holidays.deployTarget is missing] Open Settings → Tools and deploys and add a deploy target for Acme Holidays: Name `production`, Kind SSH host, Address `deploy@203.0.113.5` (engagement:" + ENG + ").",
  ];
  const answered = { [ENG]: { providerCompanyId: ACME, requesterCompanyId: OWN, answeredAt: "2026-11-12T10:00:00.000Z" } };

  it("keeps only the branch that applies at go-live, fills the tokens and shows who confirmed the value", () => {
    const c = checkOwnerSetup(BRANCHES, { company: facts(PROD, answered) }, "raise");
    expect([...c.hard, ...c.soft]).toEqual([]);
    expect(c.steps).toHaveLength(1);
    expect(c.steps[0]).toContain("press Edit on `production`");
    expect(c.steps[0]).toContain("(confirmed by Acme Holidays on 2026-11-12)");
    expect(c.steps[0]).not.toMatch(/\[if|\{\{|engagement:/);
    const none = checkOwnerSetup(BRANCHES, { company: facts(null, answered) }, "raise");
    expect([...none.hard, ...none.soft]).toEqual([]);
    expect(none.steps).toHaveLength(1);
    expect(none.steps[0]).toContain("add a deploy target for Acme Holidays");
  });

  it("checks both branches when written, and lets a token with no record yet through until go-live", () => {
    const w = checkOwnerSetup(BRANCHES, { company: facts(null, answered) }, "write");
    expect(w.steps).toHaveLength(2);
    expect([...w.hard, ...w.soft]).toEqual([]);
  });

  it("sends an unfilled token or an unsettled branch to the CEO at go-live (R4, not overridable)", () => {
    const several = checkOwnerSetup(BRANCHES, { company: facts("several", answered) }, "raise");
    expect(several.hard.map((f) => f.rule)).toContain("R4");
    const token = checkOwnerSetup(["Open Settings → Tools and deploys and press Edit on `{{company.acme-holidays.deployTarget.name}}` (the deploy target), then set Tag name to `x` and In the repo of to `web`."], { company: facts(null) }, "raise");
    expect(token.hard.map((f) => f.problem).join("\n")).toContain("{{company.acme-holidays.deployTarget.name}}");
  });

  it("refuses a token in the branch for when there is no target (nothing to fill it from)", () => {
    const { findings } = fillCompanyFacts(["[if company.acme-holidays.deployTarget is missing] Add a deploy target: Name `{{company.acme-holidays.deployTarget.name}}`."], facts(null), "write");
    expect(findings.map((f) => f.rule)).toEqual(["R4"]);
  });

  it("refuses a branch on a company Boss Man doesn't have", () => {
    const { findings } = fillCompanyFacts(["[if company.nobody.deployTarget exists] Press Edit on it."], facts(PROD), "raise");
    expect(findings[0]!.problem).toContain('company "nobody"');
  });
});

describe("R18b: another company's value needs that company's answer", () => {
  const STEP = "Open Settings → Tools and deploys, press Edit on `production` (Acme Holidays' deploy target), tick \"After a successful deploy, move tag\", set Tag name to `live-deployed` and In the repo of to `web`, then press Save.";
  const r18b = (step: string, eng: CompanyFacts["engagements"] = {}) => fillCompanyFacts([step], facts(PROD, eng), "raise").findings.filter((f) => f.rule === "R18b");

  it("refuses a typed value for another company with no engagement cited", () => {
    const [f] = r18b(STEP);
    expect(f!.problem).toContain("Acme Holidays");
    expect(f!.problem).toContain("cites no engagement");
  });

  it("refuses an engagement that isn't that company's answer to this one", () => {
    const cited = `${STEP} (engagement:${ENG})`;
    expect(r18b(cited)).toHaveLength(1); // no such engagement
    expect(r18b(cited, { [ENG]: { providerCompanyId: ACME, requesterCompanyId: OWN, answeredAt: null } })).toHaveLength(1); // not answered
    expect(r18b(cited, { [ENG]: { providerCompanyId: OWN, requesterCompanyId: ACME, answeredAt: "2026-11-12T10:00:00Z" } })).toHaveLength(1); // the wrong way round
    expect(r18b(cited, { [ENG]: { providerCompanyId: ACME, requesterCompanyId: OWN, answeredAt: "2026-11-12T10:00:00Z" } })).toEqual([]);
  });

  it("passes values taken from the record, and steps about this company's own forms", () => {
    expect(r18b("Open Settings → Tools and deploys and press Edit on `{{company.acme-holidays.deployTarget.name}}` (Acme Holidays' deploy target).")).toEqual([]);
    expect(r18b("Open Settings → Tools and deploys and add a deploy target: Name `production`, Kind SSH host, Address `deploy@203.0.113.5`.")).toEqual([]);
  });
});
