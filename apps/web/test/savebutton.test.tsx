// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SaveButton, useSaveState } from "../src/components/SaveButton";
import { flipWord } from "../src/pages/Agents";

afterEach(cleanup);

function Demo() {
  const [name, setName] = useState("a");
  const [busy, setBusy] = useState(false);
  const sv = useSaveState({ name });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setTimeout(() => (setBusy(false), sv.markSaved()), 0);
      }}
    >
      <input aria-label="name" value={name} onChange={(e) => setName(e.target.value)} />
      <SaveButton {...sv} busy={busy} />
    </form>
  );
}

describe("SaveButton", () => {
  it("goes Save, Saving…, Saved ✓ (disabled), then Save again once a field changes", async () => {
    render(<Demo />);
    const btn = () => screen.getByRole("button") as HTMLButtonElement;
    expect(btn().textContent).toBe("Save");
    expect(btn().className).toContain("primary");
    fireEvent.submit(btn().closest("form")!);
    expect(btn().textContent).toBe("Saving…");
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(btn().textContent).toBe("Saved ✓");
    expect(btn().disabled).toBe(true);
    expect(btn().className).not.toContain("primary");
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "b" } });
    expect(btn().textContent).toBe("Save");
    expect(btn().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "a" } });
    expect(btn().textContent).toBe("Saved ✓");
  });
});

describe("agent history wording", () => {
  it("reads boolean changes as plain words", () => {
    expect(flipWord("paused", true)).toBe("Paused");
    expect(flipWord("paused", false)).toBe("Unpaused");
    expect(flipWord("starred", false)).toBe("Unstarred");
    expect(flipWord("name", "x")).toBeNull();
  });
});
