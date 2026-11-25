// @vitest-environment jsdom
// BOS-2187: the "Answered" section reads past answers when opened, shows who and what, and pages with "Show older".
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnsweredList } from "../src/pages/Decisions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (n: number, over: Record<string, unknown> = {}) => ({ id: `d${n}`, question: `Question ${n}`, status: "answered", answer: "Stripe", by: "owner", byName: null, companyName: "App Co", note: n === 1 ? "Use the test key, please" : null, at: "2026-11-01T10:00:00.000Z", ticket: { id: `t${n}`, title: `Ticket ${n}`, ref: `BOS-${n}` }, ...over });
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Answered list", () => {
  it("reads nothing until opened, then shows the answer, who, and the ticket link, and Show older adds the next page", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return String(url).includes("cursor=c1") ? reply({ items: [item(2, { by: "ceo", byName: "Casey" })], next: null }) : reply({ items: [item(1)], next: "c1" });
    }));
    const { container } = render(<AnsweredList />);
    expect(calls).toHaveLength(0);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await screen.findByText("Question 1");
    expect(screen.getByText("Stripe").textContent).toBe("Stripe");
    expect(container.textContent).toContain("You");
    expect(container.querySelector('a[href="#/tickets/t1"]')).not.toBeNull();
    fireEvent.click(screen.getByText("Show older"));
    await screen.findByText("Question 2");
    expect(container.textContent).toContain("Casey");
    expect(screen.queryByText("Show older")).toBeNull();
  });

  it("Download CSV follows every next cursor with the search and company, and saves one row per card", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("cursor=c1")) return reply({ items: [item(2, { by: "ceo", byName: "Casey", answer: "Yes, ship it" })], next: null });
      return reply({ items: [item(1, { question: "Pay, now?" })], next: "c1" });
    }));
    let saved: Blob | null = null;
    URL.createObjectURL = ((b: Blob) => ((saved = b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    try {
      const { container } = render(<AnsweredList companyId="11111111-1111-4111-8111-111111111111" />);
      const details = container.querySelector("details")!;
      details.open = true;
      fireEvent(details, new Event("toggle"));
      await screen.findByText("Pay, now?");
      fireEvent.change(screen.getByLabelText("Search answered cards"), { target: { value: "pay" } });
      await waitFor(() => expect(urls.some((u) => u.includes("q=pay"))).toBe(true));
      urls.length = 0;
      fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
      await waitFor(() => expect(saved).not.toBeNull());
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain("limit=100");
      expect(urls[0]).toContain("q=pay");
      expect(urls[0]).toContain("companyId=11111111");
      const lines = (await (saved as unknown as Blob).text()).trim().split("\r\n");
      expect(lines[0]).toBe("Answered at,Company,Ticket,Question,Answer,Note,Answered by,Waited (minutes)");
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe('2026-11-01T10:00:00.000Z,App Co,BOS-1,"Pay, now?",Stripe,"Use the test key, please",owner,');
      expect(lines[2]).toContain("Yes");
      expect(lines[2]).toContain("Casey");
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
  });

  it("says so when nothing has been answered, and shows an error when the read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ items: [], next: null })));
    const { container } = render(<AnsweredList />);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await screen.findByText("No card has been answered yet.");
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })));
    const r2 = render(<AnsweredList />);
    const d2 = r2.container.querySelector("details")!;
    d2.open = true;
    fireEvent(d2, new Event("toggle"));
    await waitFor(() => expect(r2.container.querySelector('[role="alert"]')).not.toBeNull());
  });

  it("opens by itself on the one closed card a #/decisions/<id> link names, marked, with a link back to them all (BOS-2326)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (calls.push(String(url)), reply({ items: [item(7)], next: null }))));
    const { container } = render(<AnsweredList companyId="c1" linkedId="d7" />);
    await screen.findByText("Question 7");
    expect(container.querySelector("details")!.open).toBe(true);
    expect(new URL(calls[0]!, "http://x").searchParams.get("id")).toBe("d7");
    const li = container.querySelector("#decision-d7")!;
    expect(li.className).toContain("linked");
    expect(li.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Show all answered").getAttribute("href")).toBe("#/decisions");
    // No link: the whole list, unfiltered, with its search box.
    cleanup();
    calls.length = 0;
    const r2 = render(<AnsweredList companyId="c1" />);
    const d2 = r2.container.querySelector("details")!;
    d2.open = true;
    fireEvent(d2, new Event("toggle"));
    await screen.findByText("Question 7");
    expect(new URL(calls[0]!, "http://x").searchParams.get("id")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search answered cards" })).toBeTruthy();
  });

  it("shows the CEO week line, the filters, and the CEO's reason and what happened next (BOS-2382)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return reply({ items: [item(1, { by: "ceo", byName: "Casey", note: "Looked safe", kind: "merge", outcome: "merged" })], next: null, ceoWeek: { total: 3, byKind: [{ kind: "merge", count: 2 }, { kind: "plan", count: 1 }] } });
    }));
    const { container } = render(<AnsweredList />);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await screen.findByText("Question 1");
    expect(screen.getByTestId("ceo-week").textContent).toContain("This week the CEO answered 3 cards for you: 2 merges, 1 plan.");
    expect(screen.getByTestId("ceo-reason").textContent).toContain("Looked safe");
    expect(screen.getByTestId("ceo-outcome").textContent).toContain("merged");
    expect(new URL(calls[0]!, "http://x").searchParams.get("weeks")).toBe("8");
    fireEvent.click(screen.getByText("Show them"));
    await waitFor(() => expect(calls.some((u) => u.includes("by=ceo"))).toBe(true));
    expect((screen.getByLabelText("Who answered") as HTMLSelectElement).value).toBe("ceo");
    fireEvent.change(screen.getByLabelText("Who answered"), { target: { value: "ceo" } });
    await waitFor(() => expect(calls.some((u) => u.includes("by=ceo"))).toBe(true));
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "merge" } });
    await waitFor(() => expect(calls.some((u) => u.includes("by=ceo") && u.includes("kind=merge"))).toBe(true));
  });
});
