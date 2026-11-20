// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TicketOutputs, type Artifact } from "../src/components/TicketOutputs";
import { healthLines } from "../src/components/DashboardPanels";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: apiMock }));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  vi.restoreAllMocks();
});

const item: Artifact = { id: "a1", kind: "wiki_page", title: "Backlog review", slug: "backlog-review", path: null, ref: null, url: null, agent: "Gandalf", runId: null, createdAt: new Date().toISOString() };

describe("removing a task output", () => {
  it("shows the server's refusal next to the item and lets the owner try again", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMock.mockRejectedValue(new Error("Not allowed"));
    const onChanged = vi.fn();
    render(<TicketOutputs items={[item]} companyId="c1" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /off this task/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Not allowed");
    expect(onChanged).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /off this task/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Remove while the request runs", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let finish!: () => void;
    apiMock.mockReturnValue(new Promise<void>((r) => (finish = r)));
    const onChanged = vi.fn();
    render(<TicketOutputs items={[item]} companyId="c1" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /off this task/ }));
    expect((screen.getByRole("button", { name: /off this task/ }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe("dashboard runner links", () => {
  it("point at the Runner settings page for every runner state", () => {
    for (const runner of [null, { registered: false, connected: false, lastSeenAt: null }, { registered: true, connected: false, lastSeenAt: null }, { registered: true, connected: true, lastSeenAt: null }]) {
      const line = healthLines({ health: runner ? { runner } : {}, merges: null, stuck: null, running: 0, companyId: "c1" }).find((l) => l.key === "runner")!;
      expect(line.href).toBe("#/settings/c1/runner");
    }
  });
});
