// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetguardAllow } from "../src/pages/Settings";

// Settings → Server and runner (BOS-770, BOS-791): what runners may reach. The addresses Boss Man opens by itself (each
// with what it is and its company, and any the guard drops marked not allowed), then the owner's .env lines with the
// ones Boss Man covers anyway, and a duplicate line. Addresses are made-up examples.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const NOT_ALLOWED = "Not allowed. Boss Man allows this name, but it now points at a private address on your home network.";

const report = (over: Record<string, unknown> = {}) => ({
  report: {
    mode: "auto",
    automatic: [
      { address: "git.example.lan:3003", kind: "git host", name: "Website", company: "Acme", trusted: true, notAllowed: null },
      { address: "tools.example.net:443", kind: "tool server", name: "crawl4ai", company: "Acme", trusted: false, notAllowed: null },
      { address: "evil.example.org:5432", kind: "tool server", name: "pkg-server", company: "Imported Co", trusted: false, notAllowed: NOT_ALLOWED },
    ],
    entries: [{ entry: "git.example.lan:3003", coveredBy: ["git host"], note: "Already allowed by Boss Man; this line can go." }],
    lineCanGo: true,
    env: { envFound: true, reportedAt: "2026-11-08T18:00:00Z", lines: [["penpot.example.lan:9001"], ["git.example.lan:3003"]] },
    warnings: ["BOSSMAN_NETGUARD_ALLOW is set on 2 lines in .env, and only the last one counts. These entries on the earlier lines are ignored: penpot.example.lan:9001. Merge them into one line."],
    ...over,
  },
});

describe("Network guard addresses in Settings", () => {
  it("shows the two lists: what Boss Man opens by itself (with company and kind), and the .env lines", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(report())));
    render(<NetguardAllow />);
    const automatic = await screen.findByTestId("netguard-automatic");
    expect(automatic.textContent).toContain("tools.example.net:443");
    expect(automatic.textContent).toContain('tool server "crawl4ai"');
    expect(automatic.textContent).toContain("for Acme");
    expect(automatic.textContent).toContain("git host for the project \"Website\"");

    const list = screen.getByTestId("netguard-allow-entries");
    expect(list.textContent).toContain("git.example.lan:3003");
    expect(list.textContent).toContain("Already allowed by Boss Man; this line can go.");
    expect(screen.getByText("(ignored)")).toBeTruthy();
    expect(screen.getByText("(used)")).toBeTruthy();
    expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("only the last one counts"))).toBe(true);
    // The section keeps the name the Settings menu uses (BOS-1044).
    expect(screen.getByText("Network guard")).toBeTruthy();
    expect(screen.getByText("Allowed automatically")).toBeTruthy();
    expect(screen.getByText("Extra lines from your .env")).toBeTruthy();
  });

  it("marks an address the guard drops as not allowed, with the reason, instead of leaving it out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(report())));
    render(<NetguardAllow />);
    const automatic = await screen.findByTestId("netguard-automatic");
    expect(automatic.textContent).toContain("evil.example.org:5432");
    expect(automatic.textContent).toContain(NOT_ALLOWED);
    expect(screen.getByTestId("netguard-not-allowed-summary").textContent).toContain("One address above is not allowed");
  });

  it("shows nothing when there is nothing to report (no launcher, no host report)", async () => {
    const f = vi.fn(async () => json({ report: null }));
    vi.stubGlobal("fetch", f);
    const { container } = render(<NetguardAllow />);
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("says the automatic list is unknown when Boss Man couldn't work it out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(report({ automatic: null }))));
    render(<NetguardAllow />);
    expect((await screen.findByTestId("netguard-automatic-unknown")).textContent).toContain("couldn't work out");
  });
});
