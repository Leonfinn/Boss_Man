import { useEffect } from "react";
import { api } from "./api";
import { usePoll } from "./hooks";

/**
 * The server-wide hold (BOS-836): Settings → "Stop all work" turns it on, the every-page banner's Resume turns it
 * off. Both read the real state from the server. A press tells the other through a window event, so the banner
 * shows (or goes) at once rather than on its next poll.
 */
const CHANGED = "bm-hold-changed";

export async function setHold(paused: boolean): Promise<void> {
  await api("/api/kill-switch", { method: "POST", body: { paused } });
  window.dispatchEvent(new Event(CHANGED));
}

export function useHold() {
  const hold = usePoll((signal) => api<{ paused: boolean }>("/api/kill-switch", { signal }), 15_000, "kill-switch");
  const reload = hold.reload;
  useEffect(() => {
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload]);
  return hold;
}
