// @vitest-environment jsdom
// BOS-2254: rename an objective and change its priority from the Roadmap's Timeline tab.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Roadmap } from "../src/pages/Roadmap";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const obj = (id: string, title: string, priority: number) => ({ id, title, priority, status: "active", keyResults: [], milestones: [] });

function stub(patch: (body: Record<string, unknown>) => Response | null = () => null) {
  // The server returns objectives in priority order; the stub does the same.
  let objectives = [obj("o1", "Lanch the beta", 1), obj("o2", "Grow sales", 2)];
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, url: String(url), body });
        const refused = patch(body);
        if (refused) return refused;
        const id = String(url).split("/").pop();
        objectives = objectives.map((o) => (o.id === id ? { ...o, ...body } : o)).sort((a, b) => a.priority - b.priority);
        return json({});
      }
      if (String(url).includes("/api/roadmap/features")) return json([]);
      if (String(url).includes("/api/roadmap")) return json([{ id: "c1", name: "App Co", objectives }]);
      return json([]);
    }),
  );
  return calls;
}

const headings = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

describe("changing an objective on the Roadmap (BOS-2254)", () => {
  it("Change saves only the title and priority, and the objectives re-sort by priority", async () => {
    const calls = stub();
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await screen.findByText("Lanch the beta");
    expect(headings()).toEqual(["P1 Lanch the beta", "P2 Grow sales"]);

    fireEvent.click(screen.getByRole("button", { name: "Change the objective Lanch the beta" }));
    const form = screen.getByLabelText("Objective").closest("form")!;
    expect((within(form).getByLabelText("Priority") as HTMLSelectElement).value).toBe("1");
    fireEvent.change(within(form).getByLabelText("Objective"), { target: { value: "  Launch the beta " } });
    fireEvent.change(within(form).getByLabelText("Priority"), { target: { value: "3" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(headings()).toEqual(["P2 Grow sales", "P3 Launch the beta"]));
    expect(screen.queryByLabelText("Objective")).toBeNull();
    expect(calls).toEqual([{ method: "PATCH", url: "/api/objectives/o1", body: { title: "Launch the beta", priority: 3 } }]);
  });

  it("Cancel sends nothing and leaves the objective as it was", async () => {
    const calls = stub();
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await screen.findByText("Lanch the beta");
    fireEvent.click(screen.getByRole("button", { name: "Change the objective Lanch the beta" }));
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Something else" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Objective")).toBeNull();
    expect(headings()).toEqual(["P1 Lanch the beta", "P2 Grow sales"]);
    expect(calls).toEqual([]);
  });

  it("a server error shows beside the form and keeps it open", async () => {
    stub(() => json({ error: "That objective was deleted" }, 404));
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await screen.findByText("Lanch the beta");
    fireEvent.click(screen.getByRole("button", { name: "Change the objective Lanch the beta" }));
    const form = screen.getByLabelText("Objective").closest("form")!;
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(await within(form).findByText(/That objective was deleted/)).toBeTruthy();
    expect(screen.getByLabelText("Objective")).toBeTruthy();
  });
});
