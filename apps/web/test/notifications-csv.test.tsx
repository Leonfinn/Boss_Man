// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notice } from "../src/api";
import { Notifications, noticesToCsv } from "../src/pages/Notifications";

// BOS-2520: "Download CSV" saves the notices shown (pages loaded with "Show older", filters, search) and marks nothing read.

const mk = (id: string, over: Partial<Notice> = {}): Notice => ({
  id, companyId: "c1", company: "Acme", agentId: "a1", requested: "note", level: "note", demotedBy: null,
  title: `Title ${id}`, body: null, link: "#/tickets/t1", pushedAt: null, pushError: null, readAt: null,
  createdAt: new Date(Date.UTC(2026, 10, 20, 10, 0, 0)).toISOString(), ...over,
});

let blobs: Blob[] = [];
let calls: Array<{ url: string; method: string }> = [];
const json = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  blobs = [];
  calls = [];
  URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return "blob:x"; });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("noticesToCsv", () => {
  it("writes one row per notice with type, lowered by, push result and the full link, quoting commas", () => {
    const csv = noticesToCsv([
      mk("a", { requested: "page", level: "flag", demotedBy: "quiet hours", body: "Hello, \"you\"", pushError: "ntfy refused", readAt: "2026-11-21T00:00:00.000Z" }),
      mk("b", { level: "ask", requested: "ask", pushedAt: "2026-11-20T10:00:05.000Z" }),
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Time,Company,Type,Asked-for type (when lowered),Lowered by,Title,Text,Read at,Pushed to phone at,Push error,Link");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",Acme,Flag,Page,quiet hours,Title a,\"Hello, \"\"you\"\"\",2026-11-21T00:00:00.000Z,,ntfy refused,");
    expect(lines[1]).toMatch(/,http:\/\/localhost[^,]*#\/tickets\/t1$/);
    expect(lines[2]).toContain(",Acme,Ask,,,Title b,,,2026-11-20T10:00:05.000Z,,");
  });
});

describe("noticesToCsv seeded rows", () => {
  it("4 notices (lowered, push error, read, no company) give a header and 4 rows; hostile titles are quoted or guarded", () => {
    const csv = noticesToCsv([
      mk("a", { requested: "page", level: "flag", demotedBy: "quiet hours" }),
      mk("b", { level: "page", requested: "page", pushError: "refused" }),
      mk("c", { readAt: "2026-11-21T00:00:00.000Z" }),
      mk("d", { companyId: null, company: null, title: "=SUM(A1), \"x\"\nline two" }),
    ]);
    expect(csv.split("\r\n").length).toBeGreaterThanOrEqual(6);
    expect(csv).toContain("\"'=SUM(A1), \"\"x\"\"\nline two\"");
    expect(csv).toContain(",,Note,,,'=SUM".replace("'=SUM", "\"'=SUM"));
    expect(csv.startsWith("Time,Company,Type,")).toBe(true);
  });
});

describe("Notifications Download CSV", () => {
  it("with the Unread filter on, the file holds only the unread notices returned", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("status=unread")) return json({ items: [mk("u")], unread: 1 });
      throw new Error(`no stub for ${url}`);
    }));
    render(<Notifications feed={{ items: [mk("u"), mk("r", { readAt: "2026-11-21T00:00:00.000Z" })], unread: 1, counts: { level: {}, company: {} } }} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Unread/ }));
    await waitFor(() => expect(screen.queryByText("Title r")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const text = await blobs[0]!.text();
    expect(text.trim().split("\r\n")).toHaveLength(2);
    expect(text).toContain("Title u");
  });

  it("saves the rows shown under the filter, including an older page, and marks nothing read", async () => {
    const first = Array.from({ length: 50 }, (_, i) => mk(`f${i}`, { createdAt: new Date(Date.UTC(2026, 10, 20, 10, 0, 100 - i)).toISOString() }));
    const older = [mk("o1", { createdAt: new Date(Date.UTC(2026, 10, 10)).toISOString() })];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("before=")) return json({ items: older, unread: 0 });
      throw new Error(`no stub for ${url}`);
    }));
    render(<Notifications feed={{ items: first, unread: 51 }} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await screen.findByText("Title o1");
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(blobs).toHaveLength(1);
    const lines = (await blobs[0]!.text()).trim().split("\r\n");
    expect(lines).toHaveLength(52);
    expect(lines.join("\n")).toContain("Title o1");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("with a status filter on, the file holds only what the filtered list returned", async () => {
    const all = [mk("a"), mk("b")];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("level=ask")) return json({ items: [mk("q", { level: "ask", requested: "ask" })], unread: 1 });
      throw new Error(`no stub for ${url}`);
    }));
    render(<Notifications feed={{ items: all, unread: 2, counts: { level: { ask: 1 }, company: {} } }} onChanged={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Ask/ })[0]!);
    await screen.findByText("Title q");
    await waitFor(() => expect(screen.queryByText("Title a")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const text = await blobs[0]!.text();
    expect(text.trim().split("\r\n")).toHaveLength(2);
    expect(text).toContain("Title q");
    expect(text).not.toContain("Title a");
  });
});
