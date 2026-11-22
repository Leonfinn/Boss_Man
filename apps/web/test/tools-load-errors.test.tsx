// @vitest-environment jsdom
// BOS-2235: a failed load says so (with Retry) instead of showing an empty list; codes show as plain words.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { DeployTargets, PenpotSettings, ToolServers } from "../src/pages/settings/Tools";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const reply = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const failing = () => vi.stubGlobal("fetch", vi.fn(async () => reply(500, { error: "boom", message: "The server had a problem" })));

describe("Settings → Tools load failures", () => {
  it("tool servers: error with Retry, not 'No tool servers yet'", async () => {
    failing();
    render(<ToolServers company={company} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the tool servers");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No tool servers yet.")).toBeNull();
  });

  it("deploy targets: error with Retry, not the empty message", async () => {
    failing();
    render(<DeployTargets company={company} />);
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("Couldn't load the deploy targets"))).toBe(true);
    expect(screen.queryByText(/No deploy targets yet/)).toBeNull();
  });

  it("Penpot: error with Retry instead of a missing section", async () => {
    failing();
    render(<PenpotSettings company={company} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the Penpot setting");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
});

describe("Settings → Tools plain labels", () => {
  it("shows transport and target kind as the forms name them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        reply(
          200,
          url.endsWith("/mcp-servers")
            ? [
                { id: "m1", name: "scrapling", url: "http://192.0.2.10/mcp", transport: "http", secretEnv: null, secretGranted: true },
                { id: "m2", name: "crawler", url: "http://192.0.2.11/sse", transport: "sse", secretEnv: null, secretGranted: true },
              ]
            : url.endsWith("/deploy-targets")
              ? (["ssh", "docker", "git"] as const).map((kind, i) => ({ id: `t${i}`, name: `Target ${kind}`, kind, endpoint: "example.com", isProduction: false, rules: {}, lastDeploy: null }))
              : [],
        ),
      ),
    );
    render(
      <>
        <ToolServers company={company} />
        <DeployTargets company={company} />
      </>,
    );
    // The form's <option> shows the same words at once; wait for the table cells from the load.
    await screen.findByText("scrapling");
    expect(screen.getAllByText("Streamable HTTP").some((c) => c.tagName === "TD")).toBe(true);
    expect(screen.getAllByText("SSE").some((c) => c.tagName === "TD")).toBe(true);
    await screen.findByText("Target git");
    for (const label of ["SSH host", "Docker endpoint", "Git remote"]) {
      expect(screen.getAllByText(label).some((c) => c.tagName === "SPAN")).toBe(true);
    }
  });
});
