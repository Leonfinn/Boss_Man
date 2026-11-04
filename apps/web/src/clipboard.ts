/**
 * Copies text, and says whether it worked (R64). Browsers only offer the Clipboard API on
 * secure pages (HTTPS or localhost), so on a plain-http LAN address this falls back to the
 * older copy command on a hidden field (BOS-336).
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the older way.
    }
  }
  const active = document.activeElement as HTMLElement | null;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  field.style.pointerEvents = "none";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    active?.focus?.();
  }
}

/**
 * Puts the text of a block in front of the owner so they can copy it by hand when copying
 * failed (BOS-336). Never throws: if even selecting fails, the message still explains.
 */
export function selectText(element: HTMLElement | null): void {
  if (!element) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.focus?.();
  } catch {
    // Nothing more we can do; the message on the button still explains.
  }
}

/** What to tell the owner after a copy attempt. */
export const copyMessage = (ok: boolean, what: string) => (ok ? `${what} copied.` : `Couldn't copy here. Select the ${what.toLowerCase()} and press Ctrl+C (Cmd+C on a Mac).`);
