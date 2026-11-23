// @vitest-environment jsdom
// BOS-2318: each deploy target's "Deploys" fold lists its deploys newest first, 20 a page, with Show older.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { DeployTargets } from "../src/pages/settings/Tools";

let targetOver: Record<string, unknown> = {};
afterEach(() => {
  targetOver = {};
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const target = { id: "t1", companyId: "c1", name: "Staging", kind: "ssh", endpoint: "deploy@example.com", isProduction: false, rules: {}, lastDeploy: null };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

type Row = { deploy: Record<string, unknown>; agentName: string | null; ticketRef: string | null };
const row = (n: number, over: Record<string, unknown> = {}, who: string | null = "Zebedee"): Row => ({
  deploy: { id: `d${String(n).padStart(3, "0")}`, ref: `v${n}`, commit: null, notes: null, status: "succeeded", outcome: null, ticketId: null, tagName: null, tagResult: null, createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), ...over },
  agentName: who,
  ticketRef: null,
});

/** A fake /api/deploys that pages like the server: newest first, `limit` rows, older than `before`. */
function stub(all: Row[], failFirst = false) {
  const urls: string[] = [];
  let failed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/deploys")) {
        urls.push(url);
        if (failFirst && !failed) {
          failed = true;
          return json({ error: "boom", message: "the server is down" }, 500);
        }
        const q = new URLSearchParams(url.split("?")[1]);
        const sorted = [...all].sort((a, b) => String(b.deploy.id).localeCompare(String(a.deploy.id)));
        const before = q.get("before");
        const rest = before ? sorted.filter((r) => String(r.deploy.id) < before) : sorted;
        return json(rest.slice(0, Number(q.get("limit") ?? 20)));
      }
      return json(url.endsWith("/deploy-targets") ? [{ ...target, ...targetOver }] : []);
    }),
  );
  return urls;
}

async function open() {
  render(<DeployTargets company={company} />);
  const summary = await screen.findByText("Deploys");
  const details = summary.closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return details;
}

describe("deploy history", () => {
  it("lists a target's deploys newest first, in plain words, with who asked and a ticket link", async () => {
    const withTicket = row(3, { status: "pending_approval", ticketId: "tk1", notes: "Needs the migration" }, null);
    withTicket.ticketRef = "BOS-9";
    const urls = stub([row(1), row(2, { status: "failed", outcome: "Build broke" }), withTicket]);
    const details = await open();
    const items = await within(details).findAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("waiting for you"),
      expect.stringContaining("failed"),
      expect.stringContaining("succeeded"),
    ]);
    expect(items[0]!.textContent).toContain("v3");
    expect(items[0]!.textContent).toContain("asked by you");
    expect(items[0]!.textContent).toContain("Needs the migration");
    expect(items[1]!.textContent).toContain("Build broke");
    expect(items[2]!.textContent).toContain("asked by Zebedee");
    expect(within(items[0]!).getByRole("link", { name: "BOS-9" }).getAttribute("href")).toBe("#/tickets/tk1");
    expect(urls[0]).toContain("targetId=t1");
  });

  it("shows 20 of 25, then Show older brings the other 5 and goes away", async () => {
    stub(Array.from({ length: 25 }, (_, i) => row(i + 1)));
    const details = await open();
    expect(await within(details).findAllByRole("listitem")).toHaveLength(20);
    fireEvent.click(within(details).getByRole("button", { name: "Show older" }));
    await vi.waitFor(() => expect(within(details).getAllByRole("listitem")).toHaveLength(25));
    expect(within(details).queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("shows a load error with Retry, and Retry loads the list", async () => {
    stub([row(1)], true);
    const details = await open();
    fireEvent.click(await within(details).findByRole("button", { name: /retry/i }));
    expect(await within(details).findAllByRole("listitem")).toHaveLength(1);
  });
});

describe("deploy this version again (BOS-2329)", () => {
  it("offers the button on older successes only, confirms with ref, commit and date, and posts the redeploy", async () => {
    const sha = (c: string) => c.repeat(40);
    targetOver = { lastDeploy: { id: "d003", ref: "v3", commit: sha("3"), at: null, tagName: null, tagResult: null } };
    stub([
      row(1, { commit: sha("1"), finishedAt: "2026-01-01T00:01:00.000Z" }),
      row(2, { commit: sha("2") }),
      row(3, { commit: sha("3") }),
      row(4, { status: "failed", commit: sha("4") }),
      row(5, { status: "rejected", commit: sha("5") }),
    ]);
    const details = await open();
    await within(details).findAllByRole("listitem");
    const buttons = within(details).getAllByRole("button", { name: "Deploy this version again" });
    expect(buttons).toHaveLength(2);
    // Newest first: d002 is above d001; neither the latest success, the failed nor the refused row has one.
    const owners = buttons.map((b) => b.closest("li")!.textContent);
    expect(owners[0]).toContain("v2");
    expect(owners[1]).toContain("v1");

    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fireEvent.click(buttons[1]!);
    expect(confirm).toHaveBeenCalledOnce();
    const text = (confirm.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("v1");
    expect(text).toContain("1111111");
    expect(text).toContain("2026-01-01");
    expect(text).toContain("does not roll back data");
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/deploys/d001/redeploy")).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/deploys/d001/redeploy")!;
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({ companyId: "c1" });
  });
});
