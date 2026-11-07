// Device profiles (BOS-641): the owner's own signed-in browsers report their screens once, and the
// facts are kept so a layout ticket can be checked at the real device instead of a guessed size.
// One row per browser, replaced through the fingerprint the browser keeps, so a second visit (or a
// rotation) updates the same profile rather than piling up rows. Only screen facts are stored.
import { and, desc, eq } from "drizzle-orm";
import { DEVICE_UNITS, DeviceReport, isRenderableProfile, type DeviceMeasures, type DeviceProfile } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { deviceProfiles } from "../db/schema.js";

/** How many profiles one owner may keep; the oldest, unused one is dropped past this. */
export const DEVICE_PROFILES_MAX = 20;

/** A reading's units must be present and non-negative; the schema already checks this, but a
 * hand-edited or older row could be missing them, so a bad row reads as no profile (never a guess). */
const unitsOk = (u: DeviceMeasures["units"] | undefined) => !!u && DEVICE_UNITS.every((k) => typeof u[k] === "number" && u[k] >= 0);

/** A stored row in the shape Settings and an agent read. A row that doesn't parse is dropped, not
 * presented as facts a test could trust. */
function toProfile(row: typeof deviceProfiles.$inferSelect): DeviceProfile | null {
  const parsed = DeviceReport.safeParse({ label: row.label, browser: row.browser, fingerprint: row.fingerprint, readings: row.readings });
  if (!parsed.success || !parsed.data.readings.every((r) => unitsOk(r.units))) return null;
  return { ...parsed.data, id: row.id, reportedAt: row.reportedAt.toISOString() };
}

export function deviceProfilesService(db: Db) {
  /** Save a report: one row per owner and fingerprint, replacing the previous reading. */
  async function report(ownerId: string, input: unknown): Promise<DeviceProfile> {
    const body = DeviceReport.parse(input);
    const [row] = await db
      .insert(deviceProfiles)
      .values({ ownerId, fingerprint: body.fingerprint, label: body.label, browser: body.browser, readings: body.readings })
      .onConflictDoUpdate({ target: [deviceProfiles.ownerId, deviceProfiles.fingerprint], set: { label: body.label, browser: body.browser, readings: body.readings, reportedAt: new Date() } })
      .returning();
    // Keep the newest DEVICE_PROFILES_MAX and drop the rest (oldest first), so a changed fingerprint
    // can't grow the list without bound.
    const extra = await db.select({ id: deviceProfiles.id }).from(deviceProfiles).where(eq(deviceProfiles.ownerId, ownerId)).orderBy(desc(deviceProfiles.reportedAt)).offset(DEVICE_PROFILES_MAX);
    for (const r of extra) await db.delete(deviceProfiles).where(and(eq(deviceProfiles.ownerId, ownerId), eq(deviceProfiles.id, r.id)));
    return toProfile(row!)!;
  }

  /** The owner's profiles, newest first, without the ones that don't parse. */
  async function list(ownerId: string): Promise<DeviceProfile[]> {
    const rows = await db.select().from(deviceProfiles).where(eq(deviceProfiles.ownerId, ownerId)).orderBy(desc(deviceProfiles.reportedAt));
    return rows.map(toProfile).filter((p): p is DeviceProfile => !!p);
  }

  /** Rename a profile; null when it isn't this owner's. */
  async function rename(ownerId: string, id: string, label: string): Promise<DeviceProfile | null> {
    const [row] = await db.update(deviceProfiles).set({ label: label.trim() }).where(and(eq(deviceProfiles.ownerId, ownerId), eq(deviceProfiles.id, id))).returning();
    return row ? toProfile(row) : null;
  }

  /** Remove a profile; false when it isn't this owner's or is already gone. */
  async function remove(ownerId: string, id: string): Promise<boolean> {
    const [row] = await db.delete(deviceProfiles).where(and(eq(deviceProfiles.ownerId, ownerId), eq(deviceProfiles.id, id))).returning({ id: deviceProfiles.id });
    return !!row;
  }

  /** The profiles agents read through their brief and the devices tool: only the ones a layout
   * test can actually run at, so an unmeasured or half-reported device is never presented as fact. */
  async function renderable(ownerId: string): Promise<DeviceProfile[]> {
    return (await list(ownerId)).filter((p) => isRenderableProfile(p));
  }

  /** Every renderable profile, for an agent reading them in a run. Boss Man has one owner, so this
   * is that owner's list; it is owner-agnostic so the run's scope (which has no owner id) can use it. */
  async function allRenderable(): Promise<DeviceProfile[]> {
    const rows = await db.select().from(deviceProfiles).orderBy(desc(deviceProfiles.reportedAt));
    return rows.map(toProfile).filter((p): p is DeviceProfile => !!p && isRenderableProfile(p));
  }

  return { report, list, rename, remove, renderable, allRenderable };
}
