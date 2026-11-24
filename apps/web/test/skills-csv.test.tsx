// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { attentionReasons, Skills, SKILLS_CSV_HEAD, skillsToCsv } from "../src/pages/Skills";
import { stubFetchByUrl } from "./stub-fetch";

// BOS-2544: "Download CSV" on the Skills page, beside "Needs attention only". It saves the skills the list shows
// (after the switch and the filter), in the list's order, from what the page already loads.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
  source: "written" as const,
  sourceUrl: null as string | null,
  sourceRef: null,
  pack: null as string | null,
  packUrl: null,
  sizeBytes: 2048,
  fileCount: 3,
  updatedAt: "2026-11-21T14:26:00Z",
  agents: [{ id: "a1", name: "Kate - Claude" }],
  ...extra,
});
const updates = { newer: { status: "newer", commit: "abc1234", date: "2026-11-20T00:00:00Z" }, failed: { status: "error", reason: "GitHub was busy." } };
const serve = (rows: Row[]) =>
  stubFetchByUrl({
    "/api/companies": [{ id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", agents }],
    "/api/companies/c1/skills": rows,
    "/api/companies/c1/skills/updates": updates,
    "/api/companies/c1/skills/elsewhere": [],
    "/api/companies/c1/skill-proposals": [],
    "/api/notifications/week": {},
  });

function capture() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  URL.createObjectURL = ((b: Blob) => (blobs.push(b), "blob:x")) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    names.push(this.download);
  };
  return { blobs, names, restore: () => (HTMLAnchorElement.prototype.click = click) };
}

const why = (s: Row, whatHarness: (id: string) => string, u?: unknown) => attentionReasons(s as never, u as never, whatHarness);
const harness = (id: string) => agents.find((a) => a.id === id)?.agentKind ?? "";

describe("skillsToCsv", () => {
  it("writes one row per skill with the page's words for where from, and the agents joined with ; ", () => {
    const csv = skillsToCsv(
      [
        mk("linked", "linked-skill", { source: "link", sourceUrl: "https://example.com/skills", pack: "docs", fileCount: 5, sizeBytes: 500 }),
        mk("up", "uploaded-skill", { source: "upload", agents: [{ id: "a1", name: "Kate - Claude" }, { id: "a2", name: "Cody - Codex" }] }),
      ],
      {} as never,
      harness,
    );
    expect(csv.split("\r\n")).toEqual([
      SKILLS_CSV_HEAD.join(","),
      'linked-skill,linked-skill does things.,From a link,https://example.com/skills,docs,5,500 B,2026-11-21,Kate - Claude,',
      "uploaded-skill,uploaded-skill does things.,Uploaded,,,3,2.0 KB,2026-11-21,Kate - Claude; Cody - Codex,",
      "",
    ]);
  });

  it("puts every reason the row would flag in needs attention, joined with ; , and nothing for a healthy skill", () => {
    const s = mk("x", "mixed", { hasInstructions: true, instructionsUnreadable: true, agents: [] });
    expect(why(s, harness)).toEqual(["Instructions unreadable", "Nobody has it"]);
    expect(why(mk("y", "newer-skill", { hasInstructions: true }) as Row, harness, updates.newer)).toEqual(["Newer version available (2026-11-20)"]);
    expect(why(mk("z", "failed-check", { hasInstructions: true }) as Row, harness, updates.failed)).toEqual(["Couldn't check for updates"]);
    expect(why(mk("w", "codex-only", { hasInstructions: true, agents: [{ id: "a2", name: "Cody - Codex" }] }) as Row, harness)).toEqual(["Only agents that can't load skills"]);
    expect(why(mk("ok", "healthy", { hasInstructions: true }) as Row, harness)).toEqual([]);
  });
});

describe("Skills Download CSV button", () => {
  it("saves skills-<date>.csv of every skill shown", async () => {
    const cap = capture();
    serve([mk("b", "second", { hasInstructions: true }), mk("a", "first", { hasInstructions: true })]);
    render(<Skills company={company} />);
    await screen.findByText("first", { selector: "a .mono" });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(cap.names[0]).toMatch(/^skills-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = (await cap.blobs[0]!.text()).split("\r\n");
    expect(lines[0]).toBe(SKILLS_CSV_HEAD.join(","));
    expect(lines.slice(1, 3).map((l) => l.split(",")[0]).sort()).toEqual(["first", "second"]);
    cap.restore();
  });

  it("follows the attention switch and the filter, and keeps a pack's skills together before the loose ones", async () => {
    const cap = capture();
    serve([
      mk("p1", "pack-bad", { hasInstructions: false, pack: "docs" }),
      mk("p2", "pack-good", { hasInstructions: true, pack: "docs" }),
      mk("l1", "loose-good", { hasInstructions: true }),
    ]);
    render(<Skills company={company} />);
    await screen.findByText("pack-bad", { selector: "a .mono" });
    // Under the switch only the skill needing attention is shown.
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect((await cap.blobs[0]!.text()).split("\r\n").slice(1).filter(Boolean).map((l) => l.split(",")[0])).toEqual(["pack-bad"]);

    // The filter narrows the loose skills too.
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "good" } });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect((await cap.blobs[1]!.text()).split("\r\n").slice(1).filter(Boolean).map((l) => l.split(",")[0])).toEqual(["pack-good", "loose-good"]);
    cap.restore();
  });
});
