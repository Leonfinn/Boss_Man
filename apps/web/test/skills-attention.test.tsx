// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Skills } from "../src/pages/Skills";

// BOS-2518: the "Needs attention only" switch and its count gather the problem tags the Skills page already
// shows (no instructions, instructions unreadable, newer version, update check failed, nobody has it, only
// agents that can't load skills) into one place, and work beside the name filter.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const agents = [
  { id: "a1", name: "Kate - Claude", role: "worker", agentKind: "claude" },
  { id: "a2", name: "Cody - Codex", role: "worker", agentKind: "codex" },
];
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: agents as Company["agents"] };
type Row = ReturnType<typeof mk>;
const mk = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: `${name} does things.`,
  source: "written",
  sourceUrl: null,
  sourceRef: null,
  pack: null as string | null,
  packUrl: null,
  sizeBytes: 100,
  fileCount: 1,
  updatedAt: "2026-11-21T14:26:00Z",
  agents: [{ id: "a1", name: "Kate - Claude" }],
  ...extra,
});
const healthy = () => mk("ok", "healthy-skill", { hasInstructions: true });
// One skill per reason (5), plus one healthy held by an agent that loads skills (BOS-2518: "6 skills … 5 need attention").
const six = () => [
  mk("noinstr", "no-instructions", { hasInstructions: false }),
  mk("unreadable", "unreadable-skill", { hasInstructions: true, instructionsUnreadable: true }),
  mk("newer", "newer-skill", { hasInstructions: true }),
  mk("nobody", "nobody-has-it", { hasInstructions: true, agents: [] }),
  mk("unloadable", "only-codex", { hasInstructions: true, agents: [{ id: "a2", name: "Cody - Codex" }] }),
  healthy(),
];
const updates = { newer: { status: "newer", commit: "abc1234", date: "2026-11-20T00:00:00Z" } };
const serve = (rows: Row[], up: unknown = updates) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (url.endsWith("/skills/updates") ? json(up) : url.endsWith("/skills") ? json(rows) : json([]))),
  );
const listed = () =>
  [...document.querySelectorAll(".wiki-list ul a .mono")].map((el) => el.textContent);
const tagOf = (name: string) => {
  const link = [...document.querySelectorAll(".wiki-list a")].find((a) => a.querySelector(".mono")?.textContent === name);
  return [...(link?.querySelectorAll(".tag") ?? [])].map((t) => t.textContent);
};
const switchEl = async () => (await screen.findByRole("switch")) as HTMLButtonElement;

describe("skills needs attention", () => {
  it("counts the 5 and the switch shows those 5, not the healthy one, each with its reason's tag", async () => {
    serve(six());
    render(<Skills company={company} />);
    await screen.findByText("healthy-skill", { selector: "a .mono" });
    expect(screen.getByText("5 need attention")).toBeTruthy();

    fireEvent.click(await switchEl());
    expect(listed().sort()).toEqual(["newer-skill", "no-instructions", "nobody-has-it", "only-codex", "unreadable-skill"].sort());
    expect(listed()).not.toContain("healthy-skill");

    expect(tagOf("no-instructions")).toContain("No instructions");
    expect(tagOf("unreadable-skill")).toContain("Instructions unreadable");
    expect(tagOf("newer-skill")).toContain("Newer version available (2026-11-20)");
    expect(tagOf("nobody-has-it")).toContain("Nobody has it");
    expect(tagOf("only-codex")).toContain("Only agents that can't load skills");
  });

  it("counts a skill whose update check failed, with its own tag", async () => {
    serve([mk("failed", "check-failed", { hasInstructions: true }), healthy()], { failed: { status: "error", reason: "GitHub was busy." } });
    render(<Skills company={company} />);
    await screen.findByText("check-failed", { selector: "a .mono" });
    expect(screen.getByText("1 needs attention")).toBeTruthy();
    fireEvent.click(await switchEl());
    expect(listed()).toEqual(["check-failed"]);
    expect(tagOf("check-failed")).toContain("Couldn't check for updates: GitHub was busy.");
  });

  it("applies with the filter box: both on shows only matching skills that need attention", async () => {
    serve([...six(), mk("noroom", "no-instructions-other", { hasInstructions: false }), mk("fine", "nobody-fine", { hasInstructions: true })]);
    render(<Skills company={company} />);
    const box = (await screen.findByLabelText("Filter")) as HTMLInputElement;
    await screen.findByText("healthy-skill", { selector: "a .mono" });
    fireEvent.click(await switchEl());

    fireEvent.change(box, { target: { value: "no-instructions" } });
    expect(listed().sort()).toEqual(["no-instructions", "no-instructions-other"]);
    expect(listed()).not.toContain("healthy-skill");

    fireEvent.change(box, { target: { value: "healthy" } });
    expect(listed()).toEqual([]);
    expect(screen.getByText("Nothing needs attention.")).toBeTruthy();
  });

  it("shows a pack with a skill needing attention and hides a pack with none", async () => {
    serve([
      mk("p1", "pack-bad", { hasInstructions: false, pack: "docs" }),
      mk("p2", "pack-good", { hasInstructions: true, pack: "docs" }),
      mk("q1", "fine-a", { hasInstructions: true, pack: "fine" }),
      mk("q2", "fine-b", { hasInstructions: true, pack: "fine" }),
    ]);
    render(<Skills company={company} />);
    await screen.findByText("pack-bad", { selector: "a .mono" });
    fireEvent.click(await switchEl());

    expect(screen.getByText("docs")).toBeTruthy();
    expect(screen.queryByText("fine")).toBeNull();
    // The pack shows only its matching skill under the switch; the healthy sibling is hidden.
    expect(listed()).toEqual(["pack-bad"]);
  });

  it("says Nothing needs attention when nothing to show", async () => {
    serve([healthy()]);
    render(<Skills company={company} />);
    await screen.findByText("healthy-skill", { selector: "a .mono" });
    expect(screen.getByText("0 need attention")).toBeTruthy();
    fireEvent.click(await switchEl());
    expect(screen.getByText("Nothing needs attention.")).toBeTruthy();
    expect(listed()).toEqual([]);
  });
});
