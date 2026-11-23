// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkHealth } from "../src/pages/Wiki";

// BOS-2395: the page list's "Link health" fold. The route is owner-only on the server (wiki-link-health.test.ts).
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stub(handler: (url: string) => Response) {
  const fn = vi.fn(async (url: string) => handler(url));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const open = () => {
  const d = document.querySelector(".wiki-link-health") as HTMLDetailsElement;
  d.open = true;
  fireEvent(d, new Event("toggle"));
};

describe("Link health fold (BOS-2395)", () => {
  it("loads only once opened, then lists missing links (page as a link, slug as text) and orphans with 'and N more'", async () => {
    const fn = stub(() =>
      json({
        missing: [{ slug: "specs/login", title: "Login spec", target: "old-plan-" }],
        missingTotal: 1,
        orphans: [{ slug: "lonely", title: "Lonely page" }],
        orphansTotal: 203,
      }),
    );
    render(<LinkHealth companyId="c1" onPick={() => {}} />);
    await new Promise((r) => setTimeout(r, 0)); // test-lines-ok: one tick so a load on mount would have started
    expect(fn).not.toHaveBeenCalled();
    open();
    await screen.findByText("1 missing-page link");
    expect(String(fn.mock.calls[0]?.[0])).toBe("/api/companies/c1/wiki-link-health");
    expect(screen.getByRole("link", { name: "Login spec" }).getAttribute("href")).toBe("#/wiki/c1/specs/login");
    expect(screen.getByText("old-plan-").closest("a")).toBeNull();
    expect(screen.getByText("203 pages nothing links to")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Lonely page/ }).getAttribute("href")).toBe("#/wiki/c1/lonely");
    expect(screen.getByText("and 202 more")).toBeTruthy();
  });

  it("says so when there is nothing to fix", async () => {
    stub(() => json({ missing: [], missingTotal: 0, orphans: [], orphansTotal: 0 }));
    render(<LinkHealth companyId="c1" onPick={() => {}} />);
    open();
    await screen.findByText("No broken links");
    expect(screen.getByText("Every page is linked from somewhere")).toBeTruthy();
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it("shows the shared load error with Retry", async () => {
    let fail = true;
    stub(() => (fail ? json({ error: "boom" }, 500) : json({ missing: [], missingTotal: 0, orphans: [], orphansTotal: 0 })));
    render(<LinkHealth companyId="c1" onPick={() => {}} />);
    open();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load link health");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await screen.findByText("No broken links");
  });
});
