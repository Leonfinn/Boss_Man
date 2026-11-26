// The owner's per-login preferences (BOS-2689, shared with BOS-2669): saved on the server, one row per
// owner, so a choice follows the login to every browser and survives updates and restarts. A missing row
// is every default, so nothing is written until the owner changes something.
import { eq } from "drizzle-orm";
import { OwnerPreferences, OwnerPreferencesPatch } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { ownerPreferences } from "../db/schema.js";

export function ownerPreferencesService(db: Db) {
  /** The owner's preferences; every default when they have never changed anything. */
  async function get(ownerId: string): Promise<OwnerPreferences> {
    const [row] = await db.select().from(ownerPreferences).where(eq(ownerPreferences.ownerId, ownerId));
    if (!row) return OwnerPreferences.parse({});
    // A row written by an older version may be missing a newer field; its default fills the gap.
    return OwnerPreferences.parse({ singleLetterKeys: row.singleLetterKeys, pinnedPages: row.pinnedPages });
  }

  /** Change only what the page sent, and return all of it, so the page can show what was saved. */
  async function update(ownerId: string, patch: unknown): Promise<OwnerPreferences> {
    const body = OwnerPreferencesPatch.parse(patch);
    const merged = OwnerPreferences.parse({ ...(await get(ownerId)), ...body });
    await db
      .insert(ownerPreferences)
      .values({ ownerId, singleLetterKeys: merged.singleLetterKeys, pinnedPages: merged.pinnedPages })
      .onConflictDoUpdate({ target: ownerPreferences.ownerId, set: { singleLetterKeys: merged.singleLetterKeys, pinnedPages: merged.pinnedPages, updatedAt: new Date() } });
    return merged;
  }

  return { get, update };
}
