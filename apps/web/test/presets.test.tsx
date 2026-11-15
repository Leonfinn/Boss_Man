// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REVIEW_POLICY, DEFAULT_WATCHDOG, ReviewPolicySchema, WatchdogSettings } from "@boss-man/shared";
import type { Agent, Company } from "../src/api";
import { CompanyReviews } from "../src/components/ReviewPolicy";
import { Watchdog } from "../src/pages/Settings";
import { limitsFromDraft, matchPreset, REVIEW_PRESETS, WATCHDOG_LIMIT_KEYS, WATCHDOG_PRESETS } from "../src/lib/presets";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const byId = <V,>(list: Array<{ id: string; values: V }>, id: string) => list.find((p) => p.id === id)!.values;

describe("review presets (BOS-1493)", () => {
  it("Standard is exactly today's default, and every preset is a valid policy", () => {
    expect(byId(REVIEW_PRESETS, "standard")).toEqual(DEFAULT_REVIEW_POLICY);
    for (const p of REVIEW_PRESETS) expect(ReviewPolicySchema.safeParse(p.values).success, p.id).toBe(true);
  });
  it("names roles only, never an agent", () => {
    const refs = (v: Record<string, { planApprover: string; reviewer: unknown; kinds?: Record<string, unknown> }>) => Object.values(v).flatMap((r) => [r.planApprover, r.reviewer, ...Object.values(r.kinds ?? {})]);
    for (const p of REVIEW_PRESETS) for (const ref of refs(p.values as never)) expect(["none", "owner", "ceo", "senior-dev"], `${p.id}: ${String(ref)}`).toContain(ref);
  });
  it("Light: the CEO reviews up to medium; high and critical keep owner sign-off and security", () => {
    const v = byId(REVIEW_PRESETS, "light");
    for (const t of ["trivial", "low", "medium"] as const) expect(v[t].reviewer).toBe("ceo");
    for (const t of ["high", "critical"] as const) expect(v[t]).toMatchObject({ planApprover: "owner", ownerSignoff: true, kinds: { security: "ceo" } });
  });
  it("Strict: two reviewers above trivial, owner sign-off from medium", () => {
    const v = byId(REVIEW_PRESETS, "strict");
    expect(v.trivial.kinds).toBeUndefined();
    for (const t of ["low", "medium", "high", "critical"] as const) expect(v[t].kinds?.adversarial, t).toBe("ceo");
    expect(v.low.ownerSignoff).toBe(false);
    for (const t of ["medium", "high", "critical"] as const) expect(v[t].ownerSignoff, t).toBe(true);
  });
  it("matches ignoring key order and an empty kinds; anything else is Custom", () => {
    const std = structuredClone(DEFAULT_REVIEW_POLICY);
    std.low = { ownerSignoff: false, reviewer: "ceo", planApprover: "ceo", kinds: {} };
    expect(matchPreset(std, REVIEW_PRESETS)?.id).toBe("standard");
    std.low = { ...std.low, reviewer: "someone" };
    expect(matchPreset(std, REVIEW_PRESETS)).toBeNull();
  });
});

describe("watchdog presets (BOS-1493)", () => {
  it("Normal equals today's limits and every preset is inside the schema's bounds", () => {
    expect(byId(WATCHDOG_PRESETS, "normal")).toEqual(Object.fromEntries(WATCHDOG_LIMIT_KEYS.map((k) => [k, DEFAULT_WATCHDOG[k]])));
    for (const p of WATCHDOG_PRESETS) {
      expect(Object.keys(p.values).sort(), p.id).toEqual([...WATCHDOG_LIMIT_KEYS].sort());
      expect(WatchdogSettings.safeParse({ ...DEFAULT_WATCHDOG, ...p.values }).success, p.id).toBe(true);
    }
  });
  it("Relaxed loosens and Tight tightens the time limits, and the caps go the matching way", () => {
    const n = byId(WATCHDOG_PRESETS, "normal"), r = byId(WATCHDOG_PRESETS, "relaxed"), t = byId(WATCHDOG_PRESETS, "tight");
    const caps = ["maxSmRunsPerHour", "maxNudgesPerHour", "maxCeoAlertsPerHour"] as const;
    for (const k of WATCHDOG_LIMIT_KEYS) {
      if ((caps as readonly string[]).includes(k)) {
        expect(r[k], k).toBeLessThan(n[k]);
        expect(t[k], k).toBeGreaterThan(n[k]);
      } else {
        expect(r[k], k).toBeGreaterThan(n[k]);
        expect(t[k], k).toBeLessThan(n[k]);
      }
    }
  });
  it("a blank or bad entry matches nothing", () => {
    const draft = Object.fromEntries(WATCHDOG_LIMIT_KEYS.map((k) => [k, String(DEFAULT_WATCHDOG[k])]));
    expect(matchPreset(limitsFromDraft(draft) as never, WATCHDOG_PRESETS)?.id).toBe("normal");
    expect(matchPreset(limitsFromDraft({ ...draft, reviewHours: "" }) as never, WATCHDOG_PRESETS)).toBeNull();
  });
});

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({ id, companyId: "c1", name, role: "worker", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null, ...over });
const AGENTS = [agent("a0", "Ada", { role: "ceo" }), agent("a1", "Sam")];

function stubReviews(policy: unknown) {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return json(policy);
  }));
  return calls;
}
const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) });

describe("Settings > Reviews cards", () => {
  it("shows Standard for today's default, folded, and saves nothing by opening the page", async () => {
    const calls = stubReviews(DEFAULT_REVIEW_POLICY);
    const { container } = render(<CompanyReviews companyId="c1" agents={AGENTS} />);
    await screen.findByLabelText("Medium: code reviewed by");
    expect(radio("Standard").getAttribute("aria-checked")).toBe("true");
    expect(radio("Custom").getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("details")!.open).toBe(false);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
  it("picking a card fills the table and saves nothing until Save", async () => {
    const calls = stubReviews(DEFAULT_REVIEW_POLICY);
    render(<CompanyReviews companyId="c1" agents={AGENTS} />);
    await screen.findByLabelText("Medium: code reviewed by");
    fireEvent.click(radio("Strict"));
    expect((screen.getByLabelText("Medium: you sign off") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Low: adversarial review by") as HTMLSelectElement).value).toBe("ceo");
    expect(radio("Strict").getAttribute("aria-checked")).toBe("true");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
  });
  it("editing a cell moves to Custom and opens the table; unknown saved values open on Custom", async () => {
    stubReviews(DEFAULT_REVIEW_POLICY);
    const first = render(<CompanyReviews companyId="c1" agents={AGENTS} />);
    await screen.findByLabelText("Medium: code reviewed by");
    fireEvent.click(screen.getByLabelText("Low: you sign off"));
    expect(radio("Custom").getAttribute("aria-checked")).toBe("true");
    expect(first.container.querySelector("details")!.open).toBe(true);
    first.unmount();
    const calls = stubReviews({ ...DEFAULT_REVIEW_POLICY, low: { planApprover: "ceo", reviewer: "a1", ownerSignoff: false } });
    const second = render(<CompanyReviews companyId="c1" agents={AGENTS} />);
    await screen.findByLabelText("Medium: code reviewed by");
    expect(radio("Custom").getAttribute("aria-checked")).toBe("true");
    expect(second.container.querySelector("details")!.open).toBe(true);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: AGENTS };
const status = (limits: Record<string, number> = {}) => ({ settings: { ...DEFAULT_WATCHDOG, ...limits }, scrumMaster: null, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 });

describe("Settings > Watchdog cards", () => {
  it("shows Normal for today's limits and saves nothing by opening the page", async () => {
    const calls = stubReviews(status());
    render(<Watchdog company={company} />);
    await screen.findByLabelText("No movement in progress");
    expect(radio("Normal").getAttribute("aria-checked")).toBe("true");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
  it("picking Tight fills the limits, saves nothing, then Save sends them without touching on/off or record only", async () => {
    const calls = stubReviews(status());
    render(<Watchdog company={company} />);
    await screen.findByLabelText("No movement in progress");
    fireEvent.click(radio("Tight"));
    expect((screen.getByLabelText("No movement in progress") as HTMLInputElement).value).toBe("1");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toBeTruthy());
    const sent = calls.find((c) => c.method === "PATCH")!;
    expect(sent.url).toBe("/api/companies/c1/watchdog");
    expect(sent.body).toMatchObject({ inProgressHours: 1, reviewHours: 1, unassignedMinutes: 10, spareCapacityMinutes: 10 });
    expect(sent.body).not.toHaveProperty("enabled");
    expect(sent.body).not.toHaveProperty("recordOnly");
  });
  it("editing a limit shows Custom; limits matching no preset open on Custom with the grid open", async () => {
    stubReviews(status());
    const first = render(<Watchdog company={company} />);
    const input = (await screen.findByLabelText("No movement in progress")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    expect(radio("Custom").getAttribute("aria-checked")).toBe("true");
    first.unmount();
    const calls = stubReviews(status({ reviewHours: 3 }));
    const second = render(<Watchdog company={company} />);
    await screen.findByLabelText("No movement in progress");
    expect(radio("Custom").getAttribute("aria-checked")).toBe("true");
    expect(second.container.querySelector("details")!.open).toBe(true);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});
