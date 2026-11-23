// @vitest-environment jsdom
// BOS-2251: the Feedback inbox's "Download CSV" exports the notes shown for the current tab and search.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, NoteSummary } from "../src/api";
import { Feedback, fetchAllNotes, noteFilter, notesToCsv } from "../src/pages/Feedback";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const companies = [{ id: "co-1", name: "App Co", agents: [] }] as unknown as Company[];
const note = (over: Partial<NoteSummary>): NoteSummary => ({
  id: "n1",
  companyId: "co-1",
  title: null,
  text: "Please add export",
  source: "owner",
  state: "unprocessed",
  untrusted: false,
  createdAt: "2026-11-08T12:00:00Z",
  customer: "Sam",
  insightCount: 2,
  features: [],
  ...over,
});

describe("notesToCsv", () => {
  it("writes ISO times and quotes text with commas and newlines", () => {
    const [head, line] = notesToCsv([note({ title: "Export", text: "a, b" })]).split("\r\n");
    expect(head).toBe("received,from,title,text,state,linked_features");
    expect(line).toBe('2026-11-08T12:00:00.000Z,Sam,Export,"a, b",unprocessed,2');
  });
});

describe("Download CSV button", () => {
  const stub = (rows: NoteSummary[]) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/feedback?") ? rows : url.includes("/feedback/unprocessed") ? {} : url.includes("/features") ? null : []), { status: 200 })));

  it("is disabled when the list is empty", async () => {
    stub([]);
    render(<Feedback companies={companies} companyId="co-1" noteId={undefined} go={() => {}} />);
    await screen.findByText("Nothing waiting. Add feedback above.");
    expect((screen.getByRole("button", { name: "Download CSV" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("exports only the notes of the tab shown, named after it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.includes("state=archived") ? [note({ id: "n2", text: "Old one", state: "archived" })] : url.includes("/feedback?") ? [note({})] : url.includes("/feedback/unprocessed") ? {} : url.includes("/features") ? null : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    let saved: Blob | null = null;
    let name = "";
    URL.createObjectURL = ((b: Blob) => ((saved = b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { name = this.download; };
    try {
      render(<Feedback companies={companies} companyId="co-1" noteId={undefined} go={() => {}} />);
      await screen.findByText("Please add export");
      fireEvent.click(screen.getAllByRole("tab").find((t) => /archived/i.test(t.textContent ?? ""))!);
      await screen.findByText("Old one");
      fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
      await waitFor(() => expect(saved).not.toBeNull());
      const text = await (saved as unknown as Blob).text();
      expect(text).toContain("Old one");
      expect(text).not.toContain("Please add export");
      expect(name).toMatch(/^feedback-App-Co-archived-\d{4}-\d{2}-\d{2}\.csv$/);
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
  });

  it("downloads the rows shown", async () => {
    stub([note({})]);
    let saved: Blob | null = null;
    URL.createObjectURL = ((b: Blob) => ((saved = b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    render(<Feedback companies={companies} companyId="co-1" noteId={undefined} go={() => {}} />);
    await screen.findByText("Please add export");
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(saved).not.toBeNull());
    expect(await (saved as unknown as Blob).text()).toContain("2026-11-08T12:00:00.000Z,Sam,,Please add export,unprocessed,2");
  });

  it("pages back past the 50 shown so the file holds every note", async () => {
    const mk = (i: number) => note({ id: `n${i}`, text: `note ${i}`, createdAt: new Date(Date.UTC(2026, 10, 1) - i * 1000).toISOString() });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const before = /before=([^&]+)/.exec(url);
      const start = before ? 200 : 0;
      const count = before ? 20 : 200;
      return new Response(JSON.stringify(Array.from({ length: count }, (_, k) => mk(start + k))), { status: 200 });
    }));
    const rows = await fetchAllNotes("co-1", "archived", "export");
    expect(rows).toHaveLength(220);
    expect(urls[0]).toContain("state=archived&limit=200&q=export");
    expect(urls[1]).toContain("before=");
  });
});

describe("linked feature states", () => {
  it("shows status tags, 'Not linked yet', and the delivered line on the Delivered tab", async () => {
    const linked = note({ id: "n1", text: "Wants dark mode", features: [{ id: "f1", title: "Dark mode", status: "released" }] });
    const bare = note({ id: "n2", text: "Wants nothing yet", features: [] });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.includes("delivered=true") ? [linked] : url.includes("/feedback?") ? [linked, bare] : url.includes("/feedback/unprocessed") ? {} : url.includes("/features") ? null : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    render(<Feedback companies={companies} companyId="co-1" noteId={undefined} go={() => {}} />);
    await screen.findByText("Wants nothing yet");
    expect(screen.getByText("Dark mode: Released")).toBeTruthy();
    expect(screen.getByText("Not linked yet")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("tab").find((t) => /delivered/i.test(t.textContent ?? ""))!);
    await screen.findByText("1 note is delivered: their features are all released.");
    expect(screen.queryByText("Wants nothing yet")).toBeNull();
  });
});

describe("noteFilter", () => {
  it("maps the Delivered tab to delivered=true and the others to a state", () => {
    expect(noteFilter("delivered")).toBe("delivered=true");
    expect(noteFilter("processed")).toBe("state=processed");
  });
});
