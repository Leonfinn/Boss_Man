// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubWatch } from "../src/pages/settings/Projects";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GitHub watcher load states", () => {
  it("says so with a Retry when the load fails, instead of vanishing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "server_busy" }), { status: 500, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GithubWatch projectId="p1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load the GitHub feedback watcher");
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
  });

  it("shows the loading mark while the first load is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<GithubWatch projectId="p1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(container.textContent).toContain("Loading the GitHub feedback watcher");
  });
});
