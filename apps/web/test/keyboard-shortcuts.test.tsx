// @vitest-environment jsdom
// Keyboard shortcuts (BOS-2321): "?" opens the list, Escape closes it and puts focus back, "g" then a letter
// jumps to a main screen, and nothing fires in a text box, over another dialog or with Ctrl/Alt/Meta held.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { G_WINDOW_MS, JUMPS, Shortcuts } from "../src/components/Shortcuts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
  document.body.innerHTML = "";
});

const press = (key: string, extra: Record<string, unknown> = {}, target: Element | Window = window) => fireEvent.keyDown(target, { key, ...extra });

describe("keyboard shortcuts (BOS-2321)", () => {
  it("'?' opens the list with Ctrl/Cmd+K and every jump in it; Escape closes it and returns focus", () => {
    render(<><button type="button">Before</button><Shortcuts go={() => {}} hasProjects /></>);
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    press("?", { shiftKey: true });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog.textContent).toMatch(/K\s*Search tickets/);
    for (const j of JUMPS) expect(dialog.textContent).toContain(`g then ${j.key}`);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("the Close button closes the list too", () => {
    render(<Shortcuts go={() => {}} hasProjects />);
    press("?", { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("'g' then each letter goes to its screen", () => {
    const go = vi.fn();
    render(<Shortcuts go={go} hasProjects />);
    for (const j of JUMPS) {
      press("g");
      press(j.key);
    }
    expect(go.mock.calls.map((c) => c[0])).toEqual(["dashboard", "board", "chat", "decisions", "notifications", "runs", "wiki", "features", "settings"]);
  });

  it("'g b' opens Projects when there is no project, and stays put on a project's board", () => {
    const go = vi.fn();
    const { rerender } = render(<Shortcuts go={go} hasProjects={false} />);
    press("g");
    press("b");
    expect(go).toHaveBeenLastCalledWith("projects");
    rerender(<Shortcuts go={go} hasProjects />);
    window.location.hash = "#/board/p2";
    go.mockClear();
    press("g");
    press("b");
    expect(go).not.toHaveBeenCalled();
  });

  it("the second letter only counts within the time window", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const go = vi.fn();
    render(<Shortcuts go={go} hasProjects />);
    press("g");
    vi.setSystemTime(Date.now() + G_WINDOW_MS + 1);
    press("d");
    expect(go).not.toHaveBeenCalled();
    // A letter on its own, with no "g" before it, does nothing either.
    press("r");
    expect(go).not.toHaveBeenCalled();
  });

  it("never fires while typing in an input, textarea, select or contenteditable", () => {
    const go = vi.fn();
    render(
      <>
        <input aria-label="i" />
        <textarea aria-label="t" />
        <select aria-label="s"><option>x</option></select>
        <div aria-label="e" contentEditable suppressContentEditableWarning><span>inner</span></div>
        <Shortcuts go={go} hasProjects />
      </>,
    );
    const boxes = [screen.getByLabelText("i"), screen.getByLabelText("t"), screen.getByLabelText("s"), screen.getByText("inner")];
    for (const box of boxes) {
      press("?", { shiftKey: true }, box);
      press("g", {}, box);
      press("d", {}, box);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(go).not.toHaveBeenCalled();
  });

  it("never fires over another open dialog, or with Ctrl, Alt or Meta held", () => {
    const go = vi.fn();
    render(<Shortcuts go={go} hasProjects />);
    for (const mod of ["ctrlKey", "altKey", "metaKey"]) {
      press("?", { shiftKey: true, [mod]: true });
      press("g", { [mod]: true });
      press("d", { [mod]: true });
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(go).not.toHaveBeenCalled();
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-modal", "true");
    document.body.appendChild(other);
    press("?", { shiftKey: true });
    press("g");
    press("d");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(go).not.toHaveBeenCalled();
  });
});
