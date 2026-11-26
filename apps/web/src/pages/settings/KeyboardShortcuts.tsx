import { useState } from "react";
import { settingsPath } from "../settings-redirect";
import { usePreferences } from "../../preferences";
import { OPEN_SHORTCUTS_EVENT } from "../../components/Shortcuts";
import { Section } from "./shared";

/**
 * The keyboard-shortcut switch (BOS-2689, BOS-2671 part 3d): one box, on until turned off, saved on the
 * server per login so it follows the owner to every browser and survives updates and restarts. Ticking it
 * saves straight away (it is a setting, not a form with a Save button), and a failed save puts the box back
 * where it was and says so under it.
 */
export function KeyboardShortcuts({ companyId }: { companyId: string | undefined }) {
  const { prefs, save } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The box shows what the server has saved; a failed save leaves that unchanged, which puts the box back.
  const on = prefs.singleLetterKeys;

  const change = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await save({ singleLetterKeys: next });
    } catch {
      setError("Couldn't save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="keyboard-shortcuts-h" title="Keyboard shortcuts">
      <label htmlFor="pref-single-letter-keys" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <input id="pref-single-letter-keys" type="checkbox" checked={on} disabled={busy} onChange={(e) => void change(e.target.checked)} />
        <span>Use single-letter keys</span>
      </label>
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        ? for the list, g then a letter to go to a page, j k to move between cards. Turn off if you use voice control or press keys by accident.
      </p>
      {error && (
        <p className="error" role="alert" style={{ fontSize: 14, margin: 0 }}>
          {error}
        </p>
      )}
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        Ctrl K for search always works. This setting follows your login to every browser. ·{" "}
        <a
          href={`#/${settingsPath(companyId, "account")}`}
          onClick={(e) => {
            e.preventDefault();
            window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));
          }}
        >
          Show all keyboard shortcuts
        </a>
      </p>
    </Section>
  );
}
