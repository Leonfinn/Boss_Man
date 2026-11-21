// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WikiCompare } from "../src/components/WikiCompare";
import { diffLines } from "../src/line-diff";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const versions = [
  { id: "v3", createdAt: "2026-11-03T10:00:00Z", agent: "Bramble" },
  { id: "v2", createdAt: "2026-11-02T10:00:00Z", agent: null },
  { id: "v1", createdAt: "2026-11-01T10:00:00Z", agent: "Fern" },
];
const bodies: Record<string, string> = {
  v1: "a\nb\nc",
  v2: "a\nB\nc\nd",
  v3: ["x", ...Array.from({ length: 10 }, (_, i) => `same ${i}`), "end"].join("\n"),
};

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const id = url.split("/").pop() as string;
      const v = versions.find((x) => x.id === id)!;
      return new Response(JSON.stringify({ id, body: bodies[id], createdAt: v.createdAt, agent: v.agent }), { status: 200 });
    }),
  );
}

describe("wiki compare view (BOS-2198)", () => {
  it("marks added and removed lines with + and −, and counts them", async () => {
    stub();
    render(<WikiCompare companyId="c1" versions={versions} from="v1" to="v2" onRestore={() => {}} onClose={() => {}} />);
    await screen.findByText("+2 −1 lines");
    const rows = screen.getByRole("group", { name: "Changes" }).textContent ?? "";
    expect(rows).toContain("−");
    expect(rows).toContain("+");
    expect(screen.getByText("B").parentElement?.style.color).toBe("var(--green-ink)");
    expect(screen.getByText("b").parentElement?.style.color).toBe("var(--red-ink)");
  });

  it("compares any two chosen versions in either order and names who saved each", async () => {
    stub();
    render(<WikiCompare companyId="c1" versions={versions} from="v1" to="v2" onRestore={() => {}} onClose={() => {}} />);
    await screen.findByText("+2 −1 lines");
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: "v2" } });
    fireEvent.change(screen.getByLabelText(/to/), { target: { value: "v1" } });
    await screen.findByText("+1 −2 lines");
    const who = await screen.findByText(/Old: .*you.*New: .*Fern/);
    expect(who).toBeTruthy();
  });

  it("folds a long unchanged run and shows it on Show", async () => {
    stub();
    const long = { ...bodies };
    bodies.v1 = ["x", ...Array.from({ length: 10 }, (_, i) => `same ${i}`), "end?"].join("\n");
    render(<WikiCompare companyId="c1" versions={versions} from="v1" to="v3" onRestore={() => {}} onClose={() => {}} />);
    await screen.findByText(/11 unchanged lines/);
    expect(screen.queryByText("same 3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByText("same 3")).toBeTruthy();
    Object.assign(bodies, long);
  });

  it("restores the newer side through onRestore", async () => {
    stub();
    const onRestore = vi.fn();
    render(<WikiCompare companyId="c1" versions={versions} from="v1" to="v2" onRestore={onRestore} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("v2"));
  });

  // The limit is generous for slow CI machines; it catches a quadratic walk, which takes many seconds on this input.
  it("diffs a 40,000-character page with 200 changed lines in under a second", () => {
    const old = Array.from({ length: 1600 }, (_, i) => `line number ${i} of the page`);
    const next = old.map((l, i) => (i % 8 === 0 ? `${l} changed` : l));
    expect(old.join("\n").length).toBeGreaterThan(40_000 - 2000);
    const t0 = performance.now();
    const d = diffLines(old.join("\n"), next.join("\n"));
    const LIMIT_MS = 1000;
    expect(performance.now() - t0).toBeLessThan(LIMIT_MS);
    expect(d.filter((l) => l.kind === "add")).toHaveLength(200);
  });
});
