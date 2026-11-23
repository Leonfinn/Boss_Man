// @vitest-environment jsdom
// BOS-2376: the skill pane's History list and its "What changed" fold.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Skills } from "../src/pages/Skills";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const row = { id: "s1", name: "web-fetch", description: "Fetch pages.", source: "written", sourceUrl: null, sourceRef: null, pack: null, packUrl: null, sizeBytes: 100, fileCount: 1, updatedAt: "2026-10-21T14:26:00Z", agents: [] };

function stub(history: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/skills/s1/history")) return json(history);
      if (url.endsWith("/skills/s1")) return json({ ...row, files: [{ path: "SKILL.md", size: 100, text: "---\nname: web-fetch\ndescription: Fetch pages.\n---\n\nOne page.\n" }] });
      if (url.endsWith("/skills")) return json([row]);
      return json([]);
    }),
  );
}

describe("skill history", () => {
  it("lists entries and folds out the changed lines of an edit", async () => {
    stub([
      { id: "h1", at: "2026-10-22T10:00:00Z", what: "Edited by you", who: "you", summary: "Owner edited the skill web-fetch.", change: { before: "keep\nold line", after: "keep\nnew line" } },
      { id: "h2", at: "2026-10-21T10:00:00Z", what: "Added by you", who: "you", summary: "The owner added the skill web-fetch.", change: null },
    ]);
    render(<Skills company={company} />);
    fireEvent.click((await screen.findByText("web-fetch", { selector: "a span" })).closest("a")!);
    expect(await screen.findByRole("heading", { name: "History" })).toBeTruthy();
    expect(await screen.findByText("Edited by you")).toBeTruthy();
    expect(screen.getByText("Added by you")).toBeTruthy();
    // Only the edit has a fold.
    expect(screen.getAllByText("What changed")).toHaveLength(1);
    expect(screen.getByText(/old line/)).toBeTruthy();
    expect(screen.getByText(/new line/)).toBeTruthy();
  });

  it("says so when a skill has no history", async () => {
    stub([]);
    render(<Skills company={company} />);
    fireEvent.click((await screen.findByText("web-fetch", { selector: "a span" })).closest("a")!);
    expect(await screen.findByText(/No changes recorded/)).toBeTruthy();
  });
});
