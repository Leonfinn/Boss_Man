// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetguardAllow } from "../src/pages/Settings";

// Settings → Server and runner (BOS-770): the .env network-guard allow entries, the ones Boss Man covers anyway, and a
// duplicate line. Addresses are made-up examples.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("Network guard allow list in Settings", () => {
  it("lists each entry, marks the covered one, shows the .env lines and the duplicate warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          report: {
            mode: "auto",
            entries: [{ entry: "git.example.lan:3000", coveredBy: ["git host"], note: "Already allowed by Boss Man; this line can go." }],
            lineCanGo: true,
            env: { envFound: true, reportedAt: "2026-11-08T18:00:00Z", lines: [["penpot.example.lan:9001"], ["git.example.lan:3000"]] },
            warnings: ["BOSSMAN_NETGUARD_ALLOW is set on 2 lines in .env, and only the last one counts. These entries on the earlier lines are ignored: penpot.example.lan:9001. Merge them into one line."],
          },
        }),
      ),
    );
    render(<NetguardAllow />);
    const list = await screen.findByTestId("netguard-allow-entries");
    expect(list.textContent).toContain("git.example.lan:3000");
    expect(list.textContent).toContain("Already allowed by Boss Man; this line can go.");
    expect(screen.getByText("(ignored)")).toBeTruthy();
    expect(screen.getByText("(used)")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("only the last one counts");
  });

  it("shows nothing when there is nothing to report (no launcher, no host report)", async () => {
    const f = vi.fn(async () => json({ report: null }));
    vi.stubGlobal("fetch", f);
    const { container } = render(<NetguardAllow />);
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
