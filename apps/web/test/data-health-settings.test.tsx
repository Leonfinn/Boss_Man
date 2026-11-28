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
    expect(text("health-db")).toContain("3.0 GB. 1 day ago 2.9 GB, 7 days ago 1.5 GB (growth: +100% in 7 days)");
    expect(text("health-limits")).toContain("2 queries cut off");
    expect(text("health-limits")).toContain("1 times the connection pool was full");
    expect(text("health-slow")).toContain("75 s: select * from tickets where id = ?");
    expect(screen.getByRole("alert").textContent).toContain("running low");
  });

  it("lists the daily history with the change, marks a jump over 10%, and counts days so far", async () => {
    const MB = 1024 ** 2;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          disk: null,
          database: { bytes: 1000 * MB, dayAgoBytes: null, weekAgoBytes: null, growthPercent7d: null },
          history: [
            { day: "2026-11-21", bytes: 500 * MB },
            { day: "2026-11-22", bytes: 620 * MB },
            { day: "2026-11-23", bytes: 640 * MB },
          ],
          limits: { statementTimeouts: 0, poolFull: 0 },
          slowQueries: [],
          warnings: [],
        }),
      ),
    );
    render(<ServerHealth />);
    const fold = await screen.findByTestId("health-db-history");
    expect(fold.querySelectorAll("tr")).toHaveLength(3);
    expect(fold.textContent).toContain("3 days recorded so far");
    expect(fold.textContent).toContain("+120 MB (grew over 10%)");
    expect(fold.textContent).toContain("+20 MB");
    expect(screen.getAllByTestId("health-db-jump")).toHaveLength(1);
  });

  it("lists the daily disk line with the 7-day rate and days to full (BOS-2918)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          disk: { freeBytes: 100 * GB, totalBytes: 1000 * GB, freePercent: 10 },
          database: { bytes: 1000, dayAgoBytes: null, weekAgoBytes: null, growthPercent7d: null },
          diskHistory: [
            { day: "2026-11-22", usedBytes: 880 * GB, totalBytes: 1000 * GB },
            { day: "2026-11-23", usedBytes: 890 * GB, totalBytes: 1000 * GB },
          ],
          diskTrend: { perDayBytes: 5 * GB, growthPercent7d: 3.5, daysToFull: 20 },
          limits: { statementTimeouts: 0, poolFull: 0 },
          slowQueries: [],
          warnings: [],
        }),
      ),
    );
    render(<ServerHealth />);
    const fold = await screen.findByTestId("health-disk-history");
    expect(fold.querySelectorAll("tr")).toHaveLength(2);
    expect(fold.textContent).toContain("890.0 GB of 1000.0 GB");
    expect(fold.textContent).toContain("+10.0 GB");
    expect(text("health-disk-trend")).toContain("full in about 20 days");
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
    expect(text("health-db")).toContain("growth: not enough history yet");
    expect(text("health-slow")).toContain("No query is running over 60 seconds.");
  });
});
