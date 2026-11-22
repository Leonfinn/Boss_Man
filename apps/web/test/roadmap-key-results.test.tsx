// @vitest-environment jsdom
// BOS-2250: change and remove a key result from the Roadmap's Timeline tab.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Roadmap } from "../src/pages/Roadmap";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

function stub() {
  let krs = [{ id: "k1", title: "Beta usres", current: 20, target: 50, unit: "users", progress: 0.4 }];
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
        if (method === "PATCH") krs = [{ ...krs[0]!, title: "Beta users", current: 30, progress: 0.6 }];
        if (method === "DELETE") krs = [];
        return method === "DELETE" ? new Response(null, { status: 204 }) : json({});
      }
      if (String(url).includes("/api/roadmap/features")) return json([]);
      if (String(url).includes("/api/roadmap")) return json([{ id: "c1", name: "App Co", objectives: [{ id: "o1", title: "Launch", priority: 1, status: "active", keyResults: krs, milestones: [] }] }]);
      return json([]);
    }),
  );
  return calls;
}

describe("key results on the Roadmap (BOS-2250)", () => {
  it("shows an existing key result as before, then Change saves the new values and the bar updates", async () => {
    const calls = stub();
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    expect(await screen.findByText("Beta usres")).toBeTruthy();
    expect(screen.getByText(/20 \/ 50 users/)).toBeTruthy();
    expect(screen.getByLabelText("40%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Change the key result Beta usres" }));
    fireEvent.change(screen.getByLabelText("Key result"), { target: { value: "Beta users" } });
    fireEvent.change(screen.getByLabelText("Current"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByLabelText("60%")).toBeTruthy();
    expect(screen.getByText("Beta users")).toBeTruthy();
    expect(calls).toEqual([{ method: "PATCH", url: "/api/key-results/k1", body: { title: "Beta users", current: 30, target: 50, unit: "users" } }]);
  });

  it("Remove asks first: Cancel sends nothing, confirming removes the key result", async () => {
    const calls = stub();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await screen.findByText("Beta usres");
    const remove = screen.getByRole("button", { name: "Remove the key result Beta usres" });

    fireEvent.click(remove);
    expect(confirm).toHaveBeenLastCalledWith("Remove the key result Beta usres?");
    expect(calls).toEqual([]);

    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByText("Beta usres")).toBeNull());
    expect(calls).toEqual([{ method: "DELETE", url: "/api/key-results/k1", body: undefined }]);
  });
});
