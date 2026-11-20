// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Features } from "../src/pages/Features";
import { ChatPage } from "../src/pages/Chat";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

describe("Features and Chat: a failed load says so (BOS-1889)", () => {
  it("Features shows an error with Retry, then the empty text only after a good empty answer", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/features")) return fail ? json({ error: "boom" }, 500) : json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
        return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      }),
    );
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    await screen.findByText(/Couldn't load your features/);
    expect(screen.queryByText(/No features yet/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/No features yet/);
  });

  it("Chat shows an error with Retry when the team fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
    render(<ChatPage companies={[company]} companyId="c1" agentId={undefined} go={() => {}} onChanged={() => {}} />);
    await screen.findByText(/Couldn't load the team/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
