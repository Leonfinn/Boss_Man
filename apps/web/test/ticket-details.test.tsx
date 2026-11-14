// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Ticket } from "../src/pages/Ticket";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const base = { id: "t1", title: "Add limiter", systemState: "in_progress", risk: "low", projectId: "p1", project: "App", companyId: "c1", assignee: null, createdAt: "2026-10-19T09:00:00Z", lastActivityAt: "2026-10-19T09:00:00Z" };

function stub(ticket: Record<string, unknown>, row: { artifacts?: unknown[]; links?: unknown; linksFail?: boolean; images?: unknown[] } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/tickets/t1") return json({ ...base, ...ticket });
      if (url.includes("/links")) return row.linksFail ? json({ error: "links", message: "The links service didn't answer." }, 500) : json(row.links ?? { waitsOn: [], blocks: [], blockedBy: [] });
      if (url.includes("/features")) return json({ features: [] });
      if (url.includes("/messages")) return json({ live: null, items: [] });
      if (url.endsWith("/artifacts")) return json(row.artifacts ?? []);
      if (url.endsWith("/images")) return json(row.images ?? []);
      if (url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
      return json({});
    }),
  );
  vi.stubGlobal("innerWidth", 1440);
  return render(<Ticket id="t1" companies={[company]} />);
}

/** The count shown on a row, by its title. */
const countIn = (container: HTMLElement, title: string) => {
  const row = [...container.querySelectorAll(".detail-row")].find((d) => d.querySelector(".detail-title")?.textContent === title)!;
  return row?.querySelector(".detail-count")?.textContent;
};
const rowIn = (container: HTMLElement, title: string) => [...container.querySelectorAll(".detail-row")].find((d) => d.querySelector(".detail-title")?.textContent === title) as HTMLDetailsElement | undefined;

describe("the Details card (BOS-1195)", () => {
  it("puts Done when to Changes in one labelled card, and Review stays its own card", async () => {
    const { container } = stub({ systemState: "review", repoUrl: "https://x/y.git", branch: "bm/t1" });
    await screen.findByText("Done when");
    expect(container.querySelector('section.card.details-card[aria-label="Details"]')).toBeTruthy();
    const titles = [...container.querySelectorAll(".details-card .detail-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Done when", "After it goes live", "What it produced", "Roadmap and dependencies", "Changes"]);
    // Review is still its own fold card, not a row.
    expect([...container.querySelectorAll(".fold-title")].map((e) => e.textContent)).toContain("Review");
  });

  it("counts the criteria, and says none yet on a new task", async () => {
    const many = stub({ acceptanceCriteria: ["Health check returns 200", "Migration is expand-only", "Sign-in works on a phone"], stateNote: "Health check returns 200 pass. Migration is expand-only pass." });
    await screen.findByText("Done when");
    expect(countIn(many.container, "Done when")).toBe("2 of 3 passed");
    cleanup();
    vi.unstubAllGlobals();
    const fresh = stub({ acceptanceCriteria: [], stateNote: null });
    await screen.findByText("Done when");
    expect(countIn(fresh.container, "Done when")).toBe("none yet");
    expect(screen.getByText(/No criteria yet\./)).toBeTruthy();
  });

  it("says how many criteria before any report, singular and plural", async () => {
    const one = stub({ acceptanceCriteria: ["Only one"], stateNote: null });
    await screen.findByText("Done when");
    expect(countIn(one.container, "Done when")).toBe("1 criterion");
    cleanup();
    vi.unstubAllGlobals();
    const two = stub({ acceptanceCriteria: ["A", "B"], stateNote: null });
    await screen.findByText("Done when");
    expect(countIn(two.container, "Done when")).toBe("2 criteria");
  });

  it("counts the owner's steps, amber only when there are some", async () => {
    const some = stub({ ownerSetup: "Open Settings\nRestart it" });
    await screen.findByText("After it goes live");
    expect(countIn(some.container, "After it goes live")).toBe("2 steps for you");
    expect(rowIn(some.container, "After it goes live")!.querySelector(".detail-count")!.className).toContain("amber");
    cleanup();
    vi.unstubAllGlobals();
    const none = stub({ ownerSetup: null });
    await screen.findByText("After it goes live");
    expect(countIn(none.container, "After it goes live")).toBe("nothing for you");
    expect(rowIn(none.container, "After it goes live")!.querySelector(".detail-count")!.className).not.toContain("amber");
  });

  it("counts what it produced, its code, and nothing yet", async () => {
    const items = [{ id: "a1", kind: "wiki_page", title: "Report", slug: "report", path: null, ref: null, url: null, agent: null, runId: null, createdAt: "2026-10-19T09:00:00Z" }, { id: "a2", kind: "url", title: "Link", slug: null, path: null, ref: null, url: "https://example.com", agent: null, runId: null, createdAt: "2026-10-19T09:00:00Z" }];
    const two = stub({}, { artifacts: items });
    await screen.findByText("Done when");
    expect(countIn(two.container, "What it produced")).toBe("2 items");
    cleanup();
    vi.unstubAllGlobals();
    const merged = stub({ repoUrl: "https://x/y.git", mergeCommit: "1a2b3c4d5e6f" });
    await screen.findByText("Done when");
    expect(countIn(merged.container, "What it produced")).toBe("code merged as 1a2b3c4");
    cleanup();
    vi.unstubAllGlobals();
    const nothing = stub({});
    await screen.findByText("Done when");
    expect(countIn(nothing.container, "What it produced")).toBe("nothing yet");
  });

  it("counts the Images row", async () => {
    const image = { id: "i1", name: "shot.png", caption: "Before", size: 1000, createdAt: "2026-10-19T09:00:00Z" };
    const { container } = stub({}, { images: [image] });
    await screen.findByText("Images");
    expect(countIn(container, "Images")).toBe("1");
  });

  it("counts what it waits on, and says none", async () => {
    const waits = stub({}, { links: { waitsOn: [{ dependencyId: "d1", kind: "ticket", id: "x", title: "BOS-1 Fix", state: "ready", open: true, link: "#/tickets/1" }], blocks: [], blockedBy: [] } });
    await screen.findByText("Roadmap and dependencies");
    expect(countIn(waits.container, "Roadmap and dependencies")).toBe("waits on 1");
    // The row's own body still lists it.
    expect(screen.getByText("BOS-1 Fix")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    const none = stub({});
    await screen.findByText("Roadmap and dependencies");
    expect(countIn(none.container, "Roadmap and dependencies")).toBe("none");
  });

  it("says couldn't load when the row's own request fails", async () => {
    const failed = stub({}, { linksFail: true });
    await screen.findByText("Roadmap and dependencies");
    await waitFor(() => expect(countIn(failed.container, "Roadmap and dependencies")).toBe("couldn't load"));
  });

  it("opens Done when while the task is in review, and leaves it closed otherwise", async () => {
    const inReview = stub({ systemState: "review", acceptanceCriteria: ["A", "B"], stateNote: null });
    await screen.findByText("Done when");
    expect(rowIn(inReview.container, "Done when")!.open).toBe(true);
    cleanup();
    vi.unstubAllGlobals();
    const working = stub({ systemState: "in_progress", acceptanceCriteria: ["A", "B"], stateNote: null });
    await screen.findByText("Done when");
    expect(rowIn(working.container, "Done when")!.open).toBe(false);
  });

  it("opens Plan while it waits for your approval, and closes it once approved", async () => {
    const waiting = stub({ plan: "Step 1\nStep 2", planApprovedAt: null });
    await screen.findByText("Plan", { selector: ".detail-title" });
    expect(rowIn(waiting.container, "Plan")!.open).toBe(true);
    expect(countIn(waiting.container, "Plan")).toBe("waiting for your approval");
    cleanup();
    vi.unstubAllGlobals();
    const approved = stub({ plan: "Step 1", planApprovedAt: "2026-10-19T09:00:00Z" });
    await screen.findByText("Plan", { selector: ".detail-title" });
    expect(rowIn(approved.container, "Plan")!.open).toBe(false);
    expect(countIn(approved.container, "Plan")).toMatch(/^approved /);
  });

  it("counts the Changes row", async () => {
    const branch = stub({ repoUrl: "https://x/y.git", branch: "bm/t1" });
    await screen.findByText("Changes");
    expect(countIn(branch.container, "Changes")).toBe("on its branch");
    cleanup();
    vi.unstubAllGlobals();
    const merged = stub({ repoUrl: "https://x/y.git", branch: "bm/t1", mergeCommit: "1a2b3c4d5e6f" });
    await screen.findByText("Changes");
    expect(countIn(merged.container, "Changes")).toBe("merged as 1a2b3c4");
  });

  it("opens a row to what the old fold showed", async () => {
    const { container } = stub({ ownerSetup: "Open Settings" });
    await screen.findByText("After it goes live");
    const row = rowIn(container, "After it goes live")!;
    expect(row.open).toBe(false);
    fireEvent.click(row.querySelector("summary")!);
    expect(row.open).toBe(true);
  });
});
