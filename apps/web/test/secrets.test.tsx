// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Secrets } from "../src/pages/Secrets";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("secrets page", () => {
  it("is the one place to add, grant and list credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/companies/c1/grants"
          ? json([{ id: "g1", secretId: "s1", envName: "GIT_TOKEN", secret: "Boss Man Github token", hint: "Y1S4", deployTargetId: null, agentIds: [] }])
          : url === "/api/secrets"
            ? json([{ id: "s1", name: "Boss Man Github token", kind: "generic", hint: "Y1S4", version: 1, createdAt: "2026-10-19T17:22:00Z", updatedAt: "2026-10-19T17:22:00Z" }])
            : json([]),
      ),
    );
    render(<Secrets companies={[company]} companyId="c1" />);
    expect(await screen.findByRole("heading", { name: "Boss Man Co's variables" })).toBeTruthy();
    expect(await screen.findByText("GIT_TOKEN")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All stored secrets" })).toBeTruthy();
    expect((await screen.findAllByText("Boss Man Github token")).length).toBeGreaterThan(0);
  });

  it("removes a key from just this company", async () => {
    const calls: string[] = [];
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return url === "/api/companies/c1/grants"
          ? json([{ id: "g1", secretId: "s1", envName: "GIT_TOKEN", secretName: "Boss Man Github token", hint: "Y1S4", deployTargetId: null, agentIds: [] }])
          : json([]);
      }),
    );
    render(<Secrets companies={[company]} companyId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove GIT_TOKEN from Boss Man Co" }));
    await vi.waitFor(() => expect(calls).toContain("DELETE /api/grants/g1"));
    expect(calls).not.toContain("DELETE /api/secrets/s1");
  });
});

describe("agents per key", () => {
  it("saves which agents get a key", async () => {
    const calls: string[] = [];
    const agent = (id: string, name: string) => ({ id, companyId: "c1", name, role: "worker" as const, agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null });
    const co: Company = { ...company, agents: [agent("a1", "Ada"), agent("a2", "Bo")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
        return url === "/api/companies/c1/grants" ? json([{ id: "g1", secretId: "s1", envName: "GIT_TOKEN", secretName: "Token", hint: "Y1S4", deployTargetId: null, agentIds: [] }]) : json([]);
      }),
    );
    render(<Secrets companies={[co]} companyId="c1" />);
    fireEvent.click(await screen.findByText("All agents"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Bo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save agents for GIT_TOKEN" }));
    await vi.waitFor(() => expect(calls).toContain('PUT /api/grants/g1/agents {"agentIds":["a2"]}'));
  });
});
