// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnerPreferences } from "@boss-man/shared";
import { PinnedProvider, usePinned } from "../src/pinned-pages";
import { listFromRows } from "../src/shortcuts-editor";
import { DEFAULT_PREFERENCES, PreferencesContext } from "../src/preferences";

// The Edit shortcuts dialog (BOS-2669 ticket 3): rename, move, remove, with nothing saved until Save.

afterEach(cleanup);

const saves: Array<Partial<OwnerPreferences>> = [];

function EditButton() {
  const pinned = usePinned()!;
  return <button type="button" data-edit-shortcuts onClick={pinned.openEditor}>Edit</button>;
}

function Harness({ start, fail }: { start: Array<{ id: string; name?: string }>; fail?: { on: boolean } }) {
  const [prefs, setPrefs] = useState<OwnerPreferences>({ ...DEFAULT_PREFERENCES, pinnedPages: start });
  const save = async (patch: Partial<OwnerPreferences>) => {
    if (fail?.on) throw new Error("down");
    saves.push(patch);
    const next = { ...prefs, ...patch };
    setPrefs(next);
    return next;
  };
  return (
    <PreferencesContext.Provider value={{ prefs, save }}>
      <PinnedProvider companyId="c1">
        <EditButton />
        <div data-testid="saved">{JSON.stringify(prefs.pinnedPages)}</div>
      </PinnedProvider>
    </PreferencesContext.Provider>
  );
}

const three = [{ id: "updates" }, { id: "limits" }, { id: "agents" }];
const open = () => fireEvent.click(screen.getByRole("button", { name: "Edit" }));
const names = () => screen.getAllByRole("textbox").map((b) => (b as HTMLInputElement).value);

describe("Edit shortcuts dialog", () => {
  it("shows the count, the hint and where each row goes, whatever it is called", () => {
    render(<Harness start={[{ id: "updates", name: "My updates" }, { id: "limits" }]} />);
    open();
    const dialog = screen.getByRole("dialog", { name: "Edit shortcuts" });
    expect(dialog.textContent).toContain("2 of 6");
    expect(dialog.textContent).toContain("Rename, move or remove. To add one, open the page and press Add to shortcuts beside its title.");
    expect(names()[0]).toBe("My updates");
    expect(dialog.textContent).toContain("Opens Settings → Server and runner → Updates");
  });

  it("moves and removes with buttons, says so, and saves nothing until Save", async () => {
    saves.length = 0;
    render(<Harness start={three} />);
    open();
    const first = names()[0]!;
    fireEvent.click(screen.getByRole("button", { name: `Move ${first} down` }));
    expect(screen.getByRole("status").textContent).toContain(`${first} moved to position 2 of 3.`);
    expect(names()[1]).toBe(first);
    fireEvent.click(screen.getByRole("button", { name: `Remove ${first}` }));
    expect(screen.getByRole("status").textContent).toContain(`${first} removed.`);
    expect(screen.getByRole("dialog").textContent).toContain("2 of 6");
    expect(saves).toEqual([]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saves.length).toBe(1);
    expect(JSON.parse(screen.getByTestId("saved").textContent!)).toEqual([{ id: "limits" }, { id: "agents" }]);
  });

  it("the first Move up and the last Move down are disabled", () => {
    render(<Harness start={three} />);
    open();
    const rows = screen.getAllByRole("listitem");
    expect((within(rows[0]!).getByRole("button", { name: /up$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rows[2]!).getByRole("button", { name: /down$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Cancel and Esc leave the list as it was, and focus goes back to Edit", async () => {
    saves.length = 0;
    render(<Harness start={three} />);
    open();
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })));
    open();
    expect(names()[0]).not.toBe("Changed");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saves).toEqual([]);
  });

  it("focus starts on the first name box", () => {
    render(<Harness start={three} />);
    open();
    expect(document.activeElement).toBe(screen.getAllByRole("textbox")[0]);
  });

  it("an emptied name saves as the page's own name", () => {
    expect(listFromRows([{ id: "updates", name: "   ", defaultName: "Updates" }, { id: "limits", name: "Updates", defaultName: "Limits" }, { id: "agents", name: "Team", defaultName: "Agents" }])).toEqual([{ id: "updates" }, { id: "limits", name: "Updates" }, { id: "agents", name: "Team" }]);
  });

  it("stops a name at 40 characters", () => {
    expect(listFromRows([{ id: "updates", name: "x".repeat(60), defaultName: "Updates" }])[0]!.name).toHaveLength(40);
    render(<Harness start={three} />);
    open();
    expect(screen.getAllByRole("textbox")[0]!.getAttribute("maxlength")).toBe("40");
  });

  it("a failed save keeps the dialog open and says so", async () => {
    render(<Harness start={three} fail={{ on: true }} />);
    open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByRole("alert").textContent).toContain("Couldn't save your shortcuts.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("removing every row and saving saves an empty list", async () => {
    render(<Harness start={[{ id: "updates" }]} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /^Remove/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    await waitFor(() => expect(screen.getByTestId("saved").textContent).toBe("[]"));
  });
});
