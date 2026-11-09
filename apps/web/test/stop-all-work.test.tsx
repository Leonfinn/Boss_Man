// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HoldBanner } from "../src/App";
import { StopAllWork } from "../src/pages/Settings";

// Settings → Server and runner → Stop all work and the every-page banner with Resume (BOS-836): both read the
// server-wide hold from GET /api/kill-switch and set it with POST, and a press in one shows in the other at once.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

/** A fake server holding the hold, recording each POST body. */
function server(start: boolean) {
  const state = { paused: start, posts: [] as unknown[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/kill-switch");
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { paused: boolean };
        state.posts.push(body);
        state.paused = body.paused;
      }
      return json({ paused: state.paused });
    }),
  );
  return state;
}

describe("Stop all work", () => {
  it("says plainly what it does, turns the hold on after a confirm, and the banner shows at once", async () => {
    const s = server(false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <>
        <HoldBanner />
        <StopAllWork />
      </>,
    );
    const button = (await screen.findByRole("button", { name: "Stop all work" })) as HTMLButtonElement;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    const text = screen.getByRole("region", { name: "Stop all work" }).textContent!;
    expect(text).toContain("starts no new agent runs");
    expect(text).toContain("finish by themselves");
    expect(text).toContain("Runs page");
    expect(screen.queryByText("All work is stopped.")).toBeNull();
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Resume" });
    expect(s.posts).toEqual([{ paused: true }]);
    expect(screen.getByTestId("stop-all-on").textContent).toContain("All work is stopped");
    expect(screen.queryByRole("button", { name: "Stop all work" })).toBeNull();
  });

  it("shows no banner on a server that never had the hold set", async () => {
    server(false);
    render(<HoldBanner />);
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("All work is stopped.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("does nothing when the confirm is cancelled", async () => {
    const s = server(false);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<StopAllWork />);
    const button = (await screen.findByRole("button", { name: "Stop all work" })) as HTMLButtonElement;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(s.posts).toEqual([]);
  });

  it("shows the banner from the server's state on load, and Resume lifts it everywhere", async () => {
    const s = server(true);
    render(
      <>
        <HoldBanner />
        <StopAllWork />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await screen.findByRole("button", { name: "Stop all work" });
    expect(s.posts).toEqual([{ paused: false }]);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Resume" })).toBeNull());
  });
});
