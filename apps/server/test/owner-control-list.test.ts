import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNER_CONTROLS, OWNER_FIELDS, OWNER_MENU, OWNER_TABS, type OwnerScreen } from "@boss-man/shared";
import { checkAsk } from "../src/services/decisions.js";
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
    const base = { triedFirst: "Checked the ticket screen in the web app code; there is no such button." };
    expect(checkAsk({ ...base, steps: ["Open BOS-368 and press Overrule and merge."] }).error).toMatch(/Overrule and merge/);
    expect(checkAsk({ ...base, steps: ["Press Merge it on this card."], options: ["Merge it", "Not yet"] }).error).toBeNull();
    // Overridable by the CEO with a reason, like R1 and R2 (the list can't see a label set in code).
    const ceo = checkAsk({ ...base, steps: ["Press Copied under the command."], lintOverride: "The Copy button says Copied after a press.", byCeo: true });
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
  // Opened from a picture in any Markdown text.
  "components/Lightbox.tsx": "Any screen",
  // The owner's message box, on five screens (Ticket, Board, Chat, Decisions, Run).
  "components/OwnerMessageBox.tsx": "Any screen",
  "components/SaveButton.tsx": "Any screen",
  "components/Sidebar.tsx": "Any screen",
  // The page-intro fold, on four screens (P7, BOS-1278).
  "components/MoreAbout.tsx": "Any screen",
  "components/ReviewPolicy.tsx": "Reviews",
  "components/ScrumMasterLog.tsx": "Scrum Master",
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
  "pages/Decisions.tsx": "Decisions",
  "pages/Features.tsx": "Features",
  "pages/Feedback.tsx": "Feedback",
  // Funding, Rules and Secrets are pages of their own, shown as tabs of Settings.
  "pages/Funding.tsx": "Funding",
  "pages/MergeQueue.tsx": "Merge queue",
  "pages/Notifications.tsx": "Notifications",
  "pages/Plan.tsx": "Plan",
  "pages/Portal.tsx": "Feedback portal",
  "pages/Roadmap.tsx": "Roadmap",
  // The old Rules page is now the Permission rules card on Settings → Permissions (BOS-1019).
  "pages/Rules.tsx": "Permissions",
  "pages/Run.tsx": "Run",
  "pages/Runs.tsx": "Runs",
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
  "pages/settings/Team.tsx": "Team and CEO",
  "pages/settings/ThisHost.tsx": "Server and runner",
  "pages/settings/Tools.tsx": "Tools and deploys",
  "pages/settings/Transfer.tsx": "Import and export",
  "pages/settings/Watchdog.tsx": "Watchdog",
  "pages/settings/shared.tsx": "Any screen",
  "pages/Setup.tsx": "Setup",
  "pages/SetupClaude.tsx": "Setup",
  "pages/Skills.tsx": "Skills",
  "pages/Ticket.tsx": "Ticket",
  "pages/Wiki.tsx": "Wiki",
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
  "pages/Settings.tsx>ServerPanel": "Server and runner",
  "pages/Settings.tsx>SelfDeploy": "Server and runner",
  "pages/Settings.tsx>ThisHost": "Server and runner",
  "pages/Settings.tsx>NetguardAllow": "Server and runner",
  "pages/Settings.tsx>RunLimits": "Server and runner",
  "pages/Settings.tsx>WipLimits": "Server and runner",
  "pages/Settings.tsx>CheckQueueSetting": "Server and runner",
  "pages/Settings.tsx>PrivateDetails": "Server and runner",
  "pages/Settings.tsx>Runner": "Server and runner",
  "pages/Settings.tsx>Devices": "Server and runner",
  "pages/Settings.tsx>EmailSetting": "Server and runner",
  "pages/Settings.tsx>ImportCompany": "Import and export",
  "pages/Settings.tsx>ExportCompany": "Import and export",
  "pages/Settings.tsx>ToolServers": "Tools and deploys",
  "pages/Settings.tsx>DeployTargets": "Tools and deploys",
  "pages/Settings.tsx>Funding": "Funding",
  "pages/Settings.tsx>ProjectBudgets": "Funding",
  "pages/Settings.tsx>FundingCards": "Funding",
  "pages/Settings.tsx>BudgetLimits": "Funding",
  "pages/Settings.tsx>CompanyReviews": "Reviews",
  "pages/Settings.tsx>TicketPrefix": "Team and CEO",
  "pages/Settings.tsx>GoalCheck": "Reviews",
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
const SETTINGS_WRAPPERS = new Set(["Section", "JumpLinks", "HTMLHeadingElement"]);
/** Components whose `label` prop is a form field's label (rendered as a <label> from the prop). */
const FIELD_COMPONENTS = new Set(["CheckPicker"]);

/** Entries no <button> text shows, each with where it comes from; the test checks those sources instead. */
const NOT_FROM_BUTTONS: Partial<Record<OwnerScreen, string[]>> = {
  // window.confirm's own buttons.
  "Any screen": ["OK", "Cancel"],
  // The command block's copy button: its label is a variable ("Copy", then "Copied").
  Decisions: ["Copy"],
  // The sign-off button: its label is a variable that depends on how the project lands work (BOS-471).
  Ticket: ["Approve", "Approve and open a pull request", "Approve and merge"],
  // The two tabs are drawn by one helper (tabButton) that adds the count, so their text is a variable (BOS-1239).
  "Merge queue": ["Merges", "Queued checks"],
  // Retire is an item in the row's ⋯ menu (RowMenu), whose label is built from the agent's name (BOS-1256).
  Agents: ["Retire"],
  // The Board's filters panel (BOS-1194): Working now is the panel's switch, labelled by a heading span, so its
  // text is not a <button>'s. The test checks the switch is still in FilterPanel.tsx instead.
  Board: ["Working now"],
  // The Unread and Read filter chips are drawn by one helper (chip) that adds the count, so their text is a variable (BOS-1277).
  Notifications: ["Unread", "Read"],
  // The Updates card's buttons come from updateStatus() in settings/updates.tsx as `label:` values and are drawn by
  // one loop in System.tsx, so no <button> holds their text (BOS-1238). The tests in updates.test.tsx check the labels.
  "Server and runner": ["Review and deploy", "Check for updates now", "Cancel queued runner update", "Cancel the update", "Stop making room", "Lift the hold now"],
};

function skipString(s: string, i: number): number {
  const q = s[i];
  for (i++; i < s.length && s[i] !== q; i++) {
    if (s[i] === "\\") i++;
    else if (q === "`" && s[i] === "$" && s[i + 1] === "{") i = skipBraces(s, i + 1) - 1;
  }
  return i + 1;
}
function skipBraces(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(s, i) - 1;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return i;
}
/** The strings a JSX expression can show: not ones compared against (`tab === "all"`) or given as attributes. */
function shown(expr: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c !== '"' && c !== "'" && c !== "`") continue;
    const e = skipString(expr, i);
    const before = expr.slice(0, i).trimEnd();
    const after = expr.slice(e).trimStart();
    const compared = /[=!]=$/.test(before) || /^[=!]==?/.test(after) || /\b(?:includes|has|startsWith|endsWith)\($/.test(before);
    if (!compared && !/[\w-]=$/.test(before)) out.push(c === "`" ? expr.slice(i + 1, e - 1).split("${")[0]! : expr.slice(i + 1, e - 1));
    i = e - 1;
  }
  return out;
}
/**
 * The text each <button> in a file shows: its JSX text and the strings in its {…} children. A label with a value
 * inside comes out in pieces ("Open", "'s Kanban"); only pieces starting with a capital are labels (the rest are
 * the tail of one, or class names). TypeScript 7 has no JS parser API to borrow, so this is a small scanner that
 * knows JSX braces and strings.
 */
function buttonLabels(src: string): string[] {
  return clean(elementTexts(src, "button").flatMap((chunks) => chunks.flat()));
}

/** The inside of every `<tag …>…</tag>` in a file, as its runs of text: each JSX text run or {…} is one chunk. */
function elementTexts(src: string, tag: string): string[][][] {
  const out: string[][][] = [];
  for (const m of src.matchAll(new RegExp(`<${tag}\\b`, "g"))) {
    let i = m.index + tag.length + 1;
    while (i < src.length && src[i] !== ">") i = src[i] === "{" ? skipBraces(src, i) : src[i] === '"' || src[i] === "'" ? skipString(src, i) : i + 1;
    if (src[i - 1] === "/") continue;
    const inner = src.slice(i + 1, src.indexOf(`</${tag}>`, i));
    const chunks: string[][] = [];
    for (let k = 0; k < inner.length; ) {
      if (inner[k] === "{") {
        const e = skipBraces(inner, k);
        chunks.push(shown(inner.slice(k + 1, e - 1)));
        k = e;
      } else if (inner[k] === "<") {
        // A field's own text stops at its input: the options of a <select> inside a <label> are not its label.
        if (/^<(?:select|option|textarea)\b/.test(inner.slice(k))) break;
        while (k < inner.length && inner[k] !== ">") k = inner[k] === "{" ? skipBraces(inner, k) : k + 1;
        k++;
      } else {
        const e = inner.slice(k).search(/[{<]/);
        const t = inner.slice(k, e < 0 ? undefined : k + e);
        if (t.trim()) chunks.push([t]);
        k = e < 0 ? inner.length : k + e;
      }
    }
    out.push(chunks);
  }
  return out;
}
// Leading and trailing marks aren't part of the name: "▸ Show all", "Saved ✓", "Attaching…", "History (".
const clean = (pieces: string[]) => pieces.map((p) => p.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, "")).filter((p) => /^\p{Lu}/u.test(p));

/**
 * The label of every form field in a file (BOS-442): the first text of each <label> (the words before its input;
 * a label that is only a variable shows nothing to list), and the `label` prop of a field component (CheckPicker).
 */
function fieldLabels(src: string): string[] {
  const out = elementTexts(src, "label").flatMap((chunks) => chunks[0] ?? []);
  for (const m of src.matchAll(/<(\w+)\b[^>]*?\blabel="([^"]+)"/g)) if (FIELD_COMPONENTS.has(m[1]!)) out.push(m[2]!);
  return clean(out);
}

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
