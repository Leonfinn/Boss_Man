// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ProjectsPage } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const project = (id: string, name: string) => ({ id, companyId: "c1", name, repoUrl: null, defaultBranch: "main", landing: "merge", gitHost: null, gitApiBase: null, verifyCommand: null, deepVerifyCommand: null, ticketCostCapMicros: null, reviewPolicy: null, createdAt: "" });

describe("projects page", () => {
  it("lists every project, creates another, and opens a project's Kanban", async () => {
    const list = [project("p1", "Website")];
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
        if (url === "/api/companies/c1/projects" && init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          list.push(project("p2", "Mobile app"));
          return json(list[1], 201);
        }
        if (url === "/api/companies/c1/projects") return json(list);
        if (url.endsWith("/check-presets")) return json({ detected: [], standard: [], none: { id: "none", label: "Nothing", command: null, plain: "", needs: [] }, tools: null, error: null });
        return json({});
      }),
    );
    const go = vi.fn();
    render(<ProjectsPage companies={[company]} companyId="c1" go={go} />);
    expect(await screen.findByText("Projects (1)")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Mobile app" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("Projects (2)")).toBeTruthy();
    expect(posted).toEqual([{ name: "Mobile app" }]);

    fireEvent.click(screen.getByRole("button", { name: "Open Mobile app's Kanban" }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("board/p2"));
  });
});
