// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailSetting, MainCiSetting } from "../src/pages/settings/System";

// Settings → Email: Turn off asks first, and a slow or failed load says so instead of a blank page.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const configured = { settings: { host: "smtp.example.com", port: 587, security: "starttls", username: "u", fromAddress: "boss@example.com", fromName: null, hasPassword: true }, configured: true };

function stub() {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return json(configured);
    }),
  );
  return calls;
}
const deletes = (calls: ReturnType<typeof stub>) => calls.filter((c) => c.method === "DELETE");

describe("Settings → Email", () => {
  it("Turn off asks first and sends nothing on Cancel", async () => {
    const calls = stub();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<EmailSetting />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("password are deleted"));
    // test-lines-ok: proving a request is never sent has no event to wait for; the sleep only gives a wrongly sent DELETE time to show, and the confirming test proves one would be seen
    await new Promise((r) => setTimeout(r, 20));
    expect(deletes(calls)).toHaveLength(0);
  });

  it("Turn off deletes once the owner confirms", async () => {
    const calls = stub();
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<EmailSetting />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await vi.waitFor(() => expect(deletes(calls)).toEqual([expect.objectContaining({ url: "/api/settings/email" })]));
  });

  it("shows a loader while loading", async () => {
    // Reads of one path are shared across hooks, so answer the held requests at the end or the next test joins them.
    const held: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>((res) => held.push(() => res(json(url.includes("main-ci") ? { on: false, projects: [] } : configured))))));
    render(<EmailSetting />);
    expect(screen.getByText("Outgoing email")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByLabelText("Server")).toBeNull();
    cleanup();
    render(<MainCiSetting />);
    expect(screen.getByRole("status")).toBeTruthy();
    held.forEach((f) => f());
    await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("shows the error with Retry when a load fails, then the form once it works", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => (fail ? json({ error: "boom" }, 500) : json(configured))));
    render(<EmailSetting />);
    await screen.findByText(/Couldn't load the email setting/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText("Server");
  });

  it("Main's CI shows the error with Retry when its load fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
    render(<MainCiSetting />);
    await screen.findByText(/Couldn't load the Main's CI setting/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
