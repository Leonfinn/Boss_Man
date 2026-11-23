// @vitest-environment jsdom
// BOS-2350: #/runs?result=failed opens the Runs page already filtered to failed runs; the link wins over the
// saved filter and is saved like a click.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Runs } from "../src/pages/Runs";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

it("reads result from the link, over a saved filter, and saves it", async () => {
  localStorage.setItem("bm.runs.filter", JSON.stringify({ companyId: "", agentId: "", result: "finished", q: "" }));
  window.location.hash = "#/runs?result=failed";
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/runs/recent")) urls.push(url);
      return new Response("[]", { status: 200 });
    }),
  );
  render(<Runs companies={[] as Company[]} />);
  expect((await screen.findByRole("button", { name: "Failed" })).getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => expect(urls.at(-1)).toBe("/api/runs/recent?limit=50&result=failed"));
  expect(JSON.parse(localStorage.getItem("bm.runs.filter") ?? "{}").result).toBe("failed");
  // A later visit without the link keeps Failed (it was saved).
  cleanup();
  window.location.hash = "#/runs";
  render(<Runs companies={[] as Company[]} />);
  expect((await screen.findByRole("button", { name: "Failed" })).getAttribute("aria-pressed")).toBe("true");
});
