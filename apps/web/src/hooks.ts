import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { sharedGet } from "./shared-get";

/** The part of the URL after "#", e.g. "/board/<projectId>", so the server only serves one page. */
export function useRoute(): [string[], (to: string) => void] {
  const read = () => (window.location.hash.replace(/^#\/?/, "") || "dashboard").split("/");
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [parts, (to: string) => (window.location.hash = `#/${to}`)];
}

function hidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * What a phone keyboard's Return key should do. `newline` is in the HTML spec but React's types
 * are behind it, so the cast keeps the intent readable (BOS-245).
 */
export const NEWLINE_KEY_HINT = "newline" as "enter";

/**
 * True on a phone, where the on-screen keyboard has no Shift (BOS-245): Return should add a line
 * and the Send button should send. A tablet or a touch laptop is wider than this and keeps
 * Enter-to-send, like the desktop.
 */
export function useCoarsePointer(): boolean {
  const query = "(pointer: coarse) and (max-width: 640px)";
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [coarse, setCoarse] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setCoarse(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return coarse;
}

/**
 * Loads data now and again every `everyMs`, plus whenever the tab comes back into view.
 * The browser only ever reads: all autonomy runs on the server (R43), so a slow or closed
 * tab can't hold an agent up.
 *
 * At most one chain runs per hook: a reload asked for mid-request is remembered and happens
 * when that request comes back, never alongside it. Timers stop while the tab is hidden, and
 * one reload runs on return.
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
    let live = true;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!live || hidden()) return;
      timer = setTimeout(() => void run(), everyMs);
    };

    const run = async () => {
      if (!live) return;
      if (running) {
        // Already out: ask for one more when it comes back rather than start a second chain.
        again = true;
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      if (hidden()) return;
      running = true;
      try {
        const next = await loadRef.current(new AbortController().signal);
        if (!live) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!live || (err as Error).name === "AbortError") return;
        setError(err instanceof ApiError ? err : new ApiError(0, String(err)));
      } finally {
        running = false;
      }
      if (!live) return;
      if (again) {
        again = false;
        void run();
      } else schedule();
    };

    const onVisibility = () => {
      if (hidden()) {
        // Going away: stop the timer so nothing is sent while nobody is looking.
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (running) again = true;
      else void run();
    };

    if (!hidden()) void run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [everyMs, key, tick]);

  return { data, error, reload };
}

/**
 * "Show older" under a polled, newest-first first page (BOS-2165). `load(beforeId)` fetches the page older than a row;
 * the rows it brings are kept for `key` (a new key drops them) and follow the first page without repeats, so a poll
 * that shifts the first page never shows a row twice. More is offered while the last page came back full.
 */
export function useOlder<T extends { id: string }>(first: T[] | null, pageSize: number, load: (before: string) => Promise<T[]>, key: string) {
  const [older, setOlder] = useState<{ key: string; rows: T[]; done: boolean }>({ key, rows: [], done: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = older.key === key ? older : { key, rows: [] as T[], done: false };
  const seen = new Set((first ?? []).map((r) => r.id));
  const rows = first ? [...first, ...mine.rows.filter((r) => !seen.has(r.id))] : null;
  const canMore = !!first && first.length >= pageSize && !mine.done;
  const more = async () => {
    const last = rows?.at(-1);
    if (!last || busy) return;
    setBusy(true);
    setError(null);
    try {
      const page = await load(last.id);
      setOlder({ key, rows: [...mine.rows, ...page], done: page.length < pageSize });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { rows, canMore, more, busy, error };
}

/** True while the window matches a media query; false on the server or in an old browser. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" || !window.matchMedia ? false : window.matchMedia(query).matches));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [query]);
  return matches;
}
