// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotePane } from "../src/pages/Feedback";

const detail = {
  note: { id: "n1", title: "Slow board", text: "The board is slow", source: "manual", state: "unprocessed", createdAt: "2026-11-01T10:00:00Z", untrusted: false },
  customer: null,
  insights: [],
  suggestions: [],
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("feedback note pane", () => {
  it("shows a loading message, not a blank pane, while the note loads", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<NotePane id="n1" companyId="c1" features={[]} onChanged={() => {}} onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(container.textContent).toContain("Loading the note");
  });

  it("sends one request for a double click on Done, and the buttons stay disabled meanwhile", async () => {
    let release: () => void = () => {};
    const patches: string[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(String(init.body));
        return new Promise<Response>((r) => { release = () => r(ok({})); });
      }
      return Promise.resolve(ok(detail));
    }));
    // A different id: a GET still waiting from the first test is shared by path.
    render(<NotePane id="n2" companyId="c1" features={[]} onChanged={() => {}} onClose={() => {}} />);
    const done = await screen.findByRole("button", { name: "Done: mark processed" });
    fireEvent.click(done);
    fireEvent.click(done);
    expect(patches).toHaveLength(1);
    for (const name of ["Done: mark processed", "Archive", "Delete"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => { release(); });
    expect((screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
