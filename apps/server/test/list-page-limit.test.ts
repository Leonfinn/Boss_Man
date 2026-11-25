import { describe, expect, it } from "vitest";
import { PAGE_DEFAULT, PAGE_MAX, pageLimit } from "../src/services/list-page.js";

describe("pageLimit: one page's limit for a newest-first list (BOS-2165)", () => {
  it("uses the default when no limit is given", () => {
    expect(pageLimit()).toBe(PAGE_DEFAULT);
    expect(pageLimit(undefined)).toBe(PAGE_DEFAULT);
    expect(PAGE_DEFAULT).toBe(50);
  });

  it("keeps a normal limit as given, including the maximum itself", () => {
    expect(pageLimit(25)).toBe(25);
    expect(pageLimit(PAGE_MAX)).toBe(PAGE_MAX);
    expect(PAGE_MAX).toBe(200);
  });

  it("clamps a zero, a negative number and anything under one up to one", () => {
    expect(pageLimit(0)).toBe(1);
    expect(pageLimit(-5)).toBe(1);
    expect(pageLimit(-0.5)).toBe(1);
  });

  it("rounds a fraction down to a whole number of rows", () => {
    expect(pageLimit(10.9)).toBe(10);
    expect(pageLimit(1.5)).toBe(1);
  });

  it("clamps a value over the maximum down to the maximum, not refusing it", () => {
    expect(pageLimit(PAGE_MAX + 1)).toBe(PAGE_MAX);
    expect(pageLimit(500)).toBe(PAGE_MAX);
  });
});
