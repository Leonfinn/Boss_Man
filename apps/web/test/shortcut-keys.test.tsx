// @vitest-environment jsdom
// The g-then-a-number keys and the "Your shortcuts in the menu" block in the "?" list (BOS-2669 ticket 4):
// g 1 opens the first shortcut and so on by position; a number with no shortcut does nothing; no key acts while
// typing in a box; the list names each shortcut by its current number, none with no shortcuts, and the numbers
// follow a reorder; with single-letter keys off the digits do nothing.
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerPreferences } from "@boss-man/shared";
import { Shortcuts } from "../src/components/Shortcuts";
import { PinnedProvider } from "../src/pinned-pages";
import { DEFAULT_PREFERENCES, PreferencesContext } from "../src/preferences";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  document.body.innerHTML = "";
});

const press = (key: string, extra: Record<string, unknown> = {}, target: Element | Window = window) => fireEvent.keyDown(target, { key, ...extra });
const pressShift = (key: string) => press(key, { shiftKey: true });

/** The real menu provider and the real Shortcuts, with the owner's pinned list as its state. */
function Harness({ start, singleLetterKeys = true }: { start: string[]; singleLetterKeys?: boolean }) {
  const [prefs, setPrefs] = useState<OwnerPreferences>({ ...DEFAULT_PREFERENCES, pinnedPages: start.map((id) => ({ id })) });
  const save = async (patch: Partial<OwnerPreferences>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    return next;
  };
  return (
    <PreferencesContext.Provider value={{ prefs, save }}>
      <PinnedProvider companyId="c1">
        <Shortcuts go={(to: string) => (window.location.hash = `#/${to}`)} hasProjects singleLetterKeys={singleLetterKeys} />
      </PinnedProvider>
    </PreferencesContext.Provider>
  );
}

const openList = () => {
  pressShift("?");
  return screen.getByRole("dialog", { name: "Keyboard shortcuts" });
};

describe("g then a number opens the shortcut at that position (BOS-2669 ticket 4)", () => {
  it("g 1 opens the first shortcut and g 2 the second, by position", () => {
    window.location.hash = "#/dashboard";
    render(<Harness start={["updates", "agents"]} />);
    act(() => {
      press("g");
      press("1");
    });
    expect(window.location.hash).toBe("#/settings/c1/updates");
    act(() => {
      press("g");
      press("2");
    });
    expect(window.location.hash).toBe("#/agents");
  });

  it("a number with no shortcut does nothing, and a digit on its own does too", () => {
    window.location.hash = "#/dashboard";
    render(<Harness start={["updates"]} />);
    // g 2 has no shortcut behind it.
    act(() => {
      press("g");
      press("2");
    });
    expect(window.location.hash).toBe("#/dashboard");
    // A digit with no "g" before it is left to the page.
    press("1");
    expect(window.location.hash).toBe("#/dashboard");
  });

  it("no key acts while typing in a box", () => {
    window.location.hash = "#/dashboard";
    render(
      <>
        <Harness start={["updates"]} />
        <input aria-label="Search" />
      </>,
    );
    const box = screen.getByRole("textbox", { name: "Search" });
    press("g", {}, box);
    press("1", {}, box);
    expect(window.location.hash).toBe("#/dashboard");
  });

  it("with 'Use single-letter keys' switched off, g then a number does nothing", () => {
    window.location.hash = "#/dashboard";
    render(<Harness start={["updates"]} singleLetterKeys={false} />);
    act(() => {
      press("g");
      press("1");
    });
    expect(window.location.hash).toBe("#/dashboard");
  });
});

describe("the ? list's 'Your shortcuts in the menu' block (BOS-2669 ticket 4)", () => {
  it("names each shortcut against its number", () => {
    render(<Harness start={["updates", "agents"]} />);
    const dialog = openList();
    expect(dialog.textContent).toContain("Your shortcuts in the menu");
    const lists = dialog.querySelectorAll("dl.shortcuts-list");
    const yours = Array.from(lists).find((dl) => dl.getAttribute("aria-label") === "Your shortcuts in the menu");
    expect(yours?.textContent).toMatch(/g\s*then\s*1\s*Updates/);
    expect(yours?.textContent).toMatch(/g\s*then\s*2\s*Agents/);
  });

  it("shows no block when there are none", () => {
    render(<Harness start={[]} />);
    const dialog = openList();
    expect(dialog.textContent).not.toContain("Your shortcuts in the menu");
  });

  it("follows a reorder: the numbers match the new order", async () => {
    // Reorder from the real store: the second shortcut moved to the front.
    function Reorder() {
      const [prefs, setPrefs] = useState<OwnerPreferences>({ ...DEFAULT_PREFERENCES, pinnedPages: [{ id: "updates" }, { id: "agents" }] });
      const save = async (patch: Partial<OwnerPreferences>) => {
        const next = { ...prefs, ...patch };
        setPrefs(next);
        return next;
      };
      return (
        <PreferencesContext.Provider value={{ prefs, save }}>
          <PinnedProvider companyId="c1">
            <button type="button" onClick={() => void save({ pinnedPages: [{ id: "agents" }, { id: "updates" }] })}>
              Reorder
            </button>
            <Shortcuts go={() => {}} hasProjects />
          </PinnedProvider>
        </PreferencesContext.Provider>
      );
    }
    render(<Reorder />);
    let dialog = openList();
    let yours = Array.from(dialog.querySelectorAll("dl.shortcuts-list")).find((dl) => dl.getAttribute("aria-label") === "Your shortcuts in the menu");
    expect(yours?.textContent).toMatch(/g\s*then\s*1\s*Updates/);
    // Close, reorder, reopen.
    fireEvent.keyDown(dialog, { key: "Escape" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reorder" })));
    dialog = openList();
    yours = Array.from(dialog.querySelectorAll("dl.shortcuts-list")).find((dl) => dl.getAttribute("aria-label") === "Your shortcuts in the menu");
    expect(yours?.textContent).toMatch(/g\s*then\s*1\s*Agents/);
    expect(yours?.textContent).toMatch(/g\s*then\s*2\s*Updates/);
  });
});
