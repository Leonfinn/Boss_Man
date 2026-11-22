// @vitest-environment jsdom
// BOS-1909: the "Where work stands" strip: a labelled group, zero items hidden, each item a link to its lane.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkStands } from "../src/components/WorkStands";

afterEach(cleanup);

describe("Where work stands strip", () => {
  it("shows the counted work, then the dashed group with only the non-zero items", () => {
    render(<WorkStands counts={{ inProgress: 6, nextUp: 5, beingChecked: 0, watching: 19 }} />);
    const strip = screen.getByRole("group", { name: "Where work stands" });
    expect(strip.textContent).toContain("6 in progress");
    const quiet = screen.getByRole("group", { name: "Moving by itself, nothing to do" });
    expect(quiet.textContent).toContain("5 next up");
    expect(quiet.textContent).toContain("19 merged, watching");
    expect(quiet.textContent).not.toContain("being checked");
  });

  it("hides the whole quiet group when all three are 0", () => {
    render(<WorkStands counts={{ inProgress: 0, nextUp: 0, beingChecked: 0, watching: 0 }} />);
    expect(screen.queryByRole("group", { name: "Moving by itself, nothing to do" })).toBeNull();
    expect(screen.getByTestId("work-stands").textContent).toContain("0 in progress");
  });

  it("moves focus to the lane heading instead of changing the page hash", () => {
    const h = document.createElement("h2");
    h.id = "lane-live-check";
    h.tabIndex = -1;
    h.scrollIntoView = () => {};
    document.body.appendChild(h);
    render(<WorkStands counts={{ inProgress: 1, nextUp: 0, beingChecked: 0, watching: 2 }} targets={{ watching: "lane-live-check" }} />);
    fireEvent.click(screen.getByTestId("standing-watching"));
    expect(document.activeElement).toBe(h);
    h.remove();
  });

  it("off the Board its items link to the Board", () => {
    render(<WorkStands counts={{ inProgress: 1, nextUp: 1, beingChecked: 0, watching: 0 }} hrefFor="#/board" />);
    expect(screen.getByTestId("standing-nextUp").getAttribute("href")).toBe("#/board");
  });
});
