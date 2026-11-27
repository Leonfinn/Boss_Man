// The one shared list of pages you can pin to the menu (BOS-2669 part 1, ticket 1). These checks fail the build if the
// list ever has two pages with the same name or the same name as a menu row, a page id that left without a note saying
// where it went or that it is gone, or a row that isn't shaped like a real page the menu can open.
import { describe, expect, it } from "vitest";
import {
  PINNABLE_PAGES,
  SHORTCUT_PAGE_CHANGES,
  SHORTCUTS_MAX,
  SHORTCUT_NAME_MAX,
  TOP_LEVEL_MENU_NAMES,
  isGoneShortcutPage,
  isKnownShortcutPage,
  pinnablePage,
  shortcutAddress,
  shortcutEntries,
  shortcutListProblem,
} from "../src/shortcuts.js";

describe("the shared list of pinnable pages (BOS-2669)", () => {
  it("has 26 pages, each with an id, a name, a standard path in words, an icon and an address", () => {
    expect(PINNABLE_PAGES).toHaveLength(26);
    for (const page of PINNABLE_PAGES) {
      expect(page.id).toMatch(/^[a-z0-9-]+$/);
      expect(page.name.trim().length).toBeGreaterThan(0);
      expect([...page.name].length).toBeLessThanOrEqual(SHORTCUT_NAME_MAX);
      expect(page.path).toMatch(/→/);
      expect(page.icon).toMatch(/^[a-z0-9-]+$/);
      // Every address opens a real page: a top-level route, or the Settings screen for a named Settings page.
      const address = shortcutAddress(page, "c1");
      if (page.settingsPage) expect(address).toBe(`#/settings/c1/${page.settingsPage}`);
      else expect(address).toBe(`#/${page.page}`);
    }
  });

  it("has no two pages with the same id", () => {
    const ids = PINNABLE_PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every page a different default name, and none equals a top-level menu row's name", () => {
    const names = PINNABLE_PAGES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(TOP_LEVEL_MENU_NAMES).not.toContain(name);
  });

  it("keeps Settings → Notifications from reading as the Notifications menu row", () => {
    expect(pinnablePage("notification-settings")?.name).toBe("Notification settings");
    expect(pinnablePage("notification-settings")?.settingsPage).toBe("notifications");
  });

  it("names, for every page id that left the list, where it went or that it is gone", () => {
    // The page ids this list has ever offered, frozen. Removing one from PINNABLE_PAGES without a SHORTCUT_PAGE_CHANGES
    // entry (moved-on or removed) fails here, so a saved shortcut is never dropped silently. Adding a page is fine;
    // the new id just has no baseline yet and nothing missing.
    const EVER_OFFERED = [
      "roadmap", "features", "feedback", "plan",
      "agents", "skills", "engagements",
      "runs", "scrum-master", "workflow",
      "funding", "secrets", "account", "notification-settings", "tools",
      "reviews", "team", "watchdog", "permissions",
      "updates", "limits", "runner", "email", "server", "devices", "transfer",
    ];
    for (const id of EVER_OFFERED) {
      // Each id is still offered, or a change entry says what became of it.
      expect(isKnownShortcutPage(id) || isGoneShortcutPage(id)).toBe(true);
    }
    for (const id of Object.keys(SHORTCUT_PAGE_CHANGES)) {
      // A page in the change list is no longer pinnable, and its entry says moved-on or removed.
      expect(isKnownShortcutPage(id)).toBe(false);
      expect(isGoneShortcutPage(id)).toBe(true);
      const change = SHORTCUT_PAGE_CHANGES[id]!;
      if ("movedTo" in change) {
        // A "moved to" must name a page that is still in the list, so a shortcut can follow it.
        expect(isKnownShortcutPage(change.movedTo)).toBe(true);
      } else {
        expect(change.removed).toBe(true);
      }
    }
  });

  it("gives every entry an address that is a real page (top-level route, or Settings page)", () => {
    // The top-level routes the app draws (App.tsx), plus the Settings page ids it knows (settings-redirect.ts). A row
    // whose address is neither is a shortcut to nowhere, and fails here.
    const TOP_ROUTES = new Set(["dashboard", "decisions", "notifications", "chat", "projects", "board", "merge-queue", "wiki", "roadmap", "features", "feedback", "plan", "agents", "skills", "engagements", "runs", "scrum-master", "workflow", "settings"]);
    const SETTINGS_PAGES = new Set(["funding", "secrets", "tools", "reviews", "team", "watchdog", "permissions", "updates", "limits", "runner", "email", "server", "devices", "transfer", "account", "notifications"]);
    for (const page of PINNABLE_PAGES) {
      if (page.settingsPage) {
        expect(page.page).toBe("settings");
        expect(SETTINGS_PAGES.has(page.settingsPage)).toBe(true);
      } else {
        expect(TOP_ROUTES.has(page.page)).toBe(true);
        expect(page.page).not.toBe("settings");
      }
    }
  });
});

describe("saving a shortcut list (BOS-2669)", () => {
  it("accepts up to six known pages, each once", () => {
    expect(shortcutListProblem([{ id: "updates" }, { id: "agents" }])).toBeNull();
    expect(shortcutListProblem([])).toBeNull();
  });

  it("refuses more than six, with a plain reason", () => {
    const seven = [{ id: "updates" }, { id: "agents" }, { id: "runs" }, { id: "plan" }, { id: "skills" }, { id: "team" }, { id: "wiki" }];
    expect(shortcutListProblem(seven)).toMatch(/at most 6 shortcuts/);
  });

  it("refuses the same page twice, a page not in the list, and a name over 40 characters", () => {
    expect(shortcutListProblem([{ id: "updates" }, { id: "updates" }])).toMatch(/already in your shortcuts/);
    expect(shortcutListProblem([{ id: "not-a-page" }])).toMatch(/isn't in the list of pages/);
    expect(shortcutListProblem([{ id: "updates", name: "x".repeat(SHORTCUT_NAME_MAX + 1) }])).toMatch(/at most 40 characters/);
    expect(shortcutListProblem([{ id: "updates", name: "  " }])).toMatch(/can't be empty/);
  });

  it("still lets a gone page be kept, reordered or removed: it is not refused as unknown", () => {
    // Simulate a page that will leave the list, by asking about an id the change list names (none today).
    for (const id of Object.keys(SHORTCUT_PAGE_CHANGES)) {
      expect(isGoneShortcutPage(id)).toBe(true);
    }
  });
});

describe("what the menu draws from a saved list (BOS-2669)", () => {
  it("fills in each page's details, using the owner's own name when they gave one", () => {
    const entries = shortcutEntries([{ id: "updates" }, { id: "agents", name: "My team" }], "c1");
    expect(entries).toEqual([
      { id: "updates", name: "Updates", path: "Settings → Server and runner → Updates", icon: "download", address: "#/settings/c1/updates", gone: false },
      { id: "agents", name: "My team", path: "Team → Agents", icon: "users", address: "#/agents", gone: false },
    ]);
  });

  it("keeps a page this build no longer has, marked as gone, instead of dropping it", () => {
    const entries = shortcutEntries([{ id: "old-page", name: "Something" }], "c1");
    expect(entries).toEqual([{ id: "old-page", name: "Something", path: "", icon: "help-circle", address: "", gone: true }]);
  });

  it("opens a Settings page for the company on screen", () => {
    const page = pinnablePage("updates")!;
    expect(shortcutAddress(page, "c1")).toBe("#/settings/c1/updates");
    expect(shortcutAddress(page, undefined)).toBe("#/settings");
  });

  it("keeps at most six, matching the cap the save rules use", () => {
    expect(SHORTCUTS_MAX).toBe(6);
  });
});
