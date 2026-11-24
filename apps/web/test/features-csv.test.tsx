// @vitest-environment jsdom
// BOS-2248: the Features page's "Download CSV" exports the features shown, one column per criterion.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Driver, Feature } from "../src/api";
import { Features, featuresToCsv } from "../src/pages/Features";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const driver: Driver = { id: "d1", name: "Reach", weight: 1 } as Driver;
const feature = (over: Record<string, unknown> = {}) =>
  ({
    id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Gift cards", status: "planned", effort: 3, driverScores: { d1: 4 },
    portalVisible: true, createdAt: "2026-10-19T09:00:00Z", demand: 2, value: 3.5, priority: 7.5,
    tickets: { total: 3, done: 1, items: [] },
    ...over,
  }) as unknown as Feature;

describe("featuresToCsv", () => {
  it("writes the parent's title, a column per criterion, blanks for unscored, and quotes a comma", () => {
    const parent = feature({ title: "Cards, all kinds" });
    const sub = feature({ id: "f2", parentId: "f1", title: "Sub", driverScores: {}, effort: null, portalVisible: false });
    const csv = featuresToCsv([{ f: parent, area: "Billing" }, { f: sub, area: "Billing" }], [driver], [parent, sub]);
    const [head, a, b] = csv.split("\r\n");
    expect(head).toBe("area,feature,parent,portal,status,last_moved,demand,Reach,effort,value,priority,tasks_done,tasks");
    expect(a).toBe('Billing,"Cards, all kinds",,yes,Planned,,2,4,3,3.5,7.5,1,3');
    expect(b).toBe('Billing,Sub,"Cards, all kinds",no,Planned,,2,,,3.5,7.5,1,3');
  });
});

describe("Download CSV button", () => {
  const stub = (rows: unknown[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [driver], maxDemand: 2, features: rows });
        if (url.includes("/feedback-settings")) return json({ drivers: [], areas: [] });
        return json([]);
      }),
    );

  it("is disabled when there are no features", async () => {
    stub([]);
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    await screen.findByText(/No features yet/);
    expect((screen.getByRole("button", { name: "Download CSV" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("downloads the features shown", async () => {
    stub([feature()]);
    let saved: Blob | null = null;
    URL.createObjectURL = ((b: Blob) => ((saved = b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await (saved as unknown as Blob).text()).toContain(",Gift cards,,yes,Planned,,2,4,3,");
  });
});
