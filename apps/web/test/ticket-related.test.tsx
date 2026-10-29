// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketRelated } from "../src/components/TicketRelated";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const row = (n: number, over: Record<string, unknown> = {}) => ({ id: `t${n}`, ref: `BOS-${n}`, title: `Task ${n}`, state: "ready", cancelled: false, ...over });
const empty = { feature: null, parent: null, subtasks: [], peers: [], waitsOn: [], blocks: [], mentioned: [] };
const serve = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => json(body)));

describe("Related tickets", () => {
  it("shows only the groups that have something, open before done, with state badges and links", async () => {
    serve({ ...empty, parent: row(191, { state: "in_progress" }), peers: [row(5, { state: "done" }), row(6), row(7, { state: "done", cancelled: true })] });
    render(<TicketRelated ticketId="t192" companyId="c1" />);
    expect(await screen.findByText("Parent")).toBeTruthy();
    expect(screen.queryByText("Sub-tasks")).toBeNull();
    expect(screen.getByText("BOS-191").closest("a")!.getAttribute("href")).toBe("#/tickets/t191");
    expect(screen.getByText("Cancelled")).toBeTruthy();
    const peers = screen.getByText("Peers").parentElement!.querySelectorAll("li");
    expect([...peers].map((li) => li.querySelector("strong")!.textContent)).toEqual(["BOS-6", "BOS-5", "BOS-7"]);
  });

  it("cuts a long group to five rows and expands it", async () => {
    serve({ ...empty, peers: [1, 2, 3, 4, 5, 6, 7].map((n) => row(n)) });
    render(<TicketRelated ticketId="t0" companyId="c1" />);
    const more = await screen.findByText("show 2 more");
    expect(screen.queryByText("Task 6")).toBeNull();
    fireEvent.click(more);
    expect(screen.getByText("Task 7")).toBeTruthy();
  });

  it("says so, in muted text, when nothing is related", async () => {
    serve(empty);
    render(<TicketRelated ticketId="t0" companyId="c1" />);
    expect(await screen.findByText("No related tickets")).toBeTruthy();
  });
});
