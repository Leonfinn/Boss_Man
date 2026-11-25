// @vitest-environment jsdom
// BOS-2437: the "Why runs started, last 7 days" fold and the Reason filter on the finished runs.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Runs } from "../src/pages/Runs";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const SUMMARY = [
  { reason: "verify failed", runs: 3, costMicros: 4_500_000, share: 0.6 },
  { reason: "mystery", runs: 1, costMicros: 0, share: 0.2 },
  { reason: null, runs: 1, costMicros: 0, share: 0.2 },
];

function stub(urls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/runs/reasons")) return new Response(JSON.stringify(SUMMARY), { status: 200 });
      if (url.startsWith("/api/runs/recent")) urls.push(url);
      return new Response("[]", { status: 200 });
    }),
  );
}

it("shows runs, share and cost per reason with plain labels, and a reason link filters the list", async () => {
  const urls: string[] = [];
  stub(urls);
  render(<Runs companies={[] as Company[]} />);
  expect(await screen.findByText("Why runs started, last 7 days")).toBeTruthy();
  expect(screen.getByText("60%")).toBeTruthy();
  expect(screen.getByText("$4.50")).toBeTruthy();
  expect(screen.getByText("Mystery")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Its merge check failed" }));
  await waitFor(() => expect(urls.at(-1)).toBe("/api/runs/recent?limit=50&reason=verify+failed"));
  expect((screen.getByLabelText("Reason") as HTMLSelectElement).value).toBe("verify failed");
  expect(window.location.hash).toContain("reason=verify%20failed");
});

it("the Reason select filters the finished list and is read from the address", async () => {
  const urls: string[] = [];
  stub(urls);
  window.location.hash = "#/runs?reason=chased";
  render(<Runs companies={[] as Company[]} />);
  await waitFor(() => expect(urls.at(-1)).toBe("/api/runs/recent?limit=50&reason=chased"));
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "" } });
  await waitFor(() => expect(urls.at(-1)).toBe("/api/runs/recent?limit=50"));
});
