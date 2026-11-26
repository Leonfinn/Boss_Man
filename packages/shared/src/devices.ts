// Device profiles (BOS-641, from Brains's 7 Nov answer on the cock-ups page): the owner's own
// browsers measure their screens and Boss Man records the facts, so a layout ticket can be checked
// at the real device instead of a guessed emulated size. Emulated widths miss what breaks a phone
// layout: how tall the screen units really are while the toolbar shows and hides, the pixel ratio,
// touch and standalone mode.
//
// Only screen facts are kept: no personal data. A profile is whatever one signed-in browser
// reported, so it works on any install with no host-specific values.
import { z } from "zod";

/** The screen units a layout test needs. `vh` is the largest viewport on a phone (toolbar hidden),
 * `dvh` is the viewport as it is now, `svh` is the smallest, `lvh` is the largest; `visual` is the
 * visual viewport as the browser reports it. Each is a pixel height measured in that browser. */
export const DEVICE_UNITS = ["vh", "dvh", "svh", "lvh", "visual"] as const;
export type DeviceUnit = (typeof DEVICE_UNITS)[number];

/** A CSS pixel measurement (widths and heights), rounded to whole pixels by the reporter. */
const px = z.number().int().min(0).max(100_000);

/** The measured heights, taken once at load and again after the first scroll (the phone toolbar
 * shows on load and hides after a scroll, so the second reading is the "toolbar hidden" one). */
export const DeviceMeasures = z.object({
  /** window.innerWidth and window.innerHeight at the time of the reading. */
  width: px,
  height: px,
  /** window.devicePixelRatio, e.g. 2.6. */
  pixelRatio: z.number().min(0).max(16),
  /** matchMedia("(pointer: coarse)").matches: a finger, not a mouse. */
  coarsePointer: z.boolean(),
  /** The installed web app's display-mode (standalone, browser, minimal-ui, fullscreen): what a
   * black bar or toolbar does to the layout. */
  displayMode: z.enum(["standalone", "minimal-ui", "fullscreen", "browser", "unknown"]),
  /** The probe element heights, in CSS pixels. */
  units: z.object({ vh: px, dvh: px, svh: px, lvh: px, visual: px }),
  /** true on the reading taken after the first scroll (toolbar hidden); false at load. */
  afterScroll: z.boolean(),
});
export type DeviceMeasures = z.infer<typeof DeviceMeasures>;

/** What the browser sends when it reports a profile. The client says which browser family it is;
 * the server adds the id and the times. */
export const DeviceReport = z.object({
  /** "Pixel 8 · Brave" or a name the owner gave; the browser fills a sensible default. */
  label: z.string().trim().min(1).max(80),
  browser: z.string().trim().min(1).max(40),
  /** Both readings together (load and after the first scroll), so the browser reports once. */
  readings: z.array(DeviceMeasures).min(1).max(4),
  /** A stable string the browser keeps in local storage, so a second report replaces its row
   * instead of adding another. */
  fingerprint: z.string().trim().min(1).max(120),
});
export type DeviceReport = z.infer<typeof DeviceReport>;

/** A stored profile, as Settings and an agent read it. */
export type DeviceProfile = DeviceReport & { id: string; reportedAt: string };

/** The tallest of a profile's readings: what the phone reports with the toolbar hidden. */
export function tallestReading(p: Pick<DeviceReport, "readings">): DeviceMeasures {
  return p.readings.reduce((a, b) => (b.height > a.height ? b : a));
}

/**
 * True when the profile is one a layout ticket can be checked at: the browser measured the units
 * and at least one reading is after a scroll, so a test needn't invent a toolbar gap. A reading
 * with no scroll still counts when the units are measured and vh equals dvh (a desktop, or a
 * standalone app with no toolbar), because there is no toolbar to emulate.
 */
export function isRenderableProfile(p: Pick<DeviceReport, "readings">): boolean {
  const scrolled = p.readings.some((r) => r.afterScroll);
  const flat = p.readings.some((r) => r.units.vh === r.units.dvh);
  return scrolled || flat;
}

/**
 * The owner's per-login preferences (BOS-2689, and BOS-2669 reuses them): settings that follow the login
 * to every browser rather than living in one. One row per login on the server, so they survive a reload, a
 * server restart and a new browser. Today it holds the single-letter-key switch (BOS-2671 part 3d).
 *
 * Every field defaults to what someone who never changed anything gets, so the answer is the same whether
 * or not a row has ever been saved, and an older row missing a newer field reads that field's default.
 */
export const OwnerPreferences = z.object({
  /** "Use single-letter keys" (BOS-2671 3d): off turns off "?", the g-sequences, g 1 to g 6 and the j/k/Enter
   * card keys. Ctrl/Cmd+K, Escape and normal Tab/Enter stay. On for everyone until they turn it off. */
  singleLetterKeys: z.boolean().default(true),
  /** BOS-2669 part 3: the menu shortcuts the owner pinned, in their order. Empty until they pin one. */
  pinnedPages: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
});
export type OwnerPreferences = z.infer<typeof OwnerPreferences>;

/** What a page asks to change: any of the fields, and nothing else. Each checks its own rules when sent, and a
 * field left out keeps its saved value (so a pin save must not turn the keys back on). */
export const OwnerPreferencesPatch = z.object({
  singleLetterKeys: z.boolean().optional(),
  pinnedPages: z.array(z.string().trim().min(1).max(80)).max(6).optional(),
});
export type OwnerPreferencesPatch = z.infer<typeof OwnerPreferencesPatch>;
