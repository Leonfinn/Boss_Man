// Notices when the server now serves a newer web app than the one running in this tab (BOS-550).
//
// The app is one page that never reloads by itself: it only polls data. After an update an open tab kept running
// the old screens against the new server, so on 6 Nov a card raised after the update showed its commands as raw
// ``` text (the old renderer couldn't read the new fence lines). The page itself is served with no-cache and names
// its script by content hash, so comparing that name with the one this tab loaded tells whether a reload would
// bring newer screens. Nothing is reloaded behind the owner's back: they may be typing an answer.
import { usePoll } from "./hooks";

/** The page's main script, as the build names it: `<script type="module" … src="/assets/index-<hash>.js">`. */
export function mainScriptOf(html: string): string | null {
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1]!;
    if (!/\btype\s*=\s*["']?module\b/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (src) return new URL(src[1]!, "http://x").pathname;
  }
  return null;
}

/** The main script this tab is running, or null when it can't be told (tests, or a page with none). */
function runningScript(): string | null {
  const src = typeof document === "undefined" ? null : document.querySelector('script[type="module"][src]')?.getAttribute("src");
  return src ? new URL(src, "http://x").pathname : null;
}

/** True when the page the server serves now names a different main script from the one this tab loaded. */
export async function newerBuild(signal: AbortSignal, running = runningScript()): Promise<boolean> {
  if (!running) return false;
  const res = await fetch("/", { signal, cache: "no-store", credentials: "same-origin" });
  if (!res.ok) return false;
  const served = mainScriptOf(await res.text());
  return served !== null && served !== running;
}

/** Checks every two minutes, and when the tab comes back into view. */
export function useNewBuild(): boolean {
  return usePoll((signal) => newerBuild(signal), 120_000, "new-build").data === true;
}
