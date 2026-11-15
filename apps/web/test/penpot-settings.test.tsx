// @vitest-environment jsdom
// BOS-1582: Settings → Tools → Penpot, one form for the four Penpot secrets.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Company } from "../src/api";
import { PenpotSettings } from "../src/pages/settings/Tools";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const designer = { id: "a1", name: "Designer" } as Agent;
const developer = { id: "a2", name: "Developer" } as Agent;
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [designer, developer] };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const unset = { set: false, hint: null, secretName: null };
const notSet = { configured: false, url: null, urlHint: null, guardAddress: null, guardTrustsPrivate: false, token: unset, email: unset, password: unset, agentIds: [], exportAgentIds: [] };
// An install set up by hand on the Secrets page before BOS-1582: address and token, no export login, Designer only.
const handMade = { ...notSet, configured: true, url: "http://192.168.1.50:9001", guardAddress: "192.168.1.50:9001", guardTrustsPrivate: true, token: { set: true, hint: "••••mnop", secretName: "PENPOT_TOKEN" }, agentIds: ["a1"] };

function stub(view: unknown) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json(view);
    }),
  );
  return calls;
}

describe("Penpot settings", () => {
  it("shows a hand-made install as set up, with what the guard opens and who gets it", async () => {
    stub(handMade);
    render(<PenpotSettings company={company} />);
    const summary = await screen.findByTestId("penpot-summary");
    expect(summary.textContent).toContain("http://192.168.1.50:9001");
    expect(summary.textContent).toContain("the network guard opens 192.168.1.50:9001");
    expect(summary.textContent).toContain("Access token: saved (••••mnop), for Designer");
    expect(summary.textContent).toContain("Export login: not set");
    expect(screen.getByRole("button", { name: "Change Penpot" })).toBeTruthy();
  });

  it("keeps the saved token when its field is left blank, and sends the ticked agents", async () => {
    const calls = stub(handMade);
    render(<PenpotSettings company={company} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change Penpot" }));
    // The address is filled in; the token is never shown, and isn't required while one is saved.
    expect((screen.getByLabelText("Penpot address") as HTMLInputElement).value).toBe("http://192.168.1.50:9001");
    expect((screen.getByLabelText("Access token") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Access token") as HTMLInputElement).required).toBe(false);
    fireEvent.click(screen.getAllByLabelText("Developer")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Save Penpot" }));
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: "/api/companies/c1/penpot", body: { url: "http://192.168.1.50:9001", token: "", email: "", password: "", agentIds: ["a1", "a2"], exportAgentIds: [] } });
  });

  it("asks for the address and token on first set-up", async () => {
    stub(notSet);
    render(<PenpotSettings company={company} />);
    expect((await screen.findByTestId("penpot-not-set")).textContent).toContain("isn't set up");
    fireEvent.click(screen.getByRole("button", { name: "Set up Penpot" }));
    expect((screen.getByLabelText("Penpot address") as HTMLInputElement).required).toBe(true);
    expect((screen.getByLabelText("Access token") as HTMLInputElement).required).toBe(true);
  });
});
