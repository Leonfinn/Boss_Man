// @vitest-environment jsdom
// The one-time keyboard tip (BOS-2690, BOS-2671 part 3e, the owner chose to include it): the first time a
// login moves around by keyboard outside a text box (a Tab, or Ctrl K), a small panel at the bottom left says
// there are shortcuts. It never appears before that, never when single-letter keys are off, never on a phone
// (640 px or under), and it does not take focus. Any of its four ways to close (Show shortcuts, Got it,
// Escape, "?") hides it and stores "seen" on the login, so it never comes back.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shortcuts } from "../src/components/Shortcuts";

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
