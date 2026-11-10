// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ToolServers } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const row = { id: "m1", name: "scrapling", url: "http://192.168.1.50:30301/mcp", transport: "http", secretEnv: "SCRAPLING_MCP_TOKEN", secretGranted: true };

function stub(list: unknown[] = [row]) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json(init?.method === "POST" ? row : list);
    }),
  );
  return calls;
}

describe("tool servers", () => {
  it("lists servers with their token secret", async () => {
    stub([row, { ...row, id: "m2", name: "crawl4ai", transport: "sse", secretEnv: null }]);
    render(<ToolServers company={company} />);
    expect(await screen.findByText("scrapling")).toBeTruthy();
    expect(screen.getByText("SCRAPLING_MCP_TOKEN")).toBeTruthy();
    expect(screen.getByText("none")).toBeTruthy();
    expect(screen.queryByText(/Not granted/)).toBeNull();
  });

  it("warns when the token secret isn't granted to the company", async () => {
    stub([{ ...row, secretEnv: "SCRAPLING_API_TOKEN", secretGranted: false }]);
    render(<ToolServers company={company} />);
    expect(await screen.findByText(/Not granted to .*no agent gets this server/)).toBeTruthy();
  });

  it("adds a server", async () => {
    const calls = stub([]);
    render(<ToolServers company={company} />);
    fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "scrapling" } });
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "http://192.168.1.50:30301/mcp" } });
    fireEvent.change(screen.getByLabelText("Token secret"), { target: { value: "SCRAPLING_MCP_TOKEN" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tool server" }));
    await vi.waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      url: "/api/companies/c1/mcp-servers",
      body: { name: "scrapling", url: "http://192.168.1.50:30301/mcp", transport: "http", secretEnv: "SCRAPLING_MCP_TOKEN", headerName: "Authorization", headerValue: "Bearer {secret}" },
    });
  });

  it("removes a server after confirming", async () => {
    const calls = stub();
    vi.stubGlobal("confirm", () => true);
    render(<ToolServers company={company} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove tool server scrapling" }));
    await vi.waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: "DELETE", url: "/api/mcp-servers/m1" })));
  });
});
