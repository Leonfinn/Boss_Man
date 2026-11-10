// Text the owner reads but cannot type in, such as the standing rules shown before Edit (BOS-1050).
//
// It used to be a bare <pre> on the Settings page with `background: var(--panel, #f6f6f6)`. --panel was
// never defined in styles.css, so the box fell back to near-white while the text kept the dark theme's
// --ink: in dark mode the standing rules were pale grey on a white box, almost unreadable. The colours
// now live in the shared `.readonly-text` rule (styles.css), so a read-only box can't be left unstyled.

/** Read-only text in its own inset panel: the card's background family, body text colour, paragraphs kept. */
export function ReadOnlyText({ text, label }: { text?: string; label?: string }) {
  const empty = !(text ?? "").trim();
  return (
    <pre className={empty ? "readonly-text readonly-text-empty" : "readonly-text"} aria-label={label} role="note">
      {/* No whitespace around the text: `<pre>` shows every space and newline, and the padding is CSS. */}
      <span className="readonly-text-body">{text}</span>
    </pre>
  );
}
