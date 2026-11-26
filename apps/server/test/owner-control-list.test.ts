import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNER_CONTROLS, OWNER_FIELDS, OWNER_MENU, OWNER_SECTIONS, OWNER_TABS, type OwnerScreen } from "@boss-man/shared";
import { checkAsk } from "../src/services/decisions.js";
import { buttonLabels, fieldLabels, shown } from "../src/services/guard-scan.js";
import { lintOwnerSteps } from "../src/services/steps.js";

// R7 of the owner-card lint (BOS-421, DR-009 L6): a card may only send the owner to a button the app has.

const WEB = fileURLToPath(new URL("../../web/src/", import.meta.url));
const r7 = (steps: string[], options: string[] = []) => lintOwnerSteps(steps, { options }).refuse.filter((f) => f.rule === "R7");

describe("R7: a card names a button that doesn't exist", () => {
  it("refuses the 15:10 card, and names the ticket screen's buttons", () => {
    const [f, ...more] = r7(["Open BOS-368 and press Overrule and merge."]);
    expect(more).toEqual([]);
    expect(f!.problem).toContain('"Overrule and merge"');
    expect(f!.problem).toContain("The buttons on Ticket are:");
    expect(f!.problem).toContain("Approve and merge");
  });

  it("refuses made-up buttons however they're written", () => {
    for (const s of [
      'Click "Force merge" on the ticket.',
      "Press **Overrule** at the top.",
      "Tap `Merge anyway`.",
      'Use the "Skip review" button.',
      "On the ticket, use the Overrule and merge button.",
      "Press the Merge Now button.",
      "Open Settings → Server and runner and click Restart server.",
    ])
      expect(r7([s]).length, s).toBe(1);
  });

  it("accepts real buttons, menu items, tabs, keys and the card's own options", () => {
    const ok = [
      "Open Settings → Server and runner → Updates and press Build and update runners. It costs $5 a month.",
      "Open the ticket and press Approve and merge.",
      'Click "Request changes" and write what is wrong.',
      "Click Settings, then click Server and runner.",
      "Press the Review and deploy button.",
      "Press Save again, then press Enter.",
      "Click Open Acme's Kanban.",
      "Press Update runners (finish runs first).",
      "To undo, click Update runners again after reverting.",
      "Click Approve on this card.",
      "Press Yes, move it on this card.",
      "Click the link in the email and press it twice.",
      "Press OK in the box that asks.",
      // The project page's tabs (Board.tsx PROJECT_TABS), and a button on its Config tab.
      "Open Projects, open Acme, click Config, then click Re-detect.",
      "Click the Budget tab.",
    ];
    for (const s of ok) expect(r7([s], ["Yes, move it", "No"]), s).toEqual([]);
  });

  it("refuses a quoted name that only starts with a real label", () => {
    expect(r7(['Press "Approve anyway".'])).toHaveLength(1);
  });

  it("is a refusal checkAsk passes on, with the card's options counted as buttons", () => {
    const base = { triedFirst: "Checked the ticket screen in the web app code; there is no such button.", why: "The owner sees the right button named.", minutes: 2 };
    expect(checkAsk({ ...base, steps: ["Open BOS-368 and press Overrule and merge."] }).error).toMatch(/Overrule and merge/);
    expect(checkAsk({ ...base, steps: ["Press Merge it on this card, shown in Settings → Server and runner → This host."], options: ["Merge it", "Not yet"] }).error).toBeNull();
    // Overridable by the CEO with a reason, like R1 and R2 (the list can't see a label set in code).
    // "Copy done" is a made-up label on no screen ("Copied" is listed under Ticket and Run since BOS-2233).
    const ceo = checkAsk({ ...base, steps: ["Press Copy done under the command, shown in Settings → Server and runner → This host."], lintOverride: "The Copy button says Copy done after a press.", byCeo: true });
    expect(ceo.error).toBeNull();
    expect(ceo.lint?.override?.findings.map((x) => x.rule)).toEqual(["R7"]);
  });
});

// ---- The list can't go stale: every button in the web app is on it, and every entry still has a button. ----

/**
 * The screen a file's buttons are on when nothing else says: for a page, the page; for a shared widget, "Any
 * screen". A component another component renders takes its screens from where it is rendered instead (see
 * `screensOf`), so ProjectRow, written in Settings.tsx, counts as Config, Projects and Setup, where it's shown.
 * A new file with buttons must be added here.
 */
const FILE_SCREEN: Record<string, OwnerScreen> = {
  "App.tsx": "Any screen",
  "components/ImageAttach.tsx": "Any screen",
  // The Dashboard's "Company paused" notice has a Resume button: the same "Resume" the stop-all banner lists.
  "components/DashboardPanels.tsx": "Any screen",
  // Opened from a picture in any Markdown text.
  "components/Lightbox.tsx": "Any screen",
  "components/LoadError.tsx": "Any screen",
  // The owner's message box, on five screens (Ticket, Board, Chat, Decisions, Run).
  "components/OwnerMessageBox.tsx": "Any screen",
  "components/SaveButton.tsx": "Any screen",
  // The Ctrl+K search box and its sidebar button, mounted once in App.tsx (BOS-2192).
  "components/SearchPalette.tsx": "Any screen",
  // The "?" keyboard shortcuts list, mounted once in App.tsx (BOS-2321).
  "components/Shortcuts.tsx": "Any screen",
  "components/Sidebar.tsx": "Any screen",
  // The page-intro fold, on four screens (P7, BOS-1278).
  "components/MoreAbout.tsx": "Any screen",
  // The "Show older" button under a paged list (BOS-2165): Skills and Engagements render it.
  "components/ShowOlder.tsx": "Any screen",
  // "Copy link" in the Ticket and Run headers (BOS-2233). Not "Any screen", so it takes its screens from where
  // it is rendered (screensOf): Ticket and Run.
  "components/CopyLinkButton.tsx": "Ticket",
  // "Download" in the Ticket header: the ticket as Markdown (BOS-2314).
  "components/TicketDownloadButton.tsx": "Ticket",
  "components/ReviewPolicy.tsx": "Reviews",
  "components/OpenIssues.tsx": "Scrum Master",
  "components/ScrumMasterLog.tsx": "Scrum Master",
  // The health line's Retry (BOS-2249): shown on the board and on the Scrum Master page, so it takes its screens from where it is rendered.
  "components/WatchdogHealth.tsx": "Any screen",
  // The weekly email switch on Settings → Notifications (BOS-2195).
  "components/WeeklySummaryForm.tsx": "Notifications",
  "components/TicketActivity.tsx": "Ticket",
  "components/TicketLinks.tsx": "Ticket",
  "components/TicketOutputs.tsx": "Ticket",
  "components/TicketRelated.tsx": "Ticket",
  "components/TicketReviews.tsx": "Ticket",
  // The Board's filters panel, opened by its Filter button (BOS-1194).
  "components/FilterPanel.tsx": "Board",
  // The Thinking trace above each agent reply, rendered in the Chat page (BOS-1368).
  "components/ThinkingTrace.tsx": "Chat",
  "pages/Agents.tsx": "Agents",
  "pages/Auth.tsx": "Log in",
  "pages/Board.tsx": "Board",
  // A project's Budget tab (also shown on Settings → Funding).
  "pages/ProjectBudget.tsx": "Board",
  "pages/Chat.tsx": "Chat",
  "pages/Dashboard.tsx": "Any screen",
  "pages/Decisions.tsx": "Decisions",
  "pages/Features.tsx": "Features",
  "pages/Feedback.tsx": "Feedback",
  // Funding, Rules and Secrets are pages of their own, shown as tabs of Settings.
  "pages/Funding.tsx": "Funding",
  "pages/MergeQueue.tsx": "Merge queue",
  "pages/MergeHistory.tsx": "Merge queue",
  "pages/Notifications.tsx": "Notifications",
  // The notification settings moved here from the feed page (BOS-2327); Settings → Notifications is the same screen in the list.
  "pages/settings/Notifications.tsx": "Notifications",
  // The "Other places to send alerts" card on the Notifications page (BOS-2199).
  "components/AlertDestinations.tsx": "Notifications",
  "pages/Plan.tsx": "Plan",
  // The Search page (BOS-2378); its first field is the Open tickets only tick box (BOS-2477).
  "pages/Search.tsx": "Search",
  "pages/Portal.tsx": "Feedback portal",
  "pages/Roadmap.tsx": "Roadmap",
  // The Timeline tab's rows, rendered by pages/Roadmap.tsx (BOS-2581's "CEO manages at risk" switch is on them).
  "pages/RoadmapRows.tsx": "Roadmap",
  // The old Rules page is now the Permission rules card on Settings → Permissions (BOS-1019).
  "pages/Rules.tsx": "Permissions",
  "pages/Run.tsx": "Run",
  "pages/Runs.tsx": "Runs",
  // The Engagements list's "Show" filter (BOS-2260); its Show older button comes from ShowOlder.
  "pages/Engagements.tsx": "Engagements",
  // No buttons of its own, but it shows ScrumMasterLog's.
  "pages/ScrumMaster.tsx": "Scrum Master",
  "pages/Secrets.tsx": "Secrets",
  "pages/Settings.tsx": "Settings",
  // The Settings page's panels, one file per panel (BOS-1022). Each panel's screen comes from where Settings renders
  // it (SITE_SCREEN); these entries are the fallback, and the "as shown on Setup" cases.
  "pages/settings/Credentials.tsx": "Secrets",
  "pages/settings/Devices.tsx": "Server and runner",
  "pages/settings/Funding.tsx": "Funding",
  "pages/settings/Permissions.tsx": "Permissions",
  "pages/settings/Projects.tsx": "Projects",
  "pages/settings/Runner.tsx": "Server and runner",
  "pages/settings/System.tsx": "Server and runner",
  "pages/settings/CheckWorkers.tsx": "Server and runner",
  "pages/settings/SlotSplit.tsx": "Server and runner",
  "pages/settings/Team.tsx": "Team and CEO",
  "pages/settings/ThisHost.tsx": "Server and runner",
  "pages/settings/Tools.tsx": "Tools and deploys",
  "pages/settings/Transfer.tsx": "Import and export",
  "pages/settings/Account.tsx": "Account",
  // The single-letter-key switch on Settings → Account (BOS-2689, BOS-2671 part 3d).
  "pages/settings/KeyboardShortcuts.tsx": "Account",
  "pages/settings/Watchdog.tsx": "Watchdog",
  "pages/settings/shared.tsx": "Any screen",
  "pages/Setup.tsx": "Setup",
  "pages/SetupClaude.tsx": "Setup",
  "pages/Skills.tsx": "Skills",
  "pages/SpendReport.tsx": "Spend",
  "pages/Ticket.tsx": "Ticket",
  "pages/Wiki.tsx": "Wiki",
  "components/DeletedPages.tsx": "Wiki",
  "components/WikiCompare.tsx": "Wiki",
  "pages/Workflow.tsx": "Workflow",
};

/** A page component the router (App.tsx) shows as its own screen, where that isn't its file's screen. */
const PAGE_SCREEN: Record<string, OwnerScreen> = {
  "pages/settings/Projects.tsx#ProjectsPage": "Projects",
};
/** A render site that is a tab of its page: `file>Component` is that component as that file renders it. */
const SITE_SCREEN: Record<string, OwnerScreen> = {
  "pages/Board.tsx>ProjectRow": "Config",
  "pages/Board.tsx>ProjectBrief": "Config",
  "pages/Board.tsx>ArchiveProject": "Config",
  // The Runs page's emergency stop, its own component in Runs.tsx (BOS-837).
  "pages/Runs.tsx>EndAllRuns": "Runs",
  // Settings' pages (Settings.tsx SETTINGS_GROUPS): each panel the Settings page shows, by the page that shows it (BOS-1019).
  "pages/Settings.tsx>StopAllWork": "Server and runner",
  "pages/Settings.tsx>ServerHealth": "Server and runner",
  "pages/Settings.tsx>ServerPanel": "Server and runner",
  "pages/Settings.tsx>SelfDeploy": "Server and runner",
  "pages/Settings.tsx>ThisHost": "Server and runner",
  "pages/Settings.tsx>NetguardAllow": "Server and runner",
  "pages/Settings.tsx>RunLimits": "Server and runner",
  "pages/Settings.tsx>WipLimits": "Server and runner",
  "pages/Settings.tsx>CheckQueueSetting": "Server and runner",
  "pages/Settings.tsx>MainCiSetting": "Server and runner",
  "pages/Settings.tsx>PrivateDetails": "Server and runner",
  "pages/Settings.tsx>Runner": "Server and runner",
  "pages/Settings.tsx>Devices": "Server and runner",
  "pages/Settings.tsx>EmailSetting": "Server and runner",
  "pages/Settings.tsx>ImportCompany": "Import and export",
  "pages/Settings.tsx>ExportCompany": "Import and export",
  "pages/Settings.tsx>Account": "Account",
  "pages/Settings.tsx>NotificationSettings": "Notifications",
  "pages/Settings.tsx>ToolServers": "Tools and deploys",
  "pages/Settings.tsx>DeployTargets": "Tools and deploys",
  "pages/Settings.tsx>PenpotSettings": "Tools and deploys",
  "pages/Settings.tsx>Funding": "Funding",
  "pages/Settings.tsx>ProjectBudgets": "Funding",
  "pages/Settings.tsx>FundingCards": "Funding",
  "pages/Settings.tsx>BudgetLimits": "Funding",
  "pages/Settings.tsx>CompanyReviews": "Reviews",
  "pages/Settings.tsx>TicketPrefix": "Team and CEO",
  "pages/Settings.tsx>GoalCheck": "Reviews",
  "pages/Settings.tsx>CompanyPause": "Team and CEO",
  "pages/Settings.tsx>CeoApprovals": "Team and CEO",
  "pages/Settings.tsx>NudgeCap": "Team and CEO",
  "pages/Settings.tsx>RunTimeLimit": "Team and CEO",
  "pages/Settings.tsx>WorkspaceDisk": "Server and runner",
  "pages/Settings.tsx>AdviceTimeout": "Team and CEO",
  "pages/Settings.tsx>StandingRules": "Team and CEO",
  "pages/Settings.tsx>PermissionJudgeSetting": "Permissions",
  "pages/Settings.tsx>AutoTempCleanupSetting": "Permissions",
  "pages/Settings.tsx>FenceSetting": "Permissions",
  "pages/Settings.tsx>SecondOpinionSetting": "Permissions",
  "pages/Settings.tsx>Watchdog": "Watchdog",
  "pages/Settings.tsx>WorkflowRetros": "Team and CEO",
  "pages/Settings.tsx>Chapters": "Team and CEO",
};
/** Components the Settings page renders that hold no controls of their own (a wrapper), so need no tab above. */
// JumpLinks is the "on this page" nav, which holds no controls of its own; HTMLHeadingElement is the focused page
// title's type in the useRef call.
const SETTINGS_WRAPPERS = new Set(["Section", "JumpLinks", "HTMLHeadingElement", "NoCompany"]);
// Field components (CheckPicker) are FIELD_COMPONENTS in src/services/guard-scan.ts, with the label scanner.

/** Entries no <button> text shows, each with where it comes from; the test checks those sources instead. */
const NOT_FROM_BUTTONS: Partial<Record<OwnerScreen, string[]>> = {
  // window.confirm's own buttons.
  // The menu's keyboard button is an icon: its name is its aria-label, not button text (BOS-2688).
  "Any screen": ["OK", "Cancel", "Keyboard shortcuts"],
  // The command block's copy button: its label is a variable ("Copy", then "Copied").
  Decisions: ["Copy"],
  // The sign-off button: its label is a variable that depends on how the project lands work (BOS-471).
  Ticket: ["Approve", "Approve and open a pull request", "Approve and merge"],
  // The two tabs are drawn by one helper (tabButton) that adds the count, so their text is a variable (BOS-1239).
  "Merge queue": ["Merges", "Quick checks"],
  // Retire is an item in the row's ⋯ menu (RowMenu), whose label is built from the agent's name (BOS-1256).
  Agents: ["Retire"],
  // The heading of the last Settings group (BOS-1492): cards still say "Click Settings, then click Server and runner".
  Settings: ["Server and runner"],
  // The Board's filters panel (BOS-1194): Working now is the panel's switch, labelled by a heading span, so its
  // text is not a <button>'s. The test checks the switch is still in FilterPanel.tsx instead.
  Board: ["Working now"],
  // The Unread and Read filter chips are drawn by one helper (chip) that adds the count, so their text is a variable (BOS-1277).
  Notifications: ["Unread", "Read"],
  // The Updates card's buttons come from updateStatus() in settings/updates.tsx as `label:` values and are drawn by
  // one loop in System.tsx, so no <button> holds their text (BOS-1238). The tests in updates.test.tsx check the labels.
  "Server and runner": ["Review and deploy", "Check for updates now", "Cancel queued runner update", "Cancel the update", "Stop making room", "Lift the hold now"],
};

// The label scanner (buttonLabels, fieldLabels, shown) is in src/services/guard-scan.ts (BOS-2522), shared with the
// move-to-review check, so the check at the move and this test read a file the same way.

const tsx: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name));
    else if (e.name.endsWith(".tsx")) tsx.push(join(d, e.name));
  }
};
walk(WEB);

// ---- Where each component is shown: its render sites, followed up to a page or a shared widget. ----

const rel = (f: string) => relative(WEB, f).replace(/\\/g, "/");
type Chunk = { file: string; name: string; src: string };
/** A file's top-level declarations, each with its text up to the next one: components, mostly. */
function chunks(file: string, src: string): Chunk[] {
  const starts = [...src.matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)];
  const head: Chunk = { file, name: "", src: src.slice(0, starts[0]?.index ?? src.length) };
  return [head, ...starts.map((m, k) => ({ file, name: m[1]!, src: src.slice(m.index, starts[k + 1]?.index ?? src.length) }))];
}
/** The names a file imports from another web file, local name to `file#Name`. */
function imports(file: string, src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.{1,2}\/[^"]+)"/g)) {
    const target = rel(join(WEB, file, "..", `${m[2]}.tsx`));
    for (const part of m[1]!.split(",")) {
      const [orig, local] = part.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/);
      if (orig) out.set(local ?? orig, `${target}#${orig}`);
    }
  }
  return out;
}
const all: Chunk[] = tsx.flatMap((f) => chunks(rel(f), readFileSync(f, "utf8")));
const importsOf = new Map(tsx.map((f) => [rel(f), imports(rel(f), readFileSync(f, "utf8"))]));
const defined = new Set(all.map((c) => `${c.file}#${c.name}`));
/** The app's entry points and router: what they render is a page, shown as its own screen. */
const ROUTERS = new Set(["App.tsx", "main.tsx", "portal-main.tsx"]);
/** Every chunk that renders `file#Name`, outside the routers. */
function sitesOf(id: string): Chunk[] {
  const [file, name] = id.split("#") as [string, string];
  return all.filter((c) => {
    if (ROUTERS.has(c.file) || !new RegExp(`<${name}[\\s/>]`).test(c.src)) return false;
    const via = importsOf.get(c.file)?.get(name);
    return via ? via === id : c.file === file && defined.has(id);
  });
}
/** The screens a component's buttons are on. */
function screensOf(id: string, seen = new Set<string>()): Set<OwnerScreen> {
  const file = id.split("#")[0]!;
  const own = PAGE_SCREEN[id] ?? FILE_SCREEN[file];
  if (PAGE_SCREEN[id] || own === "Any screen" || seen.has(id)) return new Set(own ? [own] : []);
  seen.add(id);
  const sites = sitesOf(id);
  if (!sites.length) return new Set(own ? [own] : []);
  const out = new Set<OwnerScreen>();
  for (const c of sites) {
    const tab = SITE_SCREEN[`${c.file}>${id.split("#")[1]}`];
    for (const s of tab ? [tab] : screensOf(`${c.file}#${c.name}`, new Set(seen))) out.add(s);
  }
  return out;
}

const listed = (screen: OwnerScreen) => (OWNER_CONTROLS[screen] as readonly string[]).map((l) => l.replace(/ …$/, ""));
/** A button piece is on the list as itself or as a "…" label's start. */
const onList = (screen: OwnerScreen, label: string) => listed(screen).includes(label);
const listedFields = (screen: OwnerScreen) => ((OWNER_FIELDS as Partial<Record<OwnerScreen, readonly string[]>>)[screen] ?? []).map((l) => l.replace(/ …$/, ""));
const onFieldList = (screen: OwnerScreen, label: string) => listedFields(screen).includes(label);

describe("OWNER_CONTROLS matches the web app", () => {
  const found = new Map<OwnerScreen, Set<string>>();
  const add = (s: OwnerScreen, l: string) => (found.get(s) ?? found.set(s, new Set()).get(s)!).add(l);
  const foundFields = new Map<OwnerScreen, Set<string>>();
  const addField = (s: OwnerScreen, l: string) => (foundFields.get(s) ?? foundFields.set(s, new Set()).get(s)!).add(l);
  for (const f of tsx) {
    const src = readFileSync(f, "utf8");
    if (!buttonLabels(src).length && !fieldLabels(src).length) continue;
    const file = rel(f);
    it(`${file} has a screen`, () => expect(FILE_SCREEN[file], `add ${file} to FILE_SCREEN in this test`).toBeDefined());
  }
  for (const c of all) {
    const labels = buttonLabels(c.src);
    const fields = fieldLabels(c.src);
    if (!labels.length && !fields.length) continue;
    const id = `${c.file}#${c.name}`;
    const screens = screensOf(id);
    it(`${id} is on a screen`, () => expect(screens.size, `a file that renders ${c.name} needs a FILE_SCREEN entry`).toBeGreaterThan(0));
    for (const screen of screens) {
      for (const l of labels) add(screen, l);
      for (const l of fields) addField(screen, l);
      it(`every button in ${id} is listed under ${screen}`, () => {
        // The names go in the message, which vitest prints whole (it cuts the compared value: "…(6)").
        const missing = labels.filter((l) => !onList(screen, l));
        expect(missing, `add to OWNER_CONTROLS["${screen}"] in packages/shared/src/owner-controls.ts: ${missing.join(" | ")}`).toEqual([]);
      });
      it(`every field in ${id} is listed under ${screen}`, () => {
        const missing = fields.filter((l) => !onFieldList(screen, l));
        expect(missing, `add to OWNER_FIELDS["${screen}"] in packages/shared/src/owner-controls.ts: ${missing.join(" | ")}`).toEqual([]);
      });
    }
  }

  it("has no field entry the app no longer shows", () => {
    const stale = (Object.keys(OWNER_FIELDS) as OwnerScreen[]).flatMap((s) =>
      listedFields(s).filter((l) => !foundFields.get(s)?.has(l)).map((l) => `${s}: ${l}`),
    );
    expect(stale, `remove from OWNER_FIELDS in packages/shared/src/owner-controls.ts, or fix FILE_SCREEN or SITE_SCREEN: ${stale.join(" | ")}`).toEqual([]);
  });

  it("puts every panel of the Settings page under the tab that shows it", () => {
    const settings = all.find((c) => c.file === "pages/Settings.tsx" && c.name === "Settings")!;
    const rendered = [...new Set([...settings.src.matchAll(/<([A-Z]\w*)[\s/>]/g)].map((m) => m[1]!))].filter((n) => !SETTINGS_WRAPPERS.has(n));
    expect(rendered.filter((n) => !SITE_SCREEN[`pages/Settings.tsx>${n}`]), "add each to SITE_SCREEN with its Settings tab").toEqual([]);
  });

  // BOS-1649: the section headings a card's path may name after a tab (OWNER_SECTIONS), kept in step with the pages.
  const webFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? webFiles(join(dir, e.name)) : /\.tsx$/.test(e.name) ? [join(dir, e.name)] : []));
  const pageText = webFiles(join(WEB, "pages")).map((f) => readFileSync(f, "utf8")).join("\n");
  const listedSections = Object.values(OWNER_SECTIONS).flat() as string[];

  it("lists no section heading the app no longer shows", () => {
    const stale = listedSections.filter((h) => !pageText.includes(`"${h}"`) && !pageText.includes(`>${h}<`) && !pageText.includes(`>${h}\n`));
    expect(stale, `remove from OWNER_SECTIONS in packages/shared/src/owner-controls.ts (or fix its spelling): ${stale.join(" | ")}`).toEqual([]);
  });

  it("lists every section heading the Settings pages show", () => {
    // Only the pages a Settings tab or a project tab shows; other screens (Skills, Agents) have their own headings.
    const settingsText = webFiles(join(WEB, "pages/settings")).map((f) => readFileSync(f, "utf8")).join("\n")
      + ["Settings", "Funding", "Secrets", "Rules", "ProjectBudget"].map((n) => readFileSync(join(WEB, `pages/${n}.tsx`), "utf8")).join("\n");
    const shown = [
      ...[...settingsText.matchAll(/<Section\s+id="[^"]+"\s+title="([^"{]+)"/g)].map((m) => m[1]!),
      ...[...settingsText.matchAll(/<h3[^>]*>([A-Z][^<{]+)<\/h3>/g)].map((m) => m[1]!.trim()),
    ];
    expect(shown.length).toBeGreaterThan(20); // the scan found the headings, so an empty pass can't hide a miss
    // Headings of other screens (a project's brief, an agent's page) are not on a Settings tab: leave those out here.
    const OTHER = new Set(["New project", "Archive this project", "Archived", "Project brief", "Export", "Your devices"]);
    const missing = shown.filter((h) => !listedSections.includes(h) && !OTHER.has(h) && !h.startsWith("Export "));
    expect(missing, `add each to OWNER_SECTIONS under its tab in packages/shared/src/owner-controls.ts: ${missing.join(" | ")}`).toEqual([]);
  });

  it("knows every screen a step can name: the side menu, the Settings tabs and the project tabs", () => {
    expect([...OWNER_MENU]).toEqual(sidebar);
    expect([...OWNER_TABS.Settings]).toEqual(tabs);
    expect([...OWNER_TABS.Board]).toEqual(projectTabs);
  });
  // The sidebar menu and the Settings tabs are drawn from arrays, so their labels are read from those.
  const sidebar = [...readFileSync(join(WEB, "components/Sidebar.tsx"), "utf8").matchAll(/\{ id: "[\w-]+", label: "([^"]+)"/g)].map((m) => m[1]!);
  const tabs = [...readFileSync(join(WEB, "pages/Settings.tsx"), "utf8").matchAll(/\{\s*id: "[\w-]+",\s*label: "([^"]+)",\s*hint: "/g)].map((m) => m[1]!);
  const projectTabs = [...(/const PROJECT_TABS = \[([\s\S]*?)\] as const/.exec(readFileSync(join(WEB, "pages/Board.tsx"), "utf8"))?.[1] ?? "").matchAll(/label: "([^"]+)"/g)].map((m) => m[1]!);
  for (const l of sidebar) add("Any screen", l);
  for (const l of tabs) add("Settings", l);
  for (const l of projectTabs) add("Board", l);

  it("lists the sidebar menu, the Settings tabs and the project tabs", () => {
    expect(sidebar.length).toBeGreaterThan(10);
    expect(tabs.length).toBeGreaterThan(4);
    expect(projectTabs).toContain("Config");
    expect(sidebar.filter((l) => !onList("Any screen", l))).toEqual([]);
    expect(tabs.filter((l) => !onList("Settings", l))).toEqual([]);
    expect(projectTabs.filter((l) => !onList("Board", l))).toEqual([]);
  });

  it("puts a component on the screens it's shown on, not its file's", () => {
    expect([...screensOf("pages/settings/Projects.tsx#ProjectRow")].sort()).toEqual(["Config", "Projects", "Setup"]);
    expect([...screensOf("pages/settings/Runner.tsx#Runner")].sort()).toEqual(["Server and runner"]);
    expect([...screensOf("pages/Funding.tsx#Funding")]).toEqual(["Funding"]);
    // A funding source is added on Funding (and in Setup), the place for it since BOS-1019.
    expect([...screensOf("pages/settings/Funding.tsx#Funding")].sort()).toEqual(["Funding", "Setup"]);
    expect([...screensOf("pages/settings/Credentials.tsx#Credentials")].sort()).toEqual(["Secrets", "Setup"]);
    // Each override still names a real component, and each tab override a file that renders it.
    for (const id of Object.keys(PAGE_SCREEN)) expect(defined.has(id), id).toBe(true);
    for (const site of Object.keys(SITE_SCREEN)) {
      const [file, name] = site.split(">") as [string, string];
      expect(all.some((c) => c.file === file && new RegExp(`<${name}[\\s/>]`).test(c.src)), site).toBe(true);
    }
  });

  it("has no entry the app no longer shows", () => {
    expect(readFileSync(join(WEB, "pages/Decisions.tsx"), "utf8")).toMatch(/Copy this command/);
    expect(tsx.some((f) => /\bconfirm\(/.test(readFileSync(f, "utf8")))).toBe(true);
    const approveLabel = readFileSync(join(WEB, "pages/Ticket.tsx"), "utf8").match(/const approveLabel = (.*);/)?.[1] ?? "";
    expect(shown(approveLabel).sort()).toEqual([...NOT_FROM_BUTTONS.Ticket!].sort());
    // The Board's "Working now" is a switch in its filter panel, named by the panel's own heading (BOS-1194).
    expect(readFileSync(join(WEB, "components/FilterPanel.tsx"), "utf8")).toMatch(/role="switch"[^>]*aria-labelledby="filter-working-label/);
    const stale = (Object.keys(OWNER_CONTROLS) as OwnerScreen[]).flatMap((s) =>
      listed(s).filter((l) => !found.get(s)?.has(l) && !NOT_FROM_BUTTONS[s]?.includes(l)).map((l) => `${s}: ${l}`),
    );
    expect(stale, `remove from packages/shared/src/owner-controls.ts, or fix FILE_SCREEN, PAGE_SCREEN or SITE_SCREEN: ${stale.join(" | ")}`).toEqual([]);
  });
});

// BOS-1494 (Morph's review, item 10): developer words may stay in help text or boxed technical names, never in a label.
describe("owner labels use plain words", () => {
  const DEVELOPER_WORDS = /\blegacy\b|merge train|leader lock|worktrees?\b|quota hold|no funding set|RUNNER_ADDONS|server queue/i;

  it("no button, field label, menu entry or tab uses a developer word", () => {
    const labels = [
      ...tsx.flatMap((f) => {
        const src = readFileSync(f, "utf8");
        return [...buttonLabels(src), ...fieldLabels(src)].map((l) => `${rel(f)}: ${l}`);
      }),
      ...Object.values(OWNER_CONTROLS).flat(),
      ...Object.values(OWNER_FIELDS).flat(),
      ...OWNER_MENU,
      ...Object.values(OWNER_TABS).flat(),
    ];
    expect(labels.length).toBeGreaterThan(500); // the scan found the app's labels, so an empty pass can't hide a miss
    const bad = labels.filter((l) => DEVELOPER_WORDS.test(l.replace(/^[^:]+\.tsx: /, "")));
    expect(bad).toEqual([]);
  });
});
