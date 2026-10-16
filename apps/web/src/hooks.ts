import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

/** The part of the URL after "#", e.g. "/board/<projectId>", so the server only serves one page. */
export function useRoute(): [string[], (to: string) => void] {
  const read = () => (window.location.hash.replace(/^#\/?/, "") || "decisions").split("/");
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [parts, (to: string) => (window.location.hash = `#/${to}`)];
}

/**
 * Loads data now and again every `everyMs`, plus whenever the tab comes back into view.
 * The browser only ever reads: all autonomy runs on the server (R43), so a slow or closed
 * tab can't hold an agent up.
 */
export function usePoll<T>(load: (signal: AbortSignal) => Promise<T>, everyMs: number, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    setData(null);
    setError(null);
  }, [key]);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        setData(await loadRef.current(ctrl.signal));
        setError(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof ApiError ? err : new ApiError(0, String(err)));
      }
      if (!ctrl.signal.aborted) timer = setTimeout(run, everyMs);
    };
    void run();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [everyMs, key, tick]);

  return { data, error, reload };
}
