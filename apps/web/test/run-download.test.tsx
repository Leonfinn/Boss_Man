// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Run } from "../src/pages/Run";

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
});
