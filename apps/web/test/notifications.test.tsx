// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Notice } from "../src/api";
import { Notifications } from "../src/pages/Notifications";

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
      expect(JSON.parse(sessionStorage.getItem("notifications-filters")!)).toEqual({ status: "unread", level: "ask", company: "none" });
      expect(await screen.findByText("No notifications match")).toBeTruthy();
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
      const { container } = render(<Notifications feed={feed} onChanged={() => {}} companies={companies} />);
      await screen.findByText("Recent phone pushes");
      expect((container.querySelector("details.pushes") as HTMLDetailsElement).open).toBe(false);
    });
  });
});
