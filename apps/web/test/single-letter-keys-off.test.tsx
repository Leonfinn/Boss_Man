// @vitest-environment jsdom
// Single-letter keys off (BOS-2689, WCAG 2.1.4, the owner-approved BOS-2671 plan part 3d): with the box off,
// "?", the g-sequences, g 1 to g 6 and the j/k/Enter card keys do nothing while Ctrl/Cmd+K keeps working; the
// list still opens and says so, with "Turn them on". The switch saves per login, so it survives a reload, a
// restart and another browser, and a failed save puts the box back with the words under it.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { Company } from "../src/api";
import { Shortcuts } from "../src/components/Shortcuts";
import { PreferencesContext, type Preferences } from "../src/preferences";
import { KeyboardShortcuts } from "../src/pages/settings/KeyboardShortcuts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  document.body.innerHTML = "";
});

const press = (key: string, extra: Record<string, unknown> = {}, target: Element | Window = window) => fireEvent.keyDown(target, { key, ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A provider with a saved choice, and a save that records what it was asked to save. */
function preferences(singleLetterKeys: boolean, save: Preferences["save"] = async () => ({ singleLetterKeys, pinnedPages: [] })): Preferences {
  return { prefs: { singleLetterKeys, pinnedPages: [] }, save };
}

describe("single-letter keys off (BOS-2689)", () => {
  it("with the keys off, '?', g-sequences and j/k/Enter do nothing, while Ctrl+K still opens search", async () => {
    const go = vi.fn();
    render(
      <>
        <button type="button">A card</button>
        <input aria-label="open target" />
        <Shortcuts go={go} hasProjects singleLetterKeys={false} />
      </>,
    );
    // "?" opens nothing (and is not swallowed, so a shortcut-less page types nothing either).
    press("?", { shiftKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    // g then a letter, and g then a number, go nowhere.
    act(() => {
      press("g");
      press("i");
    });
    expect(go).not.toHaveBeenCalled();
    act(() => {
      press("g");
      press("3");
    });
    expect(go).not.toHaveBeenCalled();
    // j/k/Enter on cards leave focus where it was.
    const card = screen.getByRole("button", { name: "A card" });
    card.focus();
    press("j");
    press("Enter");
    expect(document.activeElement).toBe(card);
  });

  it("Ctrl/Cmd+K is the search box's own key, so it is untouched: the search box still opens", async () => {
    const { SearchPalette } = await import("../src/components/SearchPalette");
    render(<><SearchPalette companyId="c1" go={() => {}} /><Shortcuts go={() => {}} hasProjects singleLetterKeys={false} /></>);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("combobox")).toBeTruthy();
  });

  it("the list still opens from the menu's way in and shows the off notice and 'Turn them on', which turns them on", async () => {
    const on = vi.fn();
    window.dispatchEvent(new Event("noop"));
    render(<Shortcuts go={() => {}} hasProjects singleLetterKeys={false} onTurnKeysOn={on} />);
    // The menu's keyboard button opens it the same way the settings link does (no "?" needed).
    act(() => {
      window.dispatchEvent(new Event("bossman:open-shortcuts"));
    });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog.textContent).toContain("Single-letter keys are off, so only the ones with Ctrl work.");
    fireEvent.click(screen.getByRole("button", { name: "Turn them on" }));
    expect(on).toHaveBeenCalledTimes(1);
    // Escape still closes it.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with the keys on, the list has no off notice", () => {
    render(<Shortcuts go={() => {}} hasProjects singleLetterKeys onTurnKeysOn={() => {}} />);
    press("?", { shiftKey: true });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog.textContent).not.toContain("Single-letter keys are off");
    expect(screen.queryByRole("button", { name: "Turn them on" })).toBeNull();
  });
});

describe("Settings → Account: the switch (BOS-2689)", () => {
  it("shows the saved choice, saves a tick, and the box follows what the server saved", async () => {
    let saved: boolean | null = null;
    const save = vi.fn(async (patch: { singleLetterKeys?: boolean }) => {
      saved = patch.singleLetterKeys ?? null;
      return { singleLetterKeys: patch.singleLetterKeys ?? true, pinnedPages: [] };
    });
    const { rerender } = render(
      <PreferencesContext.Provider value={{ prefs: { singleLetterKeys: true, pinnedPages: [] }, save }}>
        <KeyboardShortcuts companyId="c1" />
      </PreferencesContext.Provider>,
    );
    const box = screen.getByRole("checkbox", { name: "Use single-letter keys" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(saved).toBe(false));
    // The provider gives the saved answer back, the way App does once /api/preferences answers.
    rerender(
      <PreferencesContext.Provider value={{ prefs: { singleLetterKeys: false, pinnedPages: [] }, save }}>
        <KeyboardShortcuts companyId="c1" />
      </PreferencesContext.Provider>,
    );
    expect((screen.getByRole("checkbox", { name: "Use single-letter keys" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed save puts the box back and shows the words under it", async () => {
    const save = vi.fn(async () => {
      throw new Error("the server said no");
    });
    render(
      <PreferencesContext.Provider value={{ prefs: { singleLetterKeys: true, pinnedPages: [] }, save }}>
        <KeyboardShortcuts companyId="c1" />
      </PreferencesContext.Provider>,
    );
    const box = screen.getByRole("checkbox", { name: "Use single-letter keys" }) as HTMLInputElement;
    fireEvent.click(box);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't save. Check your connection and try again.");
    // The error's own words are not echoed, and the box is where the saved choice is (on).
    expect(alert.textContent).not.toContain("the server said no");
    expect(box.checked).toBe(true);
  });

  it("says what the switch does, and that Ctrl K always works", () => {
    render(
      <PreferencesContext.Provider value={preferences(true)}>
        <KeyboardShortcuts companyId="c1" />
      </PreferencesContext.Provider>,
    );
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.getByText(/Ctrl K for search always works\. This setting follows your login to every browser\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Show all keyboard shortcuts" })).toBeTruthy();
  });
});

describe("the choice follows the login (BOS-2689)", () => {
  it("the app reads the switch with the sign-in answer, so a later load (reload, restart, another browser) is off without a click", async () => {
    const company = { id: "c1", name: "App Co", agents: [], projects: [{ id: "p1", name: "Site", starred: false }] } as unknown as Company;
    const prefs = { singleLetterKeys: false, pinnedPages: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/setup") return json({ needsSetup: false });
        if (url === "/api/me") return json({ username: "leon" });
        if (url === "/api/preferences") return json(prefs);
        if (url === "/api/companies") return json([company]);
        if (url === "/api/maintenance") return json({ on: false });
        if (url === "/api/notifications") return json({ items: [], unread: 0 });
        if (url.startsWith("/api/decisions/tally")) return json({ open: 0 });
        if (url === "/api/kill-switch") return json({ paused: false });
        return json([]);
      }),
    );
    window.location.hash = "#/dashboard";
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    // The shell can be on screen a moment before its key listeners are added.
    await waitFor(() => {
      act(() => {
        press("g");
        press("i");
      });
      expect(window.location.hash).toBe("#/dashboard");
    });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    vi.unstubAllGlobals();
  });
});
