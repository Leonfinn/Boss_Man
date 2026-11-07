import { describe, expect, it } from "vitest";
import { checkAsk } from "../src/services/decisions.js";
import { lintOwnerSteps } from "../src/services/steps.js";

// R8 (the screen a step sends the owner to) and R13 (the value of a field a step tells them to fill in), BOS-442.
// The 3 Nov cards' own text isn't kept anywhere the tests can read, so their wording below is rebuilt from the
// cock-ups log (P5) and the BOS-421 addendum: what each said, and where it was wrong.

const rule = (r: string) => (steps: string[], options: string[] = []) => lintOwnerSteps(steps, { options }).refuse.filter((f) => f.rule === r);
const r8 = rule("R8");
const r13 = rule("R13");
const all = (steps: string[]) => lintOwnerSteps(steps, {}).refuse;

describe("R8: the screen a step sends the owner to", () => {
  it("refuses card 1b5189cf's merge-check setting under Settings, and names the right screen", () => {
    for (const s of [
      "Open Settings and set Before merging, Boss Man will to Run the quick check, then press Save.",
      "Open Settings → Server and runner and set **Before merging, Boss Man will** to Run the quick check.",
      "Set the Before merging, Boss Man will… setting to Run the quick check under Settings.",
    ]) {
      const [f, ...more] = r8([s]);
      expect(more, s).toEqual([]);
      expect(f?.problem, s).toContain('"Before merging, Boss Man will"');
      expect(f?.problem, s).toContain("Projects → (the project) → Config");
    }
  });

  it("passes the merge-check setting on the project's Config tab or the Projects page", () => {
    for (const s of [
      "Open Projects → Development → Config, set Before merging, Boss Man will to Run the quick check and press Save.",
      "Open Project → Development → Config and set **Before merging, Boss Man will** to Run the quick check.",
      "Open Project → Config and set Before merging, Boss Man will to Run the quick check.",
      "On the Projects page, set For high-risk work, also to Run the full check.",
    ])
      expect(all([s]), s).toEqual([]);
  });

  it("refuses the 7 Nov ntfy card: Notifications isn't a Settings tab", () => {
    const [f] = r8(["Open Settings → Notifications and tick Send to my phone through my own ntfy server."]);
    expect(f?.problem).toMatch(/Notifications isn't under Settings: it is Notifications/);
    expect(all(["Open Notifications and tick Send to my phone through my own ntfy server."])).toEqual([]);
  });

  it("refuses the first second-Claude-Max card's funding page: sources are added on Access and funding", () => {
    const [f] = r8(["Open Settings → Funding and add a funding source: under **New funding source** set **Kind** to **Anthropic subscription**, then press Save."]);
    expect(f?.problem).toContain("Settings → Access and funding");
    expect(all(["Open Settings → Access and funding. Under **New funding source** set **Kind** to **Anthropic subscription**, then press Save."])).toEqual([]);
  });

  it("refuses a tab under the wrong tab, and a button on another screen", () => {
    expect(r8(["Open Settings → Access and funding → Funding and press Save."])[0]?.problem).toMatch(/Funding isn't under Settings → Access and funding: it is Settings → Funding/);
    expect(r8(["Open Settings → Projects."])[0]?.problem).toMatch(/it is Projects/);
    expect(r8(["Open Settings → Secrets and press Build and update runners."])[0]?.problem).toContain("Settings → Server and runner");
    expect(r8(["Open Settings → Secrets → Build and update runners."])[0]?.problem).toContain("Settings → Server and runner");
  });

  it("passes paths through headings it doesn't know, and buttons every screen has", () => {
    for (const s of [
      "Open Settings → Server and runner → Updates and press Build and update runners.",
      "Settings → Server and runner → Updates → Build and update runners",
      "Open Settings → Secrets, then press Save.",
      "Open Settings → Funding and press Save.",
      "Open Projects, open Acme, click Config, then click Re-detect.",
      "Open Settings → Reviews and CEO and press Run a retro now.",
      "Open BOS-368 and press Approve and merge.",
      "Open Dashboard → Something new and press Save.",
      // A tab named by its first word; "Reviews" is also a button on a ticket's page.
      "Move the review to another agent in Settings → Reviews",
      "Open Settings → Server and runner → Server: Role reads leader, and Settings → Reviews and CEO should look as expected.",
    ])
      expect(r8([s]), s).toEqual([]);
  });

  it("names the screen the path reaches when R7 refuses a button", () => {
    const [f] = rule("R7")(["Open Settings → Server and runner and click Restart server."]);
    expect(f?.problem).toContain("The buttons on Server and runner are:");
  });
});

describe("R13: a field the owner fills in has its value", () => {
  it("refuses the first second-Claude-Max card: no Variable name given", () => {
    const [f, ...more] = r13(["Open Settings → Secrets, choose Claude token under Add, paste the setup-token from step 1 into Value and fill in Variable name, then press Save."]);
    expect(more).toEqual([]);
    expect(f?.problem).toContain('"Variable name"');
  });

  it("passes bac2347c's wording: every field has its value", () => {
    const steps = [
      "Open Settings → Secrets.",
      "Under Add choose Claude token, paste the setup-token from step 1 into Value, set Variable name to `CLAUDE_CODE_OAUTH_TOKEN` and leave Name blank (any name works). Press Save.",
    ];
    expect(all(steps)).toEqual([]);
  });

  it("refuses a field left unsaid however it is named", () => {
    for (const s of [
      "Open Settings → Funding and fill in the Order field.",
      'Open Settings → Secrets and enter a variable name in "Variable name".',
      "Open Settings → Secrets, type the variable name and press Save.",
      "Open Settings → Secrets and set **Name**.",
    ])
      expect(r13([s]).length, s).toBe(1);
  });

  it("passes a value given any way, or a plain 'any value works'", () => {
    for (const s of [
      "Open Settings → Funding and set Order to 2.",
      "Open Settings → Funding and set **Order** to 2.",
      'Open Settings → Secrets and type "GITHUB_TOKEN" in Variable name.',
      "Open Settings → Secrets and fill in Name (any name works, it is only a label).",
      "Open Settings → Secrets, paste the token you copied into Value and press Save.",
      "Open Settings → Access and funding and set Kind to Anthropic subscription.",
      "Open Settings → Secrets and leave Name empty.",
      // Named, not filled in.
      "Open Settings → Secrets: the Variable name field shows CLAUDE_CODE_OAUTH_TOKEN.",
      "Open Notifications and tick Send to my phone through my own ntfy server.",
    ])
      expect(r13([s]), s).toEqual([]);
  });

  it("doesn't take a button or an everyday word for a field", () => {
    for (const s of ["Open Settings → Secrets, click **Add** and choose Claude token.", "Enter your password when asked, then choose the value you want and press Save."])
      expect(r13([s]), s).toEqual([]);
  });
});

describe("R8 and R13 in checkAsk", () => {
  it("refuse a card, and the CEO can override them with a reason", () => {
    const base = { triedFirst: "Read the Secrets page in the web app code." };
    const steps = ["Open Settings → Notifications and fill in Topic."];
    expect(checkAsk({ ...base, steps }).error).toMatch(/Notifications isn't under Settings/);
    const ceo = checkAsk({ ...base, steps, lintOverride: "Checked the screen by hand; the list is behind.", byCeo: true });
    expect(ceo.error).toBeNull();
    expect(ceo.lint?.override?.findings.map((x) => x.rule).sort()).toEqual(["R13", "R8"]);
  });
});
