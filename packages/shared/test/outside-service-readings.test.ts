import { describe, expect, it } from "vitest";
import { renderReadingsMarkdown, SERVICE_READINGS, zeroErrorsWithoutReadDate } from "../src/outside-service-readings.js";

describe("SERVICE_READINGS (BOS-2740)", () => {
  it("has the five services, each with every field filled", () => {
    expect(SERVICE_READINGS.map((r) => r.id)).toEqual(["search-console-sitemap", "search-console-url-inspection", "bing-sitemap", "github-actions-run", "ntfy-delivery"]);
    for (const r of SERVICE_READINGS) {
      expect(r.apiField, r.id).not.toBe("");
      expect(r.screen.length, r.id).toBeGreaterThan(0);
      expect(r.done, r.id).not.toBe("");
      expect(r.blindSpots.length, r.id).toBeGreaterThan(0);
      expect(r.turnaround, r.id).not.toBe("");
      expect(r.confirmed, r.id).toMatch(/^(not yet confirmed|confirmed against the owner's screen on .+, image .+)/);
    }
  });
  it("starts with the sitemap row: lastDownloaded set, isPending false, errors 0, submitted above 0", () => {
    const first = SERVICE_READINGS[0]!;
    expect(first.done).toBe("lastDownloaded set, isPending false, errors 0, and submitted above 0");
  });
  it("renders every service into the wiki page", () => {
    const md = renderReadingsMarkdown();
    for (const r of SERVICE_READINGS) expect(md).toContain(`## ${r.service}`);
  });
});

describe("zeroErrorsWithoutReadDate", () => {
  it("flags zero errors with no date", () => {
    expect(zeroErrorsWithoutReadDate("pending, 0 errors")).toBe(true);
    expect(zeroErrorsWithoutReadDate("sitemap has no errors")).toBe(true);
    expect(zeroErrorsWithoutReadDate("lastDownloaded set, 0 errors")).toBe(true);
  });
  it("accepts a read date, or no zero-errors claim", () => {
    expect(zeroErrorsWithoutReadDate("read 26 Nov, 0 errors")).toBe(false);
    expect(zeroErrorsWithoutReadDate("Nov 26: no errors")).toBe(false);
    expect(zeroErrorsWithoutReadDate("lastDownloaded 2026-11-26, 0 errors")).toBe(false);
    expect(zeroErrorsWithoutReadDate("Sitemap read, 12 pages discovered")).toBe(false);
    expect(zeroErrorsWithoutReadDate("3 errors")).toBe(false);
  });
});
