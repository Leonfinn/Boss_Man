// @vitest-environment jsdom
// BOS-2162: stopping one run (ticket page "Stop", Run page "Stop run") asks first, sends once, and says
// so when Boss Man ended the run itself because the runner is offline.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { TicketActivity } from "../src/components/TicketActivity";
import { Run } from "../src/pages/Run";

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [] } as unknown as Company;
const ASK = "Stop Ada's run? It stops mid-step, so anything it has not committed yet can be lost.";

/** Serves the polls; cancel calls are recorded and answered by `cancel` (default: ok). */
function stub(cancels: string[], cancel: () => Promise<Response> = async () => json({ ok: true })) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/cancel")) {
        cancels.push(url);
        return cancel();
      }
      if (url.includes("/transcript"))
        return json({ run: { id: "r1", companyId: "c1", agent: "Ada", agentId: "a1", ticketId: null, ticket: null, startedAt: "2026-11-05T10:00:00Z", endedAt: null }, items: [], next: 0, more: false });
      if (url.endsWith("/messages")) return json({ items: [], live: { id: "r1", agent: "Ada" } });
      return json([]);
    }),
  );
}

describe("stopping one run asks first and sends once (BOS-2162)", () => {
  it("ticket page: No sends nothing; Yes sends one request even after a second tap", async () => {
    const cancels: string[] = [];
    let release: (r: Response) => void = () => {};
    stub(cancels, () => new Promise<Response>((res) => (release = res)));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<TicketActivity ticketId="t1" assignee="Ada" />);
    const stop = await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    expect(confirm).toHaveBeenCalledWith(ASK);
    expect(cancels).toHaveLength(0);
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));

    confirm.mockReturnValue(true);
    fireEvent.click(stop);
    fireEvent.click(stop);
    await waitFor(() => expect(cancels).toHaveLength(1));
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    release(json({}));
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
  });

  it("ticket page: says the runner is offline when the server ended the run itself", async () => {
    stub([], async () => json({ endedHere: true }));
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<TicketActivity ticketId="t1" assignee="Ada" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByText("The runner is offline, so Boss Man marked the run as stopped.")).toBeTruthy();
  });

  it("Run page: asks, sends nothing on No, and once on Yes", async () => {
    const cancels: string[] = [];
    stub(cancels);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Run runId="r1" companies={[company]} />);
    const stop = await screen.findByRole("button", { name: "Stop run" });
    fireEvent.click(stop);
    expect(confirm).toHaveBeenCalledWith("Stop this agent's run? It stops mid-step, so anything it has not committed yet can be lost.");
    expect(cancels).toHaveLength(0);
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
    confirm.mockReturnValue(true);
    fireEvent.click(stop);
    await waitFor(() => expect(cancels).toHaveLength(1));
    expect(await screen.findByText("Stopping the run.")).toBeTruthy();
  });
});
