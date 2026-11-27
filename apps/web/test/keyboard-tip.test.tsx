// @vitest-environment jsdom
// The one-time keyboard tip (BOS-2690, BOS-2671 part 3e, the owner chose to include it): the first time a
// login moves around by keyboard outside a text box (a Tab, or Ctrl K), a small panel at the bottom left says
// there are shortcuts. It never appears before that, never when single-letter keys are off, never on a phone
// (640 px or under), and it does not take focus. Any of its four ways to close (Show shortcuts, Got it,
// Escape, "?") hides it and stores "seen" on the login, so it never comes back.
// BOS-2769: a real-browser check that the tip sits clear of the menu's pinned bottom row (Settings, the
// keyboard button, Log out), above all on a short window (the owner's Brave at 1667x724).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Shortcuts } from "../src/components/Shortcuts";
import { Sidebar } from "../src/components/Sidebar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const press = (key: string, extra: Record<string, unknown> = {}, target: Element | Window = window) => fireEvent.keyDown(target, { key, ...extra });
const tip = () => screen.queryByRole("status");
const tipText = "Boss Man has keyboard shortcuts. Press ? any time to see them.";

/** A window at a given width: 640 px and under is a phone, above is a desktop. */
const width = (px: number) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width: 640px") && px <= 640, media: q, addEventListener: () => {}, removeEventListener: () => {} }));

describe("the one-time keyboard tip (BOS-2690)", () => {
  it("is not there before anyone touches the keyboard", () => {
    width(1550);
    render(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={() => {}} />);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(tip()).toBeNull();
  });

  it("appears on the first Tab outside a text box, with the final words, and does not take focus", () => {
    width(1550);
    const button = document.createElement("button");
    button.textContent = "A button";
    document.body.appendChild(button);
    button.focus();
    render(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={() => {}} />);
    act(() => {
      press("Tab", {});
    });
    const panel = tip();
    expect(panel).toBeTruthy();
    expect(panel!.textContent).toContain(tipText);
    expect(screen.getByRole("button", { name: "Show shortcuts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Got it" })).toBeTruthy();
    // Focus stays where it was: the panel is only read out.
    expect(document.activeElement).toBe(button);
  });

  it("does not appear when the Tab is inside a text box", () => {
    width(1550);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    render(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={() => {}} />);
    act(() => {
      press("Tab", {}, input);
    });
    expect(tip()).toBeNull();
  });

  it("appears on Ctrl K", () => {
    width(1550);
    render(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={() => {}} />);
    act(() => {
      press("k", { ctrlKey: true });
    });
    expect(tip()).toBeTruthy();
  });

  it("never appears when single-letter keys are off", () => {
    width(1550);
    render(<Shortcuts go={() => {}} hasProjects singleLetterKeys={false} keyboardTipSeen={false} onTipSeen={() => {}} />);
    act(() => {
      press("Tab");
      press("k", { ctrlKey: true });
    });
    expect(tip()).toBeNull();
  });

  it("never appears on a phone (640 px or under)", () => {
    width(640);
    render(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={() => {}} />);
    act(() => {
      press("Tab");
      press("k", { ctrlKey: true });
    });
    expect(tip()).toBeNull();
  });

  it("never appears once this login has seen it", () => {
    width(1550);
    render(<Shortcuts go={() => {}} hasProjects keyboardTipSeen onTipSeen={() => {}} />);
    act(() => {
      press("Tab");
      press("k", { ctrlKey: true });
    });
    expect(tip()).toBeNull();
  });

  for (const how of ["Got it", "Escape", "?"] as const) {
    it(`closes for good on ${how}: it hides and stores "seen"`, () => {
      width(1550);
      const onTipSeen = vi.fn();
      render(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={onTipSeen} />);
      act(() => {
        press("Tab");
      });
      expect(tip()).toBeTruthy();
      act(() => {
        if (how === "Got it") fireEvent.click(screen.getByRole("button", { name: "Got it" }));
        else if (how === "Escape") press("Escape");
        else press("?", { shiftKey: true });
      });
      expect(onTipSeen).toHaveBeenCalledTimes(1);
      expect(tip()).toBeNull();
    });
  }

  it("'Show shortcuts' closes it, stores 'seen' and opens the list", () => {
    width(1550);
    const onTipSeen = vi.fn();
    render(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={onTipSeen} />);
    act(() => {
      press("Tab");
    });
    fireEvent.click(screen.getByRole("button", { name: "Show shortcuts" }));
    expect(onTipSeen).toHaveBeenCalledTimes(1);
    expect(tip()).toBeNull();
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("once shown it stays until closed (no timer)", () => {
    vi.useFakeTimers();
    try {
      width(1550);
      render(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={() => {}} />);
      act(() => {
        press("Tab");
      });
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(tip()).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- BOS-2769: a real-browser layout check, the tip beside the menu's pinned bottom row ----
// The first-time tip used to sit over Settings, the keyboard button and Log out on a short window. This
// renders the real Sidebar under the real tip with the real styles.css and checks the tip never overlaps the
// pinned row at the owner's two devices (Brave 1667x724 and Safari 1550 wide), with the menu full and folded
// to its icon strip. Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type ShotPage = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string }) => Promise<unknown>;
  close: () => Promise<void>;
};
type ShotBrowser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean }) => Promise<ShotPage>;
  close: () => Promise<void>;
};

async function launchTipBrowser(): Promise<ShotBrowser | null> {
  let chromium: { launch: (opts?: { executablePath?: string }) => Promise<ShotBrowser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      // try the next one
    }
  }
  return null;
}

const tipBrowser = await launchTipBrowser();
afterAll(async () => {
  await tipBrowser?.close();
});

const scratchTip = process.env.BOSSMAN_SCRATCH;
const tipShot = async (name: string) => (scratchTip ? (await import("node:path")).join(scratchTip, `keyboard-tip-${name}.png`) : null);

const company: Company = { id: "c1", name: "Fernleaf Studio", mission: null, paused: false, agents: [] };
const noop = () => {};
const tipOverMenu = (collapsed: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="app${collapsed ? " side-collapsed" : ""}">` +
  renderToStaticMarkup(
    <Sidebar active="dashboard" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} collapsed={collapsed} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onLogout={noop} />,
  ) +
  renderToStaticMarkup(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={() => {}} initialTip />) +
  "</div></body></html>";

const measureTip = () => {
  const rect = (el: Element | null) => {
    const b = el?.getBoundingClientRect();
    return b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null;
  };
  const tip = rect(document.querySelector(".shortcuts-tip"));
  const pinned = document.querySelectorAll(".side-pinned > *");
  const key = rect(document.querySelector(".side-pinned .shortcuts-button"));
  const out = rect(document.querySelector(".side-pinned .logout"));
  const settings = rect(document.querySelector(".side-pinned a.nav"));
  const hits = (a: { left: number; right: number; top: number; bottom: number } | null, b: { left: number; right: number; top: number; bottom: number } | null) =>
    !!a && !!b && !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  return {
    hasTip: !!tip,
    // The tip and the menu's pinned row don't touch at all.
    overlapsPinned: [...pinned].some((el) => hits(tip, rect(el))),
    overlapsKey: hits(tip, key),
    overlapsLogout: hits(tip, out),
    overlapsSettings: hits(tip, settings),
    // The whole tip is on screen, and clear of the menu's column when the menu is beside the page.
    inside: !!tip && tip.left >= 0 && tip.right <= document.documentElement.clientWidth + 0.5 && tip.top >= 0 && tip.bottom <= document.documentElement.clientHeight + 0.5,
    tip: tip,
    key: key,
    logout: out,
  };
};

const tipDevices = [
  { name: "brave-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true, collapsed: false },
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2, collapsed: false },
  { name: "strip-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true, collapsed: true },
];

describe.skipIf(!tipBrowser)("the one-time tip stays clear of the menu's pinned row (BOS-2769)", () => {
  for (const d of tipDevices) {
    it(`${d.name}: the tip never covers Settings, the keyboard button or Log out`, async () => {
      const p = await tipBrowser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch });
      try {
        await p.setContent(tipOverMenu(d.collapsed), { waitUntil: "load" });
        const got = await p.evaluate(measureTip);
        expect(got.hasTip).toBe(true);
        expect(got.overlapsPinned).toBe(false);
        expect(got.overlapsKey).toBe(false);
        expect(got.overlapsLogout).toBe(false);
        expect(got.overlapsSettings).toBe(false);
        expect(got.inside).toBe(true);
        // Beside the menu's column (240 px, or the 64 px strip), not over it.
        const menuWidth = d.collapsed ? 64 : 240;
        expect(got.tip!.left).toBeGreaterThanOrEqual(menuWidth);
        // And above the pinned row's top, so the row stays readable.
        expect(got.tip!.bottom).toBeLessThanOrEqual(got.key!.top);
        const path = await tipShot(`${d.name}`);
        if (path) await p.screenshot({ path });
      } finally {
        await p.close();
      }
    });
  }
});
