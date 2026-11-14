// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldHelp } from "../src/components/FieldHelp";

afterEach(cleanup);

const help = (label: string, text = "The help text.") => (
  <FieldHelp label={label}>
    <p>{text}</p>
  </FieldHelp>
);

describe("field help behind a ? (BOS-1195)", () => {
  it("is a real button named About <field>, with the help closed until it is pressed", () => {
    render(help("Risk"));
    const btn = screen.getByRole("button", { name: "About Risk" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "About Risk" })).toBeNull();
  });

  it("opens on press with aria-expanded and aria-controls pointing at the help, and closes on a second press", () => {
    render(help("Risk"));
    const btn = screen.getByRole("button", { name: "About Risk" });
    fireEvent.click(btn);
    const pop = screen.getByRole("region", { name: "About Risk" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(pop.id).toBe(btn.getAttribute("aria-controls"));
    expect(pop.textContent).toContain("The help text.");
    // Focus moves into the help (the × is next in the tab order), so it isn't stranded on the button.
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "About Risk" })).toBeNull();
  });

  it("Esc closes it and puts focus back on the ?", () => {
    render(help("Size"));
    const btn = screen.getByRole("button", { name: "About Size" });
    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(btn);
  });

  it("the × closes it and puts focus back on the ?", () => {
    render(help("Watcher"));
    const btn = screen.getByRole("button", { name: "About Watcher" });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "Close Watcher help" }));
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(btn);
  });

  it("a click outside closes it, and a click inside doesn't", () => {
    render(
      <>
        {help("Status")}
        <button type="button">Elsewhere</button>
      </>,
    );
    const btn = screen.getByRole("button", { name: "About Status" });
    fireEvent.click(btn);
    fireEvent.mouseDown(screen.getByRole("region", { name: "About Status" }));
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("only one is open at a time", () => {
    render(
      <>
        {help("Status")}
        {help("Risk")}
      </>,
    );
    const [status, risk] = [screen.getByRole("button", { name: "About Status" }), screen.getByRole("button", { name: "About Risk" })];
    fireEvent.click(status);
    fireEvent.click(risk);
    expect(status.getAttribute("aria-expanded")).toBe("false");
    expect(risk.getAttribute("aria-expanded")).toBe("true");
  });

  it("flips above when there is no room below it in the window", () => {
    // jsdom has no layout, so the button's place in the window is stubbed: close to the bottom.
    const spy = () => ({ top: 700, bottom: 722, left: 0, right: 22, width: 22, height: 22, x: 0, y: 700, toJSON: () => ({}) }) as DOMRect;
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = spy;
    try {
      vi_stubInnerHeight(724);
      render(help("Risk"));
      fireEvent.click(screen.getByRole("button", { name: "About Risk" }));
      expect(screen.getByRole("region", { name: "About Risk" }).className).toContain("above");
    } finally {
      Element.prototype.getBoundingClientRect = real;
    }
  });
});

/** Window height for the flip test; jsdom's own is a plain 768. */
function vi_stubInnerHeight(px: number) {
  Object.defineProperty(window, "innerHeight", { value: px, configurable: true, writable: true });
}
