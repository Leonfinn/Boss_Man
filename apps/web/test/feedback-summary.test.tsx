// @vitest-environment jsdom
// BOS-2455: the Feedback inbox's summary line, "Oldest first" and "Show older".
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, NoteSummary } from "../src/api";
import { daysWaited, feedbackOrderHref, feedbackPageQuery, readFeedbackOrder, waitedText } from "../src/feedback-summary";
import { Feedback } from "../src/pages/Feedback";

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "#/feedback/co-1";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const companies = [{ id: "co-1", name: "App Co", agents: [] }] as unknown as Company[];
const note = (i: number): NoteSummary => ({
  id: `n${i}`,
  companyId: "co-1",
  title: null,
  text: `note number ${i}`,
  source: "owner",
  state: "unprocessed",
  untrusted: false,
  createdAt: new Date(Date.UTC(2026, 10, 20) - i * 1000).toISOString(),
  customer: null,
  insightCount: 0,
  features: [],
});

describe("helpers", () => {
  it("reads and writes the order in the address", () => {
    expect(readFeedbackOrder(new URLSearchParams("order=oldest"))).toBe("oldest");
    expect(readFeedbackOrder(new URLSearchParams("order=x"))).toBe("newest");
    expect(feedbackOrderHref("#/feedback/co-1/n2?order=oldest", "newest")).toBe("#/feedback/co-1/n2");
    expect(feedbackOrderHref("#/feedback/co-1", "oldest")).toBe("#/feedback/co-1?order=oldest");
  });
  it("pages by before in newest order and by after in oldest order", () => {
    expect(feedbackPageQuery("newest", "T")).toBe("&order=newest&limit=50&before=T");
    expect(feedbackPageQuery("oldest", "T")).toBe("&order=oldest&limit=50&after=T");
  });
  it("counts whole days waited, never negative", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(daysWaited("2026-11-23T12:00:00Z", now)).toBe(1);
    expect(daysWaited("2026-11-22T00:00:00Z", now)).toBe(2);
    expect(daysWaited("2026-11-25T12:00:00Z", now)).toBe(0);
  });
  it("words the wait", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(waitedText("2026-11-24T08:00:00Z", now)).toBe("less than a day");
    expect(waitedText("2026-11-23T08:00:00Z", now)).toBe("1 day");
    expect(waitedText("2026-11-10T08:00:00Z", now)).toBe("14 days");
  });
});

describe("Feedback inbox", () => {
  it("shows the summary line, and Show older loads the next 50 under the list", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      let body: unknown = [];
      if (url.includes("/feedback-summary")) body = { waiting: 61, oldest: { id: "n60", title: "note number 60", createdAt: "2026-11-01T00:00:00Z" }, week: { portal: 3, github: 2, owner: 1 } };
      else if (url.includes("/feedback?")) body = url.includes("before=") ? [note(50), note(51)] : Array.from({ length: 50 }, (_, i) => note(i));
      else if (url.includes("/feedback/unprocessed")) body = {};
      else if (url.includes("/features")) body = null;
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    render(<Feedback companies={companies} companyId="co-1" noteId={undefined} go={() => {}} />);
    const line = await screen.findByTestId("feedback-summary");
    expect(line.textContent).toContain("61 waiting to be triaged");
    expect(line.textContent).toContain("this week: 3 from the portal, 2 from GitHub, 1 added here");
    expect(screen.getByRole("link", { name: "note number 60" }).getAttribute("href")).toBe("#/feedback/co-1/n60");
    fireEvent.click(await screen.findByRole("button", { name: "Show older" }));
    await screen.findByText("note number 51");
    expect(urls.some((u) => u.includes("before="))).toBe(true);
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("Oldest first asks for the oldest order, keeps it in the address and pages with after", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.includes("/feedback?") ? Array.from({ length: 50 }, (_, i) => note(100 - i)) : url.includes("/feedback/unprocessed") ? {} : url.includes("/features") ? null : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    render(<Feedback companies={companies} companyId="co-1" noteId={undefined} go={() => {}} />);
    await screen.findByText("note number 100");
    fireEvent.change(screen.getByLabelText("Order"), { target: { value: "oldest" } });
    expect(window.location.hash).toBe("#/feedback/co-1?order=oldest");
    await waitFor(() => expect(urls.some((u) => u.includes("order=oldest"))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Show newer" }));
    await waitFor(() => expect(urls.some((u) => u.includes("order=oldest") && u.includes("after="))).toBe(true));
  });
});
