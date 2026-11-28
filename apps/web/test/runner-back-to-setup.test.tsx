// @vitest-environment jsdom
// BOS-2826: Settings → Runner links back to the setup wizard only while the wizard is still open.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackToSetup } from "../src/pages/settings/Runner";
import { stubFetchByUrl } from "./stub-fetch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Back to setup on Settings → Runner", () => {
  it("shows while setup is open and points at the wizard", async () => {
    stubFetchByUrl({ "/api/setup-progress": { dismissed: false, step: 2, companyId: "c1" } });
    render(<BackToSetup />);
    expect((await screen.findByText("Back to setup")).getAttribute("href")).toBe("#/setup");
  });

  it("is gone once setup was dismissed", async () => {
    stubFetchByUrl({ "/api/setup-progress": { dismissed: true, step: 2, companyId: "c1" } });
    render(<BackToSetup />);
    // Wait for the answer to land, then check nothing was drawn.
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0));
    await act(async () => {}); // let the reply land
    expect(screen.queryByText("Back to setup")).toBeNull();
  });
});
