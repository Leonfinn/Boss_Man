// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeletedNotice, DeletedPages } from "../src/components/DeletedPages";

// BOS-2197: the wiki bin's "Deleted pages" list and the notice a link to a deleted page shows.
// Owner-only is enforced on the server (the routes sit on the owner router, covered in
// apps/server/test/wiki-bin.test.ts and owner-control-list.test.ts); here we test what the owner sees.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const row = { slug: "specs/login", folder: "specs", title: "Login spec", deletedAt: new Date(Date.now() - 3600_000).toISOString(), deletedBy: "Radagast", purgeOn: "2099-01-31" };

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("DeletedPages list (BOS-2197)", () => {
  it("shows title, folder, who deleted it and when, with Restore; Restore posts, reloads the tree and opens the page", async () => {
    let listed = [row];
    const fn = stub((url) => {
      if (url.includes("/wiki-deleted/restore")) {
        listed = [];
        return json({ ok: true });
      }
      if (url.includes("/wiki-deleted")) return json({ pages: listed });
      return json([]);
    });
    const go = vi.fn();
    const onChanged = vi.fn();
    render(<DeletedPages companyId="c1" go={go} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Deleted pages" }));
    await screen.findByText("Login spec");
    const line = screen.getByText(/deleted .* by Radagast/);
    expect(line.textContent).toContain("specs");
    expect(line.textContent).toContain("2099-01-31");
    fireEvent.click(screen.getByRole("button", { name: "Restore Login spec" }));
    await vi.waitFor(() => expect(go).toHaveBeenCalledWith("wiki/c1/specs/login"));
    const post = fn.mock.calls.find(([u]) => String(u).includes("/wiki-deleted/restore"));
    expect(post).toBeTruthy();
    expect(post?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ slug: "specs/login" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await screen.findByText(/No deleted pages/);
  });

  it("shows the empty state", async () => {
    stub(() => json({ pages: [] }));
    render(<DeletedPages companyId="c1" go={() => {}} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Deleted pages" }));
    await screen.findByText(/No deleted pages/);
  });

  it("shows an error when the list can't load", async () => {
    stub(() => json({ error: "boom" }, 500));
    render(<DeletedPages companyId="c1" go={() => {}} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Deleted pages" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the deleted pages");
  });

  it("shows the error when Restore fails and does not open the page", async () => {
    stub((url) => (url.includes("/restore") ? json({ error: "That address is taken" }, 409) : json({ pages: [row] })));
    const go = vi.fn();
    render(<DeletedPages companyId="c1" go={go} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Deleted pages" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore Login spec" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("taken");
    expect(go).not.toHaveBeenCalled();
  });
});

describe("DeletedNotice (BOS-2197)", () => {
  const stubRow = { title: "Login spec", deletedAt: "2026-11-01T10:00:00.000Z", deletedBy: null, purgeOn: "2026-12-01" };

  it("says when the page was deleted and Restore posts the slug, then calls onRestored", async () => {
    const fn = stub(() => json({ ok: true }));
    const onRestored = vi.fn();
    render(<DeletedNotice companyId="c1" slug="specs/login" stub={stubRow} onRestored={onRestored} />);
    expect(screen.getByText(/This page was deleted on 1 November 2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await vi.waitFor(() => expect(onRestored).toHaveBeenCalledWith("specs/login"));
    expect(JSON.parse(String(fn.mock.calls[0]?.[1]?.body))).toEqual({ slug: "specs/login" });
  });

  it("shows the error when Restore is refused", async () => {
    stub(() => json({ error: "No longer in the bin" }, 404));
    const onRestored = vi.fn();
    render(<DeletedNotice companyId="c1" slug="specs/login" stub={stubRow} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByRole("alert");
    expect(onRestored).not.toHaveBeenCalled();
  });
});
