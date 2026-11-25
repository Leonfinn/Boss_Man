// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LastSevenDays } from "../src/pages/settings/Notifications";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const counts = { notices: 0, pushed: 0, quiet: 0, cap: 0, failed: 0 };
const days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"].map((day) => ({ day, ...counts }));

it("shows the day table, totals, noisiest agents and the latest failure with a link", async () => {
  const week = {
    timeZone: "Europe/London",
    days: days.map((d, i) => (i === 6 ? { ...d, notices: 4, pushed: 1, quiet: 2, cap: 1, failed: 1 } : d)),
    totals: { notices: 4, pushed: 1, quiet: 2, cap: 1, failed: 1 },
    topAgents: [{ agentId: "a1", name: "Ann", notices: 3, pushed: 1 }],
    lastFailure: { id: "n1", at: "2026-11-22T10:00:00Z", error: "ntfy answered 502", link: "#/notifications/n1", title: "t" },
  };
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(week))));
  render(<LastSevenDays companyId="c1" />);
  expect(await screen.findByText("2026-11-22")).toBeTruthy();
  expect(screen.getByText("7 days")).toBeTruthy();
  expect(screen.getByText(/Ann: 3 notices, 1 to your phone/)).toBeTruthy();
  expect(screen.getByText(/ntfy answered 502/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "See the notice" }).getAttribute("href")).toBe("#/notifications/n1");
  const url = (vi.mocked(fetch).mock.calls[0] as unknown as [string])[0];
  expect(url).toBe("/api/notifications/week?company=c1");
});

it("says nothing was sent when the week is empty", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ timeZone: "UTC", days, totals: counts, topAgents: [], lastFailure: null }))));
  render(<LastSevenDays companyId="c1" />);
  expect(await screen.findByText("Nothing was sent in the last 7 days.")).toBeTruthy();
});

it("shows the load error with Retry, and Retry asks again", async () => {
  const f = vi.fn(() => Promise.resolve(json({ error: "boom" }, 500)));
  vi.stubGlobal("fetch", f);
  render(<LastSevenDays companyId="c1" />);
  const retry = await screen.findByRole("button", { name: "Retry" });
  const before = f.mock.calls.length;
  fireEvent.click(retry);
  await vi.waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(before));
});
