// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotePane, PortalSettings } from "../src/pages/Feedback";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const settings = {
  demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: "tok", portalTitle: "Ideas", portalIntro: "", portalBackUrl: null, portalBackText: null,
  hasLogo: true, portalUrl: "https://example.com/p/tok", confirmByEmail: false, confirmLinkHours: 24, rememberAddressDays: 30, emailReady: false, drivers: [], areas: [],
};
const detail = {
  note: { id: "n1", title: "Slow board", text: "The board is slow", source: "manual", state: "unprocessed", createdAt: "2026-11-01T10:00:00Z", untrusted: false },
  customer: null,
  insights: [{ id: "i1", noteId: "n1", featureId: "f1", importance: "important", highlight: "so slow", createdBy: "owner", createdAt: "2026-11-01T10:00:00Z", feature: { id: "f1", title: "Fast board", status: "planned" } }],
  suggestions: [],
};

let calls: Array<{ url: string; method: string }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method });
    if (String(url).includes("feedback-settings")) return Promise.resolve(ok(settings));
    if (String(url).includes("/api/feedback/")) return Promise.resolve(ok(detail));
    return Promise.resolve(ok({}));
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const deletes = (part: string) => calls.filter((c) => c.method === "DELETE" && c.url.includes(part));

describe("portal logo Remove", () => {
  it("asks first; Cancel sends nothing", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PortalSettings companyId="c1" shown={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(confirm).toHaveBeenCalledWith("Remove the portal logo? Visitors will see the default.");
    expect(deletes("portal-logo")).toHaveLength(0);
  });
  it("removes the logo once confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PortalSettings companyId="c1" shown={1} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deletes("portal-logo")).toHaveLength(1));
  });
});

describe("feedback Unlink", () => {
  it("asks first, naming the feature; Cancel sends nothing", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<NotePane id="n9" companyId="c1" features={[]} onChanged={() => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }));
    expect(confirm).toHaveBeenCalledWith("Unlink this feedback from Fast board? Its highlight and importance are removed.");
    expect(deletes("/api/insights/")).toHaveLength(0);
  });
  it("unlinks once confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<NotePane id="n10" companyId="c1" features={[]} onChanged={() => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(deletes("/api/insights/i1")).toHaveLength(1));
  });
  it("still asks before Delete feedback", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<NotePane id="n11" companyId="c1" features={[]} onChanged={() => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith("Delete this feedback and its links?");
    expect(deletes("/api/feedback/n11")).toHaveLength(0);
  });
});
