// @vitest-environment jsdom
// BOS-2476: "Find in this run" and the "Show" choice on the Run page. jsdom has no layout, so the list draws only its
// first rows: the stubbed run is short and every event of interest sits near the top.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Run } from "../src/pages/Run";

// jsdom has no layout: give every element a size so the virtual list draws its rows.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const company = { id: "c1", name: "App Co", agents: [] } as unknown as Company;
const at = "2026-01-05T10:00:00Z";
const upd = (seq: number, update: Record<string, unknown>) => ({ seq, type: "run.update", at, event: { update } });
const items = [
  { seq: 1, type: "run.started", at, event: {} },
  upd(2, { kind: "agent_message", text: "I will git push the branch" }),
  upd(3, { kind: "tool_call", title: "Bash: git push", status: "completed" }),
  upd(4, { kind: "agent_message", text: "Nothing to see" }),
  upd(5, { kind: "tool_call", title: "Bash: ls", status: "failed" }),
  upd(6, { kind: "agent_message", text: "Pushed: git push worked" }),
  { seq: 7, type: "run.ended", at, event: { error: "boom" } },
];
function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("/transcript")
            ? { run: { id: "r1", companyId: "c1", agent: "Ada", agentId: "a1", ticketId: null, ticket: null, startedAt: at, endedAt: at }, items, next: 8, more: false }
            : url.includes("/permissions")
              ? { entries: [], truncated: false }
              : [],
        ),
        { status: 200 },
      ),
    ),
  );
}
const box = () => screen.getByLabelText("Find in this run") as HTMLInputElement;
const showSelect = () => screen.getByRole("combobox") as HTMLSelectElement;
const find = async (text: string) => {
  render(<Run runId="r1" companies={[company]} />);
  await screen.findByText("Nothing to see");
  fireEvent.change(box(), { target: { value: text } });
};

describe("find in this run (BOS-2476)", () => {
  it("counts matches, steps with Next, Enter and Shift+Enter, and marks the current one", async () => {
    stub();
    await find("git push");
    expect(await screen.findByText("1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Next match"));
    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(document.querySelectorAll("mark.find-hit.current").length).toBe(1);
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Previous match"));
    expect(screen.getByText("1 of 3")).toBeTruthy();
  });
  it("says 'No matches' when nothing is found", async () => {
    stub();
    await find("zzz-not-there");
    expect(await screen.findByText("No matches")).toBeTruthy();
  });
  it("Show: Tool calls and Problems hide the rest, Everything brings it back, and the choice is in the link", async () => {
    stub();
    render(<Run runId="r1" companies={[company]} />);
    await screen.findByText("Nothing to see");
    fireEvent.change(showSelect(), { target: { value: "tools" } });
    expect(screen.queryByText("Nothing to see")).toBeNull();
    expect(screen.getByText("Bash: ls")).toBeTruthy();
    expect(window.location.hash).toContain("show=tools");
    fireEvent.change(showSelect(), { target: { value: "problems" } });
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Bash: git push")).toBeNull();
    fireEvent.change(showSelect(), { target: { value: "all" } });
    expect(screen.getByText("Nothing to see")).toBeTruthy();
    expect(window.location.hash).not.toContain("show=");
  });
  it("a link with ?show=tools opens with that choice", async () => {
    stub();
    window.location.hash = "#/runs/r1?show=tools";
    render(<Run runId="r1" companies={[company]} />);
    await screen.findByText("Bash: ls");
    expect(showSelect().value).toBe("tools");
    expect(screen.queryByText("Nothing to see")).toBeNull();
  });
  it("with Tool calls shown, find counts only tool events", async () => {
    stub();
    render(<Run runId="r1" companies={[company]} />);
    await screen.findByText("Nothing to see");
    fireEvent.change(showSelect(), { target: { value: "tools" } });
    fireEvent.change(box(), { target: { value: "git push" } });
    await waitFor(() => expect(screen.getByText("1 of 1")).toBeTruthy());
  });
});
