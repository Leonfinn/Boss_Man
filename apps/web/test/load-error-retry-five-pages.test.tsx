// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FundingCards } from "../src/pages/Funding";
import { Engagement } from "../src/pages/Engagements";
import { ProjectBudget } from "../src/pages/ProjectBudget";
import { AnsweredList } from "../src/pages/Decisions";
import type { Project } from "../src/api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("a failed load offers Retry (BOS-2275)", () => {
  it("Funding: error with Retry, no spinner beside it, and Retry reloads", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => (fail ? json({ error: "boom" }, 500) : json([]))));
    render(<FundingCards />);
    await screen.findByText(/Couldn't load funding sources/);
    expect(screen.queryByRole("status")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/No funding sources yet/);
  });

  it("an engagement's page: error with Retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
    render(<Engagement id="e1" />);
    await screen.findByText(/Couldn't load the engagement/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("project Budget: error with Retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
    render(<ProjectBudget project={{ id: "p1" } as Project} />);
    await screen.findByText(/Couldn't load the budget/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Decisions → Answered: error with Retry, and Retry loads the list", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => (fail ? json({ error: "boom" }, 500) : json({ items: [], next: null }))));
    const { container } = render(<AnsweredList />);
    const d = container.querySelector("details") as HTMLDetailsElement;
    d.open = true;
    fireEvent(d, new Event("toggle"));
    await screen.findByText(/Couldn't load answered cards/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/No card has been answered yet/);
  });
});
