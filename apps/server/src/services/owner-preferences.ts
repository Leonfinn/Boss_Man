// The owner's per-login preferences (BOS-2689, shared with BOS-2669): saved on the server, one row per
// owner, so a choice follows the login to every browser and survives updates and restarts. A missing row
// is every default, so nothing is written until the owner changes something.
import { eq } from "drizzle-orm";
import { OwnerPreferences, OwnerPreferencesPatch, shortcutListProblem, type SavedShortcut } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { ownerPreferences } from "../db/schema.js";

/** A saved shortcut as it may have been stored: a bare id (an early row), or an id with an optional name. */
function asSaved(raw: unknown): SavedShortcut[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) =>
    typeof item === "string" ? { id: item } : typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string" ? { id: (item as { id: string }).id, ...(typeof (item as { name?: unknown }).name === "string" ? { name: (item as { name: string }).name } : {}) } : { id: "" },
  );
}

export function ownerPreferencesService(db: Db) {
  /** The owner's preferences; every default when they have never changed anything. */
  async function get(ownerId: string): Promise<OwnerPreferences> {
    const [row] = await db.select().from(ownerPreferences).where(eq(ownerPreferences.ownerId, ownerId));
    if (!row) return OwnerPreferences.parse({});
    // A row written by an older version may be missing a newer field; its default fills the gap. Shortcuts saved
    // as bare ids by an earlier build read back as a shortcut with no name, never dropped.
    return OwnerPreferences.parse({ singleLetterKeys: row.singleLetterKeys, pinnedPages: asSaved(row.pinnedPages), keyboardTipSeen: row.keyboardTipSeen });
  }

  /** Change only what the page sent, and return all of it, so the page can show what was saved. Throws a plain
   * `ShortcutSaveError` when the shortcut list can't be saved, and the saved list is left as it was. */
  async function update(ownerId: string, patch: unknown): Promise<OwnerPreferences> {
    const body = OwnerPreferencesPatch.parse(patch);
    if (body.pinnedPages) {
      const problem = shortcutListProblem(body.pinnedPages);
      if (problem) throw new ShortcutSaveError(problem);
    }
    const merged = OwnerPreferences.parse({ ...(await get(ownerId)), ...body });
    const values = { ownerId, singleLetterKeys: merged.singleLetterKeys, pinnedPages: merged.pinnedPages, keyboardTipSeen: merged.keyboardTipSeen };
    await db
      .insert(ownerPreferences)
      .values(values)
      .onConflictDoUpdate({ target: ownerPreferences.ownerId, set: { ...values, updatedAt: new Date() } });
    return merged;
  }

  return { get, update };
}

/** A shortcut list that can't be saved, with the plain reason the page shows. */
export class ShortcutSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShortcutSaveError";
  }
}
