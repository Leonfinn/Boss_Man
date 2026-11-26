// The owner's per-login preferences (BOS-2689, shared with BOS-2669): read once with the sign-in answer,
// so a screen that needs them (the keyboard shortcuts) decides before anything is drawn and never makes
// its own request. The settings page saves them through the same provider, so a change here shows there too.
// The shape and the defaults live in @boss-man/shared, next to the server's.
import { createContext, useContext } from "react";
import type { OwnerPreferences } from "@boss-man/shared";

export type Preferences = {
  prefs: OwnerPreferences;
  /** Save a change; resolves with everything the server saved. A failed save leaves the old choice. */
  save: (patch: Partial<OwnerPreferences>) => Promise<OwnerPreferences>;
};

/** Every default: what someone who never changed anything gets, so a screen works with no provider too. */
export const DEFAULT_PREFERENCES: OwnerPreferences = { singleLetterKeys: true, pinnedPages: [] };

export const PreferencesContext = createContext<Preferences>({
  prefs: DEFAULT_PREFERENCES,
  save: async () => {
    throw new Error("Can't save right now.");
  },
});

export const usePreferences = () => useContext(PreferencesContext);
