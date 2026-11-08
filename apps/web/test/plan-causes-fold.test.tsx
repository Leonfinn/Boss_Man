// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, Plan as PlanData, PlanNode } from "../src/api";
import { Plan } from "../src/pages/Plan";

// BOS-745: the "What's holding work up" box shows 5 items then "Show all N", its heading arrow
// rolls it up, and both choices survive a reload (and so the 30-second refresh).

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
});

const company = { id: "c1", name: "App Co", mission: "x", paused: false, agents: [] } as Company;

const ticket = (i: number, holdingUp: number): PlanNode => ({
  id: `t${i}`,
  kind: "ticket",
  ref: `BOS-${100 + i}`,
  title: `Blocker number ${i}`,
  state: "in_progress",
  open: true,
  link: `#/ticket/t${i}`,
  assignee: "Someone",
  project: "Development",
  layer: 0,
  blocked: false,
  causes: [],
  holdingUp,
});

const blockerCount = (n: number): PlanData => ({
  nodes: Array.from({ length: n }, (_, i) => ticket(i, n - i)),
  edges: [],
  columns: [],
});

function stubPlan(plan: PlanData) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(plan), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

async function renderPlan(plan: PlanData) {
  stubPlan(plan);
  render(<Plan companies={[company]} companyId="c1" go={() => {}} />);
  const heading = await screen.findByRole("heading", { name: /What's holding work up/ });
  return within(heading.closest(".card") as HTMLElement);
}

const causeItems = (box: ReturnType<typeof within>) => box.getAllByRole("listitem");

describe("What's holding work up (BOS-745)", () => {
  it("shows the first 5 items and a 'Show all N' button when there are more", async () => {
    const box = await renderPlan(blockerCount(14));
    expect(causeItems(box)).toHaveLength(5);
    const more = box.getByRole("button", { name: /Show all 14/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    // The order is kept: most-held-up first.
    expect(causeItems(box)[0]!.textContent).toContain("Blocker number 0");
    expect(causeItems(box)[4]!.textContent).toContain("Blocker number 4");
  });

  it("expands to every item and rolls back with 'Show fewer'", async () => {
    const box = await renderPlan(blockerCount(14));
    fireEvent.click(box.getByRole("button", { name: /Show all 14/ }));
    expect(causeItems(box)).toHaveLength(14);
    const fewer = box.getByRole("button", { name: /Show fewer/ });
    expect(fewer.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fewer);
    expect(causeItems(box)).toHaveLength(5);
    expect(box.getByRole("button", { name: /Show all 14/ })).toBeTruthy();
  });

  it("has no 'Show all' button with 5 or fewer items", async () => {
    const box = await renderPlan(blockerCount(5));
    expect(causeItems(box)).toHaveLength(5);
    expect(box.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("rolls the whole box up to its heading and count, and back out", async () => {
    const box = await renderPlan(blockerCount(14));
    const head = box.getByRole("button", { name: /What's holding work up \(14\)/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect((document.getElementById("causes-body") as HTMLElement).hidden).toBe(true);
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect((document.getElementById("causes-body") as HTMLElement).hidden).toBe(false);
  });

  it("remembers both choices across a reload", async () => {
    let box = await renderPlan(blockerCount(14));
    fireEvent.click(box.getByRole("button", { name: /Show all 14/ }));
    fireEvent.click(box.getByRole("button", { name: /What's holding work up/ }));
    cleanup();

    box = await renderPlan(blockerCount(14));
    const head = box.getByRole("button", { name: /What's holding work up \(14\)/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(head);
    expect(causeItems(box)).toHaveLength(14);
    expect(box.getByRole("button", { name: /Show fewer/ })).toBeTruthy();
  });
});
