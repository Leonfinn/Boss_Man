// @vitest-environment jsdom
// BOS-2761: Tab stays inside the open shortcuts list (aria-modal), and the "These need a keyboard." line
// follows the browser's (any-pointer: fine) test.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shortcuts } from "../src/components/Shortcuts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shortcuts list focus and touch line (BOS-2761)", () => {
  it("Tab from the last control wraps to the first, and Shift+Tab from the first wraps to the last", () => {
    render(<><button type="button">Page behind</button><Shortcuts go={() => {}} hasProjects initialOpen onTurnKeysOn={() => {}} /></>);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const close = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "Turn off single-letter keys" });
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false); // default prevented
    expect(document.activeElement).toBe(close);
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
    // In the middle Tab is left to the browser.
    expect(dialog.contains(document.activeElement)).toBe(true);
    close.focus();
    expect(fireEvent.keyDown(close, { key: "Tab" })).toBe(true);
  });

  it("shows the line when no pointer is fine, and not when there is a mouse", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    render(<Shortcuts go={() => {}} hasProjects initialOpen />);
    expect(document.querySelector(".shortcuts-note")!.textContent).toMatch(/^These need a keyboard\./);
    cleanup();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
    render(<Shortcuts go={() => {}} hasProjects initialOpen />);
    expect(document.querySelector(".shortcuts-note")!.textContent).not.toMatch(/need a keyboard/);
  });
});
