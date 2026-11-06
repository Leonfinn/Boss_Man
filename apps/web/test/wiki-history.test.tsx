// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Wiki } from "../src/pages/Wiki";

const OLD = { id: "r-old", title: "Index", body: "# Index\n\n## Releases\n\n- v1", createdAt: new Date(Date.now() - 3_600_000).toISOString(), agent: "Brian" };
const page = {
  id: "p1",
  slug: "index",
  folder: "",
  title: "Index",
  body: "short",
  updatedAt: new Date().toISOString(),
  updatedBy: "Brian",
  revisions: [
    { id: "r-new", createdAt: new Date().toISOString(), agent: "Brian", runId: null, size: 5 },
    { id: "r-old", createdAt: OLD.createdAt, agent: "Brian", runId: null, size: 38_311 },
  ],
  tickets: [],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stub(revResponse: () => Response) {
  const f = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/wiki-revisions/r-old")) return Promise.resolve(revResponse());
    if (url.includes("/wiki-restore")) return Promise.resolve(json({ ...page, body: OLD.body }));
    if (url.includes("/wiki/index")) return Promise.resolve(json(page));
    return Promise.resolve(json([]));
  });
  vi.stubGlobal("fetch", f);
  return f;
}

describe("wiki history (BOS-430)", () => {
  it("shows each version's size, so a wiped version can be told from a full one", async () => {
    stub(() => json(OLD));
    render(<Wiki companies={[{ id: "c1", name: "App Co", agents: [] } as never]} companyId="c1" slug="index" go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /History/ }));
    expect(screen.getByText(/38,311 characters/)).toBeTruthy();
    expect(screen.getByText(/5 characters/)).toBeTruthy();
  });

  it("says so when a version won't open, instead of the click doing nothing", async () => {
    stub(() => json({ error: "bad_gateway" }, 502));
    render(<Wiki companies={[{ id: "c1", name: "App Co", agents: [] } as never]} companyId="c1" slug="index" go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /History/ }));
    fireEvent.click(screen.getAllByRole("button")[screen.getAllByRole("button").length - 1]!);
    expect(await screen.findByText(/Couldn't open that version/)).toBeTruthy();
  });

  it("puts a version back through restore, so it is a new version that can be undone", async () => {
    const f = stub(() => json(OLD));
    render(<Wiki companies={[{ id: "c1", name: "App Co", agents: [] } as never]} companyId="c1" slug="index" go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /History/ }));
    // The oldest version is the second row of the History list; its time is a button that opens it.
    fireEvent.click(screen.getByText(/38,311 characters/).closest("li")!.querySelector("button")!);
    expect(await screen.findByText(/You.re looking at the version from/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Put this version back" }));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u).includes("/wiki-restore") && i?.method === "POST")).toBe(true));
    const call = f.mock.calls.find(([u]) => String(u).includes("/wiki-restore"))!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ slug: "index", revisionId: "r-old" });
  });
});
