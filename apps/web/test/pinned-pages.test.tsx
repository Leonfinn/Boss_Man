// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnerPreferences } from "@boss-man/shared";
import { AddToShortcuts, PinnedProvider, ShortcutGone } from "../src/pinned-pages";
import { DEFAULT_PREFERENCES, PreferencesContext } from "../src/preferences";

// The Add to shortcuts chip and its toast (BOS-2669 ticket 2): press adds with no reload, pressing again or Undo
// takes it out, a failed save leaves the button as it was and shows the failure toast, the 7th is refused.

afterEach(cleanup);

function Harness({ start, fail }: { start: { id: string }[]; fail?: { on: boolean } }) {
  const [prefs, setPrefs] = useState<OwnerPreferences>({ ...DEFAULT_PREFERENCES, pinnedPages: start });
  const save = async (patch: Partial<OwnerPreferences>) => {
    if (fail?.on) throw new Error("down");
    const next = { ...prefs, ...patch };
    setPrefs(next);
    return next;
  };
  return (
    <PreferencesContext.Provider value={{ prefs, save }}>
      <PinnedProvider companyId="c1">
        <AddToShortcuts settingsPage="updates" />
        <AddToShortcuts page="notifications" />
        <ShortcutGone id="old-page" />
      </PinnedProvider>
    </PreferencesContext.Provider>
  );
}

describe("Add to shortcuts", () => {
  it("adds, shows the toast, and Undo takes it out again", async () => {
    render(<Harness start={[]} />);
    const chip = screen.getByRole("button", { name: /Add to shortcuts/ });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByRole("button", { name: /In shortcuts/ }).getAttribute("aria-pressed")).toBe("true"));
    // The button flips when the save lands; the toast is set one await later, so wait for it too (a read straight
    // after the button check raced the toast on a slower machine).
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Updates added to your shortcuts."));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await waitFor(() => expect(screen.getByRole("button", { name: /Add to shortcuts/ }).getAttribute("aria-pressed")).toBe("false"));
  });

  it("pressing a pinned page's chip again removes it, with Undo", async () => {
    render(<Harness start={[{ id: "updates" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /In shortcuts/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Updates removed from your shortcuts."));
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("a failed save leaves the button as it was and says so", async () => {
    render(<Harness start={[]} fail={{ on: true }} />);
    fireEvent.click(screen.getByRole("button", { name: /Add to shortcuts/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Couldn't save your shortcuts."));
    expect(screen.getByRole("button", { name: /Add to shortcuts/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("refuses a 7th shortcut in words and saves nothing", async () => {
    const six = ["limits", "agents", "runs", "funding", "roadmap", "skills"].map((id) => ({ id }));
    render(<Harness start={six} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Add to shortcuts/ })[0]!);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("You have 6 shortcuts, the most there's room for."));
    expect(screen.getAllByRole("button", { name: /Add to shortcuts/ })[0]!.getAttribute("aria-pressed")).toBe("false");
  });

  it("a gone page offers Remove this shortcut", async () => {
    render(<Harness start={[{ id: "old-page" }]} />);
    expect(screen.getByRole("alert").textContent).toContain("Page no longer exists");
    fireEvent.click(screen.getByRole("button", { name: "Remove this shortcut" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("removed from your shortcuts."));
  });
});
