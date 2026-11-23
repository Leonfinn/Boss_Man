// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketDownloadButton } from "../src/components/TicketDownloadButton";
import { fetchAllMessages, ticketFileName, ticketMarkdown, type ExportMessage } from "../src/ticket-markdown";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const msg = (id: string, at: string, over: Partial<ExportMessage> = {}): ExportMessage => ({ id, author: "agent", agent: "Sam", text: `text ${id}`, delivery: null, createdAt: at, ...over });

const TICKET = {
  id: "t1",
  companyId: "c1",
  ref: "BOS-12",
  title: "Fix the login page: it's broken!",
  systemState: "review",
  outcome: null,
  assignee: "Sam",
  risk: "low",
  size: 2,
  featureId: "f1",
  body: "The login page 500s.",
  acceptanceCriteria: ["Login works", "Error page is friendly"],
  stateNote: "1 pass; 2 fail",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ticket Markdown (BOS-2314)", () => {
  it("names the file ref then short title", () => {
    expect(ticketFileName("BOS-12", "Fix the login page: it's broken!")).toBe("BOS-12-fix-the-login-page-it-s-broken.md");
    expect(ticketFileName(null, "!!!")).toBe("ticket.md");
    expect(ticketFileName("BOS-1", "x".repeat(200))).toBe(`BOS-1-${"x".repeat(50)}.md`);
  });

  it("holds the facts, description, verdicts, state note and conversation oldest first", () => {
    const md = ticketMarkdown(TICKET, [msg("a", "2026-11-23T07:46:12.000Z", { author: "owner", agent: null, text: "Please fix" }), msg("b", "2026-11-23T08:00:00.000Z", { text: "Done.\n\nDetails:\nsha" })], "Login");
    expect(md).toContain("# BOS-12: Fix the login page: it's broken!");
    expect(md).toContain("- State: In review\n- Assignee: Sam\n- Risk: low\n- Size: 2\n- Feature: Login");
    expect(md).toContain("## Description\n\nThe login page 500s.");
    expect(md).toContain("1. **pass**: Login works\n2. **fail**: Error page is friendly");
    expect(md).toContain("## State note\n\n1 pass; 2 fail");
    expect(md).toContain("**Owner** · 2026-11-23 07:46 UTC\n\nPlease fix\n\n---\n\n**Sam** · 2026-11-23 08:00 UTC\n\nDone.\n\nDetails:\nsha\n");
    expect(md.indexOf("Please fix")).toBeLessThan(md.indexOf("Done."));
    expect(md.endsWith("sha\n")).toBe(true);
  });

  it("says what is missing rather than leaving gaps", () => {
    const md = ticketMarkdown({ ...TICKET, ref: null, assignee: null, risk: null, size: null, body: null, acceptanceCriteria: [], stateNote: null, systemState: "done", outcome: "cancelled" }, [], null);
    expect(md).toContain("# Fix the login page");
    expect(md).toContain("- State: Cancelled\n- Assignee: nobody\n- Risk: not rated\n- Size: not sized\n- Feature: none");
    expect(md).toContain("_No description._");
    expect(md).toContain("## Acceptance criteria\n\n_None._");
    expect(md).toContain("_No messages._");
  });

  it("fetches older pages past the newest until the server has no more", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        urls.push(url);
        if (url.endsWith("before=m3")) return Promise.resolve(json({ items: [msg("m1", "2026-01-01T00:00:01Z"), msg("m2", "2026-01-01T00:00:02Z")], hasMore: false }));
        return Promise.resolve(json({ items: [msg("m3", "2026-01-01T00:00:03Z"), msg("m4", "2026-01-01T00:00:04Z")], hasMore: true }));
      }),
    );
    const all = await fetchAllMessages("t1");
    expect(all.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(urls).toEqual(["/api/tickets/t1/messages", "/api/tickets/t1/messages?before=m3"]);
  });

  it("stops when a page brings nothing new, so a server slip can't loop forever", async () => {
    const f = vi.fn(() => Promise.resolve(json({ items: [msg("m1", "2026-01-01T00:00:01Z")], hasMore: true })));
    vi.stubGlobal("fetch", f);
    expect((await fetchAllMessages("t1")).map((m) => m.id)).toEqual(["m1"]);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("Download button (BOS-2314)", () => {
  it("says Preparing while it fetches, then saves the ticket as Markdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/features")) return json({ features: [{ id: "f1", title: "Login" }] });
        await gate;
        return json({ items: [msg("m1", "2026-01-01T00:00:01Z")], hasMore: false });
      }),
    );
    const blobs: Blob[] = [];
    const names: string[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => (blobs.push(b), "blob:x");
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    render(<TicketDownloadButton t={TICKET as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByRole("button", { name: "Preparing" })).toHaveProperty("disabled", true);
    await act(async () => release());
    await screen.findByRole("button", { name: "Download" });
    expect(names).toEqual(["BOS-12-fix-the-login-page-it-s-broken.md"]);
    expect(blobs[0]!.type).toMatch(/^text\/markdown/);
    const text = await blobs[0]!.text();
    expect(text).toContain("- Feature: Login");
    expect(text).toContain("text m1");
  });

  it("says why when the conversation can't be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{\"error\":\"nope\"}", { status: 500, headers: { "content-type": "application/json" } }))));
    render(<TicketDownloadButton t={{ ...TICKET, featureId: null } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Couldn't prepare the download/);
    expect(screen.getByRole("button", { name: "Download" })).toHaveProperty("disabled", false);
  });
});
