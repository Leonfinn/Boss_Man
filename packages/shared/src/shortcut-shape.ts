// The tiny stored shape of one menu shortcut (BOS-2669), kept apart from the page list in shortcuts.ts so a screen
// that only reads the owner's preferences, such as the app's first load, never drags the page list into its bundle.
import { z } from "zod";

/** Most shortcuts at once: 6 keeps the whole top block (Dashboard, Decisions, Notifications, Chat) in view. */
export const SHORTCUTS_MAX = 6;

/** One saved shortcut: which page (from the shared list) and the owner's own name for it, if they gave one. */
export const SavedShortcut = z.object({
  id: z.string(),
  name: z.string().optional(),
});
export type SavedShortcut = z.infer<typeof SavedShortcut>;
