// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { browserName, defaultLabel, fingerprint, measure } from "../src/devices";

// Device profile measurement (BOS-641). jsdom has no layout, so the probe elements measure 0: that is
// exactly the point of a failure case below. The probe wiring and the plain window values are checked.

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

const win = (over: Partial<typeof window> = {}) => Object.assign(Object.create(window), over) as unknown as typeof window;

describe("measure", () => {
  it("reads the window values and the display mode, marking whether it was after a scroll", () => {
    const m = measure(
      win({
        innerWidth: 840,
        innerHeight: 900,
        devicePixelRatio: 2.6,
        matchMedia: ((q: string) => ({ matches: q === "(pointer: coarse)" || q === "(display-mode: standalone)" })) as unknown as typeof window.matchMedia,
        visualViewport: { height: 800 } as never,
      }),
      document,
      true,
    );
    expect(m.width).toBe(840);
    expect(m.height).toBe(900);
    expect(m.pixelRatio).toBe(2.6);
    expect(m.coarsePointer).toBe(true);
    expect(m.displayMode).toBe("standalone");
    expect(m.units.visual).toBe(800);
    expect(m.afterScroll).toBe(true);
  });

  it("falls back to the window height for the visual viewport when the browser has none", () => {
    const m = measure(win({ innerHeight: 800, matchMedia: ((_q: string) => ({ matches: false })) as unknown as typeof window.matchMedia, visualViewport: null }), document, false);
    expect(m.units.visual).toBe(800);
    expect(m.displayMode).toBe("unknown");
  });
});

describe("browserName and defaultLabel", () => {
  it("names a known brand, else falls back to the user agent, never throwing", () => {
    expect(browserName({ userAgentData: { brands: [{ brand: "Brave" }] }, userAgent: "" })).toBe("Brave");
    expect(browserName({ userAgent: "Mozilla/5.0 (X11) Firefox/124" })).toBe("Firefox");
    expect(browserName({ userAgent: "something odd" })).toBe("Browser");
  });

  it("builds a label from the browser, the CSS width and touch", () => {
    const m = measure(win({ innerWidth: 700, matchMedia: ((_q: string) => ({ matches: true })) as unknown as typeof window.matchMedia }), document, false);
    expect(defaultLabel("Brave", m)).toBe("Brave · 700px · touch");
  });
});

describe("fingerprint", () => {
  it("keeps the same value across calls so a second report replaces the row", () => {
    const a = fingerprint(localStorage);
    expect(fingerprint(localStorage)).toBe(a);
    expect(localStorage.getItem("bossman-device-fingerprint")).toBe(a);
  });
});
