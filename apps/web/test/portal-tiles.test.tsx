// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PortalApp } from "../src/pages/Portal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("BOS-1921: a summary that only repeats the title is shown once; a different one is kept", async () => {
  window.location.hash = "#tok";
  const features = [
    { id: "a", title: "Dark mode", description: "Dark mode.", stage: "under_consideration", myVote: null },
    { id: "b", title: "Export", description: "Download everything as CSV", stage: "under_consideration", myVote: null },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ title: "Next", intro: null, hasLogo: false, features }), { status: 200 })));
  render(<PortalApp />);
  await screen.findByRole("heading", { name: "Next" });
  expect(await screen.findAllByText("Dark mode")).toHaveLength(1);
  expect(screen.getByText("Download everything as CSV")).toBeTruthy();
  expect(document.querySelectorAll("ul.portal-list > li")).toHaveLength(2);
});
