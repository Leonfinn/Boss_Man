// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoreAbout } from "../src/components/MoreAbout";
import { StopAllWork } from "../src/pages/Settings";

// The shorter page intros (P7, BOS-1278): each place keeps one lead sentence visible and puts the rest behind
// a "More about this" button. Closed by default, the button is a real one with aria-expanded and works from the
// keyboard, and the bullets are in the page only while it is open.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("More about this", () => {
  it("shows the lead at once and keeps the bullets out of the page until the button is pressed", () => {
    render(
      <MoreAbout lead="Choose how loudly Boss Man tells you about things.">
        <li>Notes stay in this feed.</li>
      </MoreAbout>,
    );
    expect(screen.getByText("Choose how loudly Boss Man tells you about things.")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "More about this" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Notes stay in this feed.")).toBeNull();
    expect(toggle.getAttribute("aria-controls")).toBeTruthy();
  });

  it("opens with a press and with the keyboard, links the buttons to the list, and closes again", () => {
    render(
      <MoreAbout lead="One line.">
        <li>First rule.</li>
        <li>Second rule.</li>
      </MoreAbout>,
    );
    const toggle = screen.getByRole("button", { name: "More about this" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(list).toBeTruthy();
    expect(within(list as HTMLElement).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["First rule.", "Second rule."]);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("First rule.")).toBeNull();

    // Enter and Space on a focused button fire a click in a real browser; here we press the button itself.
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(screen.getByText("Second rule.")).toBeTruthy();
  });

  it("gives each fold its own id, so a page can hold more than one", () => {
    render(
      <>
        <MoreAbout lead="First lead.">
          <li>A.</li>
        </MoreAbout>
        <MoreAbout lead="Second lead.">
          <li>B.</li>
        </MoreAbout>
      </>,
    );
    const [first, second] = screen.getAllByRole("button", { name: "More about this" });
    expect(first!.getAttribute("aria-controls")).not.toBe(second!.getAttribute("aria-controls"));
  });
});

describe("Stop all work: the P7 intro", () => {
  it("keeps the short lead visible and folds the rest away until asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ paused: false })));
    render(<StopAllWork />);
    const region = screen.getByRole("region", { name: "Stop all work" });
    expect(within(region).getByText("Stops every company from starting new agent runs until you press Resume.")).toBeTruthy();
    expect(within(region).queryByText(/Runs already going are not cut off/)).toBeNull();
    // The control the intro describes is still there, ready to press.
    await within(region).findByRole("button", { name: "Stop all work" });

    const toggle = within(region).getByRole("button", { name: "More about this" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(region).getByText(/Runs already going are not cut off/)).toBeTruthy();
    expect(within(region).getByText(/Wake-ups and messages wait in line/)).toBeTruthy();
  });
});
