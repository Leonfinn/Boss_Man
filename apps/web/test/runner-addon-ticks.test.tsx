// @vitest-environment jsdom
// BOS-1583: the runner add-on tick boxes in Settings → Runner.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Runner } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const status = (addons: unknown) => ({ registered: true, runnerId: "r1", connected: true, lastSeenAt: null, imageVersion: null, diskUsedBytes: null, addons });
const installed = [{ id: "agent-browser", version: "0.39.0", ok: true }];

function stub(selection: unknown, addons: unknown) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/self-deploy/runner-addons") return init?.method === "PUT" ? json({ saved: [] }) : json(selection);
      return json(status(addons));
    }),
  );
  return calls;
}

describe("runner add-on tick boxes", () => {
  it("starts ticked from what the runner already has when nothing was saved (add-ons set by hand in .env)", async () => {
    stub({ enabled: true, saved: null, built: null }, installed);
    render(<Runner company={company} />);
    const browser = (await screen.findByRole("checkbox", { name: "Browser (agent-browser)" })) as HTMLInputElement;
    await vi.waitFor(() => expect(browser.checked).toBe(true));
    expect((screen.getByRole("checkbox", { name: "WebKit (Playwright)" }) as HTMLInputElement).checked).toBe(false);
  });

  it("saves exactly the ticked set, and the first save keeps an add-on that was already there", async () => {
    const calls = stub({ enabled: true, saved: null, built: null }, installed);
    render(<Runner company={company} />);
    const browser = (await screen.findByRole("checkbox", { name: "Browser (agent-browser)" })) as HTMLInputElement;
    await vi.waitFor(() => expect(browser.checked).toBe(true));
    const save = (await screen.findByRole("button", { name: "Save add-ons" })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "WebKit (Playwright)" }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await vi.waitFor(() => expect(calls).toContainEqual({ method: "PUT", url: "/api/self-deploy/runner-addons", body: { ids: ["agent-browser", "webkit"] } }));
    expect(await screen.findByText(/builds the runner with exactly these add-ons/)).toBeTruthy();
  });

  it("the saved choice wins over what is installed, and says it waits for the next build", async () => {
    stub({ enabled: true, saved: ["webkit"], built: ["agent-browser"] }, installed);
    render(<Runner company={company} />);
    const web = (await screen.findByRole("checkbox", { name: "WebKit (Playwright)" })) as HTMLInputElement;
    await vi.waitFor(() => expect(web.checked).toBe(true));
    expect((screen.getByRole("checkbox", { name: "Browser (agent-browser)" }) as HTMLInputElement).checked).toBe(false);
    expect(await screen.findByText(/Not on the runner yet: press Build and update runners/)).toBeTruthy();
  });

  it("without self-deploy the boxes are off and say why", async () => {
    stub({ enabled: false, saved: null, built: null }, null);
    render(<Runner company={company} />);
    expect(await screen.findByText(/needs self-deploy set up/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Browser (agent-browser)" }) as HTMLInputElement).disabled).toBe(true);
  });
});
