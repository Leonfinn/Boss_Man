// The Settings addresses, kept apart from the Settings page itself so the app shell can redirect an old address
// without loading the whole Settings page (BOS-1843: pages load when opened). test/first-load.test.ts keeps
// SETTINGS_PAGE_IDS equal to the pages in Settings.tsx.
export type SettingsPage = "funding" | "secrets" | "tools" | "reviews" | "team" | "watchdog" | "permissions" | "updates" | "limits" | "runner" | "email" | "server" | "devices" | "transfer";
export const SETTINGS_PAGE_IDS: readonly SettingsPage[] = ["funding", "secrets", "tools", "reviews", "team", "watchdog", "permissions", "updates", "limits", "runner", "email", "server", "devices", "transfer"];

/** The address of a Settings page: its own URL for a company, else the menu. */
export const settingsPath = (companyId: string | undefined, page: SettingsPage) => (companyId ? `settings/${companyId}/${page}` : "settings");

/**
 * The old Settings addresses and anchors, kept working forever (BOS-1018 build notes). A route as the URL reader
 * makes it (`useRoute` splits on "/"), answered with the address that replaces it, or null for one that still works.
 */
export function settingsRedirect(route: readonly string[], companyId: string | undefined): string | null {
  const [page, ...rest] = route;
  if (page === "settings") {
    // The company's id is the first part after "settings"; the page is the second.
    if (rest.length <= 1) return null;
    const [company, tab] = [rest[0], rest[1]];
    if ((SETTINGS_PAGE_IDS as readonly string[]).includes(tab ?? "")) return null;
    // "Server and runner" was one page (`system`, BOS-1492): it is now a group of six. The old address opens the first
    // of them, Updates, which keeps the company; the other five are one click away in the side list.
    if (tab === "system") return `settings/${company}/updates`;
    // The two tabs that were split up (BOS-1018's old → new map): their links land on the page that took each part.
    if (tab === "access") return `settings/${company}/tools`;
    if (tab === "workflow") return `settings/${company}/reviews`;
    // Any other page that no longer exists opens the menu rather than a page that is gone.
    return "settings";
  }
  if (page === "funding") return settingsPath(companyId, "funding");
  if (page === "secrets") return settingsPath(companyId, "secrets");
  // The Rules page was its own page; it is now Permissions, and its scope (a company id, or "all") is kept.
  if (page === "rules") return settingsPath(rest[0] && rest[0] !== "all" ? rest[0] : companyId, "permissions");
  return null;
}
