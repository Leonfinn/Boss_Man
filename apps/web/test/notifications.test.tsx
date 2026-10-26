// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notice } from "../src/api";
import { Notifications } from "../src/pages/Notifications";

afterEach(() => {
  cleanup();
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
});
