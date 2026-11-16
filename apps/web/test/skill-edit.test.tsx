// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Skills } from "../src/pages/Skills";
import { Runner } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const jsonStatus = (b: unknown, status: number) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const row = { id: "s1", name: "web-fetch", description: "Fetch pages.", source: "written", sourceUrl: null, sourceRef: null, pack: null, packUrl: null, sizeBytes: 100, fileCount: 1, updatedAt: "2026-10-21T14:26:00Z", agents: [] };

describe("skills", () => {
  it("edits a written skill and saves it with PUT", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/skills/s1")) return init?.method === "PUT" ? json({ id: "s1", name: "web-fetch" }) : json({ ...row, files: [{ path: "SKILL.md", size: 100, text: '---\nname: web-fetch\ndescription: "Fetch pages."\n---\n\n# Rules\n\nOne page per call.\n' }] });
        if (url.endsWith("/skills")) return json([row]);
        return json([]);
      }),
    );
    render(<Skills company={company} />);
    fireEvent.click((await screen.findByText("web-fetch", { selector: "a span" })).closest("a")!);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const body = screen.getByLabelText("Instructions, in Markdown") as HTMLTextAreaElement;
    expect(body.value).toBe("# Rules\n\nOne page per call.");
    fireEvent.change(body, { target: { value: "# Rules\n\nTwo pages at most." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(calls).toContainEqual({ method: "PUT", url: "/api/companies/c1/skills/s1", body: { name: "web-fetch", description: "Fetch pages.", body: "# Rules\n\nTwo pages at most." } }));
    expect(await screen.findByText(/Saved\. Agents get the new version/)).toBeTruthy();
  });

  it("marks a skill with no instructions, on the list and on the skill", async () => {
    const empty = { ...row, id: "s2", name: "empty-body", hasInstructions: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/skills/s2")) return json({ ...empty, files: [{ path: "SKILL.md", size: 80, text: '---\nname: empty-body\ndescription: "Says what it does."\n---\n\n' }], requiresAddons: null, instructions: { path: "SKILL.md", body: "", empty: true, unreadable: false } });
        if (url.endsWith("/skills")) return json([empty]);
        return json([]);
      }),
    );
    render(<Skills company={company} />);
    expect(await screen.findByText("No instructions")).toBeTruthy();
    fireEvent.click((await screen.findByText("empty-body", { selector: "a span" })).closest("a")!);
    expect(await screen.findByText("No instructions: this skill does nothing when loaded.")).toBeTruthy();
    // It can be edited to add instructions; it is only marked as doing nothing today.
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("asks before replacing real instructions with an empty box, and sends confirmation only when allowed", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const full = { ...row, hasInstructions: true };
    let puts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/skills/s1") && init?.method === "PUT") {
          puts++;
          return puts === 1 ? jsonStatus({ error: "conflict", message: "This skill has instructions. Saving an empty Instructions box would delete them; confirm the change to remove them." }, 409) : json({ id: "s1", name: "web-fetch" });
        }
        if (url.endsWith("/skills/s1")) return json({ ...full, files: [{ path: "SKILL.md", size: 100, text: '---\nname: web-fetch\ndescription: "Fetch pages."\n---\n\n# Rules\n\nOne page per call.\n' }], requiresAddons: null, instructions: { path: "SKILL.md", body: "# Rules\n\nOne page per call.", empty: false, unreadable: false } });
        if (url.endsWith("/skills")) return json([full]);
        return json([]);
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Skills company={company} />);
    fireEvent.click((await screen.findByText("web-fetch", { selector: "a span" })).closest("a")!);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Instructions, in Markdown"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("delete them"));
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      { name: "web-fetch", description: "Fetch pages.", body: "" },
      { name: "web-fetch", description: "Fetch pages.", body: "", confirmEmptyBody: true },
    ]);
    expect(await screen.findByText(/Saved\. Agents get the new version/)).toBeTruthy();
  });

  it("marks a skill as needing the browser add-on (docs/12)", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/skills/s1/addons")) return json({ requires: ["agent-browser"] });
        if (url.endsWith("/skills/s1")) return json({ ...row, requiresAddons: null, files: [{ path: "SKILL.md", size: 10, text: "x" }] });
        if (url.endsWith("/skills")) return json([row]);
        return json([]);
      }),
    );
    render(<Skills company={company} />);
    fireEvent.click((await screen.findByText("web-fetch", { selector: "a span" })).closest("a")!);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Browser (agent-browser)" }));
    await vi.waitFor(() => expect(calls).toContainEqual({ method: "PUT", url: "/api/companies/c1/skills/s1/addons", body: { requires: ["agent-browser"] } }));
    expect(await screen.findByText(/goes with runs only while the runner reports Browser \(agent-browser\) working/)).toBeTruthy();
  });

  it("shows each runner add-on as working, not working, or not installed, each with a tick box", async () => {
    let addons: unknown = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/self-deploy/runner-addons" ? json({ enabled: true, saved: null, built: null }) : json({ registered: true, runnerId: "r1", connected: true, lastSeenAt: null, imageVersion: null, diskUsedBytes: null, addons }))));
    const view = render(<Runner company={company} />);
    expect(await screen.findAllByText("Not installed")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "Browser (agent-browser)" })).toBeTruthy();
    expect(screen.queryByText("RUNNER_ADDONS=agent-browser")).toBeNull();
    view.unmount();
    addons = [{ id: "agent-browser", version: "0.39.0", ok: false, detail: "spawn agent-browser ENOENT" }];
    render(<Runner company={company} />);
    expect(await screen.findByText("Not working")).toBeTruthy();
    expect(screen.getByText("spawn agent-browser ENOENT")).toBeTruthy();
    cleanup();
    addons = [{ id: "agent-browser", version: "0.39.0", ok: true }];
    render(<Runner company={company} />);
    expect(await screen.findByText("Working, 0.39.0")).toBeTruthy();
  });

  it("adds a skill from another company and shows the result", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const other = { id: "s9", name: "kit", description: "Builds kits.", companyName: "Other Co", requiresAddons: null, fileCount: 2, hasScripts: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.includes("/skills/elsewhere")) return json([other]);
        if (url.endsWith("/skills/copy")) return json({ id: "s10", name: "kit" });
        return json([]);
      }),
    );
    render(<Skills company={company} />);
    expect(await screen.findByText("Builds kits.")).toBeTruthy();
    expect(screen.getByText(/Other Co · 2 files · has scripts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to Boss Man Co" }));
    expect(await screen.findByText("Added to Boss Man Co. Choose who has it.")).toBeTruthy();
    expect(calls).toContainEqual({ method: "POST", url: "/api/companies/c1/skills/copy", body: { skillId: "s9" } });
    expect((screen.getByRole("button", { name: "Added" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
