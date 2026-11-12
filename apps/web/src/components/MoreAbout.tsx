import { useId, useState, type ReactNode } from "react";

/**
 * A page intro that stays one sentence, with the rest behind a "More about this" fold (P7, BOS-1278): the
 * lead is plain text, the toggle is a real button carrying aria-expanded/aria-controls, and the bullets are
 * added to the page only while it is open. Closed by default, and the fold draws its own chevron (P12) so it
 * looks the same on every browser.
 */
export function MoreAbout({ lead, children }: { lead: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="more-about">
      <p className="muted more-about-lead">{lead}</p>
      <button type="button" className="more-about-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="more-about-chevron" aria-hidden="true" />
        More about this
      </button>
      {open && (
        <ul id={id} className="muted more-about-list">
          {children}
        </ul>
      )}
    </div>
  );
}
