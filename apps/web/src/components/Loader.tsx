import { useEffect, useState } from "react";

// The shared loading mark (BOS-1276, P8): three board columns rising in turn. Nothing shows for the
// first second so a fast load never flashes; then the mark and "Loading <what> · N s". The words are
// the accessible name; the SVG is decoration.
export const LOADER_DELAY_MS = 1000;

export function Loader({ label = "Loading", size = 24 }: { label?: string; size?: 16 | 24 }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(t);
  }, []);
  // role=status stays mounted so a screen reader hears the label when it appears.
  return (
    <div className={`loader${size === 16 ? " sm" : ""}`} role="status" aria-live="polite">
      {secs >= 1 && (
        <>
          <svg className="loader-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect className="b1" x="3" y="4" width="5" height="16" rx="1.5" fill="#9db4f5" />
            <rect className="b2" x="9.5" y="4" width="5" height="16" rx="1.5" fill="#c3d1fa" />
            <rect className="b3" x="16" y="4" width="5" height="16" rx="1.5" fill="#f0b75c" />
          </svg>
          <span>{label} · {secs} s</span>
        </>
      )}
    </div>
  );
}
