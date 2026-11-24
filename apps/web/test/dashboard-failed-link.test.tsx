// @vitest-environment jsdom
// BOS-2350: the Run activity chart's Failed legend item links to Runs filtered to failed runs; hidden at 0.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Chart } from "../src/pages/Dashboard";

afterEach(cleanup);

const series = [
  { key: "succeeded", label: "Finished", tone: "green" },
  { key: "failed", label: "Failed", tone: "red" },
];

it("shows 'N failed in 14 days' as a link to the failed filter when N > 0", () => {
  const days = [
    { day: "2026-11-22", succeeded: 3, failed: 2 },
    { day: "2026-11-23", succeeded: 1, failed: 1 },
  ];
  render(<Chart title="Run activity" emptyText="none" days={days} series={series} failedLink="#/runs?result=failed" />);
  expect(screen.getByRole("link", { name: "3 failed in 14 days" }).getAttribute("href")).toBe("#/runs?result=failed");
});

it("shows no link at 0 failed", () => {
  render(<Chart title="Run activity" emptyText="none" days={[{ day: "2026-11-23", succeeded: 4, failed: 0 }]} series={series} failedLink="#/runs?result=failed" />);
  expect(screen.queryByRole("link")).toBeNull();
});
