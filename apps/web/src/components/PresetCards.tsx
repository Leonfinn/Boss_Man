import { useState, type ReactNode } from "react";
import type { Preset } from "../lib/presets";

/** A row of preset cards plus "Custom" (BOS-1493). `active` is worked out from the form values by the caller, so editing any cell moves the choice to Custom. */
export function PresetCards<V>({ label, presets, active, onPick }: { label: string; presets: Array<Preset<V>>; active: Preset<V> | null; onPick: (p: Preset<V>) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="preset-cards">
      {presets.map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={active?.id === p.id} className={`preset-card${active?.id === p.id ? " on" : ""}`} onClick={() => onPick(p)}>
          <strong>{p.name}</strong>
          <span className="muted">{p.blurb}</span>
        </button>
      ))}
      <div role="radio" aria-checked={!active} aria-disabled="true" className={`preset-card${active ? "" : " on"}`}>
        <strong>Custom</strong>
        <span className="muted">Your own values. Pick a card to replace them; nothing changes until you save.</span>
      </div>
    </div>
  );
}

/** The full grid, folded. Open state is remembered per device; it is forced open while the values are Custom. */
export function Advanced({ storeKey, forceOpen, summary, children }: { storeKey: string; forceOpen: boolean; summary: string; children: ReactNode }) {
  const key = `bossman.advanced.${storeKey}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const shown = open || forceOpen;
  return (
    <details open={shown} onToggle={(e) => {
      const now = (e.currentTarget as HTMLDetailsElement).open;
      if (forceOpen && !now) return;
      setOpen(now);
      try {
        localStorage.setItem(key, now ? "1" : "0");
      } catch {
        /* storage is off: the fold just won't be remembered */
      }
    }}>
      <summary style={{ cursor: "pointer" }}>
        Advanced <span className="muted">{summary}</span>
      </summary>
      {children}
    </details>
  );
}
