// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertDestinations } from "../src/components/AlertDestinations";

// BOS-2199: the "Other places to send alerts" box. The address is typed once and never shown again.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const dest = (over: object = {}) => ({ id: "d1", type: "slack", name: "Team channel", kinds: ["decision_waiting", "merge_stuck"], allowPrivate: false, enabled: true, hint: "••••9876", lastFailureNote: null, lastFailedAt: null, ...over });

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve(handler(url, init));
  }));
  return calls;
}

describe("Other places to send alerts", () => {
  it("adds a destination with the two default kinds ticked and sends the address once", async () => {
    let made = false;
    const calls = stub((url, init) => (init?.method === "POST" ? ((made = true), json(dest(), 201)) : json({ destinations: made ? [dest()] : [] })));
    render(<AlertDestinations />);
    expect((screen.getByLabelText("A decision is waiting") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Merging is stuck") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("A spend alert") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Team channel" } });
    fireEvent.change(screen.getByLabelText("Webhook address"), { target: { value: "https://hooks.example.com/services/abc9876" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/address ending ••••9876/)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ type: "slack", name: "Team channel", address: "https://hooks.example.com/services/abc9876", kinds: ["decision_waiting", "merge_stuck"], allowPrivate: false });
    // After saving, the address is not on the page anywhere.
    expect(document.body.innerHTML).not.toContain("abc9876");
    expect((screen.getByLabelText("Webhook address") as HTMLInputElement).value).toBe("");
  });

  it("shows the server's reason when an address is refused", async () => {
    stub((_u, init) => (init?.method === "POST" ? json({ error: "bad_address", message: "The address must start with https://." }, 400) : json({ destinations: [] })));
    render(<AlertDestinations />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Webhook address"), { target: { value: "http://example.com/a" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toContain("must start with https://");
  });

  it("shows the last failure with its time, and the test message's success or status", async () => {
    let n = 0;
    stub((url) => (url.endsWith("/test") ? json(n++ === 0 ? { ok: true, message: "Sent. Check the channel." } : { ok: false, status: 404, message: "The other side answered 404." }) : json({ destinations: [dest({ lastFailureNote: "404", lastFailedAt: "2026-11-20T14:02:00Z" })] })));
    render(<AlertDestinations />);
    const failed = await screen.findByText(/Last failed .*: 404/);
    expect(failed.textContent).toMatch(/^Last failed \d{1,2}:\d{2}.*: 404$/);
    fireEvent.click(screen.getByRole("button", { name: "Send a test message" }));
    expect(await screen.findByText("Sent. Check the channel.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send a test message" }));
    expect(await screen.findByText("The other side answered 404.")).toBeTruthy();
  });

  it("edits the kinds and the address of a destination, and removes it", async () => {
    const calls = stub((_u, init) => (init?.method === "DELETE" ? json({ ok: true }) : init?.method === "PUT" ? json(dest()) : json({ destinations: [dest()] })));
    render(<AlertDestinations />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(screen.getAllByLabelText("A spend alert")[0]!);
    fireEvent.change(screen.getByLabelText(/New address/), { target: { value: "https://hooks.example.com/new1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ kinds: ["decision_waiting", "merge_stuck", "spend_alert"], address: "https://hooks.example.com/new1234" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/alert-destinations/d1")).toBe(true));
  });

  it("says when a destination was switched off, and switching it on sends enabled true", async () => {
    const calls = stub(() => json({ destinations: [dest({ enabled: false, lastFailureNote: "410" })] }));
    render(<AlertDestinations />);
    expect((await screen.findByRole("alert")).textContent).toContain("Switched off after 3 days of failures (last answer: 410)");
    fireEvent.click(screen.getByRole("button", { name: "Switch on" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && JSON.stringify(c.body) === '{"enabled":true}')).toBe(true));
  });
});
