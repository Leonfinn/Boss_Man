import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNER_CONTROLS, type OwnerScreen } from "@boss-man/shared";
import { checkAsk } from "../src/services/decisions.js";
import { lintOwnerSteps } from "../src/services/steps.js";

// R6 of the owner-card lint (BOS-421, DR-009 L6): a card may only send the owner to a button the app has.

const WEB = fileURLToPath(new URL("../../web/src/", import.meta.url));
const r6 = (steps: string[], options: string[] = []) => lintOwnerSteps(steps, options).refuse.filter((f) => f.rule === "R6");

describe("R6: a card names a button that doesn't exist", () => {
  it("refuses the 15:10 card, and names the ticket screen's buttons", () => {
    const [f, ...more] = r6(["Open BOS-368 and press Overrule and merge."]);
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
      expect(r6([s]).length, s).toBe(1);
  });

  it("accepts real buttons, menu items, tabs, keys and the card's own options", () => {
    const ok = [
      "Open Settings → Server and runner → Updates and press Build and update runners. It costs $5 a month.",
      "Open the ticket and press Approve and merge.",
      'Click "Request changes" and write what is wrong.',
      "Click Settings, then click Server and runner.",
      "Press the Deploy latest button.",
      "Press Save again, then press Enter.",
      "Click Open Acme's Kanban.",
      "Press Update runners (finish runs first).",
      "Click Approve on this card.",
      "Press Yes, move it on this card.",
      "Click the link in the email and press it twice.",
      "Press OK in the box that asks.",
    ];
    for (const s of ok) expect(r6([s], ["Yes, move it", "No"]), s).toEqual([]);
  });

  it("refuses a quoted name that only starts with a real label", () => {
    expect(r6(['Press "Approve anyway".'])).toHaveLength(1);
  });

  it("is a refusal checkAsk passes on, with the card's options counted as buttons", () => {
    const base = { triedFirst: "Checked the ticket screen in the web app code; there is no such button." };
    expect(checkAsk({ ...base, steps: ["Open BOS-368 and press Overrule and merge."] }).error).toMatch(/Overrule and merge/);
    expect(checkAsk({ ...base, steps: ["Press Merge it on this card."], options: ["Merge it", "Not yet"] }).error).toBeNull();
    // Overridable by the CEO with a reason, like R1 and R2 (the list can't see a label set in code).
    const ceo = checkAsk({ ...base, steps: ["Press Copied under the command."], lintOverride: "The Copy button says Copied after a press.", byCeo: true });
    expect(ceo.error).toBeNull();
    expect(ceo.lint?.override?.findings.map((x) => x.rule)).toEqual(["R6"]);
  });
});

// ---- The list can't go stale: every button in the web app is on it, and every entry still has a button. ----

/** Which screen each file's buttons are on. A new file with buttons must be added here. */
const FILE_SCREEN: Record<string, OwnerScreen> = {
  "App.tsx": "Any screen",
  "components/ImageAttach.tsx": "Any screen",
  "components/SaveButton.tsx": "Any screen",
  "components/Sidebar.tsx": "Any screen",
  "components/ReviewPolicy.tsx": "Settings",
  "components/ScrumMasterLog.tsx": "Scrum Master",
  "components/TicketActivity.tsx": "Ticket",
  "components/TicketLinks.tsx": "Ticket",
  "components/TicketOutputs.tsx": "Ticket",
  "components/TicketRelated.tsx": "Ticket",
  "components/TicketReviews.tsx": "Ticket",
  "pages/Agents.tsx": "Agents",
  "pages/Auth.tsx": "Log in",
  "pages/Board.tsx": "Board",
  "pages/Chat.tsx": "Chat",
  "pages/Decisions.tsx": "Decisions",
  "pages/Features.tsx": "Features",
  "pages/Feedback.tsx": "Feedback",
  "pages/Funding.tsx": "Settings",
  "pages/Notifications.tsx": "Notifications",
  "pages/Plan.tsx": "Plan",
  "pages/Portal.tsx": "Feedback portal",
  "pages/Roadmap.tsx": "Roadmap",
  "pages/Rules.tsx": "Settings",
  "pages/Run.tsx": "Run",
  "pages/Secrets.tsx": "Settings",
  "pages/Settings.tsx": "Settings",
  "pages/Setup.tsx": "Setup",
  "pages/Skills.tsx": "Skills",
  "pages/Ticket.tsx": "Ticket",
  "pages/Wiki.tsx": "Wiki",
};

/** Entries no <button> text shows, each with where it comes from; the test checks those sources instead. */
const NOT_FROM_BUTTONS: Partial<Record<OwnerScreen, string[]>> = {
  // window.confirm's own buttons.
  "Any screen": ["OK", "Cancel"],
  // The command block's copy button: its label is a variable ("Copy", then "Copied").
  Decisions: ["Copy"],
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
  const out: string[] = [];
  for (const m of src.matchAll(/<button\b/g)) {
    let i = m.index + "<button".length;
    while (i < src.length && src[i] !== ">") i = src[i] === "{" ? skipBraces(src, i) : src[i] === '"' || src[i] === "'" ? skipString(src, i) : i + 1;
    if (src[i - 1] === "/") continue;
    const inner = src.slice(i + 1, src.indexOf("</button>", i));
    for (let k = 0; k < inner.length; ) {
      if (inner[k] === "{") {
        const e = skipBraces(inner, k);
        out.push(...shown(inner.slice(k + 1, e - 1)));
        k = e;
      } else if (inner[k] === "<") {
        while (k < inner.length && inner[k] !== ">") k = inner[k] === "{" ? skipBraces(inner, k) : k + 1;
        k++;
      } else {
        const e = inner.slice(k).search(/[{<]/);
        out.push(inner.slice(k, e < 0 ? undefined : k + e));
        k = e < 0 ? inner.length : k + e;
      }
    }
  }
  // Leading and trailing marks aren't part of the name: "▸ Show all", "Saved ✓", "Attaching…", "History (".
  return out.map((p) => p.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, "")).filter((p) => /^\p{Lu}/u.test(p));
}

const tsx: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name));
    else if (e.name.endsWith(".tsx")) tsx.push(join(d, e.name));
  }
};
walk(WEB);
const listed = (screen: OwnerScreen) => (OWNER_CONTROLS[screen] as readonly string[]).map((l) => l.replace(/ …$/, ""));
/** A button piece is on the list as itself or as a "…" label's start. */
const onList = (screen: OwnerScreen, label: string) => listed(screen).includes(label);

describe("OWNER_CONTROLS matches the web app", () => {
  const found = new Map<OwnerScreen, Set<string>>();
  const add = (s: OwnerScreen, l: string) => (found.get(s) ?? found.set(s, new Set()).get(s)!).add(l);
  for (const f of tsx) {
    const labels = buttonLabels(readFileSync(f, "utf8"));
    if (!labels.length) continue;
    const file = relative(WEB, f).replace(/\\/g, "/");
    const screen = FILE_SCREEN[file];
    it(`${file} has a screen`, () => expect(screen, `add ${file} to FILE_SCREEN in this test`).toBeDefined());
    if (!screen) continue;
    for (const l of labels) add(screen, l);
    it(`every button in ${file} is listed under ${screen}`, () => {
      expect(labels.filter((l) => !onList(screen, l)), `add these to OWNER_CONTROLS["${screen}"] in packages/shared/src/owner-controls.ts`).toEqual([]);
    });
  }
  // The sidebar menu and the Settings tabs are drawn from arrays, so their labels are read from those.
  const sidebar = [...readFileSync(join(WEB, "components/Sidebar.tsx"), "utf8").matchAll(/\{ id: "[\w-]+", label: "([^"]+)"/g)].map((m) => m[1]!);
  const tabs = [...(/const TABS = \[([\s\S]*?)\] as const/.exec(readFileSync(join(WEB, "pages/Settings.tsx"), "utf8"))?.[1] ?? "").matchAll(/label: "([^"]+)"/g)].map((m) => m[1]!);
  for (const l of sidebar) add("Any screen", l);
  for (const l of tabs) add("Settings", l);

  it("lists the sidebar menu and the Settings tabs", () => {
    expect(sidebar.length).toBeGreaterThan(10);
    expect(tabs.length).toBeGreaterThan(4);
    expect(sidebar.filter((l) => !onList("Any screen", l))).toEqual([]);
    expect(tabs.filter((l) => !onList("Settings", l))).toEqual([]);
  });

  it("has no entry the app no longer shows", () => {
    expect(readFileSync(join(WEB, "pages/Decisions.tsx"), "utf8")).toMatch(/Copy this command/);
    expect(tsx.some((f) => /\bconfirm\(/.test(readFileSync(f, "utf8")))).toBe(true);
    const stale = (Object.keys(OWNER_CONTROLS) as OwnerScreen[]).flatMap((s) =>
      listed(s).filter((l) => !found.get(s)?.has(l) && !NOT_FROM_BUTTONS[s]?.includes(l)).map((l) => `${s}: ${l}`),
    );
    expect(stale, "remove these from packages/shared/src/owner-controls.ts, or fix FILE_SCREEN").toEqual([]);
  });
});
