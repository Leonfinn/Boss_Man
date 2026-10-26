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

  describe("filters", () => {
    const co = (id: string, name: string) => ({ id, name }) as Company;
    const companies = [co("c1", "HolidayHours"), co("c2", "Acme")];
    const feed = { items: [notice("hello")], unread: 1 };
    const stubFetch = (items: Notice[]) => {
      const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items, unread: items.length }), { status: 200, headers: { "content-type": "application/json" } })));
      vi.stubGlobal("fetch", f);
      return f;
    };
    const urls = (f: ReturnType<typeof stubFetch>) => (f.mock.calls as unknown as [string][]).map((c) => c[0]);

    it("asks the server for the combined filters and remembers them", async () => {
      const f = stubFetch([]);
      render(<Notifications feed={feed} onChanged={() => {}} companies={companies} />);
      fireEvent.click(screen.getByRole("button", { name: "Unread" }));
      fireEvent.click(screen.getByRole("button", { name: "Asks" }));
      fireEvent.change(screen.getByLabelText("Company"), { target: { value: "none" } });
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
      expect((screen.getByLabelText("Company") as HTMLSelectElement).value).toBe("all");
      expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    });
  });
});
