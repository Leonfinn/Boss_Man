// The wiki's bin (BOS-2197): a deleted page waits 30 days here with Restore, then is removed for good.
// Two parts: the "Deleted pages" list beside the page tree, and the notice a link to a deleted page shows.
import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { when } from "../pages/Runs";

type DeletedRow = { slug: string; folder: string; title: string; deletedAt: string; deletedBy: string | null; purgeOn: string };

/** Restore puts the page back where it was, with its history. `after` runs once it is back (reload the tree, open the page). */
function useRestore(companyId: string, after: (slug: string) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = async (slug: string) => {
    setBusy(slug);
    setError(null);
    try {
      await api(`/api/companies/${companyId}/wiki-deleted/restore`, { method: "POST", body: { slug } });
      after(slug);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, restore };
}

/** The "Deleted pages" list: title, folder, who deleted it and when, and Restore. Closed until the owner opens it. */
export function DeletedPages({ companyId, go, onChanged }: { companyId: string; go: (to: string) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const list = usePoll((signal) => (open ? api<{ pages: DeletedRow[] }>(`/api/companies/${companyId}/wiki-deleted`, { signal }) : Promise.resolve({ pages: [] as DeletedRow[] })), 30_000, `wiki-deleted/${companyId}/${open}`);
  const { busy, error, restore } = useRestore(companyId, (slug) => {
    onChanged();
    list.reload();
    go(`wiki/${companyId}/${slug}`);
  });
  const rows = list.data?.pages ?? [];
  return (
    <div className="wiki-deleted">
      <button type="button" className="btn" aria-expanded={open} aria-controls="wiki-deleted-list" onClick={() => setOpen((o) => !o)}>
        Deleted pages
      </button>
      {open && (
        <div id="wiki-deleted-list">
          {list.error && <p className="error" role="alert">Couldn't load the deleted pages: {list.error.message}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {list.data && rows.length === 0 && <p className="muted">No deleted pages. A page you delete waits here for 30 days.</p>}
          <ul>
            {rows.map((r) => (
              <li key={r.slug} style={{ fontSize: 14 }}>
                <strong>{r.title}</strong>
                <small className="muted" style={{ display: "block" }}>
                  {r.folder ? `${r.folder.split("/").join(" / ")} · ` : ""}deleted {when(r.deletedAt)} by {r.deletedBy ?? "you"} · gone for good on {r.purgeOn}
                </small>
                <button type="button" className="btn" disabled={busy === r.slug} onClick={() => void restore(r.slug)} aria-label={`Restore ${r.title}`}>
                  {busy === r.slug ? "Restoring…" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** What a link to a deleted page shows: when it was deleted, and Restore. */
export function DeletedNotice({ companyId, slug, stub, onRestored }: { companyId: string; slug: string; stub: { title: string; deletedAt: string; deletedBy: string | null; purgeOn: string }; onRestored: () => void }) {
  const { busy, error, restore } = useRestore(companyId, onRestored);
  return (
    <article className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600 }}>{stub.title}</h2>
      <p>
        This page was deleted on {new Date(stub.deletedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} by {stub.deletedBy ?? "you"}. It is gone for good on {stub.purgeOn}.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div>
        <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void restore(slug)}>
          {busy ? "Restoring…" : "Restore"}
        </button>
      </div>
    </article>
  );
}
