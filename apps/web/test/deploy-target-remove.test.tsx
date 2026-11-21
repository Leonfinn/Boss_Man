// @vitest-environment jsdom
// BOS-2158: removing a deploy target that has deploys asks first; a live deploy gives no override.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { DeployTargets } from "../src/pages/settings/Tools";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const target = { id: "t1", companyId: "c1", name: "Staging", kind: "ssh", endpoint: "deploy@example.com", isProduction: false, rules: {}, lastDeploy: null };
const reply = (status: number, b: unknown) => new Response(status === 204 ? null : JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function stub(onDelete: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        calls.push(url);
        return onDelete(url);
      }
      return reply(200, url.endsWith("/deploy-targets") ? [target] : []);
    }),
  );
  return calls;
}

describe("removing a deploy target", () => {
  it("shows the server's message with Remove anyway for past deploys, and removes with force", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = stub((url) => (url.includes("force=1") ? reply(204, null) : reply(409, { error: "has_history", field: "has_history", message: "This target has past deploys." })));
    render(<DeployTargets company={company} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete deploy target Staging" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This target has past deploys.");
    fireEvent.click(screen.getByRole("button", { name: "Remove anyway" }));
    await screen.findByText("Deleted Staging.");
    expect(calls).toEqual(["/api/deploy-targets/t1", "/api/deploy-targets/t1?force=1"]);
  });

  it("shows a live deploy's message with no Remove anyway", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    stub(() => reply(409, { error: "live", message: "A deploy to this target is waiting for approval." }));
    render(<DeployTargets company={company} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete deploy target Staging" }));
    expect((await screen.findByRole("alert")).textContent).toContain("waiting for approval");
    expect(screen.queryByRole("button", { name: "Remove anyway" })).toBeNull();
  });
});
