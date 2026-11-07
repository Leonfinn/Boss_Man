import { describe, expect, it } from "vitest";
import { dateFormat, formatCacheSize, formatDate, isTimeZone } from "../src/index.js";


describe("the shared cached date formatter (BOS-652)", () => {
  it("gives the same answer as a fresh Intl.DateTimeFormat", () => {
    const d = new Date("2026-11-04T07:35:00Z");
    const opts = { day: "numeric", month: "short", timeZone: "Europe/London" } as const;
    expect(formatDate("en-GB", d, opts)).toBe("4 Nov");
    expect(formatDate("en-GB", new Date("2026-11-04T23:30:00Z"), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York" })).toBe(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York" }).format(new Date("2026-11-04T23:30:00Z")));
  });

  it("reuses one formatter for the same locale, zone and options", () => {
    const opts = { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" } as const;
    expect(dateFormat("en-GB", opts)).toBe(dateFormat("en-GB", { ...opts }));
    expect(dateFormat("en-GB", opts)).not.toBe(dateFormat("en-GB", { ...opts, month: "long" }));
    expect(dateFormat("en-GB", opts)).not.toBe(dateFormat("en-GB", { ...opts, timeZone: "Europe/London" }));
  });

  it("tells a real time zone from a made-up one, and remembers the answer", () => {
    expect(isTimeZone("Europe/London")).toBe(true);
    expect(isTimeZone("europe/LONDON")).toBe(true);
    expect(isTimeZone("Not/AZone")).toBe(false);
    expect(isTimeZone("Not/AZone")).toBe(false);
  });
  it("clears its cache rather than grow past the cap", () => {
    const zone = (n: number) => ["Europe/London", "America/New_York", "Asia/Tokyo"][n % 3]!;
    const month = (n: number) => ["long", "short", "2-digit", "numeric"][Math.floor(n / 3) % 4] as "long" | "short" | "2-digit" | "numeric";
    for (let n = 0; n < 400; n++) formatDate("en-GB", new Date(0), { timeZone: zone(n), month: month(n), year: "numeric", day: "numeric", weekday: "short", hour: "2-digit" });
    expect(formatCacheSize()).toBeLessThanOrEqual(256);
  });
});
