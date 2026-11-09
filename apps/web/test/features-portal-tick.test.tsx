// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Features } from "../src/pages/Features";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const feature = (over: Record<string, unknown> = {}) => ({
  id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Dark mode", description: null, status: "in_progress", effort: null, driverScores: {}, milestoneId: null,
  portalVisible: false, keepOffPortal: false, publicSummary: null, publicTitle: null, showPublicly: false,
  createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 0, insightCount: 0, customerCount: 0, value: 0, demandPart: 0, priority: 0,
  tickets: { total: 0, done: 0, items: [] },
  portal: { onPortal: false, reason: "needs public summary" },
  ...over,
});

/** A stub server whose one feature flips portalVisible when the PATCH arrives, and whose feature page reads the same feature. */
function stub(initial: Record<string, unknown>) {
  let row: Record<string, unknown> = feature(initial);
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url.startsWith("/api/features/")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push({ url, body });
        if (body.portalVisible === true) row = { ...row, portalVisible: true };
        return json(row);
      }
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [row] });
      if (url.startsWith("/api/features/")) return json({ feature: row, drivers: [], settings: { demandWeight: 1 }, maxDemand: 0, subfeatures: [], insights: [], tickets: [] });
      if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      if (url.endsWith("/objectives")) return json([]);
      return json([]);
    }),
  );
  return { patches, row: () => row };
}

describe("Features list: on-portal tick (BOS-957)", () => {
  it("ticks a feature onto the portal from the list, saving at once, and the feature page shows it", async () => {
    const s = stub({});
    const { unmount } = render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    const tick = (await screen.findByRole("checkbox", { name: "On portal: Dark mode" })) as HTMLInputElement;
    expect(tick.checked).toBe(false);
    fireEvent.click(tick);
    await waitFor(() => expect(s.patches).toEqual([{ url: "/api/features/f1", body: { portalVisible: true } }]));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "On portal: Dark mode" }) as HTMLInputElement).checked).toBe(true));
    unmount();

    // The feature page ticks the same box from the same state, so the two stay in sync.
    render(<Features companies={[company]} companyId="c1" featureId="f1" go={() => {}} />);
    const show = (await screen.findByLabelText(/Show on the feedback portal/)) as HTMLInputElement;
    expect(show.checked).toBe(true);
  });

  it("shows why a feature is kept off", async () => {
    stub({ title: "Rotate API keys", portal: { onPortal: false, reason: "security" } });
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    expect(await screen.findByText("kept off: security")).toBeTruthy();
  });

  it("says a ticked feature needs a public summary before visitors see it", async () => {
    stub({ portalVisible: true, portal: { onPortal: false, reason: "needs public summary" } });
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    expect(await screen.findByText("needs public summary")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "On portal: Dark mode" }) as HTMLInputElement).checked).toBe(true);
  });

  it("saves the public title with the summary, so visitors see it instead of the internal title (BOS-991)", async () => {
    const s = stub({ publicSummary: "A dark theme you can switch on." });
    render(<Features companies={[company]} companyId="c1" featureId="f1" go={() => {}} />);
    const title = (await screen.findByLabelText(/Public title/)) as HTMLInputElement;
    expect(title.value).toBe("");
    fireEvent.change(title, { target: { value: "  Night reading  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save summary" }));
    await waitFor(() =>
      expect(s.patches).toEqual([{ url: "/api/features/f1", body: { publicSummary: "A dark theme you can switch on.", publicTitle: "Night reading" } }]),
    );
  });

  it("has a 'Keep off the portal (sensitive)' mark on the feature page", async () => {
    const s = stub({ portalVisible: true });
    render(<Features companies={[company]} companyId="c1" featureId="f1" go={() => {}} />);
    const mark = (await screen.findByLabelText(/Keep off the portal \(sensitive\)/)) as HTMLInputElement;
    expect(mark.checked).toBe(false);
    fireEvent.click(mark);
    await waitFor(() => expect(s.patches).toEqual([{ url: "/api/features/f1", body: { keepOffPortal: true } }]));
  });
});
