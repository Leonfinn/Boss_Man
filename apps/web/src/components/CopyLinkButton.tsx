import { useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard";

/** The page's full address to share: origin, path and hash route. The query string is left off on purpose. */
export const pageLink = (loc: Pick<Location, "origin" | "pathname" | "hash"> = window.location) => `${loc.origin}${loc.pathname}${loc.hash}`;

/** How long "Copied" stays on the button. */
export const COPIED_MS = 2000;

/**
 * "Copy link" for a page header (BOS-2233): a home-screen app on a phone has no address bar to copy from.
 * On success the button says "Copied" for a moment; if copying fails here, the address is shown, selected,
 * so the owner can copy it by hand. The timer is cleared on unmount so it never fires into a gone page (BOS-1783).
 */
export function CopyLinkButton() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [link, setLink] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (state === "failed") {
      field.current?.focus();
      field.current?.select();
    }
  }, [state, link]);

  const copy = async () => {
    const address = pageLink();
    const ok = await copyText(address);
    if (!mounted.current) return;
    clearTimeout(timer.current);
    setLink(address);
    setState(ok ? "copied" : "failed");
    if (ok) timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, maxWidth: "100%" }}>
      <button type="button" className="btn small" onClick={() => void copy()}>
        {state === "copied" ? "Copied" : "Copy link"}
      </button>
      <span className="sr-only" role="status">
        {state === "copied" ? "Link copied." : ""}
      </span>
      {state === "failed" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, width: "min(420px, 100%)" }}>
          <span className="muted" role="alert">
            Couldn't copy here. Copy the address by hand:
          </span>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            Page address
            <input ref={field} className="mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          </label>
        </div>
      )}
    </div>
  );
}
