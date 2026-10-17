/**
 * Copies text, and says whether it worked (R64). Browsers only offer the Clipboard API on
 * secure pages (HTTPS or localhost), so on a plain-http LAN address this falls back to the
 * older copy command on a hidden field.
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
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/** What to tell the owner after a copy attempt. */
export const copyMessage = (ok: boolean, what: string) => (ok ? `${what} copied.` : `Couldn't copy here. Select the ${what.toLowerCase()} and press Ctrl+C (Cmd+C on a Mac).`);
