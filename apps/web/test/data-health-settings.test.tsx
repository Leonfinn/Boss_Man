// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerHealth } from "../src/pages/settings/System";

// BOS-2380: Settings → System → Server health shows the disk, the database and its growth, the limit counts and slow queries.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GB = 1024 ** 3;
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const text = (id: string) => screen.getByTestId(id).textContent ?? "";

describe("Server health", () => {
  it("shows the figures, a warning and a slow query with values removed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          disk: { freeBytes: 8 * GB, totalBytes: 100 * GB, freePercent: 8 },
          database: { bytes: 3 * GB, dayAgoBytes: 2.9 * GB, weekAgoBytes: 1.5 * GB, growthPercent7d: 100 },
          limits: { statementTimeouts: 2, poolFull: 1 },
          slowQueries: [{ seconds: 75, query: "select * from tickets where id = ?" }],
          warnings: ["The server's data disk is running low: 8.0 GB free of 100.0 GB (8%)."],
        }),
      ),
    );
    render(<ServerHealth />);
    await screen.findByTestId("health-disk");
    expect(text("health-disk")).toContain("8.0 GB free of 100.0 GB (8% free)");
    expect(text("health-db")).toContain("3.0 GB. 1 day ago 2.9 GB, 7 days ago 1.5 GB (+100% in 7 days)");
    expect(text("health-limits")).toContain("2 queries cut off");
    expect(text("health-limits")).toContain("1 times the connection pool was full");
    expect(text("health-slow")).toContain("75 s: select * from tickets where id = ?");
    expect(screen.getByRole("alert").textContent).toContain("running low");
  });

  it("says so when there is no history or no disk reading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ disk: null, database: { bytes: 1024 ** 2 * 40, dayAgoBytes: null, weekAgoBytes: null, growthPercent7d: null }, limits: { statementTimeouts: 0, poolFull: 0 }, slowQueries: [], warnings: [] })),
    );
    render(<ServerHealth />);
    await screen.findByTestId("health-disk");
    expect(text("health-disk")).toContain("not available");
    expect(text("health-db")).toContain("1 day ago not available");
    expect(text("health-slow")).toContain("No query is running over 60 seconds.");
  });
});
