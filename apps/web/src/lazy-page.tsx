import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

// BOS-1843: each top-level page is its own file the browser fetches when the page is first opened.

const RELOADED = "bossman-chunk-reload";

/**
 * A page chunk that fails to load is nearly always a build that was replaced while this tab stayed open (the old
 * file names are gone). One reload fetches the new build; a second failure inside a minute is a real fault, so it
 * goes to the page's error box instead of looping.
 */
export function loadOrReload<T>(importer: () => Promise<T>): Promise<T> {
  return importer().catch((e: unknown) => {
    let recent = false;
    try {
      const at = Number(sessionStorage.getItem(RELOADED) ?? 0);
      recent = Date.now() - at < 60_000;
      if (!recent) sessionStorage.setItem(RELOADED, String(Date.now()));
    } catch {
      recent = true;
    }
    if (recent) throw e;
    location.reload();
    // The page is reloading: never settle, so no error box flashes first.
    return new Promise<T>(() => {});
  });
}

/** `lazyPage(() => import("./pages/Board"), "Board")` is the Board component, loaded on first use. */
export function lazyPage<M, K extends keyof M>(importer: () => Promise<M>, name: K) {
  return lazy(() => loadOrReload(importer).then((m) => ({ default: m[name] as unknown as ComponentType<any> }))) as unknown as M[K];
}

/** The light stand-in while a page loads: it holds the space a page takes, so nothing jumps when the page arrives. */
export function PageLoading() {
  return (
    <div role="status" aria-live="polite" className="muted" style={{ minHeight: "60vh", padding: 16 }}>
      Loading…
    </div>
  );
}

export function PageSuspense({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  return <Suspense fallback={fallback === undefined ? <PageLoading /> : fallback}>{children}</Suspense>;
}
