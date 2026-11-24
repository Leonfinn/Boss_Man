// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RecordRuns } from "../src/pages/Agents";

afterEach(cleanup);

it("shows runs, failed runs and the share, with 'failed' linking to the Runs page's failed filter", () => {
  render(<RecordRuns runs={8} failedRuns={3} />);
  expect(screen.getByTestId("record-runs").textContent).toBe("8 runs · 3 failed (38%)");
  expect(screen.getByRole("link", { name: "3 failed" }).getAttribute("href")).toBe("#/runs?result=failed");
});

it("shows plain '0 failed' with no link when nothing failed, and copes with no runs", () => {
  render(<RecordRuns runs={1} failedRuns={0} />);
  expect(screen.getByTestId("record-runs").textContent).toBe("1 run · 0 failed (0%)");
  expect(screen.queryByRole("link")).toBeNull();
  cleanup();
  render(<RecordRuns runs={0} failedRuns={0} />);
  expect(screen.getByTestId("record-runs").textContent).toBe("0 runs · 0 failed (0%)");
});
