// @vitest-environment jsdom
// BOS-2251: the Feedback inbox's "Download CSV" exports the notes shown for the current tab and search.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, NoteSummary } from "../src/api";
import { Feedback, notesToCsv } from "../src/pages/Feedback";

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
    expect(saved).not.toBeNull();
    expect(await (saved as unknown as Blob).text()).toContain("2026-11-08T12:00:00.000Z,Sam,,Please add export,unprocessed,2");
  });
});
