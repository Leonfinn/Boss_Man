// @vitest-environment jsdom
// BOS-2390: the Dashboard's weekly folds load when opened, link merged tickets, and offer Retry on a failure.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WeekFold } from "../src/pages/Dashboard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const view = { week: "this", merged: [{ title: "Fix it", feature: "Search", id: "t1" }], spentMicros: 2_500_000, beforeMicros: 1_000_000, released: [], waiting: 0, oldestWaitingMs: null, text: "" };
const open = () => {
  const d = document.querySelector("details")!;
  d.open = true;
  fireEvent(d, new Event("toggle"));
};

it("loads only when opened and links each merged ticket", async () => {
  const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(view), { headers: { "content-type": "application/json" } }));
  render(<WeekFold companyId="c1" week="this" title="This week so far" />);
  expect(f).not.toHaveBeenCalled();
  open();
  const link = await screen.findByRole("link", { name: "Fix it" });
  expect(link.getAttribute("href")).toBe("#/tickets/t1");
  expect(String(f.mock.calls[0]![0])).toContain("/api/companies/c1/weekly-summary/view?week=this");
  expect(screen.getByText(/\$2\.50/)).toBeTruthy();
});

it("shows a load error with Retry, and Retry loads it", async () => {
  const f = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("down")).mockResolvedValue(new Response(JSON.stringify(view), { headers: { "content-type": "application/json" } }));
  render(<WeekFold companyId="c1" week="last" title="Last week" />);
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByRole("link", { name: "Fix it" })).toBeTruthy());
  expect(f).toHaveBeenCalledTimes(2);
});
