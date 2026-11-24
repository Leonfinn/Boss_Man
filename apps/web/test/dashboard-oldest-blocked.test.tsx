// @vitest-environment jsdom
// BOS-2467: the blocked count says how long the oldest block has lasted and links to that ticket.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OldestBlocked } from "../src/pages/Dashboard";

afterEach(cleanup);

const NOW = Date.parse("2026-11-24T12:00:00Z");

it("shows the age and ref as a link to the ticket", () => {
  render(<OldestBlocked oldest={{ at: "2026-11-20T12:00:00Z", ticketId: "t-1", ref: "BOS-12" }} now={NOW} />);
  const a = screen.getByRole("link", { name: "Oldest block: BOS-12, 4d ago" });
  expect(a.getAttribute("href")).toBe("#/tickets/t-1");
});

it("shows just the age when the ticket has no ref", () => {
  render(<OldestBlocked oldest={{ at: "2026-11-24T09:00:00Z", ticketId: "t-2", ref: null }} now={NOW} />);
  expect(screen.getByRole("link").textContent).toBe("Oldest block: 3h ago");
});

it("shows nothing when no ticket is blocked or the server is older", () => {
  const { container, rerender } = render(<OldestBlocked oldest={null} />);
  expect(container.innerHTML).toBe("");
  rerender(<OldestBlocked />);
  expect(container.innerHTML).toBe("");
});
