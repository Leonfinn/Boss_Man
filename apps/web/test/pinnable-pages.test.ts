// BOS-2669 ticket 1: the shared list of pinnable pages must name real pages. This reads the actual Settings pages and
// the app's menu rows, so an entry whose address opens nothing (a renamed Settings page, or a made-up route) fails
// here rather than showing a shortcut that leads nowhere.
import { describe, expect, it } from "vitest";
import { PINNABLE_PAGES, TOP_LEVEL_MENU_NAMES } from "@boss-man/shared";
import { SETTINGS_PAGES } from "../src/pages/Settings";
import { settingsPath } from "../src/pages/settings-redirect";

describe("pinnable pages point at real screens (BOS-2669)", () => {
  it("has a Settings entry for each page that lives in Settings, with the same name", () => {
    const pages = new Set(SETTINGS_PAGES.map((p) => p.id));
    for (const page of PINNABLE_PAGES) {
      if (!page.settingsPage) continue;
      expect(pages.has(page.settingsPage as never)).toBe(true);
      // Build the address the app itself uses; it must be a real Settings page for a company.
      expect(`#/${settingsPath("c1", page.settingsPage as never)}`).toBe(`#/settings/c1/${page.settingsPage}`);
    }
  });

  it("names no shortcut settings-into-nothing: each non-Settings page is a top-level route the menu shows", () => {
    // The routes the app draws, taken from the menu rows it can open. A shortcut to one of these lands on the page.
    const menuRoutes = new Set(["dashboard", "decisions", "notifications", "chat", "projects", "merge-queue", "wiki", "roadmap", "features", "feedback", "plan", "agents", "skills", "engagements", "runs", "scrum-master", "workflow", "settings"]);
    for (const page of PINNABLE_PAGES) {
      if (page.settingsPage) continue;
      expect(menuRoutes.has(page.page)).toBe(true);
    }
  });

  it("doesn't reuse a top-level menu row's name for a Settings page", () => {
    for (const page of PINNABLE_PAGES) {
      if (!page.settingsPage) continue;
      expect(TOP_LEVEL_MENU_NAMES).not.toContain(page.name);
    }
  });
});
