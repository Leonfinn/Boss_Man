// @vitest-environment jsdom
// Settings → Server and runner: one card per safety feature the runner hasn't proven, with two buttons (DR-049 point 1, BOS-938).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Runner } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const base = { registered: true, runnerId: "r1", connected: true, lastSeenAt: "2026-11-13T10:00:00.000Z", imageVersion: "1", diskUsedBytes: null, addons: null, report: null };
const fingerprint = "6.1.0-test|docker 27.0.1|linux";

function stub(safety: unknown) {
  const posts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST" && url.endsWith("/safety-choice")) {
      posts.push(JSON.parse(init.body!));
      return json({ ok: true });
    }
    if (url.endsWith("/api/companies/c1/runner")) return json({ ...base, safety });
    return json([]);
  }));
  return posts;
}

describe("the safety cards", () => {
  it("shows a card for a missing network guard, with Keep agents stopped as the default, and sends the owner's choice", async () => {
    const posts = stub({ fingerprint, fence: { proven: true, runWithout: false }, guard: { proven: false, runWithout: false, reason: "connected to the gateway" } });
    render(<Runner company={company} />);
    const card = await screen.findByTestId("safety-card-guard");
    expect(card.textContent).toContain("no proven network guard");
    expect(card.textContent).toContain("Agents are stopped");
    expect(card.textContent).toContain(fingerprint);
    expect(screen.queryByTestId("safety-card-fence")).toBeNull();
    expect(screen.getByText("Keep agents stopped").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("Run agents without the network guard"));
    await waitFor(() => expect(posts).toEqual([{ feature: "guard", run: true }]));
  });

  it("shows one card per missing feature, the fence one with its own button", async () => {
    const posts = stub({ fingerprint, fence: { proven: false, runWithout: false }, guard: { proven: false, runWithout: false, reason: null } });
    render(<Runner company={company} />);
    expect(await screen.findByTestId("safety-card-guard")).toBeTruthy();
    expect(screen.getByTestId("safety-card-fence")).toBeTruthy();
    fireEvent.click(screen.getByText("Run agents without the fence"));
    await waitFor(() => expect(posts).toEqual([{ feature: "fence", run: true }]));
  });

  it("says when the owner already chose to run without it, and shows no card when both features are proven", async () => {
    stub({ fingerprint, fence: { proven: true, runWithout: false }, guard: { proven: false, runWithout: true, reason: "x" } });
    render(<Runner company={company} />);
    expect((await screen.findByTestId("safety-card-guard")).textContent).toContain("You chose to run agents without it");
    cleanup();
    stub({ fingerprint, fence: { proven: true, runWithout: false }, guard: { proven: true, runWithout: false, reason: null } });
    render(<Runner company={company} />);
    await screen.findByTestId("runner-now");
    expect(screen.queryByTestId("safety-cards")).toBeNull();
  });
});
