// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Workflow } from "../src/pages/Workflow";
import { findings, timeWords, type FindingsInput, type Part } from "../src/workflow-findings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const H = 3_600_000;
const stats = (done: number, medianCycleMs: number | null = null) => ({ done, medianCycleMs });
const base = (over: Partial<FindingsInput> = {}): FindingsInput => ({ days: 14, overall: stats(23, 36 * H), previous: { overall: stats(17, 48 * H), handoffs: [] }, handoffs: [], features: [], sizeNotes: [], ...over });
const text = (ps: Part[]) => ps.map((p) => (typeof p === "string" ? p : p.text)).join("");

describe("timeWords", () => {
  it("says times in words", () => {
    expect(timeWords(30 * 60_000)).toBe("30 minutes");
    expect(timeWords(1 * H)).toBe("1 hour");
    expect(timeWords(6 * H)).toBe("6 hours");
    expect(timeWords(1.5 * H)).toBe("1.5 hours");
    expect(timeWords(36 * H)).toBe("36 hours");
    expect(timeWords(72 * H)).toBe("3 days");
    expect(timeWords(84 * H)).toBe("3.5 days");
  });
});

describe("findings", () => {
  it("is null when the server sent no whole-team figures", () => {
    expect(findings(base({ overall: undefined }))).toBeNull();
  });

  it("compares pace with the period before", () => {
    const f = findings(base())!;
    expect(f.scope).toBe("Last 14 days, compared with the 14 days before.");
    expect(text(f.items[0]!.lead)).toBe("The team finished 23 tickets, up from 17.");
    expect(text(f.items[0]!.detail)).toBe("A ticket usually takes 36 hours from start to finish, down from 2 days.");
  });

  it("says about the same inside the 20% band", () => {
    const f = findings(base({ overall: stats(19, 50 * H) }))!;
    expect(text(f.items[0]!.lead)).toContain("about the same as before");
  });

  it("leaves out every comparison in the first period", () => {
    const f = findings(base({ previous: { overall: stats(4), handoffs: [] } }))!;
    expect(f.scope).toBe("Last 14 days. There are no figures from the 14 days before, so nothing is compared yet.");
    expect(text(f.items[0]!.lead)).toBe("The team finished 23 tickets.");
    expect(text(f.items[0]!.detail)).not.toContain("down from");
  });

  it("gives one sentence and a next period when there is too little data", () => {
    const f = findings(base({ overall: stats(2) }))!;
    expect(f.items).toEqual([]);
    expect(f.sparse).toEqual({ text: "Not enough finished work in the last 14 days to say. 2 tickets were finished; a summary needs at least 5.", nextDays: 30 });
    expect(findings(base({ overall: stats(0) }))!.sparse!.text).toBe("Nothing was finished in the last 14 days, so there is nothing to sum up yet.");
    expect(findings(base({ days: 90, overall: stats(1) }))!.sparse).toEqual({ text: "Not enough finished work in the last 90 days to say. 1 ticket was finished; a summary needs at least 5 in 90 days.", nextDays: null });
  });

  it("names the longest wait, with its earlier figure", () => {
    const f = findings(
      base({
        handoffs: [
          { from: "developer", to: "reviewer", kind: "review", count: 8, medianWaitMs: 6 * H, bounceRate: 0.1 },
          { from: "owner", to: "developer", kind: "assign", count: 9, medianWaitMs: 2 * H, bounceRate: null },
          { from: "qa", to: "ceo", kind: "review", count: 2, medianWaitMs: 40 * H, bounceRate: null },
        ],
        previous: { overall: stats(17), handoffs: [{ from: "developer", to: "reviewer", kind: "review", count: 6, medianWaitMs: 4 * H, bounceRate: null }] },
      }),
    )!;
    expect(text(f.items[1]!.lead)).toBe("Reviews are where work waits longest.");
    expect(text(f.items[1]!.detail)).toBe("A developer's ticket usually waits 6 hours for the reviewer's verdict, up from 4 hours.");
  });

  it("says work rarely waits when the longest wait is under an hour", () => {
    const f = findings(base({ handoffs: [{ from: "owner", to: "developer", kind: "assign", count: 4, medianWaitMs: 20 * 60_000, bounceRate: null }] }))!;
    expect(text(f.items[1]!.lead)).toBe("Work rarely waits.");
    expect(text(f.items[1]!.detail)).toBe("The longest usual wait is 20 minutes, for the developer's pick-up.");
  });

  it("looks at a held-up feature first, linking feature and ticket", () => {
    const feat = (id: string, ageing: { id: string; ref: string | null; title: string; reasons: string[] }[]) => ({ id, title: `Feature ${id}`, tailFlag: true, tail: [], criticalPath: { ageing } });
    const f = findings(base({ features: [feat("a", []), feat("b", [{ id: "t1", ref: "FER-412", title: "x", reasons: ["Nobody is assigned"] }]), feat("c", [{ id: "t2", ref: "FER-9", title: "y", reasons: ["Blocked"] }])] }), "c1")!;
    const it3 = f.items[1]!;
    expect(text(it3.lead)).toBe("“Feature b” is held up.");
    expect((it3.lead[1] as { href: string }).href).toBe("#/features/c1/b");
    expect(text(it3.detail)).toBe("FER-412 is on its longest chain of tasks and nobody has it. 1 more feature is held up.");
    expect(it3.target).toBe("features");
  });

  it("falls through to a slow tail, then send-backs, then sizes", () => {
    const tail = { id: "a", title: "A very long feature title that goes on and on past sixty characters for sure", tailFlag: true, tail: [{ ref: "X-1", title: "t", ageMs: 5 * H }, { ref: "X-2", title: "t", ageMs: 9 * H }], criticalPath: null };
    const slow = findings(base({ features: [tail] }))!.items[1]!;
    expect(text(slow.lead)).toContain("…");
    expect(text(slow.detail)).toBe("X-2 has been open 9 hours.");
    const back = findings(base({ handoffs: [{ from: "developer", to: "reviewer", kind: "review", count: 6, medianWaitMs: null, bounceRate: 0.4 }] }))!.items[1]!;
    expect(text(back.lead)).toBe("Reviews send back 4 in 10 of the developer's tickets.");
    const size = findings(base({ sizeNotes: [{ role: "developer", size: 5, likeSize: 3 }] }))!.items[1]!;
    expect(text(size.lead)).toBe("Developer size 5 tasks take about as long as size 3.");
    expect(findings(base())!.items).toHaveLength(1);
  });
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const card = (over: Record<string, unknown>) => ({ days: 14, costBasis: null, byRole: [], byAgent: [], handoffs: [], features: [], sizes: [], sizeNotes: [], ...over });

function stub(responder: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/retros/latest")) return new Response(JSON.stringify({ retro: null, changes: [] }), { status: 200 });
      return new Response(JSON.stringify(responder(url)), { status: 200 });
    }),
  );
}

describe("What this shows card", () => {
  it("shows the sentences above the tables, and a See link moves focus to the heading", async () => {
    stub(() => card({ overall: stats(23, 36 * H), previous: { overall: stats(17, 48 * H), handoffs: [] } }));
    render(<Workflow company={company} />);
    expect(await screen.findByRole("region", { name: "What this shows" })).toBeTruthy();
    expect(screen.getByText("The team finished 23 tickets, up from 17.")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "See roles" }));
    expect(document.activeElement?.textContent).toBe("Roles");
    expect(document.getElementById("handoffs")).toBeTruthy();
    expect(document.getElementById("features")).toBeTruthy();
    expect(document.getElementById("sizes")).toBeTruthy();
  });

  it("with too little data, the button switches the period and asks again", async () => {
    const urls: string[] = [];
    stub((url) => {
      urls.push(url);
      return url.includes("days=30") ? card({ days: 30, overall: stats(12), previous: null }) : card({ overall: stats(1) });
    });
    render(<Workflow company={company} />);
    expect(await screen.findByText(/Not enough finished work in the last 14 days/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show the last 30 days" }));
    expect(await screen.findByText("The team finished 12 tickets.")).toBeTruthy();
    expect(urls.some((u) => u.includes("days=30"))).toBe(true);
  });

  it("keeps the column definitions under Roles in a fold that starts closed and opens on activation", async () => {
    stub(() => card({ overall: stats(23, 36 * H), previous: { overall: stats(17, 48 * H), handoffs: [] } }));
    render(<Workflow company={company} />);
    const summary = await screen.findByText("What the columns mean");
    const fold = summary.closest("details")!;
    expect(summary.tagName).toBe("SUMMARY");
    expect(fold.open).toBe(false);
    expect(fold.textContent).toContain("Right first time is the share of reviewed tickets that were never sent back.");
    fireEvent.click(summary);
    expect(fold.open).toBe(true);
    expect(fold.textContent).toContain("Answers changed is how often the answer to a decision this role raised was not the one it recommended.");
  });

  it("shows no card when the server sends no whole-team figures", async () => {
    stub(() => card({}));
    render(<Workflow company={company} />);
    expect(await screen.findByText("Not enough finished tickets yet.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "What this shows" })).toBeNull();
  });
});
