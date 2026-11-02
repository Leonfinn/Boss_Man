// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";

afterEach(cleanup);

const picture = "![Architecture overview](/api/ticket-images/11111111-2222-3333-4444-555555555555)";

describe("a picture in a wiki page (BOS-330)", () => {
  it("opens enlarged in an overlay on the page instead of a new window", () => {
    render(<Markdown text={picture} wikiCompanyId="c1" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enlarge: Architecture overview" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Architecture overview");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The enlarged copy is the picture from the company's image route, shown at natural size.
    const enlarged = dialog.querySelector(".lightbox-scroll img");
    expect(enlarged?.getAttribute("src")).toBe("/api/ticket-images/11111111-2222-3333-4444-555555555555");
    expect(enlarged?.className).toBe("natural");
    // The caption is the alt text.
    expect(dialog.querySelector(".lightbox-caption")?.textContent).toBe("Architecture overview");
  });

  it("closes with the X button and returns focus to the picture", () => {
    render(<Markdown text={picture} wikiCompanyId="c1" />);
    const opener = screen.getByRole("button", { name: "Enlarge: Architecture overview" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Close the enlarged picture" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes with Escape", () => {
    render(<Markdown text={picture} wikiCompanyId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Enlarge: Architecture overview" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes when the backdrop is clicked but not when the picture is", () => {
    render(<Markdown text={picture} wikiCompanyId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Enlarge: Architecture overview" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog.querySelector(".lightbox-panel")!);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers a fit-to-window toggle and starts at actual size", () => {
    render(<Markdown text={picture} wikiCompanyId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Enlarge: Architecture overview" }));
    const size = screen.getByRole("button", { name: "Fit to window" });
    fireEvent.click(size);
    expect(screen.getByRole("dialog").querySelector(".lightbox-scroll img")?.className).toBe("fit");
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    expect(screen.getByRole("dialog").querySelector(".lightbox-scroll img")?.className).toBe("natural");
  });
});
