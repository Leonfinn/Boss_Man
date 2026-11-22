// @vitest-environment jsdom
// BOS-2257: a failed load of the review policy, a project's Reviews setting or the CEO's chapters says so, with Retry.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REVIEW_POLICY } from "@boss-man/shared";
import type { Company } from "../src/api";
import { CompanyReviews, ProjectReviews } from "../src/components/ReviewPolicy";
import { Chapters } from "../src/pages/settings/Team";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const reply = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const failing = () => vi.stubGlobal("fetch", vi.fn(async () => reply(500, { error: "boom", message: "The server had a problem" })));

describe("Reviews and chapters load failures", () => {
  it("company reviews: error with Retry, not an endless spinner", async () => {
    failing();
    render(<CompanyReviews companyId="c1" agents={[]} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the review policy");
    expect(screen.queryByText("Loading the review policy")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });

  it("company reviews: Retry after the server recovers shows the presets and table; the first load shows the spinner", async () => {
    let ok = false;
    vi.stubGlobal("fetch", vi.fn(async () => (ok ? reply(200, DEFAULT_REVIEW_POLICY) : reply(500, { error: "boom", message: "The server had a problem" }))));
    render(<CompanyReviews companyId="c1" agents={[]} />);
    // The Loader's words only appear after its first second; the status region is there from the start.
    expect(screen.getByRole("status")).toBeTruthy();
    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).toBeNull();
    ok = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText("Review preset");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("project reviews and chapters: nothing but the spinner/blank while the first load runs", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<ProjectReviews projectId="p-pending" companyId="c-pending" agents={[]} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    render(<Chapters company={{ ...company, id: "c-pending" }} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No chapter yet/)).toBeNull();
  });

  it("project reviews: error with Retry, not a vanished setting", async () => {
    failing();
    render(<ProjectReviews projectId="p1" companyId="c1" agents={[]} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load this project's reviews");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("chapters: error with Retry, not a blank section", async () => {
    failing();
    render(<Chapters company={company} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the CEO's chapters");
    expect(screen.queryByText(/No chapter yet/)).toBeNull();
  });
});
