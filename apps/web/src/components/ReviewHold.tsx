import type { ReviewHold } from "../api";
import { holdWords } from "../hold-words";

/**
 * A reviewer's hold on the merge (BOS-808), as the ticket page's banner shows it: who holds it and until what, or,
 * once that is done, who has to release it and how long it has waited (BOS-2870). The owner can let it go on (the
 * normal approval and merge follow) or withdraw the reviewer's pass.
 */
export function ReviewHoldBanner({ hold, now, busy, onRelease, onCancel }: { hold: ReviewHold; now: number; busy?: boolean; onRelease: () => void; onCancel: () => void }) {
  const words = holdWords(hold, now);
  return (
    <div className="card review-hold" role="status" data-testid="review-hold" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ flex: "1 1 320px" }}>
        <strong data-testid="hold-headline">{words.headline}</strong>
        <br />
        <span className="muted">{hold.reason} The review passed; the merge starts only after the hold is released.</span>
      </span>
      <button type="button" className="btn primary" disabled={busy} onClick={onRelease}>
        Release hold
      </button>
      <button type="button" className="btn" disabled={busy} onClick={onCancel}>
        Cancel hold and review again
      </button>
    </div>
  );
}

/** The Review box's body for a held ticket whose owner sign-off isn't needed (BOS-2870): it is not the owner's turn. */
export function ReviewHeldNote({ hold, now }: { hold: ReviewHold; now: number }) {
  return (
    <p data-testid="review-held">
      {holdWords(hold, now).headline} The reviews passed and your sign-off isn't needed, so you don't need to do anything. You can still release or cancel the hold above.
    </p>
  );
}
