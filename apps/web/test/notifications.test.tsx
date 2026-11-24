// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Notice } from "../src/api";
import { Notifications } from "../src/pages/Notifications";
import { NotificationSettings } from "../src/pages/settings/Notifications";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const notice = (body: string): Notice => ({ id: "n1", companyId: "c1", company: "HolidayHours", agentId: "a1", requested: "note", level: "note", demotedBy: null, title: 'Reply on "HOL-182"', body, link: "#/tickets/t1", pushedAt: null, pushError: null, readAt: null, createdAt: new Date().toISOString() });

describe("notifications", () => {
  it("shows a long body cut short, and the whole of it in place on Show all", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const body = `${"Yes, this is resolved. ".repeat(20)}The last words.`;
    render(<Notifications feed={{ items: [notice(body)], unread: 1 }} onChanged={() => {}} />);
    expect(screen.queryByText(/The last words\./)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "▸ Show all" }));
    expect(screen.getByText(/The last words\./)).toBeTruthy();
  });

  it("shows a short body whole, with nothing to expand", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<Notifications feed={{ items: [notice("Nothing needed from you.")], unread: 1 }} onChanged={() => {}} />);
    expect(screen.getByText("Nothing needed from you.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("loads the next 50 before the oldest shown on Show older, then hides the button on a short page", async () => {
    const mk = (i: number): Notice => ({ ...notice(`b${i}`), id: `n${i}`, title: `Notice ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - i)).toISOString() });
    const first = Array.from({ length: 50 }, (_, i) => mk(i));
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [mk(50), mk(51)], unread: 0 }), { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", f);
    render(<Notifications feed={{ items: first, unread: 0 }} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(await screen.findByText("Notice 51")).toBeTruthy();
    const url = (f.mock.calls as unknown as [string][]).map((c) => c[0]).find((u) => u.includes("before="))!;
    expect(url).toContain("limit=50");
    expect(decodeURIComponent(url)).toContain(`before=${first[49]!.createdAt}`);
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("groups by day and 'Mark this day read' sends only that day's unread ids (BOS-2441)", async () => {
    const today = new Date();
    const old = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5, 12);
    const items = [
      { ...notice("a"), id: "t1", title: "T1" },
      { ...notice("b"), id: "t2", title: "T2", readAt: today.toISOString() },
      { ...notice("c"), id: "o1", title: "O1", createdAt: old.toISOString() },
    ];
    const f = vi.fn(() => Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", f);
    render(<Notifications feed={{ items, unread: 2 }} onChanged={() => {}} />);
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.getAllByText("1 new").length).toBe(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Mark this day read" })[0]!);
    await waitFor(() => expect(f).toHaveBeenCalled());
    const call = (f.mock.calls as unknown as [string, RequestInit][]).find((c) => c[0] === "/api/notifications/read")!;
    expect(JSON.parse(call[1].body as string)).toEqual({ ids: ["t1"] });
  });

  it("keeps the rows and shows the error when an older load fails", async () => {
    const first = Array.from({ length: 50 }, (_, i) => ({ ...notice("x"), id: `n${i}`, title: `Notice ${i}` }));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }))));
    render(<Notifications feed={{ items: first, unread: 0 }} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.getByText("Notice 49")).toBeTruthy();
  });

  it("sends the filter with the older request and starts again when it changes", async () => {
    const mk = (i: number): Notice => ({ ...notice("x"), id: `n${i}`, title: `Notice ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - i)).toISOString() });
    const page = Array.from({ length: 50 }, (_, i) => mk(i));
    const f = vi.fn((u: string) => {
      const items = u.includes("before=") ? [mk(60)] : page;
      return Promise.resolve(new Response(JSON.stringify({ items, unread: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", f);
    sessionStorage.setItem("notifications-filters", JSON.stringify({ status: "unread", level: "all", company: "all" }));
    render(<Notifications feed={{ items: page, unread: 1 }} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show older" }));
    expect(await screen.findByText("Notice 60")).toBeTruthy();
    const url = (f.mock.calls as unknown as [string][]).map((c) => c[0]).find((u) => u.includes("before="))!;
    expect(url).toContain("status=unread");
    fireEvent.click(screen.getByRole("button", { name: /^Read$/ }));
    await waitFor(() => expect(screen.queryByText("Notice 60")).toBeNull());
  });

  describe("filters", () => {
    const co = (id: string, name: string) => ({ id, name }) as Company;
    const companies = [co("c1", "HolidayHours"), co("c2", "Acme")];
    const feed = { items: [notice("hello")], unread: 1, counts: { level: { note: 1 }, company: { c1: 1, none: 1 } } };
    const stubFetch = (items: Notice[]) => {
      const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items, unread: items.length }), { status: 200, headers: { "content-type": "application/json" } })));
      vi.stubGlobal("fetch", f);
      return f;
    };
    const urls = (f: ReturnType<typeof stubFetch>) => (f.mock.calls as unknown as [string][]).map((c) => c[0]);

    it("asks the server for the combined filters and remembers them", async () => {
      const f = stubFetch([]);
      render(<Notifications feed={feed} onChanged={() => {}} companies={companies} />);
      fireEvent.click(screen.getByRole("button", { name: /^Unread/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Asks/ }));
      fireEvent.click(screen.getByRole("button", { name: /^No company/ }));
      await waitFor(() => expect(urls(f).some((u) => u.includes("status=unread") && u.includes("level=ask") && u.includes("company=none"))).toBe(true));
      expect(JSON.parse(sessionStorage.getItem("notifications-filters")!)).toEqual({ status: "unread", level: "ask", company: "none", text: "" });
      expect(await screen.findByText("No notifications match")).toBeTruthy();
    });

    it("searches after a pause, saves the text, keeps it on Show older, and Clear filters empties the box (BOS-2316)", async () => {
      const mk = (i: number): Notice => ({ ...notice("x"), id: `n${i}`, title: `Runner ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - i)).toISOString() });
      const page = Array.from({ length: 50 }, (_, i) => mk(i));
      const f = vi.fn((u: string) => Promise.resolve(new Response(JSON.stringify({ items: u.includes("before=") ? [mk(60)] : page, unread: 1 }), { status: 200, headers: { "content-type": "application/json" } })));
      vi.stubGlobal("fetch", f);
      render(<Notifications feed={{ items: [notice("hello")], unread: 1 }} onChanged={() => {}} companies={companies} />);
      const box = screen.getByLabelText("Search notifications") as HTMLInputElement;
      fireEvent.change(box, { target: { value: "run" } });
      fireEvent.change(box, { target: { value: "runner" } });
      // Nothing is asked for while the typing continues; one request follows the pause, with the whole text.
      expect(urls(f as ReturnType<typeof stubFetch>).some((u) => u.includes("q="))).toBe(false);
      await waitFor(() => expect(urls(f as ReturnType<typeof stubFetch>).filter((u) => u.includes("q=")).length).toBeGreaterThan(0));
      expect(urls(f as ReturnType<typeof stubFetch>).filter((u) => u.includes("q=")).every((u) => u.includes("q=runner"))).toBe(true);
      expect(JSON.parse(sessionStorage.getItem("notifications-filters")!).text).toBe("runner");
      fireEvent.click(await screen.findByRole("button", { name: "Show older" }));
      expect(await screen.findByText("Runner 60")).toBeTruthy();
      expect(urls(f as ReturnType<typeof stubFetch>).find((u) => u.includes("before="))).toContain("q=runner");
      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      await waitFor(() => expect(box.value).toBe(""));
      expect(JSON.parse(sessionStorage.getItem("notifications-filters")!).text).toBe("");
    });

    it("clears every filter from the empty state", async () => {
      stubFetch([]);
      sessionStorage.setItem("notifications-filters", JSON.stringify({ status: "read", level: "all", company: "all" }));
      render(<Notifications feed={feed} onChanged={() => {}} companies={companies} />);
      await screen.findByText("No notifications match");
      fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[1]!);
      expect(screen.getByText("Reply on \"HOL-182\"")).toBeTruthy();
      expect(screen.queryByText("No notifications match")).toBeNull();
    });

    it("falls back to All companies when the remembered company is gone", () => {
      stubFetch([]);
      sessionStorage.setItem("notifications-filters", JSON.stringify({ status: "all", level: "all", company: "gone" }));
      render(<Notifications feed={feed} onChanged={() => {}} companies={companies} />);
      expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
      expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    });

    it("turns a chip off on a second press, and swaps within a group", () => {
      stubFetch([]);
      render(<Notifications feed={feed} onChanged={() => {}} companies={companies} />);
      const unread = screen.getByRole("button", { name: /^Unread/ });
      fireEvent.click(unread);
      expect(unread.getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Read" }));
      expect(unread.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(screen.getByRole("button", { name: "Read" }));
      expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    });

    it("shows unread counts, hides zeros, caps at 99+, and shows none until they arrive", () => {
      stubFetch([]);
      const withCounts = { items: [notice("hello")], unread: 150, counts: { level: { ask: 2, note: 148 }, company: { c1: 150 } } };
      const { unmount } = render(<Notifications feed={withCounts} onChanged={() => {}} companies={companies} />);
      expect(screen.getByRole("button", { name: "Asks, 2 unread" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Notes, more than 99 unread" }).textContent).toContain("99+");
      expect(screen.getByRole("button", { name: "Pages" }).textContent).not.toMatch(/\d/);
      unmount();
      render(<Notifications feed={{ items: [notice("hello")], unread: 1 }} onChanged={() => {}} companies={companies} />);
      expect(screen.getByRole("button", { name: "Asks" })).toBeTruthy();
    });

    it("opens the one-line legend from the ? button", () => {
      stubFetch([]);
      render(<Notifications feed={feed} onChanged={() => {}} companies={companies} />);
      const help = screen.getByRole("button", { name: "What the types mean" });
      expect(help.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(help);
      expect(help.getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById(help.getAttribute("aria-controls")!)?.hasAttribute("hidden")).toBe(false);
    });

    it("holds more than four companies in one Company dropdown chip", () => {
      stubFetch([]);
      const many = ["A", "B", "C", "D", "E"].map((n) => co(`c-${n}`, n));
      render(<Notifications feed={feed} onChanged={() => {}} companies={many} />);
      fireEvent.change(screen.getByRole("combobox", { name: "Company" }), { target: { value: "c-B" } });
      expect(JSON.parse(sessionStorage.getItem("notifications-filters")!).company).toBe("c-B");
    });

    it("hides the Company group with one company and no company-less notices", () => {
      stubFetch([]);
      render(<Notifications feed={{ items: [notice("hello")], unread: 1, counts: { level: { note: 1 }, company: { c1: 1 } } }} onChanged={() => {}} companies={[co("c1", "HolidayHours")]} />);
      expect(screen.queryByRole("group", { name: "Company" })).toBeNull();
    });

    it("folds the phone-push history shut, with a line saying how many", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }))));
      const { container } = render(<NotificationSettings companies={companies} />);
      await screen.findByText("Recent phone pushes");
      expect((container.querySelector("details.pushes") as HTMLDetailsElement).open).toBe(false);
    });

    it("links to the notification settings and no longer holds them (BOS-2327)", () => {
      stubFetch([]);
      render(<Notifications feed={feed} onChanged={() => {}} companies={companies} />);
      expect(screen.getByRole("link", { name: "Notification settings" }).getAttribute("href")).toBe("#/settings/notifications");
      expect(screen.queryByText("Recent phone pushes")).toBeNull();
    });
  });
});
