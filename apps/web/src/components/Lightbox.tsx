// Pictures in Markdown open enlarged over the page instead of in a new window (BOS-330). The backdrop
// dims the page, the picture keeps its own proportions, and it scrolls inside the overlay when it is
// taller than the window, so a 1080px wide diagram stays readable at its natural width. Escape, the X
// and the backdrop close it; focus moves in on open and goes back to the picture on close.
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Natural width by default (readable diagrams); "fit" shows the whole picture in the window.
  const [fit, setFit] = useState(false);
  // Close only when the click lands on the dimmed overlay itself or the empty area beside the picture,
  // not on the picture, the bar or the caption. The panel fills the window, so its own padding is that area.
  const missTarget = useCallback((e: MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  useEffect(() => {
    // Remember what had focus so it can be given back when the overlay closes.
    const before = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      // Keep Tab inside the overlay while it is open.
      const items = [...panel.current.querySelectorAll<HTMLElement>("button, [href]")].filter((el) => !el.hasAttribute("disabled"));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus();
    };
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt || "Enlarged picture"} onClick={missTarget}>
      <div ref={panel} className="lightbox-panel" onClick={missTarget}>
        <div className="lightbox-bar">
          <button type="button" className="btn small lightbox-size" onClick={() => setFit((f) => !f)} aria-pressed={fit} title={fit ? "Show at actual size, scrolling if needed" : "Fit the whole picture to the window"}>
            {fit ? "Actual size" : "Fit to window"}
          </button>
          <button ref={closeButton} type="button" className="lightbox-close" aria-label="Close the enlarged picture" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="lightbox-scroll" onClick={missTarget}>
          <img src={src} alt={alt} className={fit ? "fit" : "natural"} />
        </div>
        {alt && <p className="lightbox-caption">{alt}</p>}
      </div>
    </div>
  );
}

/** Wraps a Markdown picture so a click opens it in the overlay, with the picture's own alt text as its caption. */
export function EnlargeableImage({ src, alt, children }: { src?: string; alt?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  // A stable close so the overlay's effect (focus, scroll lock) doesn't re-run on every parent render.
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" className="md-zoom" onClick={() => setOpen(true)} title="Click to enlarge" aria-label={alt ? `Enlarge: ${alt}` : "Enlarge picture"}>
        {children ?? <img src={src} alt={alt ?? ""} />}
      </button>
      {open && <Lightbox src={src ?? ""} alt={alt ?? ""} onClose={close} />}
    </>
  );
}
