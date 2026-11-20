// @vitest-environment jsdom
// BOS-1910: "⚠ N looks stuck" in the strip: hidden at 0, links (focus) to the first stuck card.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkStands } from "../src/components/WorkStands";

afterEach(cleanup);
const counts = { inProgress: 2, nextUp: 0, beingChecked: 0, watching: 0 };

describe("looks stuck in the strip", () => {
  it("is hidden at 0", () => {
    render(<WorkStands counts={counts} stuck={0} />);
    expect(screen.queryByTestId("standing-stuck")).toBeNull();
  });

  it("shows the count and moves to the first stuck card", () => {
    const card = document.createElement("article");
    card.dataset.ticketId = "t-1";
    const a = document.createElement("a");
    a.href = "#/tickets/t-1";
    card.append(a);
    card.scrollIntoView = () => {};
    document.body.append(card);
    render(<WorkStands counts={counts} stuck={2} stuckTicketId="t-1" />);
    const item = screen.getByTestId("standing-stuck");
    expect(item.textContent).toBe("⚠2 looks stuck");
    fireEvent.click(item);
    expect(document.activeElement).toBe(a);
    card.remove();
  });
});
