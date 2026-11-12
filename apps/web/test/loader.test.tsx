// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Loader } from "../src/components/Loader";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("shared Loader", () => {
  it("shows nothing for the first second, then the label with the seconds", () => {
    const { container } = render(<Loader label="Loading tasks" />);
    act(() => { vi.advanceTimersByTime(900); });
    expect(container.textContent).toBe("");
    expect(container.querySelector("svg")).toBeNull();
    act(() => { vi.advanceTimersByTime(300); });
    expect(container.textContent).toBe("Loading tasks · 1 s");
    act(() => { vi.advanceTimersByTime(2000); });
    expect(container.textContent).toBe("Loading tasks · 3 s");
  });
  it("is a polite status with a decorative SVG, and a small size", () => {
    const { container } = render(<Loader label="Loading the team" size={16} />);
    act(() => { vi.advanceTimersByTime(1200); });
    const status = container.querySelector('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.classList.contains("sm")).toBe(true);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("width")).toBe("16");
  });
});

describe("reduced motion", () => {
  it("the stylesheet stops the animation and fade and sets still bar heights", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .loader"));
    expect(block).toMatch(/\.loader \{ animation: none; \}/);
    expect(block).toMatch(/\.loader-mark rect \{ animation: none; \}/);
    expect(block).toMatch(/\.loader-mark \.b1 \{ transform: scaleY\(0\.55\)/);
  });
});
