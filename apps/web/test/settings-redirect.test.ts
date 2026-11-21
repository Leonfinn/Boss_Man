// Old Settings addresses keep working (BOS-1019, from BOS-1018's build notes): every old URL or anchor lands on
// the page that replaced it, and a current one is left alone. The table is the one App.tsx runs before it renders.
import { describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, SETTINGS_PAGES, settingsPath, settingsRedirect } from "../src/pages/Settings";

const route = (hash: string) => hash.replace(/^#\/?/, "").split("/");

describe("Settings pages", () => {
  it("has the 15 approved pages in 3 groups, in order (BOS-1492, Account added in BOS-2159)", () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(["Money and access", "How the team works", "Server and runner"]);
    expect(SETTINGS_PAGES.map((p) => p.label)).toEqual([
      "Funding", "Secrets", "Account", "Tools and deploys", "Reviews", "Team and CEO", "Watchdog", "Permissions",
      "Updates", "Limits and checks", "Runner", "Email", "This server", "Devices and privacy", "Import and export",
    ]);
  });

  it("gives each page its own URL under the company", () => {
    expect(settingsPath("c1", "funding")).toBe("settings/c1/funding");
    expect(settingsPath(undefined, "funding")).toBe("settings");
  });
});

describe("old Settings links land on the new page (BOS-1018 §5)", () => {
  it("sends #/settings/<co>/access to Tools and deploys", () => {
    expect(settingsRedirect(route("settings/c1/access"), "c1")).toBe("settings/c1/tools");
  });

  it("sends the one-page #/settings/<co>/system to Updates, the first of its six pages, keeping the company (BOS-1492)", () => {
    expect(settingsRedirect(route("settings/c1/system"), "c1")).toBe("settings/c1/updates");
  });

  it("sends #/settings/<co>/workflow to Reviews", () => {
    expect(settingsRedirect(route("settings/c1/workflow"), "c1")).toBe("settings/c1/reviews");
  });

  it("sends the old pages of their own to their Settings page", () => {
    expect(settingsRedirect(route("funding"), "c1")).toBe("settings/c1/funding");
    expect(settingsRedirect(route("secrets"), "c1")).toBe("settings/c1/secrets");
    expect(settingsRedirect(route("rules"), "c1")).toBe("settings/c1/permissions");
    // A rule's scope (the company it was opened for, or "all") is kept.
    expect(settingsRedirect(route("rules/c9"), undefined)).toBe("settings/c9/permissions");
    expect(settingsRedirect(route("rules/all"), "c1")).toBe("settings/c1/permissions");
  });

  it("leaves a current page and the bare menu alone", () => {
    for (const p of SETTINGS_PAGES) expect(settingsRedirect(route(`settings/c1/${p.id}`), "c1"), p.id).toBeNull();
    expect(settingsRedirect(route("settings"), "c1")).toBeNull();
    expect(settingsRedirect(route("settings/c1"), "c1")).toBeNull();
  });

  it("opens the menu for a page that no longer exists", () => {
    expect(settingsRedirect(route("settings/c1/gone"), "c1")).toBe("settings");
  });

  it("leaves every other page alone", () => {
    for (const r of ["board", "agents", "tickets/abc", "runs", "decisions"]) expect(settingsRedirect(route(r), "c1"), r).toBeNull();
  });
});
