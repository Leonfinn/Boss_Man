// The one list of pages you can pin to the menu, and the rules for saving them (BOS-2669 part 1, ticket 1).
// The menu (ticket 2), the edit dialog (ticket 3), the g-then-number keys (ticket 4) and the save on the server
// all read from here, so a page you can pin is a page that is listed. To add a shortcut, add a row here.
//
// A shortcut is saved as a page id plus an optional name of your own; never as a free web address, so it can
// never point outside the app, and when an update renames or moves a page the shortcut follows it.

import { z } from "zod";

/** Most shortcuts at once: 6 keeps the whole top block (Dashboard, Decisions, Notifications, Chat) in view. */
export const SHORTCUTS_MAX = 6;

/** Most characters in a shortcut's own name. */
export const SHORTCUT_NAME_MAX = 40;

/**
 * The top-level menu rows, by name: the ones that are a clickable row of their own, not a group heading (Product, Team
 * and Activity head groups). A page's default name never equals one of these, so the menu never shows two rows with
 * the same name; Settings → Notifications starts as "Notification settings" for the same reason.
 */
export const TOP_LEVEL_MENU_NAMES: readonly string[] = [
  "Dashboard",
  "Decisions",
  "Notifications",
  "Chat",
  "Projects",
  "Merge queue",
  "Wiki",
  "Settings",
  "Log out",
];

/** A page that can be pinned to the menu. */
export type PinnablePage = {
  /** The id saved in the list: stable, never shown to the owner. */
  id: string;
  /** The name the shortcut starts with. */
  name: string;
  /** The standard path in words, e.g. "Settings → Server and runner → Updates". */
  path: string;
  /** The app's own top-level route id (e.g. "roadmap"), for building its address. */
  page: string;
  /** The Settings page id when this page lives in Settings (e.g. "updates"); its address needs the company on screen. */
  settingsPage?: string;
  /** The menu icon's name (a lucide icon in the web app), so the list has no second copy of it. */
  icon: string;
};

/**
 * Every page more than one click away today, in the order they appear in the menu and in Settings. Settings pages
 * open for the company on screen, like the menu, so their address needs that company (see `shortcutAddress`).
 */
export const PINNABLE_PAGES: readonly PinnablePage[] = [
  // Product (in the menu).
  { id: "roadmap", name: "Roadmap", path: "Product → Roadmap", page: "roadmap", icon: "map" },
  { id: "features", name: "Features", path: "Product → Features", page: "features", icon: "sparkles" },
  { id: "feedback", name: "Feedback", path: "Product → Feedback", page: "feedback", icon: "message-circle" },
  { id: "plan", name: "Plan", path: "Product → Plan", page: "plan", icon: "list-checks" },
  // Team (in the menu).
  { id: "agents", name: "Agents", path: "Team → Agents", page: "agents", icon: "users" },
  { id: "skills", name: "Skills", path: "Team → Skills", page: "skills", icon: "puzzle" },
  { id: "engagements", name: "Engagements", path: "Team → Engagements", page: "engagements", icon: "handshake" },
  // Activity (in the menu).
  { id: "runs", name: "Runs", path: "Activity → Runs", page: "runs", icon: "activity" },
  { id: "scrum-master", name: "Scrum Master log", path: "Activity → Scrum Master log", page: "scrum-master", icon: "shield-check" },
  { id: "workflow", name: "Workflow report", path: "Activity → Workflow report", page: "workflow", icon: "workflow" },
  // Settings → Money and access.
  { id: "funding", name: "Funding", path: "Settings → Money and access → Funding", page: "settings", settingsPage: "funding", icon: "wallet" },
  { id: "secrets", name: "Secrets", path: "Settings → Money and access → Secrets", page: "settings", settingsPage: "secrets", icon: "key" },
  { id: "account", name: "Account", path: "Settings → Money and access → Account", page: "settings", settingsPage: "account", icon: "id-card" },
  { id: "notification-settings", name: "Notification settings", path: "Settings → Money and access → Notifications", page: "settings", settingsPage: "notifications", icon: "bell" },
  { id: "tools", name: "Tools and deploys", path: "Settings → Money and access → Tools and deploys", page: "settings", settingsPage: "tools", icon: "plug" },
  // Settings → How the team works.
  { id: "reviews", name: "Reviews", path: "Settings → How the team works → Reviews", page: "settings", settingsPage: "reviews", icon: "check-check" },
  { id: "team", name: "Team and CEO", path: "Settings → How the team works → Team and CEO", page: "settings", settingsPage: "team", icon: "user-cog" },
  { id: "watchdog", name: "Watchdog", path: "Settings → How the team works → Watchdog", page: "settings", settingsPage: "watchdog", icon: "dog" },
  { id: "permissions", name: "Permissions", path: "Settings → How the team works → Permissions", page: "settings", settingsPage: "permissions", icon: "shield" },
  // Settings → Server and runner.
  { id: "updates", name: "Updates", path: "Settings → Server and runner → Updates", page: "settings", settingsPage: "updates", icon: "download" },
  { id: "limits", name: "Limits and checks", path: "Settings → Server and runner → Limits and checks", page: "settings", settingsPage: "limits", icon: "gauge" },
  { id: "runner", name: "Runner", path: "Settings → Server and runner → Runner", page: "settings", settingsPage: "runner", icon: "cpu" },
  { id: "email", name: "Email", path: "Settings → Server and runner → Email", page: "settings", settingsPage: "email", icon: "mail" },
  { id: "server", name: "This server", path: "Settings → Server and runner → This server", page: "settings", settingsPage: "server", icon: "server" },
  { id: "devices", name: "Devices and privacy", path: "Settings → Server and runner → Devices and privacy", page: "settings", settingsPage: "devices", icon: "smartphone" },
  { id: "transfer", name: "Import and export", path: "Settings → Server and runner → Import and export", page: "settings", settingsPage: "transfer", icon: "arrow-left-right" },
] as const;

/** Where a page id that left the list went, or that it is gone for good. */
export type ShortcutPageChange = { movedTo: string } | { removed: true };

/**
 * Pages that have left the shared list, and what happened to them. A saved shortcut that points at one of these is
 * still returned (marked as gone), so an update never silently drops a shortcut the owner saved.
 */
export const SHORTCUT_PAGE_CHANGES: Readonly<Record<string, ShortcutPageChange>> = {};

const byId = new Map(PINNABLE_PAGES.map((p) => [p.id, p]));

/** The page a saved id names, or undefined for one this build no longer has. */
export function pinnablePage(id: string): PinnablePage | undefined {
  return byId.get(id);
}

/** Whether the list still has this id (a shortcut to it is live, not gone). */
export function isKnownShortcutPage(id: string): boolean {
  return byId.has(id);
}

/** Whether a saved id names a page that has left the list (moved on or removed). */
export function isGoneShortcutPage(id: string): boolean {
  return !byId.has(id) && id in SHORTCUT_PAGE_CHANGES;
}

/**
 * One saved shortcut: which page (from the shared list) and the owner's own name for it, if they gave one. The
 * name is optional; without it the menu uses the page's own name.
 */
export const SavedShortcut = z.object({
  id: z.string(),
  name: z.string().optional(),
});
export type SavedShortcut = z.infer<typeof SavedShortcut>;

/**
 * What the menu draws for one saved shortcut: the page's details from the shared list (or, for a page this build
 * no longer has, the stored name and a "gone" mark so it is never dropped silently).
 */
export const ShortcutEntry = z.object({
  id: z.string(),
  /** The name to show: the owner's own name, else the page's name, else (for a gone page) the stored name. */
  name: z.string(),
  path: z.string(),
  icon: z.string(),
  /** The address it opens, worked out from the page; empty for a page that has gone. */
  address: z.string(),
  /** True when this build no longer has the page, but the owner's shortcut is still kept. */
  gone: z.boolean().default(false),
});
export type ShortcutEntry = z.infer<typeof ShortcutEntry>;

/** A name over the limit, in characters as the owner sees them. */
export function shortcutNameTooLong(name: string): boolean {
  return [...name].length > SHORTCUT_NAME_MAX;
}

/** Why a list can't be saved, as a plain sentence for the owner, or null when it can. */
export function shortcutListProblem(list: readonly SavedShortcut[]): string | null {
  if (list.length > SHORTCUTS_MAX) return `You can have at most ${SHORTCUTS_MAX} shortcuts. Remove one to add another.`;
  const seen = new Set<string>();
  for (const item of list) {
    const page = pinnablePage(item.id);
    if (seen.has(item.id)) return `${page?.name ?? "That page"} is already in your shortcuts.`;
    seen.add(item.id);
    if (!page && !isGoneShortcutPage(item.id)) return "One of those pages isn't in the list of pages you can pin.";
    if (item.name !== undefined && shortcutNameTooLong(item.name)) return `A shortcut's name can be at most ${SHORTCUT_NAME_MAX} characters.`;
    if (item.name !== undefined && item.name.trim() === "") return "A shortcut's name can't be empty. Leave the name out to use the page's own name.";
  }
  return null;
}

/** The address a shortcut opens for the company on screen: a top-level page, or a Settings page for that company. */
export function shortcutAddress(page: PinnablePage, companyId: string | undefined): string {
  if (page.settingsPage) return companyId ? `#/settings/${companyId}/${page.settingsPage}` : "#/settings";
  return `#/${page.page}`;
}

/**
 * Builds what the menu draws from a saved list: a live entry from the shared list, or a gone one (kept, with its
 * stored name) so it is never dropped silently. The address needs the company on screen; pass null while none is
 * chosen and the address is the plain page. Used by the server, so saved and read-back lists always agree.
 */
export function shortcutEntries(saved: readonly SavedShortcut[], companyId: string | undefined = undefined): ShortcutEntry[] {
  return saved.map((item) => {
    const page = pinnablePage(item.id);
    if (page) {
      return { id: page.id, name: item.name ?? page.name, path: page.path, icon: page.icon, address: shortcutAddress(page, companyId), gone: false };
    }
    return { id: item.id, name: item.name ?? item.id, path: "", icon: "help-circle", address: "", gone: true };
  });
}
