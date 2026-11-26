// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Transcript, TranscriptItem } from "../src/api";
import { Run, runMarkdown } from "../src/pages/Run";

// BOS-2322: "Download" the run's transcript as Markdown, fetching every page.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const company = { id: "c1", name: "App Co", agents: [] } as unknown as Company;
const run = { id: "r1", companyId: "c1", agent: "Ada Lee", agentId: "a1", ticketId: "t1", ticket: "Fix it", runTicketRef: "BOS-7", startedAt: "2026-11-01T10:00:00Z", endedAt: "2026-11-01T10:30:00Z", outcome: "end_turn" };
const say = (seq: number, text: string) => ({ seq, type: "run.update", at: "2026-11-01T10:00:00Z", event: { update: { kind: "agent_message", text } } });

describe("run download (BOS-2322)", () => {
  it("fetches all pages, cuts long text and names the file by agent and ticket", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.includes("/transcript")) return new Response("[]", { status: 200 });
        asked.push(url);
        const after = Number(/after=(\d+)/.exec(url)![1]);
        const body = after === 0 ? { run, items: [say(1, "first")], next: 1, more: true } : { run, items: [say(2, "x".repeat(3000))], next: 2, more: false };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const blobs: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => (blobs.push(b), "blob:x");
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    render(<Run runId="r1" companies={[company]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    await vi.waitFor(() => expect(blobs).toHaveLength(1));
    expect(names[0]).toBe("run-ada-lee-bos-7.md");
    const text = await blobs[0]!.text();
    expect(text).toContain("- Agent: Ada Lee");
    expect(text).toContain("- Ticket: BOS-7 Fix it");
    expect(text).toContain("- Outcome: end_turn");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("xxx"));
    expect(text).toContain("(cut)");
    expect(text).not.toContain("x".repeat(2001));
  });

  it("shows Preparing while fetching, and an error line with no file when the fetch fails", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let fail = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.includes("/transcript")) return new Response("[]", { status: 200 });
        if (fail) {
          await gate;
          return new Response(JSON.stringify({ error: "Server went away" }), { status: 500 });
        }
        return new Response(JSON.stringify({ run, items: [say(1, "hi")], next: 1, more: false }), { status: 200 });
      }),
    );
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Run runId="r1" companies={[company]} />);
    const btn = await screen.findByRole("button", { name: "Download" });
    fail = true;
    fireEvent.click(btn);
    const busy = await screen.findByRole("button", { name: "Preparing" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByRole("alert");
    expect(clicks).not.toHaveBeenCalled();
  });
});

// BOS-2620: the Markdown itself, called directly (no render, DOM or network).
describe("runMarkdown (BOS-2620)", () => {
  const madeUpRun = (over: Partial<Transcript["run"]> = {}) =>
    ({
      id: "r9",
      companyId: "c1",
      agent: "Zara Quill",
      agentId: "a9",
      ticketId: "t9",
      ticket: "Tidy the widget shelf",
      startedAt: "2026-11-02T09:05:00.000Z",
      endedAt: "2026-11-02T10:30:00.000Z",
      outcome: "end_turn",
      costMicros: 0,
      ...over,
    }) as Transcript["run"];

  const item = (type: string, at: string, event: Record<string, unknown>): TranscriptItem => ({ seq: 1, type, at, event });
  const says = (at: string, text: string) => item("run.update", at, { update: { kind: "agent_message", text } });
  const tool = (at: string, title: string, status: string) => item("run.update", at, { update: { kind: "tool_call", title, status } });

  it("heads with agent, ticket ref and title, and drops what is missing", () => {
    const full = runMarkdown(madeUpRun(), "BOS-9", []);
    expect(full.split("\n")[0]).toBe("# Run: Zara Quill, BOS-9 Tidy the widget shelf");
    expect(full).toContain("- Ticket: BOS-9 Tidy the widget shelf");

    const noRef = runMarkdown(madeUpRun(), null, []);
    expect(noRef.split("\n")[0]).toBe("# Run: Zara Quill, Tidy the widget shelf");
    expect(noRef).toContain("- Ticket: Tidy the widget shelf");
    expect(noRef).not.toContain("BOS-");

    const noTicket = runMarkdown(madeUpRun({ ticket: null, ticketId: null }), "BOS-9", []);
    expect(noTicket.split("\n")[0]).toBe("# Run: Zara Quill");
    expect(noTicket).not.toContain("- Ticket:");
    expect(noTicket).not.toContain("BOS-9");

    const noAgent = runMarkdown(madeUpRun({ agent: null }), "BOS-9", []);
    expect(noAgent.split("\n")[0]).toBe("# Run: An agent, BOS-9 Tidy the widget shelf");
    expect(noAgent).toContain("- Agent: An agent");
  });

  it("writes UTC times, and still running / end_turn when the run has not settled", () => {
    const ended = runMarkdown(madeUpRun(), "BOS-9", []);
    expect(ended).toContain("- Started: 2026-11-02 09:05 UTC");
    expect(ended).toContain("- Ended: 2026-11-02 10:30 UTC");

    const live = runMarkdown(madeUpRun({ endedAt: null, outcome: null }), "BOS-9", []);
    expect(live).toContain("- Ended: still running");
    expect(live).toContain("- Outcome: still running");

    const noOutcome = runMarkdown(madeUpRun({ outcome: null }), "BOS-9", []);
    expect(noOutcome).toContain("- Outcome: end_turn");
  });

  it("gives each item a bold label, a UTC time and a body, cutting long text", () => {
    const text = runMarkdown(madeUpRun(), "BOS-9", [
      says("2026-11-02T09:05:01.000Z", "Looking at the shelf."),
      tool("2026-11-02T09:05:02.000Z", "Read file", "running"),
    ]);
    expect(text).toContain("**Agent** · 09:05:01 UTC");
    expect(text).toContain("Looking at the shelf.");
    expect(text).toContain("**Read file** · 09:05:02 UTC");
    expect(text).toContain(`Status: running`);

    const cut = runMarkdown(madeUpRun(), "BOS-9", [says("2026-11-02T09:05:03.000Z", "y".repeat(2_500))]);
    expect(cut).toContain("(cut)");
    expect(cut).not.toContain("y".repeat(2_001));
  });

  it("shows only the header when there are no items", () => {
    const lines = runMarkdown(madeUpRun(), "BOS-9", []).trimEnd().split("\n");
    expect(lines).toHaveLength(7);
    expect(lines.at(-1)).toBe("- Outcome: end_turn");
    expect(lines.some((line) => line.startsWith("**"))).toBe(false);
  });
});
