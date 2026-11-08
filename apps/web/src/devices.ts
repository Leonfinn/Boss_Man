// Measures this browser's screen for device profiles (BOS-641): the real pixel heights of
// 100vh/100dvh/100svh/100lvh and the visual viewport, plus width, height, pixel ratio, touch and
// standalone mode. The phone's toolbar moves as the page scrolls, so a second reading is taken after
// the first scroll. Only screen facts are read: no personal data.
//
// Kept apart from the Settings component so it can be tested with a fake window.
import type { DeviceMeasures, DeviceReport } from "./api";

type Win = {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  matchMedia: (q: string) => { matches: boolean };
  visualViewport?: { height: number } | null;
};
type Probe = { style: { cssText: string }; getBoundingClientRect: () => { height: number }; remove: () => void };
type Doc = {
  createElement: (tag: string) => HTMLElement;
  body: { appendChild: (el: HTMLElement) => unknown };
};

const UNITS = ["vh", "dvh", "svh", "lvh"] as const;

/** One reading of the units. Each probe is a full-window element sized in one unit, measured. */
function readUnits(win: Win, doc: Doc): DeviceMeasures["units"] {
  const out = {} as Record<(typeof UNITS)[number], number>;
  for (const u of UNITS) {
    const el = doc.createElement("div");
    el.style.cssText = `position:fixed;top:0;left:0;width:0;height:100${u};visibility:hidden;pointer-events:none`;
    doc.body.appendChild(el);
    out[u] = Math.round(el.getBoundingClientRect().height);
    el.remove();
  }
  return { ...out, visual: Math.round(win.visualViewport?.height ?? win.innerHeight) };
}

/** The display-mode the page runs in (an installed web app is usually standalone). */
function displayMode(win: Win): DeviceMeasures["displayMode"] {
  for (const m of ["standalone", "minimal-ui", "fullscreen", "browser"] as const) {
    try {
      if (win.matchMedia(`(display-mode: ${m})`).matches) return m;
    } catch {
      // an old browser may not know the query: fall through
    }
  }
  return "unknown";
}

/** One full reading, for the current state of the window. */
export function measure(win: Win, doc: Doc, afterScroll: boolean): DeviceMeasures {
  const coarse = (() => {
    try {
      return win.matchMedia("(pointer: coarse)").matches;
    } catch {
      return false;
    }
  })();
  return {
    width: Math.round(win.innerWidth),
    height: Math.round(win.innerHeight),
    pixelRatio: Math.round(win.devicePixelRatio * 100) / 100,
    coarsePointer: coarse,
    displayMode: displayMode(win),
    units: readUnits(win, doc),
    afterScroll,
  };
}

/** The browser's name, for the profile label. Best effort: User-Agent Client Hints where present. */
export function browserName(nav: { userAgentData?: { brands?: Array<{ brand: string }> }; userAgent: string }): string {
  const brands = nav.userAgentData?.brands ?? [];
  const known = brands.find((b) => /Edge|Brave|Chrome|Firefox|Safari/i.test(b.brand));
  if (known) return known.brand;
  const ua = nav.userAgent;
  if (/Edg\//.test(ua)) return "Edge";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
  if (/Chrome\//.test(ua)) return "Chrome";
  return "Browser";
}

/** A default label: the browser, the CSS width, and whether it's touch ("Brave · 840px · touch"). */
export function defaultLabel(browser: string, m: DeviceMeasures): string {
  return `${browser} · ${m.width}px · ${m.coarsePointer ? "touch" : "mouse"}`;
}

/** The fingerprint kept in local storage, so a second report replaces the same profile. */
const FP_KEY = "bossman-device-fingerprint";
export function fingerprint(store: Pick<Storage, "getItem" | "setItem">): string {
  const have = store.getItem(FP_KEY);
  if (have) return have;
  const made = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `d${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  store.setItem(FP_KEY, made);
  return made;
}

/**
 * Measure at load, wait for the first scroll, measure again, and return the report. Resolves after
 * the scroll (or after `timeoutMs`, so a page the owner never scrolls still reports).
 */
export function collect(win: Win & { addEventListener: (e: string, cb: () => void) => void; removeEventListener: (e: string, cb: () => void) => void }, doc: Doc, nav: { userAgentData?: { brands?: Array<{ brand: string }> }; userAgent: string }, timeoutMs = 4000): Promise<DeviceReport> {
  const atLoad = measure(win, doc, false);
  const browser = browserName(nav);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      win.removeEventListener("scroll", onScroll);
      win.removeEventListener("touchmove", onScroll);
      const reading = measure(win, doc, true);
      // Keep the tallest of the two: the load reading (toolbar showing) and the scroll reading.
      resolve({ label: defaultLabel(browser, reading), browser, readings: [atLoad, reading], fingerprint: fingerprint(localStorage) });
    };
    const onScroll = () => finish();
    win.addEventListener("scroll", onScroll);
    win.addEventListener("touchmove", onScroll);
    setTimeout(finish, timeoutMs);
  });
}
